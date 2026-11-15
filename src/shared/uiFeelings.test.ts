import { describe, expect, it } from 'vitest';
import { feelingSuffix, normalizeFeelings, toggleFeeling } from './uiFeelings';

describe('界面感觉', () => {
  it('规范化为秩序→克制→从容，去重', () => {
    expect(normalizeFeelings(['calm', 'order', 'calm', 'restraint'])).toEqual(['order', 'restraint', 'calm']);
    expect(normalizeFeelings(null)).toEqual([]);
    expect(normalizeFeelings(['nope'])).toEqual([]);
  });

  it('后缀按固定顺序拼接；空则空串', () => {
    expect(feelingSuffix([])).toBe('');
    const both = feelingSuffix(['calm', 'order']);
    expect(both.indexOf('秩序感')).toBeLessThan(both.indexOf('从容感'));
    expect(both).toContain('【界面感觉：秩序感】');
    expect(both).toContain('【界面感觉：从容感】');
  });

  it('切换多选', () => {
    expect(toggleFeeling([], 'order')).toEqual(['order']);
    expect(toggleFeeling(['order', 'calm'], 'order')).toEqual(['calm']);
  });
});
