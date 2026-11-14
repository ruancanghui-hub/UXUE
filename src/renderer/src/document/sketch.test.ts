import { describe, expect, it } from 'vitest';
import { defaultRegions, detectPreset, isPageCard, isPromptCard, type PageCard, type Version } from '../../../shared/project';
import { sketchBoxes } from '../project/sketch';
import {
  addCards,
  applyGenerationResult,
  createBlockAt,
  newPageCard,
  pageBlocks,
  setPagePreset,
  sketchToWireframe,
  SKETCH_WIREFRAME_PROMPT,
  updateBlock,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `s-${++counter}`;
const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };

function version(id: string, width: number, height: number): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

function blankPage(): { state: DocState; page: PageCard } {
  const page = newPageCard(empty, { id: 'blank', name: '首页', base: null });
  return { state: addCards(empty, [page]), page };
}

describe('iPhone 尺寸预设', () => {
  it('认出 Pro Max、mini、SE 的 3 倍 / 2 倍图；换预设高度按比例', () => {
    expect(detectPreset(1290, 2796)).toEqual({ presetId: 'iphone-max', scale: 3 });
    expect(detectPreset(1125, 2436)).toEqual({ presetId: 'iphone-mini', scale: 3 });
    expect(detectPreset(750, 1334)).toEqual({ presetId: 'iphone-se', scale: 2 });
    const { state, page } = blankPage();
    const se = setPagePreset(state, page.id, 'iphone-se').cards.find((c): c is PageCard => isPageCard(c))!;
    expect(se.height).toBeCloseTo(page.width * (667 / 375));
  });
});

describe('布局草图', () => {
  it('区块工具在页面框里拖出的框就是区块，名字先叫「区块」', () => {
    const { state, page } = blankPage();
    const created = createBlockAt(state, page.id, { x: page.x + 10, y: page.y + 20, width: 200, height: 80 }, makeId)!;
    expect(pageBlocks(created.state, page.id)[0]).toMatchObject({ name: '区块', blockType: 'other', x: page.x + 10, width: 200, cropCardId: null });
    expect(createBlockAt(state, 'nope', { x: 0, y: 0, width: 10, height: 10 }, makeId)).toBeNull();
  });

  it('示意图按逻辑尺寸 3 倍换算区块位置', () => {
    const { state, page } = blankPage();
    let next = createBlockAt(state, page.id, { x: page.x, y: page.y + page.height * 0.1, width: page.width, height: page.height * 0.25 }, makeId)!.state;
    const [block] = pageBlocks(next, page.id);
    next = updateBlock(next, block.id, { name: 'Banner' });
    const sketch = sketchBoxes(page, pageBlocks(next, page.id));
    expect(sketch).toMatchObject({ width: 1179, height: 2556 });
    expect(sketch.boxes[0]).toEqual({ name: 'Banner', x: 0, y: 256, width: 1179, height: 639 });
  });

  it('草图转线框：示意图放在页面框左侧、提示词卡是「草图转线框」；出图后换成底稿，底稿来源是自己的线框，区块保留', () => {
    const { state, page } = blankPage();
    const withBlock = createBlockAt(state, page.id, { x: page.x + 20, y: page.y + 40, width: 300, height: 120 }, makeId)!.state;
    const started = sketchToWireframe(withBlock, page.id, version('sketch-1', 1179, 2556), makeId)!;
    const source = started.state.cards.find((c) => c.id === started.sourceId)!;
    expect(source.x + source.width).toBeLessThan(page.x);
    const prompt = started.state.cards.find((c) => c.id === started.promptId)!;
    expect(isPromptCard(prompt) && prompt).toMatchObject({ name: '草图转线框', purpose: 'sketch', text: SKETCH_WIREFRAME_PROMPT, inputs: [started.sourceId] });
    expect(isPromptCard(prompt) && prompt.settings.useTheme).toBe(false);

    const done = applyGenerationResult(started.state, {
      promptCardId: started.promptId,
      outputCardId: 'wire',
      versions: [version('wire-1', 1179, 2556)],
      placement: { x: 0, y: 0, width: 300, height: 650 },
    });
    const after = done.cards.find((c): c is PageCard => c.id === page.id && isPageCard(c))!;
    expect(after).toMatchObject({ baseCardId: 'wire', baseSource: 'own', wireframePromptId: null });
    expect(after.base?.id).toBe('wire-1');
    expect(pageBlocks(done, page.id)).toHaveLength(1);
  });
});
