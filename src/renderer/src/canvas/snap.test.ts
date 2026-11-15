import { describe, expect, it } from 'vitest';
import { snapPoint, snapRectMove, snapThresholdCanvas } from './snap';

describe('snap', () => {
  it('靠近边缘时吸附并给出竖线', () => {
    const moving = { x: 98, y: 10, width: 40, height: 40 };
    const target = { x: 100, y: 50, width: 40, height: 40 };
    const result = snapRectMove(moving, [target], 6);
    expect(result.dx).toBe(2);
    expect(result.guides.some((g) => g.orientation === 'v' && g.position === 100)).toBe(true);
    expect(result.guides[0].from).toBeLessThan(result.guides[0].to);
  });

  it('缩小时阈值变大，至少 8 屏幕像素', () => {
    const logical = snapThresholdCanvas(480, 393, 1);
    expect(logical).toBeGreaterThanOrEqual((6 * 480) / 393);
    const zoomedOut = snapThresholdCanvas(480, 393, 0.2);
    expect(zoomedOut).toBeGreaterThanOrEqual(8 / 0.2);
  });

  it('贴页面框左边能吸上', () => {
    const page = { x: 1000, y: 200, width: 480, height: 1040 };
    const moving = { x: page.x + 5, y: page.y + 100, width: 48, height: 48 };
    const result = snapRectMove(moving, [page], snapThresholdCanvas(480, 393, 1));
    expect(result.dx).toBe(-5);
    expect(result.guides[0]).toMatchObject({ orientation: 'v', position: page.x });
  });

  it('拖画时指针吸到目标边', () => {
    const target = { x: 100, y: 50, width: 40, height: 40 };
    const result = snapPoint(102, 80, [target], 6);
    expect(result.x).toBe(100);
    expect(result.guides.some((g) => g.orientation === 'v')).toBe(true);
  });
});
