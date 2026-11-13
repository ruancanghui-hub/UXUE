import { ImageSource, Rectangle, Texture } from 'pixi.js';
import { TEXTURE_LEVELS, type TextureLevel } from '../../../shared/bench';
import type { TexturedImage, TileRef } from '../../../shared/textures';

/** 一块纹理在原图像素坐标里覆盖的区域；L0 / L1 只有一块，L2 会切成多块 */
export interface Tile {
  texture: Texture;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileSet {
  level: TextureLevel;
  /** 纹理对应的原图尺寸，tile 坐标以它为准 */
  imageWidth: number;
  imageHeight: number;
  tiles: Tile[];
}

/** 'failed' 不会自动重试，否则文件缺失时会无限重复请求 */
type SlotState = 'empty' | 'loading' | 'committing' | 'ready' | 'failed';

interface LevelSlot {
  state: SlotState;
  /** 每次释放都会加一，让排队中的旧解码结果作废 */
  token: number;
  controller: AbortController | null;
  pending: (Tile | null)[];
  tiles: Tile[];
  imageWidth: number;
  imageHeight: number;
  bytes: number;
  /** 最近一次被需要的时间，用于按最近最少使用卸载 */
  lastWantedAt: number;
}

interface Entry {
  image: TexturedImage;
  refs: number;
  slots: [LevelSlot, LevelSlot, LevelSlot];
  wanted: TextureLevel;
  /** 数值越小越先加载（离视口中心越近越小） */
  priority: number;
}

interface DecodedTile {
  id: string;
  level: TextureLevel;
  token: number;
  index: number;
  bitmap: ImageBitmap;
  /** tile 在 bitmap 里的有效区域（去掉防接缝的 1px 外边） */
  frame: Rectangle;
  /** tile 有效区域在原图里的位置 */
  x: number;
  y: number;
}

export interface TextureStats {
  resident: [number, number, number];
  residentMB: number;
  loading: number;
  pendingCommit: number;
}

export interface TextureManagerOptions {
  maxConcurrentLoads: number;
  /** L1 + L2 纹理的显存预算；L0 常驻，不计入 */
  budgetBytes: number;
  /** 每帧最多上传到 GPU 的纹理字节数，避免一帧上传太多造成卡顿 */
  uploadBytesPerFrame: number;
  /** 立即把纹理上传到 GPU；不上传的话会拖到它第一次出现在屏幕上那一帧，集中上传造成卡顿 */
  upload: (texture: Texture) => void;
}

const DEFAULT_OPTIONS: TextureManagerOptions = {
  maxConcurrentLoads: 8,
  budgetBytes: 768 * 1024 * 1024,
  uploadBytesPerFrame: 6 * 1024 * 1024,
  upload: () => {},
};

/** 近似显存占用；L0 / L1 含 mipmap，按 1.34 倍计 */
const estimateBytes = (width: number, height: number, level: TextureLevel): number =>
  Math.round(width * height * 4 * (level < 2 ? 1.34 : 1));

/**
 * 三级纹理调度：引擎每次调度时告诉它每张图想要的级别，
 * 它负责后台解码、切块、分帧上传，并在超出预算时卸载不再需要的高清纹理。
 */
export class TextureManager {
  private readonly options: TextureManagerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly decoded: DecodedTile[] = [];
  private wantedChanged: string[] = [];
  private activeLoads = 0;
  private residentBytes = 0;
  private peakBytes = 0;
  private destroyed = false;

  constructor(options: Partial<TextureManagerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 同一个版本可能被多张卡片引用（创建副本），按引用计数管理 */
  register(image: TexturedImage): void {
    const existing = this.entries.get(image.key);
    if (existing) {
      existing.refs++;
      return;
    }
    const slot = (): LevelSlot => ({
      state: 'empty',
      token: 0,
      controller: null,
      pending: [],
      tiles: [],
      imageWidth: 0,
      imageHeight: 0,
      bytes: 0,
      lastWantedAt: 0,
    });
    this.entries.set(image.key, { image, refs: 1, slots: [slot(), slot(), slot()], wanted: 0, priority: Infinity });
  }

  unregister(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || --entry.refs > 0) return;
    for (const level of TEXTURE_LEVELS) this.releaseSlot(entry, level);
    this.entries.delete(key);
  }

  /** L0 都加载失败了，说明缓存文件不在 */
  isFailed(key: string): boolean {
    return this.entries.get(key)?.slots[0].state === 'failed';
  }

