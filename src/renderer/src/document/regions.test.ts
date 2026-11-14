import { describe, expect, it } from 'vitest';
import {
  defaultRegions,
  isPageCard,
  isRefCard,
  parseProject,
  PROJECT_SCHEMA_VERSION,
  REGION_MIN_HEIGHT,
  REGION_WIDTH,
  type CanvasCard,
  type ImageCard,
  type Region,
  type Version,
} from '../../../shared/project';
import { DocumentStore } from './DocumentStore';
import { addCards, fitRegionsToContent, layoutNewCards, newPageCard, placeIntoPage, regionOf, removeCards, type DocState } from './operations';

let counter = 0;
const makeId = (): string => `r-${++counter}`;
const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };

function version(id: string, width = 400, height = 400): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

function imageAt(x: number, y: number): ImageCard {
  const [card] = layoutNewCards([version(`v${++counter}`)], 0, 0, makeId);
  return { ...card, x, y };
}

describe('区域大小', () => {
  it('新项目三个区域各 12000 宽、4000 高，从左到右并排', () => {
    const regions = defaultRegions();
    expect(regions.map((r) => [r.x, r.width, r.height])).toEqual([
      [0, REGION_WIDTH, REGION_MIN_HEIGHT],
      [REGION_WIDTH + 600, REGION_WIDTH, REGION_MIN_HEIGHT],
      [(REGION_WIDTH + 600) * 2, REGION_WIDTH, REGION_MIN_HEIGHT],
    ]);
  });

  it('内容超出底部时区域自动长高，删掉后缩回最小高度；高度不变时返回同一个快照', () => {
    const assets = empty.regions[1];
    const low = imageAt(assets.x + 100, 9000);
    const grown = fitRegionsToContent(addCards(empty, [low]));
    expect(grown.regions[1].height).toBe(9000 + low.height + 600);
    expect(grown.regions[0].height).toBe(REGION_MIN_HEIGHT);
    const shrunk = fitRegionsToContent(removeCards(grown, new Set([low.id])));
    expect(shrunk.regions[1].height).toBe(REGION_MIN_HEIGHT);
    expect(fitRegionsToContent(shrunk)).toBe(shrunk);
  });

  it('区域下方很远的卡片仍然归到这一列', () => {
    const pages = empty.regions[2];
    expect(regionOf(empty, { x: pages.x + 50, y: 50_000, width: 10, height: 10 })).toBe('pages');
    expect(regionOf(empty, { x: pages.x + 50, y: -500, width: 10, height: 10 })).toBeNull();
  });

  it('文档仓库每次改动后自动调高度，撤销后回到原来的高度', () => {
    const store = new DocumentStore(empty, fitRegionsToContent);
    const theme = store.get().regions[0];
    store.apply('导入', addCards(store.get(), [imageAt(theme.x + 10, 6000)]));
    expect(store.get().regions[0].height).toBeGreaterThan(REGION_MIN_HEIGHT);
    store.undo();
    expect(store.get().regions[0].height).toBe(REGION_MIN_HEIGHT);
  });
});

describe('旧项目迁移', () => {
  it('6000 宽的旧区域放宽到 12000，核心素材区和高保真页面区的内容分别右移 6000 和 12000，页面框和引用仍对齐', () => {
    const legacy: Region[] = [
      { id: 'theme', name: '视觉主题区', x: 0, y: 0, width: 6000, height: 4000 },
      { id: 'assets', name: '核心素材区', x: 6600, y: 0, width: 6000, height: 4000 },
      { id: 'pages', name: '高保真页面区', x: 13200, y: 0, width: 6000, height: 4000 },
    ];
    const inTheme = imageAt(200, 200);
    const inAssets = imageAt(6800, 300);
    const legacyState: DocState = { ...empty, regions: legacy };
    const page = { ...newPageCard(legacyState, { id: 'page', name: '首页', base: null }), x: 13400, y: 200 };
    const placed = placeIntoPage(addCards(legacyState, [inTheme, inAssets, page]), page.id, [{ imageCardId: inAssets.id, rect: { x: 13450, y: 260, width: 100, height: 100 } }], makeId);
    const raw = JSON.parse(JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, regions: legacy, cards: placed.state.cards, activeThemeCardId: null, viewport: null }));

    const { project, warnings } = parseProject(raw);
    expect(project.regions.map((r) => r.width)).toEqual([REGION_WIDTH, REGION_WIDTH, REGION_WIDTH]);
    expect(warnings.some((w) => w.includes('区域已放大'))).toBe(true);
    const byId = new Map(project.cards.map((c): [string, CanvasCard] => [c.id, c]));
    expect(byId.get(inTheme.id)!.x).toBe(200);
    expect(byId.get(inAssets.id)!.x).toBe(6800 + 6000);
    const movedPage = project.cards.find(isPageCard)!;
    const movedRef = project.cards.find(isRefCard)!;
    expect(movedPage.x).toBe(13400 + 12000);
    expect(movedRef.x - movedPage.x).toBe(13450 - 13400);
    expect(regionOf({ ...empty, regions: project.regions }, movedPage)).toBe('pages');

    const again = parseProject(JSON.parse(JSON.stringify(project)));
    expect(again.warnings).toEqual([]);
    expect(again.project.cards.find(isPageCard)!.x).toBe(movedPage.x);
  });
});
