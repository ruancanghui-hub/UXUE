import { expandRect, unionRects, type Rect } from './geometry';

export interface MinimapTransform {
  bounds: Rect;
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** 把世界范围映射进固定像素鸟瞰；内容居中，四周留白 */
export function createMinimapTransform(worldRects: Iterable<Rect>, mapWidth: number, mapHeight: number, padRatio = 0.08): MinimapTransform {
  const raw = unionRects(worldRects) ?? { x: 0, y: 0, width: 1000, height: 1000 };
  const bounds = expandRect(raw, padRatio);
  const scale = Math.min(mapWidth / Math.max(1, bounds.width), mapHeight / Math.max(1, bounds.height));
  const usedW = bounds.width * scale;
  const usedH = bounds.height * scale;
  return {
    bounds,
    scale,
    offsetX: (mapWidth - usedW) / 2,
    offsetY: (mapHeight - usedH) / 2,
    width: mapWidth,
    height: mapHeight,
  };
}

export function worldToMap(t: MinimapTransform, x: number, y: number): { x: number; y: number } {
  return {
    x: t.offsetX + (x - t.bounds.x) * t.scale,
    y: t.offsetY + (y - t.bounds.y) * t.scale,
  };
}

export function mapToWorld(t: MinimapTransform, x: number, y: number): { x: number; y: number } {
  return {
    x: t.bounds.x + (x - t.offsetX) / t.scale,
    y: t.bounds.y + (y - t.offsetY) / t.scale,
  };
}

export function worldRectToMap(t: MinimapTransform, rect: Rect): Rect {
  const a = worldToMap(t, rect.x, rect.y);
  return { x: a.x, y: a.y, width: rect.width * t.scale, height: rect.height * t.scale };
}
