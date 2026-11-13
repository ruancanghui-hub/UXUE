import { ASSET_SCHEME } from './bench';

/** L2 的长边上限：更大的原图会先缩到这个尺寸再切块，避免一张图占用过多显存 */
export const L2_MAX_EDGE = 4096;
/** L2 切块边长：整张 2048 纹理一次上传耗时波动大（实测 4.5–11.5ms），切块后每帧只传一块（ADR 0004） */
export const L2_TILE_SIZE = 1024;
/** 相邻切块互相多带 1px，线性过滤采样到边缘时取到的是真实邻居像素，放大时没有接缝 */
export const L2_TILE_GUTTER = 1;
/** 缓存格式变了就加一，旧缓存会被自动重建 */
export const CACHE_VERSION = 1;

/** L2 的一块：文件里的图从 (left, top) 开始，其中有效区域是 (x, y, width, height)，都是 L2 像素坐标 */
export interface TileRect {
  name: string;
  left: number;
  top: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileRef extends TileRect {
  url: string;
}

/** 画布要显示一张图所需的全部纹理地址 */
export interface TexturedImage {
  /** 纹理缓存的键，项目里就是版本 id */
  key: string;
  /** L2 的像素尺寸，切块坐标以它为准 */
  width: number;
  height: number;
  /** L0、L1 的地址 */
  urls: [string, string];
  tiles: TileRef[];
}

export function l2Size(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, L2_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function computeTiles(width: number, height: number): TileRect[] {
  const tiles: TileRect[] = [];
  for (let y = 0; y < height; y += L2_TILE_SIZE) {
    for (let x = 0; x < width; x += L2_TILE_SIZE) {
      const tileWidth = Math.min(L2_TILE_SIZE, width - x);
      const tileHeight = Math.min(L2_TILE_SIZE, height - y);
      const left = Math.max(0, x - L2_TILE_GUTTER);
      const top = Math.max(0, y - L2_TILE_GUTTER);
      tiles.push({ name: `tile-${x}-${y}`, left, top, x, y, width: tileWidth, height: tileHeight });
    }
  }
  return tiles;
}

/** 切块文件实际的像素范围（含防接缝外边） */
export function tileExtent(tile: TileRect, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const right = Math.min(width, tile.x + tile.width + L2_TILE_GUTTER);
  const bottom = Math.min(height, tile.y + tile.height + L2_TILE_GUTTER);
  return { left: tile.left, top: tile.top, width: right - tile.left, height: bottom - tile.top };
}

export const cacheFiles = {
  l0: (key: string) => `.cache/${key}@256.webp`,
  l1: (key: string) => `.cache/${key}@1024.webp`,
  tile: (key: string, tile: TileRect) => `.cache/${key}@${tile.name}.webp`,
  marker: (key: string) => `.cache/${key}.json`,
};

/** 原图尺寸 → 画布要用的全部纹理地址；主进程写缓存和渲染进程读缓存用的是同一套规则 */
export function texturedImage(host: string, key: string, originalWidth: number, originalHeight: number): TexturedImage {
  const base = `${ASSET_SCHEME}://${host}/`;
  const { width, height } = l2Size(originalWidth, originalHeight);
  return {
    key,
    width,
    height,
    urls: [base + cacheFiles.l0(key), base + cacheFiles.l1(key)],
    tiles: computeTiles(width, height).map((tile) => ({ ...tile, url: base + cacheFiles.tile(key, tile) })),
  };
}
