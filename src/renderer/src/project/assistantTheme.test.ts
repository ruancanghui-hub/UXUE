import { describe, expect, it } from 'vitest';
import { defaultRegions, type ImageCard } from '../../../shared/project';
import { applyAssistantDrafts, type DocState } from '../document/operations';
import { wantsThemeCard } from './AssistantSession';

const img = (id: string): ImageCard => ({
  kind: 'image',
  id,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  currentVersionId: `${id}-v`,
  groupId: null,
  versions: [
    { id: `${id}-v`, file: `assets/${id}.png`, width: 100, height: 100, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' },
  ],
});

describe('wantsThemeCard', () => {
  it('识别提炼 / 生成主题意图', () => {
    expect(wantsThemeCard('从选中的参考图提炼主题卡')).toBe(true);
    expect(wantsThemeCard('为「寿司」生成一套视觉主题')).toBe(true);
    expect(wantsThemeCard('反推选中的图')).toBe(false);
  });
});

describe('applyAssistantDrafts 主题来源', () => {
  it('看图路径写入来源；无来源时为 null', () => {
    const empty: DocState = { cards: [img('ip')], regions: defaultRegions(), activeThemeCardId: null };
    const draft = {
      theme: {
        name: '主题',
        topic: '测试',
        keywords: ['a'],
        cues: ['b'],
        palette: [{ role: '主色', name: '红', hex: '#FF0000', note: '' }],
        rules: { shape: '', material: '', lighting: '', color: '' },
      },
      prompts: [] as { name: string; text: string; inputIndex: number | null }[],
    };
    const withSource = applyAssistantDrafts(empty, draft, ['ip'], { x: 0, y: 0 }, () => 't1', {
      imageCardId: 'ip',
      versionId: 'ip-v',
    });
    expect(withSource.state.cards.find((c) => c.id === 't1')).toMatchObject({
      sourceImageCardId: 'ip',
      sourceVersionId: 'ip-v',
    });
    expect(withSource.state.activeThemeCardId).toBe('t1');

    const textOnly = applyAssistantDrafts(empty, draft, [], { x: 0, y: 0 }, () => 't2', null);
    expect(textOnly.state.cards.find((c) => c.id === 't2')).toMatchObject({
      sourceImageCardId: null,
      sourceVersionId: null,
    });
  });

  it('已有生效主题卡时不抢生效', () => {
    const state: DocState = {
      cards: [
        img('ip'),
        {
          kind: 'theme',
          id: 'old',
          name: '旧',
          x: 0,
          y: 0,
          width: 420,
          height: 500,
          topic: '旧',
          keywords: [],
          cues: [],
          palette: [],
          rules: { shape: '', material: '', lighting: '', color: '' },
          groupId: null,
          sourceImageCardId: null,
          sourceVersionId: null,
        },
      ],
      regions: defaultRegions(),
      activeThemeCardId: 'old',
    };
    const applied = applyAssistantDrafts(
      state,
      {
        theme: {
          name: '新',
          topic: '新',
          keywords: [],
          cues: [],
          palette: [],
          rules: { shape: '', material: '', lighting: '', color: '' },
        },
        prompts: [],
      },
      ['ip'],
      { x: 0, y: 0 },
      () => 't-new',
      { imageCardId: 'ip', versionId: 'ip-v' },
    );
    expect(applied.state.activeThemeCardId).toBe('old');
    expect(applied.themeId).toBe('t-new');
  });
});
