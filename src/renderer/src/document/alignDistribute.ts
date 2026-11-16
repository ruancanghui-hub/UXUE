import { isGroupCard, isPageCard, isStrokeCard, type CanvasCard } from '../../../shared/project';
import { unionRects } from '../canvas/geometry';
import type { DocState } from './operations';

export type AlignAction =
  | 'left'
  | 'centerX'
  | 'right'
  | 'top'
  | 'centerY'
  | 'bottom'
  | 'distributeX'
  | 'distributeY';

export const ALIGN_LABELS: Record<AlignAction, string> = {
  left: '左对齐',
  centerX: '水平居中',
  right: '右对齐',
  top: '上对齐',
  centerY: '垂直居中',
  bottom: '下对齐',
  distributeX: '水平均分',
  distributeY: '垂直均分',
};

export function isAlignableCard(card: CanvasCard): boolean {
  return !isPageCard(card) && !isGroupCard(card) && !isStrokeCard(card);
}

export function alignableFromSelection(cards: readonly CanvasCard[], ids: ReadonlySet<string>): CanvasCard[] {
  return cards.filter((card) => ids.has(card.id) && isAlignableCard(card));
}

export function canAlign(count: number, action: AlignAction): boolean {
  if (action === 'distributeX' || action === 'distributeY') return count >= 3;
  return count >= 2;
}

type Item = { id: string; x: number; y: number; width: number; height: number };

/** 计算新位置；不足数量或无需移动时返回 null */
export function computeAlignPositions(items: readonly Item[], action: AlignAction): Map<string, { x: number; y: number }> | null {
  if (!canAlign(items.length, action)) return null;
  const bounds = unionRects(items);
  if (!bounds) return null;

  const next = new Map<string, { x: number; y: number }>();

  if (action === 'distributeX' || action === 'distributeY') {
    const horizontal = action === 'distributeX';
    const sorted = [...items].sort((a, b) => {
      const av = horizontal ? a.x : a.y;
      const bv = horizontal ? b.x : b.y;
      if (av !== bv) return av - bv;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const span = horizontal
      ? last.x + last.width - first.x
      : last.y + last.height - first.y;
    const sizes = sorted.reduce((sum, item) => sum + (horizontal ? item.width : item.height), 0);
    const gap = (span - sizes) / (sorted.length - 1);
    let cursor = horizontal ? first.x : first.y;
    for (const item of sorted) {
      if (horizontal) next.set(item.id, { x: cursor, y: item.y });
      else next.set(item.id, { x: item.x, y: cursor });
      cursor += (horizontal ? item.width : item.height) + gap;
    }
    return positionsChanged(items, next) ? next : null;
  }

  for (const item of items) {
    let x = item.x;
    let y = item.y;
    switch (action) {
      case 'left':
        x = bounds.x;
        break;
      case 'centerX':
        x = bounds.x + bounds.width / 2 - item.width / 2;
        break;
      case 'right':
        x = bounds.x + bounds.width - item.width;
        break;
      case 'top':
        y = bounds.y;
        break;
      case 'centerY':
        y = bounds.y + bounds.height / 2 - item.height / 2;
        break;
      case 'bottom':
        y = bounds.y + bounds.height - item.height;
        break;
    }
    next.set(item.id, { x, y });
  }
  return positionsChanged(items, next) ? next : null;
}

function positionsChanged(items: readonly Item[], next: Map<string, { x: number; y: number }>): boolean {
  for (const item of items) {
    const pos = next.get(item.id);
    if (!pos) return true;
    if (pos.x !== item.x || pos.y !== item.y) return true;
  }
  return false;
}

/** 对选区做多选排齐；无可操作对象时返回 null */
export function alignCards(state: DocState, ids: ReadonlySet<string>, action: AlignAction): DocState | null {
  const items = alignableFromSelection(state.cards, ids);
  const positions = computeAlignPositions(items, action);
  if (!positions) return null;
  let changed = false;
  const cards = state.cards.map((card) => {
    const pos = positions.get(card.id);
    if (!pos || (pos.x === card.x && pos.y === card.y)) return card;
    changed = true;
    return { ...card, x: pos.x, y: pos.y };
  });
  return changed ? { ...state, cards } : null;
}
