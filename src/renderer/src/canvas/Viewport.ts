import type { Rect } from './geometry';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/** 屏幕坐标 = (世界坐标 - origin) × zoom */
export class Viewport {
  originX = 0;
  originY = 0;
  zoom = 1;
  screenWidth = 1;
  screenHeight = 1;

  resize(width: number, height: number): void {
    this.screenWidth = Math.max(1, width);
    this.screenHeight = Math.max(1, height);
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return { x: screenX / this.zoom + this.originX, y: screenY / this.zoom + this.originY };
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return { x: (worldX - this.originX) * this.zoom, y: (worldY - this.originY) * this.zoom };
  }

  panByScreen(dx: number, dy: number): void {
    this.originX -= dx / this.zoom;
    this.originY -= dy / this.zoom;
  }

  /** 以屏幕上某一点为中心缩放，这一点下的世界坐标保持不动 */
  zoomAt(screenX: number, screenY: number, nextZoom: number): void {
    const anchor = this.screenToWorld(screenX, screenY);
    this.zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    this.originX = anchor.x - screenX / this.zoom;
    this.originY = anchor.y - screenY / this.zoom;
  }

  zoomAtCenter(nextZoom: number): void {
    this.zoomAt(this.screenWidth / 2, this.screenHeight / 2, nextZoom);
  }

  fit(rect: Rect, paddingPx = 48): void {
    const availableWidth = Math.max(1, this.screenWidth - paddingPx * 2);
    const availableHeight = Math.max(1, this.screenHeight - paddingPx * 2);
    this.zoom = clamp(Math.min(availableWidth / rect.width, availableHeight / rect.height), MIN_ZOOM, MAX_ZOOM);
    this.centerOn(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  centerOn(worldX: number, worldY: number): void {
    this.originX = worldX - this.screenWidth / 2 / this.zoom;
    this.originY = worldY - this.screenHeight / 2 / this.zoom;
  }

  visibleWorldRect(): Rect {
    return {
      x: this.originX,
      y: this.originY,
      width: this.screenWidth / this.zoom,
      height: this.screenHeight / this.zoom,
    };
  }

  snapshot(): { originX: number; originY: number; zoom: number } {
    return { originX: this.originX, originY: this.originY, zoom: this.zoom };
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
