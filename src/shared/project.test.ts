import { describe, expect, it } from 'vitest';
import { emptyProject, parseProject, PROJECT_SCHEMA_VERSION } from './project';
import { computeTiles, l2Size, L2_TILE_GUTTER, L2_TILE_SIZE, tileExtent } from './textures';

const validCard = {
  kind: 'image',
  id: 'c1',
  name: '热门寿司',
  x: 10,
  y: 20,
  width: 400,
  height: 200,
  currentVersionId: 'v2',
  versions: [
    { id: 'v1', file: 'assets/v1.png', width: 2000, height: 1000, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' },
    { id: 'v2', file: 'assets/v2.png', width: 2000, height: 1000, createdAt: '2026-01-02T00:00:00.000Z', origin: 'import' },
  ],
};

describe('parseProject', () => {
  it('写出去再读回来完全一致', () => {
    const project = { ...emptyProject(), cards: [validCard], viewport: { originX: 1, originY: 2, zoom: 0.5 } };
    const { project: parsed, warnings } = parseProject(JSON.parse(JSON.stringify(project)));
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(project);
  });

  it('跳过坏掉的图像卡，其余照常打开', () => {
    const raw = {
      ...emptyProject(),
      cards: [validCard, { kind: 'image', id: 'broken' }, { ...validCard }, { ...validCard, id: 'c2', versions: [] }],
    };
    const { project, warnings } = parseProject(raw);
    expect(project.cards.map((card) => card.id)).toEqual(['c1']);
    expect(warnings).toHaveLength(3);
  });

  it('当前版本 id 无效时退回最后一个版本', () => {
    const { project } = parseProject({ ...emptyProject(), cards: [{ ...validCard, currentVersionId: 'nope' }] });
    expect(project.cards[0].currentVersionId).toBe('v2');
  });

  it('拒绝指向项目目录以外的文件路径', () => {
    const escaping = { ...validCard, versions: [{ ...validCard.versions[0], file: '../../etc/passwd' }], currentVersionId: 'v1' };
    expect(parseProject({ ...emptyProject(), cards: [escaping] }).project.cards).toEqual([]);
  });

  it('版本号不对时直接报错，不去猜结构', () => {
    expect(() => parseProject({ schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toThrow(/版本/);
  });

  it('缺少区域时补上默认的三个区域', () => {
    const { project } = parseProject({ schemaVersion: PROJECT_SCHEMA_VERSION, cards: [] });
    expect(project.regions.map((region) => region.id)).toEqual(['theme', 'assets', 'pages']);
  });
});

describe('L2 切块', () => {
  it('超过 4096 的原图先等比缩到 4096', () => {
    expect(l2Size(8000, 4000)).toEqual({ width: 4096, height: 2048 });
    expect(l2Size(1200, 900)).toEqual({ width: 1200, height: 900 });
  });

  it('切块无缝覆盖整张图，内侧边各多带 1px', () => {
    const width = 2500;
    const height = 1100;
    const tiles = computeTiles(width, height);
    expect(tiles).toHaveLength(3 * 2);
    expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(width * height);

    const inner = tiles.find((tile) => tile.x === L2_TILE_SIZE && tile.y === 0)!;
    const extent = tileExtent(inner, width, height);
    expect(extent.left).toBe(L2_TILE_SIZE - L2_TILE_GUTTER);
    expect(extent.width).toBe(L2_TILE_SIZE + 2 * L2_TILE_GUTTER);
    expect(extent.height).toBe(L2_TILE_SIZE + L2_TILE_GUTTER);
  });
});
