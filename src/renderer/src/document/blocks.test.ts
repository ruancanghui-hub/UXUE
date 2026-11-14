import { describe, expect, it } from 'vitest';
import { normalizeBlockCoordinates, sanitizeAssistantOutput, type BlockDraft } from '../../../shared/assistant';
import { planPageExport } from '../../../shared/export';
import {
  blockPixelRect,
  defaultRegions,
  isBlockCard,
  isBlockCropStale,
  isGroupCard,
  isImageCard,
  isPromptCard,
  isRefCard,
  parseProject,
  PROJECT_SCHEMA_VERSION,
  type BlockCard,
  type PageCard,
  type Version,
} from '../../../shared/project';
import {
  addCards,
  applyBlockPrompts,
  applyDecomposition,
  applyGenerationResult,
  duplicateCards,
  moveCards,
  newPageCard,
  pageBlocks,
  placeBlockCrops,
  removeCards,
  renderOrder,
  resizeBlock,
  withPageChildren,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `id-${++counter}`;

function version(id: string, width: number, height: number): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

const DRAFTS: BlockDraft[] = [
  { name: 'Banner', type: 'hero', group: null, x: 0, y: 100, width: 1000, height: 250 },
  { name: '金刚位 1', type: 'icon', group: '金刚位', x: 100, y: 400, width: 150, height: 70 },
  { name: '金刚位 2', type: 'icon', group: '金刚位', x: 300, y: 400, width: 150, height: 70 },
];

function setup(): { state: DocState; page: PageCard; blocks: BlockCard[] } {
  const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };
  const page = newPageCard(empty, { id: 'page', name: '首页', base: version('lowfi', 1179, 2556) });
  const applied = applyDecomposition(addCards(empty, [page]), page.id, DRAFTS, makeId);
  return { state: applied.state, page, blocks: pageBlocks(applied.state, page.id) };
}

/** 给区块裁截图、写提示词，再模拟第一次生成完成 */
function throughGeneration(): { state: DocState; page: PageCard; banner: BlockCard; outputId: string } {
  const { state, page, blocks } = setup();
  const crops = blocks.map((block) => ({ blockId: block.id, version: version(`crop-${block.id}`, 600, 300) }));
  const cropped = placeBlockCrops(state, page.id, crops, makeId).state;
  const ordered = pageBlocks(cropped, page.id);
  const written = applyBlockPrompts(
    cropped,
    ordered,
    ordered.map((block, i) => ({ name: block.name, text: `画 ${block.name} {{Image 1}}`, inputIndex: i + 1 })),
    makeId,
  ).state;
  const banner = pageBlocks(written, page.id).find((block) => block.blockType === 'hero')!;
  const outputId = 'out-1';
  const result = { promptCardId: banner.promptCardId!, outputCardId: outputId, versions: [version('gen-1', 1200, 600)], placement: { x: 0, y: 0, width: 300, height: 150 } };
  return { state: applyGenerationResult(written, result), page, banner, outputId };
}

describe('拆解', () => {
  it('按 0–1000 坐标在页面框里放区块，带类型和组', () => {
    const { page, blocks } = setup();
    expect(blocks).toHaveLength(3);
    const banner = blocks[0];
    expect(banner).toMatchObject({ blockType: 'hero', group: null, pageId: page.id, cropCardId: null, promptCardId: null });
    expect(banner.x).toBeCloseTo(page.x);
    expect(banner.y).toBeCloseTo(page.y + page.height * 0.1);
    expect(banner.width).toBeCloseTo(page.width);
    expect(blocks[1].group).toBe('金刚位');
  });

  it('再次拆解：已经有输出的区块保留，其余换成新提议', () => {
    const { state, page, banner } = throughGeneration();
    const again = applyDecomposition(state, page.id, [{ name: '新瓷片', type: 'tile', group: null, x: 0, y: 600, width: 500, height: 200 }], makeId).state;
    const names = pageBlocks(again, page.id).map((block) => block.name);
    expect(names).toContain(banner.name);
    expect(names).toContain('新瓷片');
    expect(names).not.toContain('金刚位 1');
  });

  it('助手给像素、0–1 小数或 0–1000 都换成 0–1000', () => {
    const blocksOf = (raw: unknown): { x: number; y: number; width: number; height: number }[] =>
      sanitizeAssistantOutput(normalizeBlockCoordinates(raw, 416, 870), 1).blocks;
    const pixels = { blocks: [{ name: '头像', type: 'illustration', group: null, x: 104, y: 87, width: 208, height: 174 }] };
    expect(blocksOf(pixels)[0]).toMatchObject({ x: 250, y: 100, width: 500, height: 200 });
    const fractions = { blocks: [{ name: '头像', type: 'illustration', group: null, x: 0.25, y: 0.1, width: 0.5, height: 0.2 }] };
    expect(blocksOf(fractions)[0]).toMatchObject({ x: 250, y: 100, width: 500, height: 200 });
    const permille = { blocks: [{ name: '导航', type: 'tabbar', group: null, x: 250, y: 900, width: 100, height: 60 }] };
    expect(blocksOf(permille)[0]).toMatchObject({ x: 250, y: 900, width: 100, height: 60 });
  });

  it('助手返回的区块坐标被夹到 0–1000，太小的丢掉，未知类型记为其他', () => {
    const out = sanitizeAssistantOutput(
      {
        reply: 'ok',
        theme: null,
        prompts: [],
        blocks: [
          { name: 'A', type: 'hero', group: '', x: -20, y: 900, width: 2000, height: 300 },
          { name: 'B', type: 'weird', group: null, x: 10, y: 10, width: 2, height: 50 },
          { name: 'C', type: 'weird', group: null, x: 10, y: 10, width: 50, height: 50 },
        ],
      },
      1,
    );
    expect(out.blocks).toEqual([
      { name: 'A', type: 'hero', group: null, x: 0, y: 900, width: 1000, height: 100 },
      { name: 'C', type: 'other', group: null, x: 10, y: 10, width: 50, height: 50 },
    ]);
  });
});

