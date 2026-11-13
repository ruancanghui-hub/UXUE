import { describe, expect, it } from 'vitest';
import { defaultRegions, type ImageCard, type Version } from '../../../shared/project';
import { DocumentStore } from './DocumentStore';
import {
  addCards,
  addVersions,
  duplicateCards,
  layoutNewCards,
  MIN_CARD_EDGE,
  moveCards,
  regionOf,
  removeCards,
  reorderCards,
  scaleCards,
  setCurrentVersion,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `id-${++counter}`;

function version(id: string, width = 2000, height = 1000): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import', sourceName: `${id}.png` };
}

function img(state: DocState, index: number): ImageCard {
  return state.cards[index] as ImageCard;
}

function emptyState(): DocState {
  return { cards: [], regions: defaultRegions() };
}

function stateWith(count: number): DocState {
  return addCards(emptyState(), layoutNewCards(Array.from({ length: count }, (_, i) => version(`v${i}`)), 1000, 1000, makeId));
}

describe('layoutNewCards', () => {
  it('长边超过 800 的图缩到 800，保持比例，整体居中', () => {
    const cards = layoutNewCards([version('a', 2000, 1000)], 500, 500, makeId);
    expect(cards[0]).toMatchObject({ width: 800, height: 400, x: 100, y: 300, name: 'a', currentVersionId: 'a' });
  });

  it('一次导入 100 张时整批能放进一个 6000 × 4000 的区域', () => {
    const cards = layoutNewCards(Array.from({ length: 100 }, (_, i) => version(`b${i}`, 2048, 2048)), 0, 0, makeId);
    const minX = Math.min(...cards.map((c) => c.x));
    const maxX = Math.max(...cards.map((c) => c.x + c.width));
    const minY = Math.min(...cards.map((c) => c.y));
    const maxY = Math.max(...cards.map((c) => c.y + c.height));
    expect(maxX - minX).toBeLessThan(6000);
    expect(maxY - minY).toBeLessThan(4000);
  });

  it('小图保持原尺寸，多张排成网格不重叠', () => {
    const cards = layoutNewCards(Array.from({ length: 7 }, (_, i) => version(`s${i}`, 100, 50)), 0, 0, makeId);
    expect(cards.every((card) => card.width === 100 && card.height === 50)).toBe(true);
    for (const a of cards) {
      for (const b of cards) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('图像卡操作', () => {
  it('移动按手势起点的绝对偏移计算', () => {
    const state = stateWith(2);
    const origins = new Map([[state.cards[0].id, state.cards[0]]]);
    const once = moveCards(state, origins, 10, 0);
    const twice = moveCards(once, origins, 25, 5);
    expect(twice.cards[0].x).toBe(state.cards[0].x + 25);
    expect(twice.cards[0].y).toBe(state.cards[0].y + 5);
    expect(twice.cards[1]).toBe(state.cards[1]);
  });

  it('等比缩放以锚点为不动点，并且不会缩到最小边长以下', () => {
    const state = stateWith(1);
    const card = state.cards[0];
    const origins = new Map([[card.id, card]]);
    const scaled = scaleCards(state, origins, card.x, card.y, 2).cards[0];
    expect(scaled).toMatchObject({ x: card.x, y: card.y, width: card.width * 2, height: card.height * 2 });
    const tiny = scaleCards(state, origins, card.x, card.y, 0.0001).cards[0];
    expect(Math.min(tiny.width, tiny.height)).toBeCloseTo(MIN_CARD_EDGE);
  });

  it('切换当前版本时宽度不变、高度跟随新比例', () => {
    let state = stateWith(1);
    const id = state.cards[0].id;
    state = addVersions(state, id, [version('square', 500, 500)]);
    expect(img(state, 0).currentVersionId).toBe('square');
    expect(state.cards[0].height).toBe(state.cards[0].width);
    state = setCurrentVersion(state, id, 'v0');
    expect(state.cards[0].height).toBe(state.cards[0].width / 2);
  });

  it('无变化的操作返回同一个快照，不会产生空的历史记录', () => {
    const state = stateWith(1);
    expect(setCurrentVersion(state, state.cards[0].id, img(state, 0).currentVersionId)).toBe(state);
    expect(moveCards(state, new Map(), 10, 10)).toBe(state);
  });

  it('副本共享版本、换新 id、偏移 40', () => {
    const state = stateWith(2);
    const { state: next, newIds } = duplicateCards(state, new Set([state.cards[0].id]), makeId);
    expect(next.cards).toHaveLength(3);
    const copy = next.cards[2] as ImageCard;
    expect(newIds).toEqual([copy.id]);
    expect(copy.versions).toBe(img(state, 0).versions);
    expect(copy.x).toBe(state.cards[0].x + 40);
  });

  it('移到最前 / 最后保持被选卡片之间的相对顺序', () => {
    const state = stateWith(4);
    const [a, b, c, d] = state.cards.map((card) => card.id);
    expect(reorderCards(state, new Set([a, c]), 'front').cards.map((x) => x.id)).toEqual([b, d, a, c]);
    expect(reorderCards(state, new Set([b, d]), 'back').cards.map((x) => x.id)).toEqual([b, d, a, c]);
  });

  it('按卡片中心判断所在区域', () => {
    const state = emptyState();
    const [theme, assets] = state.regions;
    expect(regionOf(state, { x: theme.x + 10, y: 10, width: 100, height: 100 })).toBe('theme');
    expect(regionOf(state, { x: assets.x + 10, y: 10, width: 100, height: 100 })).toBe('assets');
    expect(regionOf(state, { x: -5000, y: -5000, width: 10, height: 10 })).toBeNull();
  });
});

describe('DocumentStore 撤销重做', () => {
  it('每一步都能撤销回去、再重做回来', () => {
    const store = new DocumentStore(emptyState());
    const history: DocState[] = [store.get()];
    store.apply('导入', stateWith(3));
    history.push(store.get());
    store.apply('删除', removeCards(store.get(), new Set([store.get().cards[0].id])));
    history.push(store.get());

    expect(store.undo()).toBe('删除');
    expect(store.get()).toBe(history[1]);
    expect(store.undo()).toBe('导入');
    expect(store.get()).toBe(history[0]);
    expect(store.undo()).toBeNull();
    expect(store.redo()).toBe('导入');
    expect(store.redo()).toBe('删除');
    expect(store.get()).toBe(history[2]);
  });

  it('手势中间状态不进历史，整个手势合成一步', () => {
    const store = new DocumentStore(stateWith(1));
    const start = store.get();
    const origins = new Map([[start.cards[0].id, start.cards[0]]]);
    const changes: string[] = [];
    store.subscribe((_state, change) => changes.push(change));

    store.beginGesture('移动');
    for (let i = 1; i <= 5; i++) store.updateGesture(moveCards(store.get(), origins, i, i));
    store.commitGesture();

    expect(changes).toEqual(['transient', 'transient', 'transient', 'transient', 'transient', 'commit']);
    store.undo();
    expect(store.get()).toBe(start);
    expect(store.canUndo()).toBe(false);
  });

  it('没有移动的手势不产生历史；取消手势回到起点', () => {
    const store = new DocumentStore(stateWith(1));
    const start = store.get();
    store.beginGesture('移动');
    store.commitGesture();
    expect(store.canUndo()).toBe(false);

    store.beginGesture('移动');
    store.updateGesture(moveCards(store.get(), new Map([[start.cards[0].id, start.cards[0]]]), 50, 0));
    store.cancelGesture();
    expect(store.get()).toBe(start);
    expect(store.canUndo()).toBe(false);
  });

  it('新改动会清掉重做栈', () => {
    const store = new DocumentStore(emptyState());
    store.apply('导入', stateWith(1));
    store.undo();
    store.apply('导入', stateWith(2));
    expect(store.canRedo()).toBe(false);
  });
});
