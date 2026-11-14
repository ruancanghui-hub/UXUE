import { describe, expect, it } from 'vitest';
import { sanitizeAssistantOutput, type ElementDraft } from '../../../shared/assistant';
import { defaultRegions, isGroupCard, isImageCard, isPromptCard, parseProject, PROJECT_SCHEMA_VERSION, type PromptCard, type Version } from '../../../shared/project';
import { isImageCardStale } from '../../../shared/stale';
import {
  addCards,
  applyElementList,
  applyGenerationResult,
  currentStyleBenchmark,
  elementPrompts,
  layoutNewCards,
  outputPlacement,
  removeCards,
  setStyleBenchmark,
  STYLE_REF_SENTENCE,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `e-${++counter}`;
const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };

function version(id: string, width = 1024, height = 1024): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

const DRAFTS: ElementDraft[] = [
  ...['握寿司', '餐盘', '回转轨道', '灯笼'].map((name) => ({ name: `${name}图标`, category: 'icon' as const, usage: '金刚位', cue: name, text: `画一个${name}图标` })),
  { name: 'Banner 主插画', category: 'illustration', usage: 'Banner', cue: '寿司', text: '画一张横幅插画' },
  { name: '页面底纹', category: 'pattern', usage: '背景', cue: '海浪', text: '画一张可平铺底纹' },
];

function listed(): { state: DocState; prompts: PromptCard[] } {
  const applied = applyElementList(empty, DRAFTS, makeId);
  return { state: applied.state, prompts: elementPrompts(applied.state) };
}

describe('素材清单', () => {
  it('按类别分进核心素材区的分组框；1 张、图标方形、插画 3:2、附加主题', () => {
    const { state, prompts } = listed();
    const groups = state.cards.filter(isGroupCard).map((g) => g.name);
    expect(groups).toEqual(['素材清单 · 图标', '素材清单 · 插画', '素材清单 · 纹样 / 背景']);
    const assets = state.regions.find((r) => r.id === 'assets')!;
    expect(prompts.every((p) => p.x >= assets.x && p.x < assets.x + assets.width)).toBe(true);
    const icon = prompts.find((p) => p.name === '握寿司图标')!;
    const banner = prompts.find((p) => p.name === 'Banner 主插画')!;
    expect(icon.settings).toMatchObject({ count: 1, size: '1024x1024', quality: 'medium', useTheme: true });
    expect(banner.settings.size).toBe('1536x1024');
    expect(prompts.every((p) => p.purpose === 'element' && p.inputs.length === 0)).toBe(true);
  });

  it('网格里第一次出图的位置不压住同组的下一张卡', () => {
    const { state, prompts } = listed();
    const [first, second] = prompts.filter((p) => p.name.endsWith('图标'));
    const rect = outputPlacement(state, first, 1);
    expect(rect.x + rect.width).toBeLessThan(second.x);
  });

  it('再列一次追加到已有内容下方', () => {
    const { state } = listed();
    const bottom = Math.max(...state.cards.map((c) => c.y + c.height));
    const again = applyElementList(state, [DRAFTS[0]], makeId).state;
    const added = elementPrompts(again).at(-1)!;
    expect(elementPrompts(again)).toHaveLength(DRAFTS.length + 1);
    expect(added.y).toBeGreaterThan(bottom);
  });

  it('助手返回的清单项：缺名字或提示词的丢掉，未知类别记为图标，最多 16 项', () => {
    const raw = {
      elements: [
        { name: 'A', category: 'weird', usage: '', cue: '', text: '画 A' },
        { name: '', category: 'icon', usage: '', cue: '', text: '画 B' },
        ...Array.from({ length: 20 }, (_, i) => ({ name: `X${i}`, category: 'decor', usage: '', cue: '', text: '画' })),
      ],
    };
    const out = sanitizeAssistantOutput(raw, 0).elements;
    expect(out[0]).toMatchObject({ name: 'A', category: 'icon' });
    expect(out).toHaveLength(16);
  });
});

describe('风格基准', () => {
  it('全部清单提示词卡第 1 个输入换成基准图、正文加参照句；换基准替换；取消恢复原样', () => {
    const { state } = listed();
    const [imageA, imageB] = layoutNewCards([version('a'), version('b')], 0, 0, makeId);
    const withImages = addCards(state, [imageA, imageB]);
    const originalTexts = elementPrompts(withImages).map((p) => p.text);

    const setA = setStyleBenchmark(withImages, imageA.id);
    expect(currentStyleBenchmark(setA)).toBe(imageA.id);
    expect(elementPrompts(setA).every((p) => p.inputs[0] === imageA.id && p.styleRefCardId === imageA.id && p.text.startsWith(STYLE_REF_SENTENCE))).toBe(true);

    const setB = setStyleBenchmark(setA, imageB.id);
    expect(elementPrompts(setB).every((p) => p.inputs.length === 1 && p.inputs[0] === imageB.id && p.text.split(STYLE_REF_SENTENCE).length === 2)).toBe(true);

    const cleared = setStyleBenchmark(setB, null);
    expect(elementPrompts(cleared).map((p) => p.text)).toEqual(originalTexts);
    expect(elementPrompts(cleared).every((p) => p.inputs.length === 0 && !p.styleRefCardId)).toBe(true);
  });

  it('基准图是某张清单卡的输出时那张卡不绑自己；已生成的其它卡标成已过期；新列的卡自动绑基准', () => {
    const { state, prompts } = listed();
    const [p1, p2] = prompts;
    let next = applyGenerationResult(state, { promptCardId: p1.id, outputCardId: 'out-1', versions: [version('g1')], placement: { x: 0, y: 0, width: 400, height: 400 } });
    next = applyGenerationResult(next, { promptCardId: p2.id, outputCardId: 'out-2', versions: [{ ...version('g2'), origin: 'generate', generation: { promptCardId: p2.id, prompt: p2.text, inputVersionIds: [], provider: 'mock', model: 'm', quality: 'medium', size: '1024x1024', costUsd: 0, jobId: 'j', themeCardId: null } }], placement: { x: 0, y: 0, width: 400, height: 400 } });
    const benchmarked = setStyleBenchmark(next, 'out-1');
    const self = benchmarked.cards.find((c): c is PromptCard => c.id === p1.id && isPromptCard(c))!;
    expect(self.inputs).toEqual([]);
    const out2 = benchmarked.cards.find((c) => c.id === 'out-2')!;
    expect(isImageCard(out2) && isImageCardStale(out2, benchmarked)).toBe(true);

    const more = applyElementList(benchmarked, [DRAFTS[1]], makeId).state;
    expect(elementPrompts(more).at(-1)!.inputs).toEqual(['out-1']);
  });

  it('删掉基准图：提示词卡解绑并去掉参照句；读回时同样清理', () => {
    const { state } = listed();
    const [image] = layoutNewCards([version('c')], 0, 0, makeId);
    const set = setStyleBenchmark(addCards(state, [image]), image.id);
    const removed = removeCards(set, new Set([image.id]));
    expect(elementPrompts(removed).every((p) => !p.styleRefCardId && p.inputs.length === 0 && !p.text.includes(STYLE_REF_SENTENCE))).toBe(true);

    const raw = JSON.parse(JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, regions: set.regions, cards: set.cards.filter((c) => c.id !== image.id), activeThemeCardId: null, viewport: null }));
    const parsed = parseProject(raw).project.cards.filter((c): c is PromptCard => isPromptCard(c));
    expect(parsed.every((p) => p.purpose === 'element' && p.styleRefCardId === null)).toBe(true);
  });
});