describe('区块跟着页面框', () => {
  it('移动、复制、删除页面框时区块一起；复制出的区块不带截图和提示词', () => {
    const { state, page } = throughGeneration();
    const ids = withPageChildren(state, [page.id]);
    expect(pageBlocks(state, page.id).every((block) => ids.has(block.id))).toBe(true);

    const { state: copied, newIds } = duplicateCards(state, new Set([page.id]), makeId);
    const copies = pageBlocks(copied, newIds[0]);
    expect(copies).toHaveLength(3);
    expect(copies.every((block) => !block.cropCardId && !block.promptCardId && !block.cropRect)).toBe(true);

    const removed = removeCards(state, new Set([page.id]));
    expect(removed.cards.some(isBlockCard)).toBe(false);
  });

  it('绘制顺序：页面框 → 区块 → 素材引用', () => {
    const { state, page } = throughGeneration();
    const order = renderOrder(state.cards).map((card) => card.kind);
    const pageIndex = renderOrder(state.cards).findIndex((card) => card.id === page.id);
    expect(order.slice(pageIndex, pageIndex + 5)).toEqual(['page', 'block', 'block', 'block', 'ref']);
  });

  it('单个区块自由缩放（不等比），对角固定', () => {
    const { state, blocks } = setup();
    const block = blocks[1];
    const next = resizeBlock(state, block, block.x, block.y, block.x + 200, block.y + 30);
    const resized = next.cards.find((card) => card.id === block.id)!;
    expect(resized).toMatchObject({ x: block.x, y: block.y, width: 200, height: 30 });
  });
});

