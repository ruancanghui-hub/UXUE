/** 画布选择修饰键：与图层面板一致（Shift / ⌘ / Ctrl 加减选） */

export type MarqueeMode = 'replace' | 'add' | 'subtract';

export function selectionAdditive(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey;
}

/** ⌥ 优先为减选框；否则 Shift/⌘ 为加选框；否则替换 */
export function marqueeMode(event: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): MarqueeMode {
  if (event.altKey) return 'subtract';
  if (selectionAdditive(event)) return 'add';
  return 'replace';
}

export function applyMarqueeSelection(
  base: ReadonlySet<string>,
  hitIds: Iterable<string>,
  mode: MarqueeMode,
): string[] {
  const hits = [...hitIds];
  if (mode === 'replace') return hits;
  if (mode === 'add') {
    const next = new Set(base);
    for (const id of hits) next.add(id);
    return [...next];
  }
  const next = new Set(base);
  for (const id of hits) next.delete(id);
  return [...next];
}
