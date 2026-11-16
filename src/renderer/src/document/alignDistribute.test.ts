import { describe, expect, it } from 'vitest';
import { canAlign, computeAlignPositions } from './alignDistribute';

const a = { id: 'a', x: 100, y: 10, width: 40, height: 20 };
const b = { id: 'b', x: 200, y: 50, width: 40, height: 20 };

describe('canAlign', () => {
  it('needs 2 for align and 3 for distribute', () => {
    expect(canAlign(2, 'left')).toBe(true);
    expect(canAlign(1, 'left')).toBe(false);
    expect(canAlign(3, 'distributeX')).toBe(true);
    expect(canAlign(2, 'distributeX')).toBe(false);
  });
});

describe('computeAlignPositions', () => {
  it('aligns left to selection bounds', () => {
    const next = computeAlignPositions([a, b], 'left')!;
    expect(next.get('a')).toEqual({ x: 100, y: 10 });
    expect(next.get('b')).toEqual({ x: 100, y: 50 });
  });

  it('aligns right', () => {
    const next = computeAlignPositions([a, b], 'right')!;
    expect(next.get('a')!.x).toBe(200);
    expect(next.get('b')!.x).toBe(200);
  });

  it('distributes horizontal gaps equally', () => {
    const left = { id: 'l', x: 0, y: 0, width: 10, height: 10 };
    const mid = { id: 'm', x: 20, y: 0, width: 10, height: 10 };
    const right = { id: 'r', x: 100, y: 0, width: 10, height: 10 };
    const next = computeAlignPositions([left, mid, right], 'distributeX')!;
    expect(next.get('l')!.x).toBe(0);
    expect(next.get('r')!.x).toBe(100);
    expect(next.get('m')!.x).toBe(50);
  });

  it('returns null when already aligned', () => {
    const x = { id: 'x', x: 0, y: 0, width: 10, height: 10 };
    const y = { id: 'y', x: 0, y: 20, width: 10, height: 10 };
    expect(computeAlignPositions([x, y], 'left')).toBeNull();
  });

  it('stable-sorts equal positions by id for distribute', () => {
    const p = { id: 'p', x: 0, y: 0, width: 10, height: 10 };
    const q = { id: 'q', x: 0, y: 0, width: 10, height: 10 };
    const r = { id: 'r', x: 40, y: 0, width: 10, height: 10 };
    const next = computeAlignPositions([q, r, p], 'distributeX')!;
    expect([...next.keys()]).toEqual(['p', 'q', 'r']);
  });
});