describe('区块截图', () => {
  it('截图放进核心素材区的分组框，每个区块一行，记下截图时的位置', () => {
    const { state, page, blocks } = setup();
    const placed = placeBlockCrops(state, page.id, blocks.map((b) => ({ blockId: b.id, version: version(`c-${b.id}`, 400, 200) })), makeId);
    const group = placed.state.cards.find(isGroupCard)!;
    expect(group.name).toBe('首页 · 区块');
    const assets = state.regions.find((r) => r.id === 'assets')!;
    expect(group.x).toBeGreaterThanOrEqual(assets.x);
    const crops = placed.state.cards.filter(isImageCard);
    expect(crops).toHaveLength(3);
    expect(crops.every((crop) => crop.groupId === group.id)).toBe(true);
    const ys = crops.map((crop) => crop.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(pageBlocks(placed.state, page.id).every((block) => block.cropCardId && block.cropRect)).toBe(true);
  });

  it('区块相对原型挪动后截图过时；整个页面框一起移动不算；再裁一次追加新版本', () => {
    const { state, page, banner } = throughGeneration();
    const withChildren = new Map(state.cards.filter((card) => withPageChildren(state, [page.id]).has(card.id)).map((card) => [card.id, card]));
    const movedAll = moveCards(state, withChildren, 500, 300);
    const movedPage = movedAll.cards.find((card): card is PageCard => card.id === page.id)!;
    const bannerAfterAll = pageBlocks(movedAll, page.id).find((b) => b.id === banner.id)!;
    expect(isBlockCropStale(bannerAfterAll, movedPage)).toBe(false);

    const movedOne = moveCards(state, new Map([[banner.id, banner]]), 0, 40);
    const bannerMoved = pageBlocks(movedOne, page.id).find((b) => b.id === banner.id)!;
    expect(isBlockCropStale(bannerMoved, page)).toBe(true);

    const refreshed = placeBlockCrops(movedOne, page.id, [{ blockId: banner.id, version: version('crop-v2', 600, 300) }], makeId).state;
    const crop = refreshed.cards.find((card) => card.id === banner.cropCardId);
    expect(crop && isImageCard(crop) && crop.versions.length).toBe(2);
    expect(crop && isImageCard(crop) && crop.currentVersionId).toBe('crop-v2');
    const bannerAfter = pageBlocks(refreshed, page.id).find((b) => b.id === banner.id)!;
    expect(isBlockCropStale(bannerAfter, page)).toBe(false);
  });

  it('区块在原图上的像素范围', () => {
    const { page, blocks } = setup();
    expect(blockPixelRect(blocks[0], page)).toEqual({ left: 0, top: 256, width: 1179, height: 639 });
  });
});

describe('为区块写提示词与放回', () => {
  it('每个区块一张提示词卡，绑定自己的截图、放在截图右侧、同组；已有提示词的跳过', () => {
    const { state, page, blocks } = setup();
    const cropped = placeBlockCrops(state, page.id, blocks.map((b) => ({ blockId: b.id, version: version(`c2-${b.id}`, 400, 200) })), makeId).state;
    const ordered = pageBlocks(cropped, page.id);
    const drafts = ordered.map((block, i) => ({ name: block.name, text: `text ${i}`, inputIndex: i + 1 }));
    const first = applyBlockPrompts(cropped, ordered, drafts, makeId);
    expect(first.promptIds).toHaveLength(3);
    for (const block of pageBlocks(first.state, page.id)) {
      const prompt = first.state.cards.find((card) => card.id === block.promptCardId);
      const crop = first.state.cards.find((card) => card.id === block.cropCardId)!;
      expect(prompt && isPromptCard(prompt) && prompt.inputs).toEqual([crop.id]);
      expect(prompt!.x).toBeGreaterThan(crop.x + crop.width);
      expect(prompt && isPromptCard(prompt) && prompt.groupId).toBe(isImageCard(crop) ? crop.groupId : null);
    }
    const second = applyBlockPrompts(first.state, pageBlocks(first.state, page.id), drafts, makeId);
    expect(second.promptIds).toHaveLength(0);
  });

  it('输出首版出现时在区块位置自动放一个引用；套用两次不重复', () => {
    const { state, page, banner, outputId } = throughGeneration();
    const refs = state.cards.filter((card) => isRefCard(card) && card.imageCardId === outputId);
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    expect(ref).toMatchObject({ pageId: page.id, x: banner.x, width: banner.width });
    expect(ref.y + ref.height / 2).toBeCloseTo(banner.y + banner.height / 2);
    const output = state.cards.find((card) => card.id === outputId);
    expect(output && isImageCard(output) && output.groupId).toBeTruthy();

    const again = applyGenerationResult(state, {
      promptCardId: banner.promptCardId!,
      outputCardId: outputId,
      versions: [version('gen-1', 1200, 600)],
      placement: { x: 0, y: 0, width: 300, height: 150 },
    });
    expect(again.cards.filter((card) => isRefCard(card) && card.imageCardId === outputId)).toHaveLength(1);
  });

  it('删除截图卡或提示词卡时区块断开对应链接', () => {
    const { state, banner } = throughGeneration();
    const next = removeCards(state, new Set([banner.cropCardId!, banner.promptCardId!]));
    const after = next.cards.find((card): card is BlockCard => card.id === banner.id)!;
    expect(after).toMatchObject({ cropCardId: null, cropRect: null, promptCardId: null });
  });
});

describe('保存与导出', () => {
  it('project.json 往返：区块和底稿来源都在；页面框不在的区块丢掉', () => {
    const { state, page } = throughGeneration();
    const raw = JSON.parse(
      JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, regions: state.regions, cards: state.cards, activeThemeCardId: null, viewport: null }),
    );
    raw.cards = raw.cards.map((card: { kind: string }) => (card.kind === 'page' ? { ...card, baseSource: 'borrowed' } : card));
    const { project, warnings } = parseProject(raw);
    expect(warnings).toEqual([]);
    expect(project.cards.filter(isBlockCard)).toHaveLength(3);
    expect(project.cards.find((card) => card.id === page.id)).toMatchObject({ baseSource: 'borrowed' });

    raw.cards = raw.cards.filter((card: { kind: string }) => card.kind !== 'page');
    const orphan = parseProject(raw);
    expect(orphan.project.cards.some(isBlockCard)).toBe(false);
  });

  it('导出清单带区块的逻辑坐标，图层里没有区块', () => {
    const { state, page } = throughGeneration();
    const plan = planPageExport(page, state.cards);
    expect(plan.blocks).toHaveLength(3);
    expect(plan.blocks[0]).toMatchObject({ name: 'Banner', type: 'hero', x: 0, width: 393 });
    expect(plan.layers).toHaveLength(1);
  });
});
