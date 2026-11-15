import type { Rect } from './geometry';

/** 目标矩形是否已完整落在视口内（含世界坐标边距） */
export function isFullyVisible(view: Rect, target: Rect, padding: number): boolean {
  return (
    target.x >= view.x + padding &&
    target.y >= view.y + padding &&
    target.x + target.width <= view.x + view.width - padding &&
    target.y + target.height <= view.y + view.height - padding
  );
}

/**
 * 在不改缩放的前提下，计算为让 target 完整进入视口所需的新视口中心。
 * 已完全可见时返回 null。
 */
export function panCenterToReveal(view: Rect, target: Rect, padding: number): { x: number; y: number } | null {
  if (isFullyVisible(view, target, padding)) return null;

  let x = view.x;
  let y = view.y;
  const innerW = Math.max(1, view.width - padding * 2);
  const innerH = Math.max(1, view.height - padding * 2);

  if (target.width >= innerW) {
    x = target.x + target.width / 2 - view.width / 2;
  } else {
    const left = target.x - padding;
    const right = target.x + target.width + padding;
    if (left < view.x) x = left;
    else if (right > view.x + view.width) x = right - view.width;
  }

  if (target.height >= innerH) {
    y = target.y + target.height / 2 - view.height / 2;
  } else {
    const top = target.y - padding;
    const bottom = target.y + target.height + padding;
    if (top < view.y) y = top;
    else if (bottom > view.y + view.height) y = bottom - view.height;
  }

  return { x: x + view.width / 2, y: y + view.height / 2 };
}