  /** 缓存在后台重建完成后，让失败过的级别重新加载 */
  retry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const slot of entry.slots) if (slot.state === 'failed') slot.state = 'empty';
  }

  setWanted(id: string, level: TextureLevel, priority: number, now: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.wanted !== level) this.wantedChanged.push(id);
    entry.wanted = level;
    entry.priority = priority;
    for (let l = 0; l <= level; l++) entry.slots[l].lastWantedAt = now;
  }

  /**
   * 当前该用的纹理：优先用想要的级别；没有时先找更清晰的，再退回更模糊的。
   * L2 没有 mipmap，缩小显示会出锯齿，所以不想要 L2 时也不会优先选它。
   */
  bestTiles(id: string): TileSet | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const order: TextureLevel[] = entry.wanted === 2 ? [2, 1, 0] : entry.wanted === 1 ? [1, 2, 0] : [0, 1, 2];
    for (const level of order) {
      const slot = entry.slots[level];
      if (slot.state === 'ready') {
        return { level, imageWidth: slot.imageWidth, imageHeight: slot.imageHeight, tiles: slot.tiles };
      }
    }
    return null;
  }

  /** 想要的级别变了的图片 id，引擎据此重新挑选要显示的纹理 */
  takeWantedChanges(): string[] {
    const changed = this.wantedChanged;
    this.wantedChanged = [];
    return changed;
  }

  /** 取消已经不需要的高清加载，再按优先级发起新的加载 */
  schedule(): void {
    const candidates: { entry: Entry; level: TextureLevel; rank: number }[] = [];
    for (const entry of this.entries.values()) {
      for (const level of [1, 2] as const) {
        const state = entry.slots[level].state;
        if ((state === 'loading' || state === 'committing') && level > entry.wanted) this.releaseSlot(entry, level);
      }
      if (entry.slots[0].state === 'empty') {
        candidates.push({ entry, level: 0, rank: entry.priority });
      }
      if (entry.wanted > 0 && !this.hasAtLeast(entry, entry.wanted)) {
        candidates.push({ entry, level: entry.wanted, rank: 1e9 + entry.priority });
      }
    }

    candidates.sort((a, b) => a.rank - b.rank);
    for (const { entry, level } of candidates) {
      if (this.activeLoads >= this.options.maxConcurrentLoads) break;
      this.load(entry, level);
    }
  }

  /** 每帧调用：按字节预算把已解码的 tile 上传到 GPU，返回有级别变成可用的图片 id */
  commitDecoded(): string[] {
    const changed: string[] = [];
    let uploadedBytes = 0;
    let uploadedCount = 0;
    while (this.decoded.length > 0) {
      const next = this.decoded[0];
      const entry = this.entries.get(next.id);
      const slot = entry?.slots[next.level];
      if (!entry || !slot || slot.token !== next.token || slot.state !== 'committing') {
        this.decoded.shift();
        next.bitmap.close();
        continue;
      }
      const bytes = estimateBytes(next.bitmap.width, next.bitmap.height, next.level);
      // 每帧至少上传一块，之后只在不超出预算时继续
      if (uploadedCount > 0 && uploadedBytes + bytes > this.options.uploadBytesPerFrame) break;
      this.decoded.shift();

      const texture = new Texture({
        source: new ImageSource({
          resource: next.bitmap,
          // L2 只在接近原图尺寸时显示，用不上 mipmap
          autoGenerateMipmaps: next.level < 2,
          scaleMode: 'linear',
          mipmapFilter: 'linear',
        }),
        frame: next.frame,
      });
      this.options.upload(texture);
      slot.pending[next.index] = {
        texture,
        x: next.x,
        y: next.y,
        width: next.frame.width,
        height: next.frame.height,
      };
      slot.bytes += bytes;
      this.residentBytes += bytes;
      this.peakBytes = Math.max(this.peakBytes, this.residentBytes);
      uploadedBytes += bytes;
      uploadedCount++;

      if (slot.pending.every((tile) => tile !== null)) {
        slot.tiles = slot.pending as Tile[];
        slot.pending = [];
        slot.state = 'ready';
        changed.push(next.id);
      }
    }
    return changed;
  }

  /** 超出预算时，按最近最少使用卸载当前不需要的 L1 / L2，返回受影响的图片 id */
  evict(): string[] {
    let overBytes = this.highResBytes() - this.options.budgetBytes;
    if (overBytes <= 0) return [];
    const victims: { entry: Entry; level: TextureLevel; lastWantedAt: number }[] = [];
    for (const entry of this.entries.values()) {
      for (const level of [1, 2] as const) {
        if (entry.slots[level].state === 'ready' && level > entry.wanted) {
          victims.push({ entry, level, lastWantedAt: entry.slots[level].lastWantedAt });
        }
      }
    }
    victims.sort((a, b) => a.lastWantedAt - b.lastWantedAt);
    const affected: string[] = [];
    for (const { entry, level } of victims) {
      if (overBytes <= 0) break;
      overBytes -= entry.slots[level].bytes;
      this.releaseSlot(entry, level);
      affected.push(entry.image.key);
    }
    return affected;
  }

  /** 每张图的 L0 都已上屏或确定失败 */
  isAllL0Settled(): boolean {
    for (const entry of this.entries.values()) {
      const state = entry.slots[0].state;
      if (state !== 'ready' && state !== 'failed') return false;
    }
    return true;
  }

  failedCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.slots[0].state === 'failed') count++;
    return count;
  }

  stats(): TextureStats {
    const resident: [number, number, number] = [0, 0, 0];
    let loading = 0;
    for (const entry of this.entries.values()) {
      for (const level of TEXTURE_LEVELS) {
        const state = entry.slots[level].state;
        if (state === 'ready') resident[level]++;
        else if (state === 'loading' || state === 'committing') loading++;
      }
    }
    return {
      resident,
      residentMB: Math.round(this.residentBytes / 1024 / 1024),
      loading,
      pendingCommit: this.decoded.length,
    };
  }

  peakMB(): number {
    return Math.round(this.peakBytes / 1024 / 1024);
  }

  resetPeak(): void {
    this.peakBytes = this.residentBytes;
  }

  destroy(): void {
    this.destroyed = true;
    for (const id of [...this.entries.keys()]) this.unregister(id);
    for (const { bitmap } of this.decoded) bitmap.close();
    this.decoded.length = 0;
  }

  private hasAtLeast(entry: Entry, level: TextureLevel): boolean {
    for (let l = level; l <= 2; l++) if (entry.slots[l].state !== 'empty') return true;
    return false;
  }

  private highResBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.slots[1].bytes + entry.slots[2].bytes;
    return bytes;
  }

  private load(entry: Entry, level: TextureLevel): void {
    const slot = entry.slots[level];
    const controller = new AbortController();
    const token = slot.token;
    slot.state = 'loading';
    slot.controller = controller;
    this.activeLoads++;
    const isCurrent = (): boolean =>
      !this.destroyed && !controller.signal.aborted && slot.token === token && this.entries.has(entry.image.key);

    const decodeTiles =
      level === 2
        ? decodeAll(entry.image.tiles.map((tile) => decodeTile(tile, controller.signal)))
        : decodeWhole(entry.image.urls[level], controller.signal).then((tile) => [tile]);

    decodeTiles
      .then((tiles) => {
        if (!isCurrent()) {
          for (const tile of tiles) tile.bitmap.close();
          return;
        }
        const first = tiles[0];
        slot.imageWidth = level === 2 ? entry.image.width : first.bitmap.width;
        slot.imageHeight = level === 2 ? entry.image.height : first.bitmap.height;
        slot.pending = tiles.map(() => null);
        slot.state = 'committing';
        tiles.forEach((tile, index) => this.decoded.push({ ...tile, id: entry.image.key, level, token, index }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn(`[texture] ${entry.image.key} L${level} 加载失败`, error);
        if (slot.token === token && slot.state === 'loading') slot.state = 'failed';
      })
      .finally(() => {
        this.activeLoads--;
        if (slot.controller === controller) slot.controller = null;
        if (!this.destroyed) this.schedule();
      });
  }

  private releaseSlot(entry: Entry, level: TextureLevel): void {
    const slot = entry.slots[level];
    slot.controller?.abort();
    slot.controller = null;
    for (const tile of [...slot.tiles, ...slot.pending]) {
      if (!tile) continue;
      const bitmap = tile.texture.source.resource as ImageBitmap;
      tile.texture.destroy(true);
      bitmap.close();
    }
    this.residentBytes -= slot.bytes;
    slot.tiles = [];
    slot.pending = [];
    slot.bytes = 0;
    slot.state = 'empty';
    slot.token++;
  }
}

type DecodedPiece = Omit<DecodedTile, 'id' | 'level' | 'token' | 'index'>;

/** fetch + createImageBitmap 的解码在浏览器后台线程完成，不占主线程 */
async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
}

async function decodeWhole(url: string, signal: AbortSignal): Promise<DecodedPiece> {
  const bitmap = await fetchBitmap(url, signal);
  return { bitmap, frame: new Rectangle(0, 0, bitmap.width, bitmap.height), x: 0, y: 0 };
}

/** 任意一块失败就把已经解码好的块释放掉，再整体失败 */
async function decodeAll(jobs: Promise<DecodedPiece>[]): Promise<DecodedPiece[]> {
  const results = await Promise.allSettled(jobs);
  const failed = results.find((result) => result.status === 'rejected');
  if (!failed) return results.map((result) => (result as PromiseFulfilledResult<DecodedPiece>).value);
  for (const result of results) if (result.status === 'fulfilled') result.value.bitmap.close();
  throw (failed as PromiseRejectedResult).reason;
}

async function decodeTile(tile: TileRef, signal: AbortSignal): Promise<DecodedPiece> {
  const bitmap = await fetchBitmap(tile.url, signal);
  return {
    bitmap,
    frame: new Rectangle(tile.x - tile.left, tile.y - tile.top, tile.width, tile.height),
    x: tile.x,
    y: tile.y,
  };
}
