import { describe, expect, it } from 'vitest';
import { isFullyVisible, panCenterToReveal } from './viewReveal';

describe('isFullyVisible', () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };

  it('true when target inside with padding', () => {
    expect(isFullyVisible(view, { x: 100, y: 100, width: 50, height: 50 }, 40)).toBe(true);
  });

  it('false when clipping padding', () => {
    expect(isFullyVisible(view, { x: 10, y: 100, width: 50, height: 50 }, 40)).toBe(false);
  });
});

describe('panCenterToReveal', () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };

  it('returns null when already visible', () => {
    expect(panCenterToReveal(view, { x: 200, y: 200, width: 100, height: 80 }, 40)).toBeNull();
  });

  it('pans left when target is left of view', () => {
    const next = panCenterToReveal(view, { x: -200, y: 200, width: 100, height: 80 }, 40);
    expect(next).not.toBeNull();
    expect(next!.x).toBeLessThan(view.x + view.width / 2);
    expect(next!.y).toBe(view.y + view.height / 2);
  });

  it('centers when target larger than view', () => {
    const target = { x: -500, y: -400, width: 2000, height: 1600 };
    const next = panCenterToReveal(view, target, 40);
    expect(next).toEqual({ x: 500, y: 400 });
  });
});
