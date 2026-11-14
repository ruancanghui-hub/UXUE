import { describe, expect, it } from 'vitest';
import {
  defaultRegions,
  isBlockCropStale,
  isImageCard,
  isPageCard,
  isPromptCard,
  parseProject,
  PROJECT_SCHEMA_VERSION,
  type PageCard,
  type Version,
} from '../../../shared/project';
import {
  addCards,
  addVersions,
  applyDecomposition,
  applyGenerationResult,
  createWireframePrompt,
  isWireframeOutput,
  layoutNewCards,
  newPageCard,
  newPageFromImageCard,
  pageBlocks,
  placeBlockCrops,
  removeCards,
  setPageBaseFromCard,
  wireframeFromPage,
  WIREFRAME_PROMPT,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `w-${++counter}`;

function version(id: string, width: number, height: number): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };

function generated(state: DocState, promptCardId: string, outputCardId: string, v: Version): DocState {
  return applyGenerationResult(state, { promptCardId, outputCardId, versions: [v], placement: { x: 0, y: 0, width: 300, height: 600 } });
}

describe('转线框', () => {
  it('从图像卡：右侧一张转线框提示词卡，固定提示词、绑定这张图、不附加主题、1 张', () => {
    const [shot] = layoutNewCards([version('shot', 208, 435)], 0, 0, makeId);
    const created = createWireframePrompt(addCards(empty, [shot]), shot.id, makeId)!;
    const prompt = created.state.cards.find((card) => card.id === created.promptId)!;
    expect(isPromptCard(prompt) && prompt).toMatchObject({
      name: '转线框',
      text: WIREFRAME_PROMPT,
      inputs: [shot.id],
      purpose: 'wireframe',
      settings: { count: 1, size: 'match', quality: 'medium', useTheme: false },
    });
    expect(prompt.x).toBeGreaterThan(shot.x + shot.width);
  });

  it('从页面框：底稿复制成图像卡放在页面框左侧；出图后底稿换成线框、来源设为借鉴，区块截图过时', () => {
    const page = newPageCard(empty, { id: 'page', name: '首页', base: version('shot', 208, 435) });
    let state = addCards(empty, [page]);
    state = applyDecomposition(state, page.id, [{ name: 'Banner', type: 'hero', group: null, x: 0, y: 100, width: 1000, height: 200 }], makeId).state;
    const [block] = pageBlocks(state, page.id);
    state = placeBlockCrops(state, page.id, [{ blockId: block.id, version: version('crop', 400, 80) }], makeId).state;

    const started = wireframeFromPage(state, page.id, makeId)!;
    const source = started.state.cards.find((card) => card.id === started.sourceId)!;
    expect(isImageCard(source) && source.currentVersionId).toBe('shot');
    const prompt = started.state.cards.find((card) => card.id === started.promptId)!;
    expect(prompt.x + prompt.width).toBeLessThan(page.x);
    expect(started.state.cards.find((card) => card.id === page.id)).toMatchObject({ wireframePromptId: started.promptId });

    const done = generated(started.state, started.promptId, 'wire-out', version('wire-1', 489, 1024));
    const after = done.cards.find((card): card is PageCard => card.id === page.id && isPageCard(card))!;
    expect(after).toMatchObject({ baseCardId: 'wire-out', baseSource: 'borrowed', wireframePromptId: null });
    expect(after.base?.id).toBe('wire-1');
    expect(isBlockCropStale(pageBlocks(done, page.id)[0], after)).toBe(true);

    const again = generated(done, started.promptId, 'wire-out', version('wire-1', 489, 1024));
    expect(again.cards.find((card) => card.id === page.id)).toEqual(after);
  });

  it('换了线框版本后可以用当前版本做底稿；跟随原型的页面框高度按新比例', () => {
    const page = { ...newPageCard(empty, { id: 'page2', name: '页', base: version('shot2', 200, 400) }), devicePreset: null };
    const started = wireframeFromPage(addCards(empty, [page]), page.id, makeId)!;
    let state = generated(started.state, started.promptId, 'out2', version('wire-a', 200, 400));
    state = addVersions(state, 'out2', [version('wire-b', 200, 500)]);
    state = setPageBaseFromCard(state, page.id, 'out2');
    const after = state.cards.find((card): card is PageCard => card.id === page.id && isPageCard(card))!;
    expect(after.base?.id).toBe('wire-b');
    expect(after.height).toBeCloseTo(after.width * 2.5);
  });

  it('用转线框结果新建页面框：底稿来源借鉴、记住来源图像卡；普通图建页仍是自己的线框', () => {
    const [shot] = layoutNewCards([version('shot3', 1179, 2556)], 0, 0, makeId);
    const created = createWireframePrompt(addCards(empty, [shot]), shot.id, makeId)!;
    const state = generated(created.state, created.promptId, 'out3', version('wire-3', 1179, 2556));
    expect(isWireframeOutput(state, 'out3')).toBe(true);
    const fromWire = newPageFromImageCard(state, 'out3', makeId)!;
    expect(fromWire.state.cards.find((card) => card.id === fromWire.pageId)).toMatchObject({
      baseCardId: 'out3',
      baseSource: 'borrowed',
      devicePreset: 'iphone',
    });
    const fromShot = newPageFromImageCard(state, shot.id, makeId)!;
    expect(fromShot.state.cards.find((card) => card.id === fromShot.pageId)).toMatchObject({ baseSource: 'own' });
  });

  it('删掉来源图像卡或转线框提示词卡时页面框断开；读回时同样清理', () => {
    const page = newPageCard(empty, { id: 'page4', name: '页', base: version('shot4', 200, 400) });
    const started = wireframeFromPage(addCards(empty, [page]), page.id, makeId)!;
    const removed = removeCards(started.state, new Set([started.promptId]));
    expect(removed.cards.find((card) => card.id === page.id)).toMatchObject({ wireframePromptId: null });

    const raw = JSON.parse(
      JSON.stringify({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        regions: started.state.regions,
        cards: started.state.cards.filter((card) => !isPromptCard(card)).map((card) => (isPageCard(card) ? { ...card, baseCardId: 'gone' } : card)),
        activeThemeCardId: null,
        viewport: null,
      }),
    );
    const parsed = parseProject(raw).project.cards.find(isPageCard)!;
    expect(parsed).toMatchObject({ baseCardId: null, wireframePromptId: null });
  });
});
