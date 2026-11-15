import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import { BENCH_HOST, type BenchImage, type FrameSummary, type TextureLevel } from '../../../shared/bench';
import type { PromptTemplate } from '../../../shared/api';
import {
  cardGroupId,
  defaultRegions,
  isBlockCard,
  isBlockCropStale,
  isDecorCard,
  isGroupCard,
  isSketchMark,
  isSketchTextCard,
  isStrokeCard,
  SKETCH_FONT_SIZES,
  isImageCard,
  isPageCard,
  isPromptCard,
  isRefCard,
  isThemeCard,
  normalizeHex,
  pageLogicalSize,
  type BlockCard,
  type CanvasCard,
  type DecorCard,
  type ImageCard,
  type PageCard,
  type PromptCard,
  type RefCard,
  type RegionId,
  type SketchTextCard,
  type StrokeCard,
  type ThemeCard,
  type Version,
  type ViewportState,
} from '../../../shared/project';
import { texturedImage } from '../../../shared/textures';
import { DocumentStore, type DocChange } from '../document/DocumentStore';
import {
  addPromptInput,
  blockHasOutput,
  createBlockAt,
  createDecorAt,
  createPromptCard,
  createSketchText,
  createStroke,
  displayVersion,
  duplicateCards,
  fitIntoPage,
  groupCards,
  moveCards,
  outputPlacement,
  placeIntoPage,
  reassignRefPages,
  regionOf,
  removeCards,
  renderOrder,
  reorderCards,
  reorderPageStackables,
  resizeBlock,
  scaleCards,
  strokeWorldPoints,
  ungroupCards,
  updatePrompt,
  withPageChildren,
  type DocState,
} from '../document/operations';
import { Selection } from '../document/Selection';
import { expandRect, intersects, rectFromPoints, unionRects, type Rect } from './geometry';
import { PerfMonitor } from './PerfMonitor';
import { PromptNode, type PromptJobView } from './PromptNode';
import { applyMarqueeSelection, marqueeMode, selectionAdditive, type MarqueeMode } from './selectionModifiers';
import { snapPoint, snapRectMove, snapThresholdCanvas, type SnapGuide } from './snap';
import { ThemeNode } from './ThemeNode';
import { TextureManager, type TextureStats } from './TextureManager';
import { clamp, MAX_ZOOM, MIN_ZOOM, Viewport } from './Viewport';

/** block：区块；decor：页面装饰；pen / text / eraser：布局草图 */
export type Tool = 'select' | 'hand' | 'block' | 'decor' | 'pen' | 'text' | 'eraser';
export type PenWidth = 'thin' | 'thick';
/** 画笔粗细（画布单位）；页面框宽 480 时细线约 1 个像素宽的笔触 */
const PEN_WIDTHS: Record<PenWidth, number> = { thin: 2, thick: 5 };
const SKETCH_INK = 0x1d1d24;
/** 画笔采样：屏幕上移动不到这么多像素的点丢掉 */
const PEN_SAMPLE_PX = 1.5;
/** 橡皮的命中半径（屏幕像素），再加上笔迹线宽的一半 */
const ERASER_RADIUS_PX = 6;

export interface EngineStatus {
  tool: Tool;
  penWidth: PenWidth;
  zoom: number;
  itemCount: number;
  selectionCount: number;
  focusRegion: RegionId | null;
  perf: FrameSummary | null;
  idle: boolean;
  textures: TextureStats;
  refreshRateHz: number;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

type Interaction =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | {
      kind: 'drag';
      startScreenX: number;
      startScreenY: number;
      startWorldX: number;
      startWorldY: number;
      origins: Map<string, CanvasCard>;
      moved: boolean;
      toggleOnClickId: string | null;
      /** 拖着图像卡经过的页面框：松手就放进去变成引用 */
      dropPageId: string | null;
    }
  | {
      kind: 'marquee';
      startWorldX: number;
      startWorldY: number;
      base: Set<string>;
      mode: MarqueeMode;
      rect: Rect;
    }
  | {
      kind: 'resize';
      corner: Corner;
      anchorX: number;
      anchorY: number;
      cornerX: number;
      cornerY: number;
      origins: Map<string, CanvasCard>;
    }
  | { kind: 'link'; promptId: string; fromX: number; fromY: number; x: number; y: number; targetId: string | null }
  | { kind: 'drawBlock'; pageId: string; startWorldX: number; startWorldY: number; rect: Rect }
  | { kind: 'drawDecor'; pageId: string; startWorldX: number; startWorldY: number; rect: Rect }
  | { kind: 'drawStroke'; pageId: string; points: number[]; lastScreenX: number; lastScreenY: number }
  | { kind: 'erase'; removed: number };

interface ViewAnimation {
  from: { centerX: number; centerY: number; logZoom: number };
  to: { centerX: number; centerY: number; logZoom: number };
  startedAt: number;
  duration: number;
}

export interface AttachOptions {
  /** ue-asset:// 的主机名：项目用 project，性能测试用 bench */
  assetHost: string;
  /** 原图已经不在的版本 */
  missingVersionIds?: ReadonlySet<string>;
  viewport?: ViewportState | null;
}

const BACKGROUND = 0x111114;
const PLACEHOLDER_TINT = 0x26262c;
const MISSING_TINT = 0x4a2028;
const MISSING_OUTLINE = 0xff6b7a;
const ACCENT = 0x7c8cff;
const OUTPUT_LINK = 0x5ad19a;
const BLOCK_COLOR = 0xffb547;
const DECOR_PREVIEW = 0x7c8cff;
const GUIDE_COLOR = 0xff4d6a;
/** 拖出的框太小（多半是误点）就不建区块，画布单位 */
const MIN_DRAWN_BLOCK = 6;
const REGION_FILL = 0x17171c;
const REGION_STROKE = 0x2a2a33;
const FOCUS_DIM_ALPHA = 0.16;
const HANDLE_SIZE = 8;
const HANDLE_HIT = 7;
const PORT_RADIUS = 6;
const PORT_HIT = 9;
const SLOT_SPACING = 22;
const SLOT_TOP = 44;
/** 提示词卡在屏幕上小于这个高度时不画端口 */
const MIN_PORT_CARD_PX = 70;
const NUDGE_SMALL = 1;
const NUDGE_LARGE = 10;
const SCHEDULE_INTERVAL_MS = 100;
const STATUS_INTERVAL_MS = 250;
const TEXT_RESOLUTION_SETTLE_MS = 150;
const DRAG_THRESHOLD_PX = 3;
const DOUBLE_CLICK_MS = 350;
/** 屏幕上的像素尺寸超过级别上限的 15% 才升级，避免在临界点来回切换 */
const LEVEL_HYSTERESIS = 1.15;

const BENCH_CELL = 440;
const BENCH_ITEM_MAX = 400;
const BENCH_COLUMNS = 20;

export class CanvasEngine {
  readonly viewport = new Viewport();
  readonly perf = new PerfMonitor();
  readonly textures = new TextureManager({
    upload: (texture) => this.app.renderer.texture.initSource(texture.source),
  });

  private readonly app = new Application();
  private readonly regionLayer = new Graphics();
  private readonly linkLayer = new Graphics();
  private readonly world = new Container();
  private readonly overlay = new Graphics();
  private readonly labels = new Container();
  private grid: TilingSprite | null = null;
  private host: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private doc: DocumentStore = new DocumentStore({ cards: [], regions: defaultRegions(), activeThemeCardId: null });
  private selection = new Selection();
  private assetHost = BENCH_HOST;
  private missingVersionIds: ReadonlySet<string> = new Set();
  private detachDoc: (() => void) | null = null;

  /** 已经同步到 Pixi 的卡片快照，用于和新快照对比，只更新变化的部分 */
  private rendered = new Map<string, CanvasCard>();
  private readonly nodes = new Map<string, Container>();
  private readonly promptNodes = new Map<string, PromptNode>();
  private readonly themeNodes = new Map<string, ThemeNode>();
  private renderedActiveTheme: string | null = null;
  private readonly keyToCards = new Map<string, Set<string>>();
  /** 每张带图卡片当前绑定的纹理（版本 id）：图像卡、引用、有低保真原型的页面框 */
  private readonly boundKeys = new Map<string, string>();
  /** 放精灵的容器：图像卡和引用就是节点本身，页面框是背景上面那一层 */
  private readonly spriteLayers = new Map<string, Container>();
  private readonly pageBackgrounds = new Map<string, Graphics>();
  private readonly pageLabels = new Map<string, Text>();
  private readonly blockLabels = new Map<string, Text>();
  /** 草图笔迹画在 Graphics 上，草图文字是 Text */
  private readonly strokeGraphics = new Map<string, Graphics>();
  private readonly sketchTexts = new Map<string, Text>();
  private renderedSequence: CanvasCard[] = [];
  private regionLabels = new Map<RegionId, Text>();
  private readonly slotLabels: Text[] = [];
  private jobViews: ReadonlyMap<string, PromptJobView> = new Map();
  private lastJobTick = 0;

  private tool: Tool = 'select';
  private snapGuides: SnapGuide[] = [];
  private readonly decorGraphics = new Map<string, Graphics>();
  private penWidth: PenWidth = 'thin';
  private spaceHeld = false;
  private interaction: Interaction = { kind: 'none' };
  private hoverId: string | null = null;
  private hoverCorner: Corner | null = null;
  private hoverPortId: string | null = null;
  private lastClick: { id: string; at: number } | null = null;
  private animation: ViewAnimation | null = null;
  private focusRegion: RegionId | null = null;

  private needsRender = true;
  private renderedPreviousTick = false;
  private viewChanged = true;
  private overlayDirty = true;
  private lastViewChangeAt = 0;
  private textResolution = 0;
  private rafId = 0;
  private lastScheduleAt = 0;
  private lastStatusAt = 0;
  private refreshRateHz = 0;
  private readonly frameHooks = new Set<(now: number) => void>();
  private readonly statusListeners = new Set<(status: EngineStatus) => void>();
  private readonly viewportListeners = new Set<(viewport: ViewportState) => void>();
  private readonly editListeners = new Set<(cardId: string) => void>();
  private readonly cleanups: (() => void)[] = [];
  private destroyed = false;

  static async create(host: HTMLElement): Promise<CanvasEngine> {
    const engine = new CanvasEngine();
    await engine.init(host);
    return engine;
  }

