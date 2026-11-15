import { describe, expect, it } from 'vitest';
import { applyMarqueeSelection, marqueeMode, selectionAdditive } from './selectionModifiers';

describe('画布选择修饰键', () => {
  it('Shift / ⌘ / Ctrl 都算加选键', () => {
    expect(selectionAdditive({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(true);
    expect(selectionAdditive({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(selectionAdditive({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
    expect(selectionAdditive({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('框选模式：⌥ 减选优先于加选', () => {
    expect(marqueeMode({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false })).toBe('replace');
    expect(marqueeMode({ shiftKey: true, metaKey: false, ctrlKey: false, altKey: false })).toBe('add');
    expect(marqueeMode({ shiftKey: false, metaKey: true, ctrlKey: false, altKey: false })).toBe('add');
    expect(marqueeMode({ shiftKey: true, metaKey: false, ctrlKey: false, altKey: true })).toBe('subtract');
  });

  it('框选并集 / 差集 / 替换', () => {
    const base = new Set(['a', 'b']);
    expect(applyMarqueeSelection(base, ['b', 'c'], 'replace').sort()).toEqual(['b', 'c']);
    expect(applyMarqueeSelection(base, ['b', 'c'], 'add').sort()).toEqual(['a', 'b', 'c']);
    expect(applyMarqueeSelection(base, ['b', 'c'], 'subtract').sort()).toEqual(['a']);
  });
});
