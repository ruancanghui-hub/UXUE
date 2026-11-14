import { describe, expect, it } from 'vitest';
import { emptyProject, parseProject, PROJECT_SCHEMA_VERSION } from './project';
import { computeTiles, l2Size, L2_TILE_GUTTER, L2_TILE_SIZE, tileExtent } from './textures';

const validCard = {
  kind: 'image' as const,
  id: 'c1',
  name: '热门寿司',
  x: 10,
  y: 20,
  width: 400,
  height: 200,
  currentVersionId: 'v2',
  groupId: null as string | null,
  versions: [
    { id: 'v1', file: 'assets/v1.png', width: 2000, height: 1000, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' as const },
    { id: 'v2', file: 'assets/v2.png', width: 2000, height: 1000, createdAt: '2026-01-02T00:00:00.000Z', origin: 'import' as const },
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
    expect(project.cards[0]).toMatchObject({ currentVersionId: 'v2' });
  });

  it('提示词卡读回来完整，引用到不存在的图像卡时去掉引用', () => {
    const prompt = {
      kind: 'prompt',
      id: 'p1',
      name: '转 3D',
      x: 500,
      y: 0,
      width: 360,
      height: 220,
      text: '把 {{Image 1}} 转为 3D',
      inputs: ['c1', 'gone'],
      outputCardId: 'gone-too',
      settings: { count: 9, size: 'match', quality: 'high' },
      groupId: null,
    };
    const { project } = parseProject({ ...emptyProject(), cards: [validCard, prompt] });
    expect(project.cards[1]).toEqual({
      ...prompt,
      inputs: ['c1'],
      outputCardId: null,
      settings: { count: 4, size: 'match', quality: 'high', useTheme: true },
      groupId: null,
      purpose: null,
    });
  });

  it('生成得到的版本保留来源记录', () => {
    const generated = {
      ...validCard.versions[1],
      origin: 'generate',
      generation: {
        promptCardId: 'p1',
        prompt: '把 Image 1 转为 3D',
        inputVersionIds: ['v1'],
        provider: 'openai',
        model: 'gpt-image-2.6-flare',
        quality: 'medium',
        size: '1536x1024',
        costUsd: 0.04,
        jobId: 'j1',
        themeCardId: null,
      },
    };
    const card = { ...validCard, versions: [validCard.versions[0], generated] };
    const { project } = parseProject(JSON.parse(JSON.stringify({ ...emptyProject(), cards: [card] })));
    expect(project.cards[0]).toEqual(card);
  });

  it('拒绝指向项目目录以外的文件路径', () => {
    const escaping = { ...validCard, versions: [{ ...validCard.versions[0], file: '../../etc/passwd' }], currentVersionId: 'v1' };
    expect(parseProject({ ...emptyProject(), cards: [escaping] }).project.cards).toEqual([]);
  });

  it('主题卡读回来完整；颜色不合法的跳过；生效主题卡 id 无效时清空', () => {
    const theme = {
      kind: 'theme',
      id: 't1',
      name: '寿司',
      x: 0,
      y: 0,
      width: 420,
      height: 500,
      topic: '日式寿司点餐',
      keywords: ['新鲜', '热闹'],
      cues: ['寿司'],
      palette: [
        { role: '主色', name: '红', hex: '#E8473C', note: '按钮' },
        { role: '坏的', name: '', hex: 'red', note: '' },
      ],
      rules: { shape: '圆润', material: '哑光', lighting: '柔光', color: '偏暖' },
      groupId: null,
      sourceImageCardId: null,
      sourceVersionId: null,
    };
    const { project } = parseProject({ ...emptyProject(), cards: [theme], activeThemeCardId: 't1' });
    expect(project.cards[0]).toEqual({ ...theme, palette: [theme.palette[0]] });
    expect(project.activeThemeCardId).toBe('t1');
    expect(parseProject({ ...emptyProject(), cards: [theme], activeThemeCardId: 'nope' }).project.activeThemeCardId).toBeNull();
  });

  it('主题卡可带主题来源；来源图不存在时清掉', () => {
    const theme = {
      kind: 'theme' as const,
      id: 't1',
      name: '寿司',
      x: 0,
      y: 0,
      width: 420,
      height: 500,
      topic: '日式寿司点餐',
      keywords: ['新鲜'],
      cues: ['寿司'],
      palette: [{ role: '主色', name: '红', hex: '#E8473C', note: '' }],
      rules: { shape: '', material: '', lighting: '', color: '' },
      groupId: null,
      sourceImageCardId: 'c1',
      sourceVersionId: 'v2',
    };
    const withSource = parseProject({ ...emptyProject(), cards: [validCard, theme] });
    expect(withSource.project.cards.find((c) => c.id === 't1')).toMatchObject({
      sourceImageCardId: 'c1',
      sourceVersionId: 'v2',
    });
    const orphan = parseProject({ ...emptyProject(), cards: [theme] });
    expect(orphan.project.cards[0]).toMatchObject({ sourceImageCardId: null, sourceVersionId: null });
    expect(orphan.warnings.some((w) => w.includes('主题来源'))).toBe(true);
  });

  it('能打开 schema 1 的项目并升到当前版本', () => {
    const { project } = parseProject({ schemaVersion: 1, cards: [validCard] });
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(project.cards[0]).toMatchObject({ id: 'c1', groupId: null });
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