  private async init(host: HTMLElement): Promise<void> {
    this.host = host;
    const { width, height } = host.getBoundingClientRect();
    await this.app.init({
      width: Math.max(1, width),
      height: Math.max(1, height),
      background: BACKGROUND,
      antialias: false,
      resolution: window.devicePixelRatio,
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
      preference: 'webgl',
      powerPreference: 'high-performance',
      // 纹理的生命周期由 TextureManager 管理；Pixi 自带的回收会把视口外的纹理卸掉，滑回来时重新上传造成卡顿
      gcActive: false,
    });
    if (this.destroyed) return;

    const canvas = this.app.canvas;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    this.grid = new TilingSprite({ texture: createDotTexture(), width, height });
    this.grid.alpha = 0.55;
    this.app.stage.addChild(this.grid, this.regionLayer, this.linkLayer, this.world, this.overlay, this.labels);
    this.viewport.resize(width, height);

    this.bindEvents(canvas);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(host);

    this.warmUpShaders();
    this.attach(this.doc, this.selection, { assetHost: BENCH_HOST });
    void this.measureRefreshRate();
    this.rafId = requestAnimationFrame(this.loop);
  }

  // ───────────────────────── 文档 ─────────────────────────

  /** 换一份文档来显示（打开项目、进入性能测试） */
  setMissingVersionIds(ids: ReadonlySet<string>): void {
    this.missingVersionIds = ids;
    this.syncFromDoc(this.doc.get(), true);
  }

  attach(doc: DocumentStore, selection: Selection, options: AttachOptions): void {
    this.detachDoc?.();
    for (const id of [...this.nodes.keys()]) this.removeNode(id);
    this.rendered.clear();
    this.renderedSequence = [];
    this.interaction = { kind: 'none' };
    this.focusRegion = null;
    this.jobViews = new Map();

    this.doc = doc;
    this.selection = selection;
    this.assetHost = options.assetHost;
    this.missingVersionIds = options.missingVersionIds ?? new Set();

    const unsubscribeDoc = doc.subscribe((state, change) => this.onDocChange(state, change));
    const unsubscribeSelection = selection.subscribe(() => {
      this.overlayDirty = true;
      this.emitStatus();
    });
    this.detachDoc = () => {
      unsubscribeDoc();
      unsubscribeSelection();
    };

    this.syncFromDoc(doc.get(), true);
    this.drawRegions();
    if (options.viewport) {
      this.viewport.zoom = clamp(options.viewport.zoom, MIN_ZOOM, MAX_ZOOM);
      this.viewport.originX = options.viewport.originX;
      this.viewport.originY = options.viewport.originY;
      this.viewChanged = true;
    } else {
      this.fitAll(false);
    }
    this.emitStatus();
  }

  getDoc(): DocumentStore {
    return this.doc;
  }

  getSelection(): Selection {
    return this.selection;
  }

  /** 生成任务的状态，按提示词卡 id 索引 */
  setJobViews(views: ReadonlyMap<string, PromptJobView>): void {
    this.jobViews = views;
    for (const id of this.promptNodes.keys()) this.refreshPromptNode(id);
    this.overlayDirty = true;
    this.needsRender = true;
  }

  /** 这张卡片当前显示的纹理（版本 id），验收用 */
  boundKeyFor(cardId: string): string | null {
    return this.boundKeys.get(cardId) ?? null;
  }

  /** 缓存在后台重建好了，失败过的纹理重新加载 */
  retryTexture(versionId: string): void {
    this.textures.retry(versionId);
    for (const id of this.keyToCards.get(versionId) ?? []) this.refreshNodeTexture(id);
    this.needsRender = true;
  }

  /** 图缺失：图像卡的原图不在、引用指向的图像卡不在或它的原图不在、页面框的低保真原型不在 */
  isMissing(card: CanvasCard): boolean {
    if (isRefCard(card) && !this.rendered.has(card.imageCardId)) return true;
    const key = this.boundKeys.get(card.id);
    if (!key) return false;
    return this.missingVersionIds.has(key) || (this.textures.isFailed(key) && !this.textures.bestTiles(key));
  }

