import type { Rect } from './geometry';

export interface SnapGuide {
  orientation: 'v' | 'h';
  /** 世界坐标：竖线用 x，横线用 y */
  position: number;
  /** 线段在另一轴上的起止，画短一点更像 Figma */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

interface Edges {
  left: number;
  right: number;
  cx: number;
  top: number;
  bottom: number;
  cy: number;
}

function edgesOf(rect: Rect): Edges {
  return {
    left: rect.x,
    right: rect.x + rect.width,
    cx: rect.x + rect.width / 2,
    top: rect.y,
    bottom: rect.y + rect.height,
    cy: rect.y + rect.height / 2,
  };
}

/** 拖动中的框相对目标边/中心吸附；threshold 为画布单位 */
export function snapRectMove(moving: Rect, targets: readonly Rect[], threshold: number): SnapResult {
  if (threshold <= 0 || targets.length === 0) return { dx: 0, dy: 0, guides: [] };
  const m = edgesOf(moving);
  let bestDx = 0;
  let bestDy = 0;
  let bestAbsX = threshold + 1;
  let bestAbsY = threshold + 1;
  let guideV: SnapGuide | null = null;
  let guideH: SnapGuide | null = null;

  for (const target of targets) {
    const t = edgesOf(target);
    const yFrom = Math.min(m.top, t.top) - 8;
    const yTo = Math.max(m.bottom, t.bottom) + 8;
    const xFrom = Math.min(m.left, t.left) - 8;
    const xTo = Math.max(m.right, t.right) + 8;

    for (const [from, to] of [
      [m.left, t.left],
      [m.left, t.right],
      [m.left, t.cx],
      [m.right, t.left],
      [m.right, t.right],
      [m.right, t.cx],
      [m.cx, t.left],
      [m.cx, t.right],
      [m.cx, t.cx],
    ] as const) {
      const delta = to - from;
      const abs = Math.abs(delta);
      if (abs <= threshold && abs < bestAbsX) {
        bestAbsX = abs;
        bestDx = delta;
        guideV = { orientation: 'v', position: to, from: yFrom, to: yTo };
      }
    }
    for (const [from, to] of [
      [m.top, t.top],
      [m.top, t.bottom],
      [m.top, t.cy],
      [m.bottom, t.top],
      [m.bottom, t.bottom],
      [m.bottom, t.cy],
      [m.cy, t.top],
      [m.cy, t.bottom],
      [m.cy, t.cy],
    ] as const) {
      const delta = to - from;
      const abs = Math.abs(delta);
      if (abs <= threshold && abs < bestAbsY) {
        bestAbsY = abs;
        bestDy = delta;
        guideH = { orientation: 'h', position: to, from: xFrom, to: xTo };
      }
    }
  }

  const guides: SnapGuide[] = [];
  if (guideV) guides.push(guideV);
  if (guideH) guides.push(guideH);
  return { dx: bestDx, dy: bestDy, guides };
}

/** 拖画时吸附指针到附近的边/中线 */
export function snapPoint(
  x: number,
  y: number,
  targets: readonly Rect[],
  threshold: number,
): { x: number; y: number; guides: SnapGuide[] } {
  if (threshold <= 0 || targets.length === 0) return { x, y, guides: [] };
  let bestX = x;
  let bestY = y;
  let bestAbsX = threshold + 1;
  let bestAbsY = threshold + 1;
  let guideV: SnapGuide | null = null;
  let guideH: SnapGuide | null = null;

  for (const target of targets) {
    const t = edgesOf(target);
    for (const edge of [t.left, t.right, t.cx]) {
      const abs = Math.abs(edge - x);
      if (abs <= threshold && abs < bestAbsX) {
        bestAbsX = abs;
        bestX = edge;
        guideV = { orientation: 'v', position: edge, from: t.top - 8, to: t.bottom + 8 };
      }
    }
    for (const edge of [t.top, t.bottom, t.cy]) {
      const abs = Math.abs(edge - y);
      if (abs <= threshold && abs < bestAbsY) {
        bestAbsY = abs;
        bestY = edge;
        guideH = { orientation: 'h', position: edge, from: t.left - 8, to: t.right + 8 };
      }
    }
  }

  const guides: SnapGuide[] = [];
  if (guideV) guides.push(guideV);
  if (guideH) guides.push(guideH);
  return { x: bestX, y: bestY, guides };
}

/**
 * 吸附阈值（画布单位）：
 * - 至少约 8 屏幕像素（缩小时仍好吸）
 * - 且不少于 6 逻辑像素换算的画布距离
 */
export function snapThresholdCanvas(pageWidth: number, logicalWidth: number, zoom: number): number {
  const logical = logicalWidth <= 0 ? 6 : (6 * pageWidth) / logicalWidth;
  const screen = zoom > 0 ? 8 / zoom : 8;
  return Math.max(logical, screen);
}
