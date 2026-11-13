import { describe, expect, it } from 'vitest';
import { planPageExport, safeFileName } from '../../../shared/export';
import { defaultRegions, detectPreset, isRefCard, type ImageCard, type PageCard, type RefCard, type Version } from '../../../shared/project';
import {
  addCards,
  addVersions,
  duplicateCards,
  fitIntoPage,
  layoutNewCards,
  newPageCard,
  placeIntoPage,
  reassignRefPages,
  removeCards,
  renderOrder,
  reorderCards,
  setCurrentVersion,
  withPageChildren,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `id-${++counter}`;

function version(id: string, width: number, height: number): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

function setup(): { state: DocState; page: PageCard; icon: ImageCard; refId: string } {
  const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };
  const [icon] = layoutNewCards([version('icon', 1000, 1000)], 0, 0, makeId);
  const page = newPageCard(empty, { id: 'page', name: '首页', base: version('lowfi', 1179, 2556) });
  const withCards = addCards(empty, [icon, page]);
  const { state, refIds } = placeIntoPage(withCards, page.id, [{ imageCardId: icon.id, rect: { x: page.x + 10, y: page.y + 20, width: 100, height: 100 } }], makeId);
  return { state, page, icon, refId: refIds[0] };
}

describe('页面框', () => {
  it('认出设备尺寸：iPhone 3 倍图、2 倍图，其它尺寸不认', () => {
    expect(detectPreset(1179, 2556)).toEqual({ presetId: 'iphone', scale: 3 });
    expect(detectPreset(786, 1704)).toEqual({ presetId: 'iphone', scale: 2 });
    expect(detectPreset(2880, 1800)).toEqual({ presetId: 'desktop', scale: 2 });
    expect(detectPreset(1000, 1000)).toBeNull();
  });

  it('从低保真原型新建：放进高保真页面区，比例按设备', () => {
    const { page, state } = setup();
    const pages = state.regions.find((r) => r.id === 'pages')!;
    expect(page.x).toBeGreaterThanOrEqual(pages.x);
    expect(page).toMatchObject({ devicePreset: 'iphone', exportScale: 3, width: 480 });
    expect(page.height).toBeCloseTo(480 * (852 / 393));
  });

  it('放进页面的素材比页面大时缩到页面宽度的 90%', () => {
    const rect = fitIntoPage({ x: 0, y: 0, width: 400, height: 800 }, { x: 0, y: 0, width: 800, height: 400 }, 200, 300);
    expect(rect).toEqual({ x: 20, y: 210, width: 360, height: 180 });
  });

  it('删除页面框连同里面的引用；删除被引用的图像卡也去掉引用；撤销都能恢复', () => {
    const { state, page, icon, refId } = setup();
    expect(removeCards(state, new Set([page.id])).cards.some((c) => c.id === refId)).toBe(false);
    expect(removeCards(state, new Set([icon.id])).cards.some((c) => c.id === refId)).toBe(false);
    expect(state.cards.some((c) => c.id === refId)).toBe(true);
  });

  it('复制页面框时里面的引用一起复制并指向新页面', () => {
    const { state, page } = setup();
    const { state: next, newIds } = duplicateCards(state, new Set([page.id]), makeId);
    const copies = next.cards.filter((c): c is RefCard => isRefCard(c) && c.pageId === newIds[0]);
    expect(copies).toHaveLength(1);
  });

  it('拖动页面框时引用一起动', () => {
    const { state, page, refId } = setup();
    expect([...withPageChildren(state, [page.id])].sort()).toEqual([page.id, refId].sort());
  });

  it('引用按中心点重新认页面，拖出页面就脱离', () => {
    const { state, refId } = setup();
    const outside = { ...state, cards: state.cards.map((c) => (c.id === refId ? { ...c, x: -9999, y: -9999 } : c)) };
    const ref = reassignRefPages(outside, new Set([refId])).cards.find((c) => c.id === refId) as RefCard;
    expect(ref.pageId).toBeNull();
  });

  it('引用总是画在自己的页面框上面，页面挪到最前时一起走', () => {
    const { state, page, icon, refId } = setup();
    const back = reorderCards(state, new Set([page.id]), 'front');
    expect(renderOrder(back.cards).map((c) => c.id)).toEqual([icon.id, page.id, refId]);
  });

  it('换当前版本时引用的高度跟着新比例', () => {
    const { state, icon, refId } = setup();
    const withWide = addVersions(state, icon.id, [version('wide', 2000, 1000)]);
    const ref = withWide.cards.find((c) => c.id === refId) as RefCard;
    expect(ref.height).toBe(50);
    const back = setCurrentVersion(withWide, icon.id, 'icon');
    expect((back.cards.find((c) => c.id === refId) as RefCard).height).toBe(100);
  });
});

describe('导出', () => {
  it('画布坐标按页面宽度换算成导出像素（iPhone 3 倍 = 1179 × 2556）', () => {
    const { state, page } = setup();
    const plan = planPageExport(page, state.cards);
    expect(plan).toMatchObject({ width: 1179, height: 2556, logicalWidth: 393, logicalHeight: 852, exportScale: 3 });
    const s = 1179 / page.width;
    expect(plan.layers[0]).toMatchObject({ x: Math.round(10 * s), y: Math.round(20 * s), width: Math.round(100 * s) });
    expect(plan.layers[0].file).toBe('assets/icon.png');
  });

  it('同名素材的图层名加序号；文件名去掉非法字符', () => {
    const { state, page, icon } = setup();
    const twice = placeIntoPage(state, page.id, [{ imageCardId: icon.id, rect: { x: page.x, y: page.y, width: 50, height: 50 } }], makeId).state;
    const names = planPageExport(page, twice.cards).layers.map((l) => l.name);
    expect(names).toEqual([icon.name, `${icon.name} 2`]);
    expect(safeFileName('a/b:c?')).toBe('a_b_c_');
  });
});