  /** 性能测试：按网格摆放测试图，返回全部 L0 纹理上屏的耗时 */
  loadBench(images: BenchImage[]): Promise<number> {
    const cards: ImageCard[] = images.map((image, index) => {
      const scale = BENCH_ITEM_MAX / Math.max(image.width, image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      const column = index % BENCH_COLUMNS;
      const row = Math.floor(index / BENCH_COLUMNS);
      return {
        kind: 'image',
        id: image.key,
        name: image.key,
        width,
        height,
        x: column * BENCH_CELL + (BENCH_ITEM_MAX - width) / 2,
        y: row * BENCH_CELL + (BENCH_ITEM_MAX - height) / 2,
        versions: [{ id: image.key, file: '', width: image.width, height: image.height, createdAt: '', origin: 'import' }],
        currentVersionId: image.key,
        groupId: null,
      };
    });
    const bounds = unionRects(cards) ?? { x: 0, y: 0, width: 1, height: 1 };
    const region = { id: 'assets' as const, name: '性能测试', ...expandRect(bounds, 0.02) };
    this.attach(new DocumentStore({ cards, regions: [region], activeThemeCardId: null }), new Selection(), { assetHost: BENCH_HOST });
    return this.whenAllL0Settled();
  }

  whenAllL0Settled(): Promise<number> {
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.textures.isAllL0Settled()) {
          this.frameHooks.delete(check);
          resolve(Math.round(performance.now() - startedAt));
        }
      };
      this.frameHooks.add(check);
    });
  }

  // ───────────────────────── 编辑命令 ─────────────────────────

  deleteSelection(): void {
    if (this.selection.size === 0) return;
    const ids = new Set(this.selection.get());
    this.doc.apply('删除', removeCards(this.doc.get(), ids));
    this.selection.set([]);
  }

  duplicateSelection(): void {
    if (this.selection.size === 0) return;
    const { state, newIds } = duplicateCards(this.doc.get(), this.selection.get(), () => crypto.randomUUID());
    this.doc.apply('创建副本', state);
    this.selection.set(newIds);
  }

  reorderSelection(to: 'front' | 'back'): void {
    if (this.selection.size === 0) return;
    const ids = this.selection.get();
    const stacked = reorderPageStackables(this.doc.get(), ids, to);
    this.doc.apply(
      to === 'front' ? '移到最前' : '移到最后',
      stacked ?? reorderCards(this.doc.get(), ids, to),
    );
  }

  nudgeSelection(dx: number, dy: number): void {
    if (this.selection.size === 0) return;
    this.doc.apply('微调位置', moveCards(this.doc.get(), this.selectedOrigins(true), dx, dy));
  }

  selectAll(): void {
    this.selection.set(this.doc.get().cards.map((card) => card.id));
  }

  /** 用选中的图像卡新建一张提示词卡（没选图时放在视口中心），并请求开始编辑 */
  createPromptFromSelection(): PromptCard {
    const imageIds = this.selectedCards().filter(isImageCard).map((card) => card.id);
    const { state, card } = createPromptCard(this.doc.get(), imageIds, this.viewCenterWorld(), () => crypto.randomUUID());
    this.doc.apply('新建提示词卡', state);
    this.selection.set([card.id]);
    for (const listener of this.editListeners) listener(card.id);
    return card;
  }

  /** 从全局模板新建提示词卡；若当前选中了图像卡则自动绑定 */
  createPromptFromTemplate(template: PromptTemplate): PromptCard {
    const imageIds = this.selectedCards().filter(isImageCard).map((card) => card.id);
    const { state: created, card } = createPromptCard(this.doc.get(), imageIds, this.viewCenterWorld(), () => crypto.randomUUID());
    const state = updatePrompt(created, card.id, {
      name: template.name,
      text: template.text,
      settings: template.defaultSettings,
    });
    this.doc.apply('从模板新建提示词卡', state);
    this.selection.set([card.id]);
    for (const listener of this.editListeners) listener(card.id);
    return card;
  }

  groupSelection(): void {
    const result = groupCards(this.doc.get(), new Set(this.selection.get()), () => crypto.randomUUID());
    if (!result) return;
    this.doc.apply('编组', result.state);
    this.selection.set([result.groupId]);
  }

  ungroupSelection(): void {
    const state = this.doc.get();
    const groupIds = new Set<string>();
    for (const id of this.selection.get()) {
      const card = state.cards.find((item) => item.id === id);
      if (!card) continue;
      if (isGroupCard(card)) groupIds.add(card.id);
      else {
        const gid = cardGroupId(card);
        if (gid) groupIds.add(gid);
      }
    }
    const next = ungroupCards(state, groupIds);
    if (next === state) return;
    this.doc.apply('解组', next);
  }

  /** 双击提示词卡、或新建提示词卡后通知面板开始编辑 */
  onEditRequest(listener: (cardId: string) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  // ───────────────────────── 视口 ─────────────────────────

  setTool(tool: Tool): void {
    this.tool = tool;
    if (this.interaction.kind === 'drawBlock' || this.interaction.kind === 'drawDecor' || this.interaction.kind === 'drawStroke') {
      this.interaction = { kind: 'none' };
      this.overlayDirty = true;
    }
    this.updateCursor();
    this.emitStatus();
  }

  setPenWidth(width: PenWidth): void {
    this.penWidth = width;
    this.emitStatus();
  }

  fitAll(animate = true): void {
    const state = this.doc.get();
    const bounds = unionRects([...state.regions, ...state.cards]);
    if (bounds) this.animateToRect(bounds, animate);
  }

  zoomToSelection(): void {
    const bounds = unionRects(this.selectedCards());
    if (bounds) this.animateToRect(bounds, true);
  }

  zoomToCard(id: string): void {
    const card = this.doc.get().cards.find((c) => c.id === id);
    if (card) this.animateToRect(card, true, 0.6);
  }

  flyToRegion(id: RegionId): void {
    const region = this.doc.get().regions.find((r) => r.id === id);
    if (!region) return;
    if (this.focusRegion) this.setFocusRegion(id);
    this.animateToRect(region, true);
  }

  /** 只看某个区域：其他区域的内容变暗；传 null 恢复 */
  setFocusRegion(id: RegionId | null): void {
    this.focusRegion = id;
    this.applyFocus();
    this.drawRegions();
    this.needsRender = true;
    this.emitStatus();
  }

  /** 当前视口中心所在的区域；不在任何区域里时返回最近的 */
  regionAtViewCenter(): RegionId | null {
    const center = this.viewCenterWorld();
    let best: { id: RegionId; distance: number } | null = null;
    for (const region of this.doc.get().regions) {
      const dx = Math.max(region.x - center.x, 0, center.x - (region.x + region.width));
      const dy = Math.max(region.y - center.y, 0, center.y - (region.y + region.height));
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { id: region.id, distance };
    }
    return best?.id ?? null;
  }

  getFocusRegion(): RegionId | null {
    return this.focusRegion;
  }

  zoomBy(factor: number): void {
    const center = this.viewCenterWorld();
    this.animateTo(center.x, center.y, clamp(this.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM));
  }

  setZoom(zoom: number): void {
    const center = this.viewCenterWorld();
    this.animateTo(center.x, center.y, zoom);
  }

  viewCenterWorld(): { x: number; y: number } {
    return this.viewport.screenToWorld(this.viewport.screenWidth / 2, this.viewport.screenHeight / 2);
  }

  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.app.canvas.getBoundingClientRect();
    return this.viewport.screenToWorld(clientX - bounds.left, clientY - bounds.top);
  }

  /** 视口被外部直接修改后调用（性能测试脚本使用） */
  invalidateView(): void {
    this.animation = null;
    this.viewChanged = true;
  }

  addFrameHook(hook: (now: number) => void): () => void {
    this.frameHooks.add(hook);
    return () => this.frameHooks.delete(hook);
  }

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status());
    return () => this.statusListeners.delete(listener);
  }

  /** 视口每次变化都会通知，调用方自己决定多久保存一次 */
  onViewportChange(listener: (viewport: ViewportState) => void): () => void {
    this.viewportListeners.add(listener);
    return () => this.viewportListeners.delete(listener);
  }

  getRefreshRateHz(): number {
    return this.refreshRateHz;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.detachDoc?.();
    for (const cleanup of this.cleanups) cleanup();
    this.frameHooks.clear();
    this.statusListeners.clear();
    this.viewportListeners.clear();
    this.editListeners.clear();
    this.textures.destroy();
    if (this.app.renderer) this.app.destroy({ removeView: true }, { children: true });
  }

  // ───────────────────────── 帧循环 ─────────────────────────

  private readonly loop = (now: number): void => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const frameStart = performance.now();

    for (const hook of this.frameHooks) hook(now);
    this.stepAnimation(now);
    const hooksEnd = performance.now();

    if (this.viewChanged) {
      this.applyViewport();
      this.viewChanged = false;
      this.lastViewChangeAt = now;
      this.needsRender = true;
      this.overlayDirty = true;
      const snapshot = this.viewport.snapshot();
      for (const listener of this.viewportListeners) listener(snapshot);
    } else if (now - this.lastViewChangeAt > TEXT_RESOLUTION_SETTLE_MS) {
      this.updateTextResolution();
    }
    this.tickJobs(now);
    const viewEnd = performance.now();

    if (now - this.lastScheduleAt >= SCHEDULE_INTERVAL_MS) {
      this.lastScheduleAt = now;
      this.scheduleTextures(now);
    }

    const commitStart = performance.now();
    const changed = this.textures.commitDecoded();
    const evicted = this.textures.evict();
    const rewanted = this.textures.takeWantedChanges();
    for (const key of [...changed, ...evicted, ...rewanted]) {
      for (const id of this.keyToCards.get(key) ?? []) this.refreshNodeTexture(id);
    }
    if (changed.length > 0 || evicted.length > 0 || rewanted.length > 0) {
      this.needsRender = true;
      this.overlayDirty = true;
    }
    const commitMs = performance.now() - commitStart;

    if (this.overlayDirty) {
      this.drawOverlay(now);
      this.overlayDirty = false;
      this.needsRender = true;
    }

    const rendered = this.needsRender;
    if (rendered) {
      const renderStart = performance.now();
      this.app.render();
      this.needsRender = false;
      const frameEnd = performance.now();
      this.perf.recordFrame(frameStart, frameEnd - frameStart, this.renderedPreviousTick, {
        hooksMs: hooksEnd - frameStart,
        viewMs: viewEnd - hooksEnd,
        scheduleMs: commitStart - viewEnd,
        commitMs,
        renderMs: frameEnd - renderStart,
        commits: changed.length,
      });
    }
    this.renderedPreviousTick = rendered;

    if (now - this.lastStatusAt >= STATUS_INTERVAL_MS) {
      this.lastStatusAt = now;
      this.emitStatus();
    }
  };

  /** 有任务在跑时：提示词卡上的计时每秒刷新，脉动边框每帧刷新 */
  private tickJobs(now: number): void {
    let active = false;
    for (const view of this.jobViews.values()) if (view?.status === 'running' || view?.status === 'queued') active = true;
    if (!active) return;
    this.overlayDirty = true;
    if (now - this.lastJobTick >= 1000) {
      this.lastJobTick = now;
      for (const id of this.promptNodes.keys()) this.refreshPromptNode(id);
      this.needsRender = true;
    }
  }

  private applyViewport(): void {
    const { zoom, originX, originY } = this.viewport;
    this.world.scale.set(zoom);
    this.world.position.set(-originX * zoom, -originY * zoom);
    this.regionLayer.scale.set(zoom);
    this.regionLayer.position.set(-originX * zoom, -originY * zoom);
    this.updateGrid();
    this.updateCulling();
    this.positionRegionLabels();
  }

  /** 提示词卡的文字在缩放停下来后按新的缩放重新栅格化 */
  private updateTextResolution(): void {
    const resolution = clamp(window.devicePixelRatio * this.viewport.zoom, 0.5, 4);
    if (Math.abs(resolution - this.textResolution) < 0.05) return;
    this.textResolution = resolution;
    for (const node of this.promptNodes.values()) node.setTextResolution(resolution);
    for (const node of this.themeNodes.values()) node.setTextResolution(resolution);
    for (const text of this.sketchTexts.values()) text.resolution = resolution;
    this.needsRender = true;
  }

  private updateCulling(): void {
    const view = expandRect(this.viewport.visibleWorldRect(), 0.1);
    for (const card of this.doc.get().cards) {
      const node = this.nodes.get(card.id);
      if (node) node.visible = intersects(card, view) && !this.isHiddenSketch(card);
    }
  }

  private updateGrid(): void {
    if (!this.grid) return;
    const { zoom, originX, originY } = this.viewport;
    let worldSpacing = 32;
    while (worldSpacing * zoom < 14) worldSpacing *= 4;
    while (worldSpacing * zoom > 56) worldSpacing /= 4;
    this.grid.tileScale.set((worldSpacing * zoom) / DOT_TILE);
    this.grid.tilePosition.set(-originX * zoom, -originY * zoom);
  }

  private scheduleTextures(now: number): void {
    const view = this.viewport.visibleWorldRect();
    const preload = expandRect(view, 0.25);
    const centerX = view.x + view.width / 2;
    const centerY = view.y + view.height / 2;
    const pixelScale = this.viewport.zoom * this.app.renderer.resolution;

    // 同一个版本被多张卡片引用时，取需要最清晰的那张
    const wanted = new Map<string, { level: TextureLevel; priority: number }>();
    for (const card of this.doc.get().cards) {
      const key = this.boundKeys.get(card.id);
      if (!key) continue;
      const distance = Math.hypot(card.x + card.width / 2 - centerX, card.y + card.height / 2 - centerY);
      let level: TextureLevel = 0;
      let priority = 1e6 + distance;
      if (intersects(card, preload)) {
        const screenPx = Math.max(card.width, card.height) * pixelScale;
        level = screenPx > 1024 * LEVEL_HYSTERESIS ? 2 : screenPx > 256 * LEVEL_HYSTERESIS ? 1 : 0;
        priority = distance;
      }
      const previous = wanted.get(key);
      if (!previous || level > previous.level || (level === previous.level && priority < previous.priority)) {
        wanted.set(key, { level, priority });
      }
    }
    for (const [key, { level, priority }] of wanted) this.textures.setWanted(key, level, priority, now);
    this.textures.schedule();
  }

  // ───────────────────────── 场景同步 ─────────────────────────

  private onDocChange(state: DocState, change: DocChange): void {
    this.syncFromDoc(state, change === 'reset');
    if (change !== 'transient') {
      this.selection.prune(new Set(state.cards.map((card) => card.id)));
      this.drawRegions();
      this.emitStatus();
    }
  }

  /** 只更新和上一次快照相比变了的卡片；引用在它指向的图像卡换了当前版本时也要换纹理 */
  private syncFromDoc(state: DocState, full: boolean): void {
    const next = new Map(state.cards.map((card) => [card.id, card]));
    for (const id of [...this.rendered.keys()]) {
      const card = next.get(id);
      if (!card || card.kind !== this.rendered.get(id)!.kind) this.removeNode(id);
    }

    for (const card of state.cards) {
      const previous = this.rendered.get(card.id);
      const version = displayVersion(card, next);
      const keyChanged = (this.boundKeys.get(card.id) ?? null) !== (version?.id ?? null);
      if (!full && previous === card && !keyChanged) continue;

      if (isPromptCard(card)) this.syncPromptCard(card);
      else if (isThemeCard(card)) this.syncThemeCard(card);
      else if (isGroupCard(card)) this.ensureGroupNode(card);
      else if (isBlockCard(card)) this.ensureBlockNode(card);
      else if (isDecorCard(card)) this.syncDecorCard(card);
      else if (isSketchMark(card)) this.syncSketchMark(card);
      else this.ensureSpriteNode(card);
      if (keyChanged) this.rebindTexture(card.id, version);
      this.rendered.set(card.id, card);
      if (isPageCard(card)) this.drawPageBackground(card);
      if (isGroupCard(card)) this.drawGroupFrame(card);
      if (this.spriteLayers.has(card.id)) this.refreshNodeTexture(card.id);
      this.nodes.get(card.id)!.position.set(card.x, card.y);
    }

    const sequence = renderOrder(state.cards);
    if (full || !sameOrder(this.renderedSequence, sequence)) {
      this.world.removeChildren();
      for (const card of sequence) this.world.addChild(this.nodes.get(card.id)!);
    }
    this.renderedSequence = sequence;
    // 输入数量会影响提示词卡底部的说明；生效主题卡变了要更新标记
    for (const id of this.promptNodes.keys()) this.refreshPromptNode(id);
    if (full || this.renderedActiveTheme !== state.activeThemeCardId) {
      this.renderedActiveTheme = state.activeThemeCardId;
      for (const id of this.themeNodes.keys()) this.refreshThemeNode(id);
    }
    this.updateCulling();
    this.applyFocus();
    this.overlayDirty = true;
    this.needsRender = true;
  }

  /** 图像卡、引用：节点本身放精灵；页面框：背景 + 精灵层 */
  private ensureSpriteNode(card: CanvasCard): void {
    if (this.nodes.has(card.id)) return;
    if (isPageCard(card)) {
      const node = new Container();
      const background = new Graphics();
      const layer = new Container();
      node.addChild(background, layer);
      this.nodes.set(card.id, node);
      this.pageBackgrounds.set(card.id, background);
      this.spriteLayers.set(card.id, layer);
      return;
    }
    const node = new Container();
    this.nodes.set(card.id, node);
    this.spriteLayers.set(card.id, node);
  }

  /** 草图笔迹：按外接框把归一化的点画成圆头折线；草图文字：空内容时显示灰色占位 */
  private syncSketchMark(card: StrokeCard | SketchTextCard): void {
    if (isStrokeCard(card)) {
      let g = this.strokeGraphics.get(card.id);
      if (!g) {
        g = new Graphics();
        const node = new Container();
        node.addChild(g);
        this.nodes.set(card.id, node);
        this.strokeGraphics.set(card.id, g);
      }
      g.clear();
      const pts = card.points;
      g.moveTo(pts[0] * card.width, pts[1] * card.height);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] * card.width, pts[i + 1] * card.height);
      g.stroke({ color: SKETCH_INK, width: card.lineWidth, cap: 'round', join: 'round' });
      return;
    }
    let text = this.sketchTexts.get(card.id);
    if (!text) {
      text = new Text({ text: '', style: { fontFamily: 'PingFang SC, -apple-system, sans-serif', fill: SKETCH_INK } });
      if (this.textResolution > 0) text.resolution = this.textResolution;
      const node = new Container();
      node.addChild(text);
      this.nodes.set(card.id, node);
      this.sketchTexts.set(card.id, text);
    }
    text.text = card.text || '文字';
    text.style.fontSize = SKETCH_FONT_SIZES[card.fontSize];
    text.style.fill = card.text ? SKETCH_INK : 0x9a9aa8;
  }

  /** 页面框设了隐藏草图时，它的笔迹和文字不显示也点不到 */
  private isHiddenSketch(card: CanvasCard): boolean {
    if (!isSketchMark(card)) return false;
    const page = this.rendered.get(card.pageId);
    return !!page && isPageCard(page) && page.sketchHidden;
  }

  /** 区块的虚线框和标签画在覆盖层（线宽、字号不随缩放变）；世界里只留一个空节点参与排序和命中 */
  private ensureBlockNode(card: CanvasCard): void {
    if (this.nodes.has(card.id)) return;
    this.nodes.set(card.id, new Container());
  }

  /** 页面装饰：圆角填充矩形 */
  private syncDecorCard(card: DecorCard): void {
    let g = this.decorGraphics.get(card.id);
    if (!g) {
      g = new Graphics();
      const node = new Container();
      node.addChild(g);
      this.nodes.set(card.id, node);
      this.decorGraphics.set(card.id, g);
    }
    g.clear();
    const page = this.rendered.get(card.pageId) ?? this.doc.get().cards.find((c) => c.id === card.pageId);
    const logical = page && isPageCard(page) ? pageLogicalSize(page) : { width: card.width, height: card.height };
    const pageW = page && isPageCard(page) ? page.width : card.width;
    const radius = Math.min((card.cornerRadius / logical.width) * pageW, card.width / 2, card.height / 2);
    const color = parseInt((normalizeHex(card.fill) ?? '#E8E8ED').slice(1), 16);
    g.roundRect(0, 0, card.width, card.height, Math.max(0, radius)).fill({ color });
  }

  private ensureGroupNode(card: CanvasCard): void {
    if (this.nodes.has(card.id)) return;
    const node = new Container();
    const frame = new Graphics();
    node.addChild(frame);
    this.nodes.set(card.id, node);
    this.pageBackgrounds.set(card.id, frame);
  }

  private drawGroupFrame(card: CanvasCard): void {
    if (!isGroupCard(card)) return;
    const g = this.pageBackgrounds.get(card.id);
    if (!g) return;
    g.clear();
    g.roundRect(0, 0, card.width, card.height, 8).stroke({ width: 2, color: 0x6b7cff, alpha: 0.85 });
    g.roundRect(0, 0, card.width, card.height, 8).fill({ color: 0x6b7cff, alpha: 0.06 });
  }

  private drawPageBackground(page: PageCard): void {
    const g = this.pageBackgrounds.get(page.id);
    if (!g) return;
    g.clear();
    g.rect(0, 0, page.width, page.height).fill({ color: page.background });
  }

  private syncPromptCard(card: PromptCard): void {
    let node = this.promptNodes.get(card.id);
    if (!node) {
      node = new PromptNode();
      if (this.textResolution > 0) node.setTextResolution(this.textResolution);
      this.promptNodes.set(card.id, node);
      this.nodes.set(card.id, node.container);
    }
    this.rendered.set(card.id, card);
  }

  private syncThemeCard(card: ThemeCard): void {
    let node = this.themeNodes.get(card.id);
    if (!node) {
      node = new ThemeNode();
      if (this.textResolution > 0) node.setTextResolution(this.textResolution);
      this.themeNodes.set(card.id, node);
      this.nodes.set(card.id, node.container);
    }
    this.rendered.set(card.id, card);
    this.refreshThemeNode(card.id);
  }

  private refreshThemeNode(id: string): void {
    const card = this.rendered.get(id);
    const node = this.themeNodes.get(id);
    if (!card || !node || !isThemeCard(card)) return;
    node.update(card, this.doc.get().activeThemeCardId === id);
  }

  private refreshPromptNode(id: string): void {
    const card = this.rendered.get(id);
    const node = this.promptNodes.get(id);
    if (!card || !node || !isPromptCard(card)) return;
    const inputCount = card.inputs.filter((inputId) => this.rendered.has(inputId)).length;
    node.update(card, inputCount, this.jobViews.get(id) ?? null, performance.now());
  }

  private rebindTexture(cardId: string, version: Version | null): void {
    const previous = this.boundKeys.get(cardId);
    if (previous) {
      this.textures.unregister(previous);
      const ids = this.keyToCards.get(previous);
      ids?.delete(cardId);
      if (ids?.size === 0) this.keyToCards.delete(previous);
      this.boundKeys.delete(cardId);
    }
    if (!version) return;
    this.textures.register(texturedImage(this.assetHost, version.id, version.width, version.height));
    this.boundKeys.set(cardId, version.id);
    let ids = this.keyToCards.get(version.id);
    if (!ids) {
      ids = new Set();
      this.keyToCards.set(version.id, ids);
    }
    ids.add(cardId);
  }

  /** 精灵层里放一个精灵（L0 / L1 / 占位）或多块 L2 tile 精灵，精灵按需复用 */
  private refreshNodeTexture(id: string): void {
    const card = this.rendered.get(id);
    const layer = this.spriteLayers.get(id);
    if (!card || !layer) return;
    const key = this.boundKeys.get(id);
    const tileSet = key ? this.textures.bestTiles(key) : null;
    // 没有低保真原型的页面框只有背景
    const count = tileSet ? tileSet.tiles.length : isPageCard(card) && !key ? 0 : 1;

    while (layer.children.length > count) layer.removeChildAt(layer.children.length - 1).destroy();
    while (layer.children.length < count) layer.addChild(new Sprite(Texture.WHITE));
    if (count === 0) return;

    if (!tileSet) {
      const sprite = layer.children[0] as Sprite;
      sprite.texture = Texture.WHITE;
      sprite.tint = this.isMissing(card) ? MISSING_TINT : PLACEHOLDER_TINT;
      sprite.position.set(0, 0);
      sprite.setSize(card.width, card.height);
      return;
    }
    const scaleX = card.width / tileSet.imageWidth;
    const scaleY = card.height / tileSet.imageHeight;
    tileSet.tiles.forEach((tile, index) => {
      const sprite = layer.children[index] as Sprite;
      sprite.texture = tile.texture;
      sprite.tint = 0xffffff;
      sprite.position.set(tile.x * scaleX, tile.y * scaleY);
      sprite.setSize(tile.width * scaleX, tile.height * scaleY);
    });
  }

  private removeNode(id: string): void {
    this.rebindTexture(id, null);
    const prompt = this.promptNodes.get(id);
    const theme = this.themeNodes.get(id);
    if (prompt) {
      prompt.destroy();
      this.promptNodes.delete(id);
    } else if (theme) {
      theme.destroy();
      this.themeNodes.delete(id);
    } else {
      this.nodes.get(id)?.destroy({ children: true });
    }
    this.pageLabels.get(id)?.destroy();
    this.pageLabels.delete(id);
    this.blockLabels.get(id)?.destroy();
    this.blockLabels.delete(id);
    this.strokeGraphics.delete(id);
    this.decorGraphics.delete(id);
    this.sketchTexts.delete(id);
    this.spriteLayers.delete(id);
    this.pageBackgrounds.delete(id);
    this.nodes.delete(id);
    this.rendered.delete(id);
  }

  private applyFocus(): void {
    const state = this.doc.get();
    for (const card of state.cards) {
      const node = this.nodes.get(card.id);
      if (!node) continue;
      node.alpha = this.focusRegion && regionOf(state, card) !== this.focusRegion ? FOCUS_DIM_ALPHA : 1;
    }
  }

  private drawRegions(): void {
    const g = this.regionLayer;
    g.clear();
    const regions = this.doc.get().regions;
    for (const region of regions) {
      const dim = this.focusRegion !== null && region.id !== this.focusRegion;
      g.rect(region.x, region.y, region.width, region.height)
        .fill({ color: REGION_FILL, alpha: dim ? 0.35 : 1 })
        .stroke({ color: REGION_STROKE, width: 1, pixelLine: true, alpha: dim ? 0.4 : 1 });
    }

    const alive = new Set(regions.map((r) => r.id));
    for (const [id, label] of this.regionLabels) {
      if (!alive.has(id)) {
        label.destroy();
        this.regionLabels.delete(id);
      }
    }
    for (const region of regions) {
      let label = this.regionLabels.get(region.id);
      if (!label) {
        label = new Text({
          text: region.name,
          style: { fontFamily: 'PingFang SC, -apple-system, sans-serif', fontSize: 13, fontWeight: '600', fill: 0x9a9aa8 },
          resolution: window.devicePixelRatio * 2,
        });
        this.labels.addChild(label);
        this.regionLabels.set(region.id, label);
      }
      label.text = region.name;
      label.alpha = this.focusRegion !== null && region.id !== this.focusRegion ? 0.35 : 1;
    }
    this.positionRegionLabels();
    this.needsRender = true;
  }

  /** 区域名称贴在区域左上角外侧，字号不随缩放变化 */
  private positionRegionLabels(): void {
    for (const region of this.doc.get().regions) {
      const label = this.regionLabels.get(region.id);
      if (!label) continue;
      const corner = this.viewport.worldToScreen(region.x, region.y);
      label.position.set(Math.round(corner.x), Math.round(corner.y - label.height - 6));
    }
  }

  // ───────────────────────── 覆盖层：选框、连线、端口、任务 ─────────────────────────

  private drawOverlay(now: number): void {
    const g = this.overlay;
    g.clear();
    const state = this.doc.get();
    const selection = this.selection.get();
    const view = this.viewport.visibleWorldRect();

    this.drawLinks(state);

    for (const card of state.cards) {
      if ((isImageCard(card) || isRefCard(card) || isPageCard(card)) && intersects(card, view) && this.isMissing(card)) {
        this.strokeWorldRect(g, card, 1, 0.9, MISSING_OUTLINE);
      }
    }
    this.drawPageFrames(g, state);
    this.drawBlocks(g, state, view);
    this.drawJobs(g, state, now);

    if (this.hoverId && !selection.has(this.hoverId) && this.interaction.kind === 'none') {
      const card = this.rendered.get(this.hoverId);
      if (card) this.strokeWorldRect(g, card, 1, 0.7);
    }
    const selected = this.selectedCards();
    for (const card of selected) this.strokeWorldRect(g, card, 1.5, 1);

    const bounds = unionRects(selected);
    if (bounds && this.interaction.kind !== 'marquee' && this.interaction.kind !== 'link') {
      if (selected.length > 1) this.strokeWorldRect(g, bounds, 1, 0.5);
      for (const corner of this.cornerPoints(bounds)) {
        g.rect(corner.x - HANDLE_SIZE / 2, corner.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
          .fill({ color: 0xffffff })
          .stroke({ color: ACCENT, width: 1.5 });
      }
    }
    this.drawPorts(g, state);

    if (this.interaction.kind === 'marquee') {
      const { rect } = this.interaction;
      const a = this.viewport.worldToScreen(rect.x, rect.y);
      g.rect(a.x, a.y, rect.width * this.viewport.zoom, rect.height * this.viewport.zoom)
        .fill({ color: ACCENT, alpha: 0.1 })
        .stroke({ color: ACCENT, width: 1, alpha: 0.9 });
    }
    if (this.interaction.kind === 'drawStroke') {
      const pts = this.interaction.points;
      const first = this.viewport.worldToScreen(pts[0], pts[1]);
      g.moveTo(first.x, first.y);
      for (let i = 2; i < pts.length; i += 2) {
        const p = this.viewport.worldToScreen(pts[i], pts[i + 1]);
        g.lineTo(p.x, p.y);
      }
      g.stroke({ color: SKETCH_INK, width: PEN_WIDTHS[this.penWidth] * this.viewport.zoom, cap: 'round', join: 'round' });
    }
    if (this.interaction.kind === 'drawBlock' || this.interaction.kind === 'drawDecor') {
      const { rect } = this.interaction;
      const a = this.viewport.worldToScreen(rect.x, rect.y);
      const w = rect.width * this.viewport.zoom;
      const h = rect.height * this.viewport.zoom;
      const color = this.interaction.kind === 'drawBlock' ? BLOCK_COLOR : DECOR_PREVIEW;
      g.rect(a.x, a.y, w, h).fill({ color, alpha: 0.12 });
      dashedRect(g, a.x, a.y, w, h);
      g.stroke({ color, width: 1.5, alpha: 0.95 });
    }
    for (const guide of this.snapGuides) {
      if (guide.orientation === 'v') {
        const a = this.viewport.worldToScreen(guide.position, guide.from);
        const b = this.viewport.worldToScreen(guide.position, guide.to);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      } else {
        const a = this.viewport.worldToScreen(guide.from, guide.position);
        const b = this.viewport.worldToScreen(guide.to, guide.position);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ color: GUIDE_COLOR, width: 1.5, alpha: 1, pixelLine: true });
    }
    if (this.interaction.kind === 'link') {
      const { fromX, fromY, x, y, targetId } = this.interaction;
      const target = targetId ? this.rendered.get(targetId) : undefined;
      if (target) this.strokeWorldRect(g, target, 2, 1);
      const end = target ? this.viewport.worldToScreen(target.x + target.width, target.y + target.height / 2) : { x, y };
      curve(g, end.x, end.y, fromX, fromY);
      g.stroke({ color: ACCENT, width: 2, alpha: 0.9 });
    }
  }

  /** 页面框的细边框和名字标签（字号不随缩放变化）；拖着图像卡经过时高亮目标页面 */
  private drawPageFrames(g: Graphics, state: DocState): void {
    const dropPageId = this.interaction.kind === 'drag' ? this.interaction.dropPageId : null;
    const alive = new Set<string>();
    for (const card of state.cards) {
      if (!isPageCard(card)) continue;
      alive.add(card.id);
      const dropping = card.id === dropPageId;
      this.strokeWorldRect(g, card, dropping ? 3 : 1, dropping ? 1 : 0.35, dropping ? OUTPUT_LINK : 0xffffff);
      let label = this.pageLabels.get(card.id);
      if (!label) {
        label = new Text({
          text: '',
          style: { fontFamily: 'PingFang SC, -apple-system, sans-serif', fontSize: 12, fill: 0x9a9aa8 },
          resolution: window.devicePixelRatio * 2,
        });
        this.labels.addChild(label);
        this.pageLabels.set(card.id, label);
      }
      const logical = pageLogicalSize(card);
      label.text = `${card.name}  ${logical.width} × ${logical.height} @${card.exportScale}x${dropping ? '  · 松手放进页面' : ''}`;
      label.style.fill = dropping ? OUTPUT_LINK : 0x9a9aa8;
      const corner = this.viewport.worldToScreen(card.x, card.y);
      label.position.set(Math.round(corner.x), Math.round(corner.y - label.height - 4));
      label.visible = card.width * this.viewport.zoom > 60;
    }
    for (const [id, label] of this.pageLabels) {
      if (!alive.has(id)) {
        label.destroy();
        this.pageLabels.delete(id);
      }
    }
  }

  /**
   * 区块：虚线框 + 左上角标签（名字，截图过时时标红）。
   * 已经放好素材的区块框变淡、标签只在选中或悬停时显示，免得挡住画面。
   */
  private drawBlocks(g: Graphics, state: DocState, view: Rect): void {
    const byId = new Map(state.cards.map((card) => [card.id, card]));
    const alive = new Set<string>();
    for (const card of state.cards) {
      if (!isBlockCard(card)) continue;
      const page = byId.get(card.pageId);
      if (!page || !isPageCard(page) || !intersects(card, view)) continue;
      alive.add(card.id);
      const filled = blockHasOutput(state, card);
      const stale = isBlockCropStale(card, page);
      const focused = this.selection.has(card.id) || this.hoverId === card.id;
      const color = stale ? MISSING_OUTLINE : BLOCK_COLOR;
      const a = this.viewport.worldToScreen(card.x, card.y);
      const w = card.width * this.viewport.zoom;
      const h = card.height * this.viewport.zoom;
      if (!filled) g.rect(a.x, a.y, w, h).fill({ color, alpha: 0.08 });
      dashedRect(g, a.x, a.y, w, h);
      g.stroke({ color, width: 1.5, alpha: filled && !focused ? 0.35 : 0.95 });

      let label = this.blockLabels.get(card.id);
      if (!label) {
        label = new Text({
          text: '',
          style: { fontFamily: 'PingFang SC, -apple-system, sans-serif', fontSize: 11, fill: BLOCK_COLOR },
          resolution: window.devicePixelRatio * 2,
        });
        this.labels.addChild(label);
        this.blockLabels.set(card.id, label);
      }
      label.text = stale ? `${card.name} · 截图过时` : card.name;
      label.style.fill = color;
      label.position.set(Math.round(a.x + 3), Math.round(a.y + 2));
      // 小区块放不下名字时只在选中或悬停时显示，免得压到旁边的区块
      label.visible = focused ? h > 12 : !filled && h > 16 && label.width <= w - 4;
    }
    for (const [id, label] of this.blockLabels) {
      if (!alive.has(id)) {
        label.destroy();
        this.blockLabels.delete(id);
      }
    }
  }

  /** 拖动的是图像卡（不含页面框）时，指针下最上层的页面框就是放入目标 */
  private dropTargetFor(origins: ReadonlyMap<string, CanvasCard>, worldX: number, worldY: number): string | null {
    const cards = [...origins.values()];
    if (!cards.some(isImageCard) || cards.some(isPageCard)) return null;
    const page = this.hitTest(worldX, worldY, (card) => isPageCard(card) && !origins.has(card.id));
    return page?.id ?? null;
  }

  /** 页面里可参与对齐的对象：素材引用、区块、页面装饰 */
  private isPageSnapCard(card: CanvasCard): card is RefCard | BlockCard | DecorCard {
    return (isRefCard(card) || isBlockCard(card) || isDecorCard(card)) && !!card.pageId;
  }

  /** 同页引用 / 区块 / 装饰拖动时，吸附其它同页对象与页面框边缘/中心 */
  private computeDragSnap(
    origins: ReadonlyMap<string, CanvasCard>,
    dx: number,
    dy: number,
  ): { dx: number; dy: number; guides: SnapGuide[] } {
    // 拖着页面框一起动时不吸附，避免整页乱跳
    if ([...origins.values()].some(isPageCard)) return { dx: 0, dy: 0, guides: [] };
    const moving = [...origins.values()].filter((card) => this.isPageSnapCard(card));
    if (moving.length === 0) return { dx: 0, dy: 0, guides: [] };
    const pageId = moving[0].pageId!;
    if (!moving.every((card) => card.pageId === pageId)) return { dx: 0, dy: 0, guides: [] };
    const state = this.doc.get();
    const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
    if (!page) return { dx: 0, dy: 0, guides: [] };
    const movingIds = new Set(origins.keys());
    const siblings = state.cards
      .filter((card) => this.isPageSnapCard(card) && card.pageId === pageId && !movingIds.has(card.id))
      .map((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height }));
    const bounds = unionRects(moving.map((card) => ({ x: card.x + dx, y: card.y + dy, width: card.width, height: card.height })));
    if (!bounds) return { dx: 0, dy: 0, guides: [] };
    const logical = pageLogicalSize(page);
    const threshold = snapThresholdCanvas(page.width, logical.width, this.viewport.zoom);
    return snapRectMove(bounds, [page, ...siblings], threshold);
  }

  /** 拖画区块 / 装饰时：自由角吸附到同页对象与页面框 */
  private computeDrawSnap(pageId: string, worldX: number, worldY: number): { x: number; y: number; guides: SnapGuide[] } {
    const state = this.doc.get();
    const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
    if (!page) return { x: worldX, y: worldY, guides: [] };
    const targets = state.cards
      .filter((card) => this.isPageSnapCard(card) && card.pageId === pageId)
      .map((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height }));
    const logical = pageLogicalSize(page);
    const threshold = snapThresholdCanvas(page.width, logical.width, this.viewport.zoom);
    return snapPoint(worldX, worldY, [page, ...targets], threshold);
  }

  /**
   * 图像卡放进页面：原图回到原处，页面里多出指向它的引用（按页面大小缩放、以松手位置为中心）；
   * 一起拖动的引用直接移进这个页面。整体是一条撤销记录。
   */
  private dropIntoPage(origins: ReadonlyMap<string, CanvasCard>, pageId: string): void {
    const moved = this.doc.get();
    const page = moved.cards.find((card) => card.id === pageId);
    if (!page) {
      this.doc.commitGesture();
      return;
    }
    const items = [...origins.values()].filter(isImageCard).map((origin) => {
      const now = moved.cards.find((card) => card.id === origin.id) ?? origin;
      return { imageCardId: origin.id, rect: fitIntoPage(page, origin, now.x + now.width / 2, now.y + now.height / 2) };
    });
    const refPositions = new Map(
      [...origins.values()].filter(isRefCard).map((origin) => [origin.id, moved.cards.find((card) => card.id === origin.id) ?? origin]),
    );
    this.doc.cancelGesture();
    let next = this.doc.get();
    if (refPositions.size) {
      next = { ...next, cards: next.cards.map((card) => refPositions.get(card.id) ?? card) };
      next = reassignRefPages(next, new Set(refPositions.keys()));
    }
    const placed = placeIntoPage(next, pageId, items, () => crypto.randomUUID());
    this.doc.apply('放入页面', placed.state);
    this.selection.set([...placed.refIds, ...refPositions.keys()]);
  }

  /** 来源连线：输入图 → 提示词卡左侧各自的槽位，提示词卡右侧 → 输出图 */
  private drawLinks(state: DocState): void {
    const g = this.linkLayer;
    g.clear();
    const byId = new Map(state.cards.map((card) => [card.id, card]));
    let slotIndex = 0;
    for (const card of state.cards) {
      if (!isPromptCard(card)) continue;
      const showSlots = card.height * this.viewport.zoom >= MIN_PORT_CARD_PX;
      card.inputs.forEach((inputId, index) => {
        const input = byId.get(inputId);
        if (!input) return;
        const from = this.viewport.worldToScreen(input.x + input.width, input.y + input.height / 2);
        const to = this.slotPoint(card, index);
        curve(g, from.x, from.y, to.x, to.y);
        g.stroke({ color: ACCENT, width: 1.5, alpha: 0.6 });
        if (showSlots) this.placeSlotLabel(slotIndex++, index + 1, to.x, to.y);
      });
      const output = card.outputCardId ? byId.get(card.outputCardId) : undefined;
      if (output) {
        const from = this.viewport.worldToScreen(card.x + card.width, card.y + card.height / 2);
        const to = this.viewport.worldToScreen(output.x, output.y + output.height / 2);
        curve(g, from.x, from.y, to.x, to.y);
        g.stroke({ color: OUTPUT_LINK, width: 1.5, alpha: 0.7 });
      }
    }
    for (let i = slotIndex; i < this.slotLabels.length; i++) this.slotLabels[i].visible = false;
  }

  private placeSlotLabel(poolIndex: number, slot: number, x: number, y: number): void {
    let label = this.slotLabels[poolIndex];
    if (!label) {
      label = new Text({
        text: '',
        style: { fontFamily: '-apple-system, sans-serif', fontSize: 10, fontWeight: '700', fill: 0x0e0f1a },
        resolution: window.devicePixelRatio * 2,
      });
      label.anchor.set(0.5);
      this.labels.addChild(label);
      this.slotLabels[poolIndex] = label;
    }
    label.text = String(slot);
    label.position.set(x, y);
    label.visible = true;
  }

  /** 第 index 个输入在提示词卡左边缘的位置（屏幕坐标） */
  private slotPoint(card: PromptCard, index: number): { x: number; y: number } {
    const topLeft = this.viewport.worldToScreen(card.x, card.y);
    const heightPx = card.height * this.viewport.zoom;
    if (heightPx < MIN_PORT_CARD_PX) return { x: topLeft.x, y: topLeft.y + heightPx / 2 };
    return { x: topLeft.x, y: topLeft.y + Math.min(heightPx - 12, SLOT_TOP + index * SLOT_SPACING) };
  }

  /** "加输入"端口：在已有槽位的下面 */
  private addPortPoint(card: PromptCard): { x: number; y: number } | null {
    if (card.height * this.viewport.zoom < MIN_PORT_CARD_PX) return null;
    return this.slotPoint(card, card.inputs.length);
  }

  private drawPorts(g: Graphics, state: DocState): void {
    const selection = this.selection.get();
    for (const card of state.cards) {
      if (!isPromptCard(card)) continue;
      const slots = card.inputs.length;
      for (let i = 0; i < slots; i++) {
        const point = this.slotPoint(card, i);
        if (card.height * this.viewport.zoom >= MIN_PORT_CARD_PX) g.circle(point.x, point.y, PORT_RADIUS).fill({ color: ACCENT });
      }
      const showAdd = selection.has(card.id) || this.hoverId === card.id || this.hoverPortId === card.id;
      const add = this.addPortPoint(card);
      if (add && showAdd) {
        const hot = this.hoverPortId === card.id;
        g.circle(add.x, add.y, PORT_RADIUS)
          .fill({ color: hot ? ACCENT : 0x1c1e29 })
          .stroke({ color: ACCENT, width: 1.5 });
        g.moveTo(add.x - 3, add.y).lineTo(add.x + 3, add.y).moveTo(add.x, add.y - 3).lineTo(add.x, add.y + 3);
        g.stroke({ color: hot ? 0x0e0f1a : ACCENT, width: 1.5 });
      }
    }
  }

  /** 运行中的任务：提示词卡脉动描边；第一次生成时在输出位置画虚线占位 */
  private drawJobs(g: Graphics, state: DocState, now: number): void {
    const pulse = 0.45 + 0.45 * Math.sin(now / 260);
    for (const [promptId, view] of this.jobViews) {
      if (!view || view.status === 'failed') continue;
      const prompt = state.cards.find((card) => card.id === promptId);
      if (!prompt || !isPromptCard(prompt)) continue;
      this.strokeWorldRect(g, prompt, 2, pulse);
      const hasOutput = prompt.outputCardId && state.cards.some((card) => card.id === prompt.outputCardId);
      if (!hasOutput) {
        const ghost = outputPlacement(state, prompt, view.aspect);
        const a = this.viewport.worldToScreen(ghost.x, ghost.y);
        dashedRect(g, a.x, a.y, ghost.width * this.viewport.zoom, ghost.height * this.viewport.zoom);
        g.stroke({ color: ACCENT, width: 1.5, alpha: pulse });
      }
    }
  }

  private strokeWorldRect(g: Graphics, rect: Rect, width: number, alpha: number, color = ACCENT): void {
    const a = this.viewport.worldToScreen(rect.x, rect.y);
    g.rect(a.x, a.y, rect.width * this.viewport.zoom, rect.height * this.viewport.zoom).stroke({
      color,
      width,
      alpha,
      alignment: 1,
    });
  }

  /** 选中范围四个角在屏幕上的位置 */
  private cornerPoints(bounds: Rect): { corner: Corner; x: number; y: number }[] {
    const a = this.viewport.worldToScreen(bounds.x, bounds.y);
    const b = this.viewport.worldToScreen(bounds.x + bounds.width, bounds.y + bounds.height);
    return [
      { corner: 'nw', x: a.x, y: a.y },
      { corner: 'ne', x: b.x, y: a.y },
      { corner: 'sw', x: a.x, y: b.y },
      { corner: 'se', x: b.x, y: b.y },
    ];
  }

  private hitCorner(screenX: number, screenY: number): Corner | null {
    const bounds = unionRects(this.selectedCards());
    if (!bounds) return null;
    for (const point of this.cornerPoints(bounds)) {
      if (Math.abs(point.x - screenX) <= HANDLE_HIT && Math.abs(point.y - screenY) <= HANDLE_HIT) return point.corner;
    }
    return null;
  }

  /** 命中某张提示词卡的"加输入"端口（选中或悬停时才显示，也只在那时可点） */
  private hitAddPort(screenX: number, screenY: number): PromptCard | null {
    const selection = this.selection.get();
    for (const card of this.doc.get().cards) {
      if (!isPromptCard(card)) continue;
      if (!selection.has(card.id) && this.hoverId !== card.id && this.hoverPortId !== card.id) continue;
      const point = this.addPortPoint(card);
      if (point && Math.hypot(point.x - screenX, point.y - screenY) <= PORT_HIT) return card;
    }
    return null;
  }

  private selectedCards(): CanvasCard[] {
    const selection = this.selection.get();
    return this.doc.get().cards.filter((card) => selection.has(card.id));
  }

  /**
   * withChildren：选中的页面框连同引用、分组框连同成员一起（用于移动）。
   * forScale：缩放时排除分组成员，只改分组框本身。
   */
  private selectedOrigins(withChildren = false, forScale = false): Map<string, CanvasCard> {
    const state = this.doc.get();
    let ids: ReadonlySet<string> = withChildren ? withPageChildren(state, this.selection.get()) : this.selection.get();
    if (forScale) {
      const groups = new Set(state.cards.filter((c) => ids.has(c.id) && isGroupCard(c)).map((c) => c.id));
      if (groups.size > 0) {
        ids = new Set(
          [...ids].filter((id) => {
            const card = state.cards.find((c) => c.id === id);
            const gid = card ? cardGroupId(card) : null;
            return !gid || !groups.has(gid);
          }),
        );
      }
    }
    return new Map(state.cards.filter((card) => ids.has(card.id)).map((card) => [card.id, card]));
  }

  /** 橡皮：指针附近的笔迹整笔删掉，碰到的草图文字也删掉；整次拖动是一条撤销记录 */
  private eraseAt(worldX: number, worldY: number): void {
    if (this.interaction.kind !== 'erase') return;
    const state = this.doc.get();
    const slack = ERASER_RADIUS_PX / this.viewport.zoom;
    const hit = new Set<string>();
    for (const card of state.cards) {
      if (!isSketchMark(card) || this.isHiddenSketch(card)) continue;
      if (worldX < card.x - slack - 10 || worldX > card.x + card.width + slack + 10) continue;
      if (worldY < card.y - slack - 10 || worldY > card.y + card.height + slack + 10) continue;
      if (isSketchTextCard(card)) {
        if (worldX >= card.x && worldX <= card.x + card.width && worldY >= card.y && worldY <= card.y + card.height) hit.add(card.id);
        continue;
      }
      const pts = strokeWorldPoints(card);
      const reach = card.lineWidth / 2 + slack;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        if (segmentDistance(worldX, worldY, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= reach) {
          hit.add(card.id);
          break;
        }
      }
    }
    if (hit.size === 0) return;
    this.interaction.removed += hit.size;
    this.doc.updateGesture(removeCards(state, hit));
  }

  private hitTest(worldX: number, worldY: number, filter: (card: CanvasCard) => boolean = () => true): CanvasCard | undefined {
    const cards = this.renderedSequence;
    for (let i = cards.length - 1; i >= 0; i--) {
      const card = cards[i];
      if (!filter(card) || this.isHiddenSketch(card)) continue;
      if (worldX >= card.x && worldX <= card.x + card.width && worldY >= card.y && worldY <= card.y + card.height) {
        return card;
      }
    }
    return undefined;
  }

  // ───────────────────────── 视口动画 ─────────────────────────

  private animateToRect(rect: Rect, animate: boolean, fillRatio = 1): void {
    const padding = 64;
    const zoom = clamp(
      Math.min(
        (this.viewport.screenWidth - padding * 2) / rect.width,
        (this.viewport.screenHeight - padding * 2) / rect.height,
      ) * fillRatio,
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    if (!animate) {
      this.viewport.zoom = zoom;
      this.viewport.centerOn(centerX, centerY);
      this.viewChanged = true;
      return;
    }
    this.animateTo(centerX, centerY, zoom);
  }

  private animateTo(centerX: number, centerY: number, zoom: number): void {
    const current = this.viewCenterWorld();
    this.animation = {
      from: { centerX: current.x, centerY: current.y, logZoom: Math.log(this.viewport.zoom) },
      to: { centerX, centerY, logZoom: Math.log(zoom) },
      startedAt: performance.now(),
      duration: 220,
    };
  }

  private stepAnimation(now: number): void {
    const animation = this.animation;
    if (!animation) return;
    const t = clamp((now - animation.startedAt) / animation.duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const lerp = (a: number, b: number): number => a + (b - a) * eased;
    this.viewport.zoom = Math.exp(lerp(animation.from.logZoom, animation.to.logZoom));
    this.viewport.centerOn(lerp(animation.from.centerX, animation.to.centerX), lerp(animation.from.centerY, animation.to.centerY));
    this.viewChanged = true;
    if (t >= 1) this.animation = null;
  }

  // ───────────────────────── 输入 ─────────────────────────

  private bindEvents(canvas: HTMLCanvasElement): void {
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler as EventListener, options);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
    };

    listen(canvas, 'wheel', (event) => this.onWheel(event), { passive: false });
    listen(canvas, 'pointerdown', (event) => this.onPointerDown(event));
    listen(canvas, 'pointermove', (event) => this.onPointerMove(event));
    listen(canvas, 'pointerup', (event) => this.onPointerUp(event));
    listen(canvas, 'pointercancel', (event) => this.onPointerUp(event));
    listen(canvas, 'pointerleave', () => this.setHover(null, null, null));
    listen(window, 'keydown', (event) => this.onKeyDown(event));
    listen(window, 'keyup', (event) => this.onKeyUp(event));
    listen(window, 'blur', () => {
      this.spaceHeld = false;
      this.updateCursor();
    });
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.animation = null;
    const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const dx = event.deltaX * lineScale;
    const dy = event.deltaY * lineScale;
    const { x, y } = this.localPoint(event);

    if (event.ctrlKey || event.metaKey) {
      // 触控板双指捏合会带 ctrlKey；鼠标用 Cmd + 滚轮缩放
      this.viewport.zoomAt(x, y, this.viewport.zoom * Math.exp(-dy * 0.01));
    } else {
      this.viewport.panByScreen(-dx, -dy);
    }
    this.viewChanged = true;
  }

  private onPointerDown(event: PointerEvent): void {
    const canvas = this.app.canvas;
    canvas.setPointerCapture(event.pointerId);
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.animation = null;
    const { x, y } = this.localPoint(event);

    if (event.button === 1 || this.tool === 'hand' || this.spaceHeld) {
      this.interaction = { kind: 'pan', lastX: x, lastY: y };
      this.updateCursor();
      return;
    }
    if (event.button !== 0) return;

    if (this.tool === 'pen' || this.tool === 'eraser' || this.tool === 'text') {
      const world = this.viewport.screenToWorld(x, y);
      if (this.tool === 'eraser') {
        this.doc.beginGesture('擦除草图');
        this.interaction = { kind: 'erase', removed: 0 };
        this.eraseAt(world.x, world.y);
        return;
      }
      const top = this.hitTest(world.x, world.y);
      // 文字工具点在已有文字上：照常选中、拖动
      if (!(this.tool === 'text' && top && isSketchTextCard(top))) {
        const page = this.hitTest(world.x, world.y, isPageCard);
        if (!page) return;
        if (this.tool === 'pen') {
          this.interaction = { kind: 'drawStroke', pageId: page.id, points: [world.x, world.y], lastScreenX: x, lastScreenY: y };
          return;
        }
        const created = createSketchText(this.doc.get(), page.id, world, 'md', () => crypto.randomUUID());
        if (created) {
          this.doc.apply('写草图文字', created.state);
          this.selection.set([created.textId]);
          for (const listener of this.editListeners) listener(created.textId);
        }
        return;
      }
    }

    // 区块 / 装饰工具：在页面框空白处拖出新框；按在已有同名对象或选中框的角上，照常移动 / 缩放
    if ((this.tool === 'block' || this.tool === 'decor') && !this.hitCorner(x, y)) {
      const world = this.viewport.screenToWorld(x, y);
      const top = this.hitTest(world.x, world.y);
      const hittingOwn = this.tool === 'block' ? top && isBlockCard(top) : top && isDecorCard(top);
      if (!hittingOwn) {
        const page = this.hitTest(world.x, world.y, isPageCard);
        if (page) {
          this.interaction =
            this.tool === 'block'
              ? { kind: 'drawBlock', pageId: page.id, startWorldX: world.x, startWorldY: world.y, rect: { x: world.x, y: world.y, width: 0, height: 0 } }
              : { kind: 'drawDecor', pageId: page.id, startWorldX: world.x, startWorldY: world.y, rect: { x: world.x, y: world.y, width: 0, height: 0 } };
        }
        return;
      }
    }

    const port = this.hitAddPort(x, y);
    if (port) {
      const from = this.addPortPoint(port)!;
      this.interaction = { kind: 'link', promptId: port.id, fromX: from.x, fromY: from.y, x, y, targetId: null };
      return;
    }

    const corner = this.hitCorner(x, y);
    if (corner) {
      const bounds = unionRects(this.selectedCards())!;
      const opposite = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' } as const;
      const point = (c: Corner): { x: number; y: number } => ({
        x: c === 'nw' || c === 'sw' ? bounds.x : bounds.x + bounds.width,
        y: c === 'nw' || c === 'ne' ? bounds.y : bounds.y + bounds.height,
      });
      const anchor = point(opposite[corner]);
      const cornerPoint = point(corner);
      this.doc.beginGesture('缩放');
      this.interaction = {
        kind: 'resize',
        corner,
        anchorX: anchor.x,
        anchorY: anchor.y,
        cornerX: cornerPoint.x,
        cornerY: cornerPoint.y,
        origins: this.selectedOrigins(true, true),
      };
      return;
    }

    const world = this.viewport.screenToWorld(x, y);
    const hit = this.hitTest(world.x, world.y);

    if (!hit) {
      const mode = marqueeMode(event);
      const base = mode === 'replace' ? new Set<string>() : new Set(this.selection.get());
      if (mode === 'replace') this.selection.set([]);
      this.interaction = {
        kind: 'marquee',
        startWorldX: world.x,
        startWorldY: world.y,
        base,
        mode,
        rect: { x: world.x, y: world.y, width: 0, height: 0 },
      };
      return;
    }

    const isDoubleClick = this.lastClick?.id === hit.id && performance.now() - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { id: hit.id, at: performance.now() };
    if (isDoubleClick && isPromptCard(hit)) {
      this.selection.set([hit.id]);
      for (const listener of this.editListeners) listener(hit.id);
      return;
    }

    let toggleOnClickId: string | null = null;
    if (selectionAdditive(event)) {
      if (this.selection.has(hit.id)) toggleOnClickId = hit.id;
      else this.selection.toggle(hit.id);
    } else if (!this.selection.has(hit.id)) {
      this.selection.set([hit.id]);
    }

    this.interaction = {
      kind: 'drag',
      startScreenX: x,
      startScreenY: y,
      startWorldX: world.x,
      startWorldY: world.y,
      origins: this.selectedOrigins(true),
      moved: false,
      toggleOnClickId,
      dropPageId: null,
    };
  }

  private onPointerMove(event: PointerEvent): void {
    const { x, y } = this.localPoint(event);
    const interaction = this.interaction;

    switch (interaction.kind) {
      case 'none': {
        const port = this.hitAddPort(x, y);
        const corner = port ? null : this.hitCorner(x, y);
        const world = this.viewport.screenToWorld(x, y);
        const hit = port || corner ? null : (this.hitTest(world.x, world.y)?.id ?? null);
        this.setHover(hit ?? (port ? this.hoverId : null), corner, port?.id ?? null);
        return;
      }
      case 'pan':
        this.viewport.panByScreen(x - interaction.lastX, y - interaction.lastY);
        interaction.lastX = x;
        interaction.lastY = y;
        this.viewChanged = true;
        return;
      case 'drag': {
        if (!interaction.moved) {
          if (Math.hypot(x - interaction.startScreenX, y - interaction.startScreenY) < DRAG_THRESHOLD_PX) return;
          interaction.moved = true;
          this.doc.beginGesture('移动');
        }
        const world = this.viewport.screenToWorld(x, y);
        let dx = world.x - interaction.startWorldX;
        let dy = world.y - interaction.startWorldY;
        const snap = this.computeDragSnap(interaction.origins, dx, dy);
        dx += snap.dx;
        dy += snap.dy;
        this.snapGuides = snap.guides;
        this.doc.updateGesture(moveCards(this.doc.get(), interaction.origins, dx, dy));
        const dropPageId = event.altKey ? null : this.dropTargetFor(interaction.origins, world.x, world.y);
        if (dropPageId !== interaction.dropPageId) {
          interaction.dropPageId = dropPageId;
        }
        this.overlayDirty = true;
        return;
      }
      case 'marquee': {
        const world = this.viewport.screenToWorld(x, y);
        interaction.rect = rectFromPoints(interaction.startWorldX, interaction.startWorldY, world.x, world.y);
        const hitIds: string[] = [];
        for (const card of this.doc.get().cards) {
          if (intersects(card, interaction.rect) && !this.isHiddenSketch(card)) hitIds.push(card.id);
        }
        this.selection.set(applyMarqueeSelection(interaction.base, hitIds, interaction.mode));
        this.overlayDirty = true;
        return;
      }
      case 'resize': {
        const world = this.viewport.screenToWorld(x, y);
        const [only] = interaction.origins.values();
        if (interaction.origins.size === 1 && only && isBlockCard(only)) {
          this.doc.updateGesture(resizeBlock(this.doc.get(), only, interaction.anchorX, interaction.anchorY, world.x, world.y));
          return;
        }
        const sx = (world.x - interaction.anchorX) / (interaction.cornerX - interaction.anchorX);
        const sy = (world.y - interaction.anchorY) / (interaction.cornerY - interaction.anchorY);
        this.doc.updateGesture(
          scaleCards(this.doc.get(), interaction.origins, interaction.anchorX, interaction.anchorY, Math.max(sx, sy)),
        );
        return;
      }
      case 'drawStroke': {
        if (Math.hypot(x - interaction.lastScreenX, y - interaction.lastScreenY) < PEN_SAMPLE_PX) return;
        const world = this.viewport.screenToWorld(x, y);
        const page = this.rendered.get(interaction.pageId);
        if (!page) return;
        interaction.points.push(
          Math.min(page.x + page.width, Math.max(page.x, world.x)),
          Math.min(page.y + page.height, Math.max(page.y, world.y)),
        );
        interaction.lastScreenX = x;
        interaction.lastScreenY = y;
        this.overlayDirty = true;
        return;
      }
      case 'erase': {
        const world = this.viewport.screenToWorld(x, y);
        this.eraseAt(world.x, world.y);
        return;
      }
      case 'drawBlock':
      case 'drawDecor': {
        const world = this.viewport.screenToWorld(x, y);
        const page = this.rendered.get(interaction.pageId);
        if (!page) return;
        const clampX = (v: number): number => Math.min(page.x + page.width, Math.max(page.x, v));
        const clampY = (v: number): number => Math.min(page.y + page.height, Math.max(page.y, v));
        const snapped = this.computeDrawSnap(interaction.pageId, world.x, world.y);
        this.snapGuides = snapped.guides;
        interaction.rect = rectFromPoints(
          interaction.startWorldX,
          interaction.startWorldY,
          clampX(snapped.x),
          clampY(snapped.y),
        );
        this.overlayDirty = true;
        return;
      }
      case 'link': {
        const world = this.viewport.screenToWorld(x, y);
        const prompt = this.rendered.get(interaction.promptId);
        const outputId = prompt && isPromptCard(prompt) ? prompt.outputCardId : null;
        const target = this.hitTest(world.x, world.y, (card) => isImageCard(card) && card.id !== outputId);
        interaction.x = x;
        interaction.y = y;
        interaction.targetId = target?.id ?? null;
        this.overlayDirty = true;
        return;
      }
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const canvas = this.app.canvas;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const interaction = this.interaction;
    if (interaction.kind === 'drag' || interaction.kind === 'drawBlock' || interaction.kind === 'drawDecor') {
      this.snapGuides = [];
      this.overlayDirty = true;
    }
    if (interaction.kind === 'drag') {
      if (interaction.moved && interaction.dropPageId) this.dropIntoPage(interaction.origins, interaction.dropPageId);
      else if (interaction.moved) {
        const refIds = new Set([...interaction.origins.values()].filter(isRefCard).map((card) => card.id));
        if (refIds.size) this.doc.updateGesture(reassignRefPages(this.doc.get(), refIds));
        this.doc.commitGesture();
      } else if (interaction.toggleOnClickId) this.selection.toggle(interaction.toggleOnClickId);
    }
    if (interaction.kind === 'resize') this.doc.commitGesture();
    if (interaction.kind === 'drawStroke') {
      const points = interaction.points.length >= 4 ? interaction.points : [...interaction.points, interaction.points[0] + 0.5, interaction.points[1] + 0.5];
      const created = createStroke(this.doc.get(), interaction.pageId, points, PEN_WIDTHS[this.penWidth], () => crypto.randomUUID());
      if (created) this.doc.apply('画草图', created.state);
    }
    if (interaction.kind === 'erase') {
      if (interaction.removed > 0) this.doc.commitGesture();
      else this.doc.cancelGesture();
    }
    if (interaction.kind === 'drawBlock' && interaction.rect.width >= MIN_DRAWN_BLOCK && interaction.rect.height >= MIN_DRAWN_BLOCK) {
      const created = createBlockAt(this.doc.get(), interaction.pageId, interaction.rect, () => crypto.randomUUID());
      if (created) {
        this.doc.apply('画区块', created.state);
        this.selection.set([created.blockId]);
        for (const listener of this.editListeners) listener(created.blockId);
      }
    }
    if (interaction.kind === 'drawDecor' && interaction.rect.width >= MIN_DRAWN_BLOCK && interaction.rect.height >= MIN_DRAWN_BLOCK) {
      const created = createDecorAt(this.doc.get(), interaction.pageId, interaction.rect, () => crypto.randomUUID());
      if (created) {
        this.doc.apply('画页面装饰', created.state);
        this.selection.set([created.decorId]);
      }
    }
    if (interaction.kind === 'link' && interaction.targetId) {
      this.doc.apply('绑定输入图', addPromptInput(this.doc.get(), interaction.promptId, interaction.targetId));
    }
    this.interaction = { kind: 'none' };
    this.overlayDirty = true;
    this.updateCursor();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (isTyping(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;

    if (event.code === 'Space') {
      event.preventDefault();
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.updateCursor();
      }
      return;
    }
    if (event.key === 'Escape' && this.doc.isGestureActive()) {
      this.doc.cancelGesture();
      this.interaction = { kind: 'none' };
      this.overlayDirty = true;
      return;
    }
    if (mod) return;

    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (arrows[event.key]) {
      event.preventDefault();
      const step = event.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
      const [dx, dy] = arrows[event.key];
      this.nudgeSelection(dx * step, dy * step);
    } else if (event.shiftKey && event.code === 'Digit1') {
      this.fitAll();
    } else if (event.shiftKey && event.code === 'Digit2') {
      this.zoomToSelection();
    } else if (event.shiftKey && event.code === 'Digit0') {
      this.setZoom(1);
    } else if (event.key.toLowerCase() === 'v') {
      this.setTool('select');
    } else if (event.key.toLowerCase() === 'h') {
      this.setTool('hand');
    } else if (event.key.toLowerCase() === 'b') {
      this.setTool('block');
    } else if (event.key.toLowerCase() === 'r') {
      this.setTool('decor');
    } else if (event.key.toLowerCase() === 'd') {
      this.setTool('pen');
    } else if (event.key.toLowerCase() === 't') {
      this.setTool('text');
    } else if (event.key.toLowerCase() === 'e') {
      this.setTool('eraser');
    } else if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      this.createPromptFromSelection();
    } else if (event.key === 'Enter') {
      const [only] = this.selectedCards();
      if (this.selection.size === 1 && only && isPromptCard(only)) {
        event.preventDefault();
        for (const listener of this.editListeners) listener(only.id);
      }
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      this.deleteSelection();
    } else if (event.key === 'Escape') {
      if (this.tool !== 'select' && this.tool !== 'hand') this.setTool('select');
      else this.selection.set([]);
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') {
      this.spaceHeld = false;
      this.updateCursor();
    }
  }

  private setHover(id: string | null, corner: Corner | null, portId: string | null): void {
    if (this.hoverId === id && this.hoverCorner === corner && this.hoverPortId === portId) return;
    this.hoverId = id;
    this.hoverCorner = corner;
    this.hoverPortId = portId;
    this.overlayDirty = true;
    this.updateCursor();
  }

  private updateCursor(): void {
    const canvas = this.app.canvas;
    if (!canvas) return;
    if (this.interaction.kind === 'pan') canvas.style.cursor = 'grabbing';
    else if (this.interaction.kind === 'link' || this.hoverPortId) canvas.style.cursor = 'crosshair';
    else if (this.tool === 'hand' || this.spaceHeld) canvas.style.cursor = 'grab';
    else if (this.tool === 'block' || this.tool === 'decor' || this.tool === 'pen') canvas.style.cursor = 'crosshair';
    else if (this.tool === 'text') canvas.style.cursor = 'text';
    else if (this.tool === 'eraser') canvas.style.cursor = 'cell';
    else if (this.hoverCorner === 'nw' || this.hoverCorner === 'se') canvas.style.cursor = 'nwse-resize';
    else if (this.hoverCorner === 'ne' || this.hoverCorner === 'sw') canvas.style.cursor = 'nesw-resize';
    else canvas.style.cursor = 'default';
  }

  private localPoint(event: MouseEvent): { x: number; y: number } {
    const bounds = this.app.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  // ───────────────────────── 其它 ─────────────────────────

  private handleResize(): void {
    if (!this.host || !this.app.renderer) return;
    const { width, height } = this.host.getBoundingClientRect();
    this.app.renderer.resize(Math.max(1, width), Math.max(1, height), window.devicePixelRatio);
    this.viewport.resize(width, height);
    if (this.grid) this.grid.setSize(width, height);
    this.viewChanged = true;
  }

  private status(): EngineStatus {
    return {
      tool: this.tool,
      penWidth: this.penWidth,
      zoom: this.viewport.zoom,
      itemCount: this.doc.get().cards.length,
      selectionCount: this.selection.size,
      focusRegion: this.focusRegion,
      perf: this.perf.recent(),
      idle: this.perf.isIdle(performance.now()),
      textures: this.textures.stats(),
      refreshRateHz: this.refreshRateHz,
    };
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const status = this.status();
    for (const listener of this.statusListeners) listener(status);
  }

  /** 第一次画精灵批次和线框时才编译着色器（实测 13ms），启动时先在屏幕外画一次 */
  private warmUpShaders(): void {
    const warm = new Container();
    const sprite = new Sprite(Texture.WHITE);
    const outline = new Graphics().rect(0, 0, 4, 4).stroke({ color: ACCENT, width: 1 });
    warm.addChild(sprite, outline);
    warm.position.set(-100, -100);
    this.app.stage.addChild(warm);
    this.app.render();
    warm.destroy({ children: true });
  }

  /** 连续采样 rAF 间隔估算显示器刷新率 */
  private async measureRefreshRate(): Promise<void> {
    const samples: number[] = [];
    let last = 0;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        if (last > 0) samples.push(now - last);
        last = now;
        if (samples.length >= 40 || this.destroyed) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? 16.67;
    this.refreshRateHz = Math.round(1000 / median);
  }
}

export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
}

