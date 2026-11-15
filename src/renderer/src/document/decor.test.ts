import { describe, expect, it } from 'vitest';
import { planPageExport } from '../../../shared/export';
import { defaultRegions, isDecorCard, isPageCard, isRefCard, type PageCard, type Version } from '../../../shared/project';
import {
  createDecorAt,
  defaultDecorFill,
  newPageCard,
  nudgeSiblingOrder,
  placeIntoPage,
  resizeRefLogical,
  updateDecor,
  updatePage,
  type DocState,
} from './operations';

function version(id: string, width = 100, height = 100): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

function empty(): DocState {
  return { cards: [], regions: defaultRegions(), activeThemeCardId: null };
}

describe('页面装饰与导出', () => {
  it('R 拖出装饰默认主题色或中性灰，圆角 12', () => {
    let state = empty();
    const page = newPageCard(state, { id: 'page', name: '首页', base: version('lowfi', 1179, 2556) });
    state = { ...state, cards: [...state.cards, page] };
    const created = createDecorAt(state, page.id, { x: page.x + 10, y: page.y + 10, width: 80, height: 40 }, () => 'decor1');
    expect(created).not.toBeNull();
    state = created!.state;
    const decor = state.cards.find(isDecorCard)!;
    expect(decor.fill).toBe(defaultDecorFill(state));
    expect(decor.cornerRadius).toBe(12);
  });

  it('导出默认不含低保真；装饰进 shapes；勾选后带 base', () => {
    let state = empty();
    const page = newPageCard(state, { id: 'page', name: '首页', base: version('lowfi', 1179, 2556) });
    state = { ...state, cards: [...state.cards, page] };
    const icon = {
      kind: 'image' as const,
      id: 'icon',
      name: '图标',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      versions: [version('icon')],
      currentVersionId: 'icon',
      groupId: null,
    };
    state = { ...state, cards: [...state.cards, icon] };
    state = placeIntoPage(state, page.id, [{ imageCardId: icon.id, rect: { x: page.x + 20, y: page.y + 20, width: 50, height: 50 } }], () => 'ref1').state;
    state = createDecorAt(state, page.id, { x: page.x + 5, y: page.y + 5, width: 100, height: 60 }, () => 'decor1')!.state;
    const live = state.cards.find((c): c is PageCard => isPageCard(c))!;
    const plan = planPageExport(live, state.cards);
    expect(plan.base).toBeNull();
    expect(plan.shapes).toHaveLength(1);
    expect(plan.shapes[0].fill).toBeTruthy();
    expect(plan.layers).toHaveLength(1);

    const withBase = updatePage(state, page.id, { exportIncludeBase: true });
    const page2 = withBase.cards.find((c): c is PageCard => isPageCard(c))!;
    expect(planPageExport(page2, withBase.cards).base?.file).toBe('assets/lowfi.png');
  });

  it('同类装饰可上下调层；素材引用可按逻辑像素改大小', () => {
    let state = empty();
    const page = newPageCard(state, { id: 'page', name: '首页', base: version('lowfi', 1179, 2556) });
    state = { ...state, cards: [...state.cards, page] };
    state = createDecorAt(state, page.id, { x: page.x, y: page.y, width: 40, height: 40 }, () => 'd1')!.state;
    state = createDecorAt(state, page.id, { x: page.x + 10, y: page.y + 10, width: 40, height: 40 }, () => 'd2')!.state;
    const before = state.cards.filter(isDecorCard).map((c) => c.id);
    expect(before).toEqual(['d1', 'd2']);
    state = nudgeSiblingOrder(state, 'd1', 'forward');
    expect(state.cards.filter(isDecorCard).map((c) => c.id)).toEqual(['d2', 'd1']);

    const icon = {
      kind: 'image' as const,
      id: 'icon',
      name: '图标',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      versions: [version('icon')],
      currentVersionId: 'icon',
      groupId: null,
    };
    state = { ...state, cards: [...state.cards, icon] };
    state = placeIntoPage(state, page.id, [{ imageCardId: icon.id, rect: { x: page.x, y: page.y, width: page.width / 10, height: page.width / 10 } }], () => 'ref1').state;
    const ref = state.cards.find(isRefCard)!;
    state = resizeRefLogical(state, ref.id, { width: 48 }, true);
    const next = state.cards.find(isRefCard)!;
    const live = state.cards.find((c): c is PageCard => isPageCard(c))!;
    const logicalW = (next.width / live.width) * 393;
    expect(Math.round(logicalW)).toBe(48);
  });

  it('改装饰填充与圆角', () => {
    let state = empty();
    const page = newPageCard(state, { id: 'page', name: '首页', base: null });
    state = { ...state, cards: [...state.cards, page] };
    state = createDecorAt(state, page.id, { x: page.x, y: page.y, width: 50, height: 50 }, () => 'd1')!.state;
    state = updateDecor(state, 'd1', { fill: '#FF0000', cornerRadius: 24 });
    const decor = state.cards.find(isDecorCard)!;
    expect(decor.fill).toBe('#FF0000');
    expect(decor.cornerRadius).toBe(24);
  });
});
