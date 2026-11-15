import { describe, expect, it } from 'vitest';
import { createMinimapTransform, mapToWorld, worldToMap } from './minimapLayout';

describe('minimapLayout', () => {
  it('round-trips world ↔ map at center', () => {
    const t = createMinimapTransform([{ x: 0, y: 0, width: 1000, height: 500 }], 200, 100);
    const mid = { x: 500, y: 250 };
    const mapped = worldToMap(t, mid.x, mid.y);
    const back = mapToWorld(t, mapped.x, mapped.y);
    expect(back.x).toBeCloseTo(mid.x, 5);
    expect(back.y).toBeCloseTo(mid.y, 5);
  });

  it('fits content inside map', () => {
    const t = createMinimapTransform([{ x: 0, y: 0, width: 2000, height: 1000 }], 200, 140);
    expect(t.bounds.width * t.scale).toBeLessThanOrEqual(200 + 1e-6);
    expect(t.bounds.height * t.scale).toBeLessThanOrEqual(140 + 1e-6);
  });
});