function sameOrder(a: readonly CanvasCard[], b: readonly CanvasCard[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

/** 水平方向的三次贝塞尔曲线，两端水平进出 */
/** 点到线段的距离 */
function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function curve(g: Graphics, x1: number, y1: number, x2: number, y2: number): void {
  const bend = Math.max(40, Math.abs(x2 - x1) / 2);
  g.moveTo(x1, y1).bezierCurveTo(x1 + bend, y1, x2 - bend, y2, x2, y2);
}

function dashedRect(g: Graphics, x: number, y: number, width: number, height: number): void {
  const dash = 8;
  const gap = 6;
  const edge = (x1: number, y1: number, x2: number, y2: number): void => {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / length;
    const uy = (y2 - y1) / length;
    for (let d = 0; d < length; d += dash + gap) {
      const end = Math.min(length, d + dash);
      g.moveTo(x1 + ux * d, y1 + uy * d).lineTo(x1 + ux * end, y1 + uy * end);
    }
  };
  edge(x, y, x + width, y);
  edge(x + width, y, x + width, y + height);
  edge(x + width, y + height, x, y + height);
  edge(x, y + height, x, y);
}

const DOT_TILE = 32;

function createDotTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = DOT_TILE;
  canvas.height = DOT_TILE;
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'rgba(255,255,255,0.16)';
  context.beginPath();
  context.arc(1.5, 1.5, 1.25, 0, Math.PI * 2);
  context.fill();
  return Texture.from(canvas);
}
