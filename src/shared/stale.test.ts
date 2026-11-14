import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_SETTINGS } from './generation';
import type { ImageCard, PromptCard, ThemeCard } from './project';
import { downstreamPromptOrder, expectedPromptText, isImageCardStale, regenPromptIdsForSelection } from './stale';

const theme = (id: string, shape = '圆润'): ThemeCard => ({
  kind: 'theme',
  id,
  name: '主题',
  x: 0,
  y: 0,
  width: 420,
  height: 500,
  topic: '寿司',
  keywords: [],
  cues: [],
  palette: [],
  rules: { shape, material: '', lighting: '', color: '' },
  groupId: null,
});

const image = (id: string, versionId: string, generation?: ImageCard['versions'][0]['generation']): ImageCard => ({
  kind: 'image',
  id,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  currentVersionId: versionId,
  groupId: null,
  versions: [
    {
      id: versionId,
      file: `assets/${versionId}.png`,
      width: 100,
      height: 100,
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: generation ? 'generate' : 'import',
      ...(generation ? { generation } : {}),
    },
  ],
});

const prompt = (id: string, inputs: string[], outputCardId: string | null, text = '画一只猫'): PromptCard => ({
  kind: 'prompt',
  id,
  name: id,
  x: 0,
  y: 0,
  width: 360,
  height: 220,
  text,
  inputs,
  outputCardId,
  settings: { ...DEFAULT_PROMPT_SETTINGS, useTheme: false },
  groupId: null,
});

describe('isImageCardStale', () => {
  it('输入版没变则不过期', () => {
    const photo = image('photo', 'v1');
    const out = image('out', 'g1', {
      promptCardId: 'p1',
      prompt: '画一只猫',
      inputVersionIds: ['v1'],
      provider: 'mock',
      model: 'mock',
      quality: 'low',
      size: '1024x1024',
      costUsd: 0,
      jobId: 'j1',
      themeCardId: null,
    });
    const p = prompt('p1', ['photo'], 'out');
    const state = { cards: [photo, p, out], activeThemeCardId: null };
    expect(isImageCardStale(out, state)).toBe(false);
  });

  it('输入图换了当前版本则过期', () => {
    const photo: ImageCard = {
      ...image('photo', 'v1'),
      versions: [
        image('photo', 'v1').versions[0],
        { id: 'v2', file: 'assets/v2.png', width: 100, height: 100, createdAt: '2026-01-02T00:00:00.000Z', origin: 'import' },
      ],
      currentVersionId: 'v2',
    };
    const out = image('out', 'g1', {
      promptCardId: 'p1',
      prompt: '画一只猫',
      inputVersionIds: ['v1'],
      provider: 'mock',
      model: 'mock',
      quality: 'low',
      size: '1024x1024',
      costUsd: 0,
      jobId: 'j1',
      themeCardId: null,
    });
    const state = { cards: [photo, prompt('p1', ['photo'], 'out'), out], activeThemeCardId: null };
    expect(isImageCardStale(out, state)).toBe(true);
  });

  it('提示词改字则过期', () => {
    const photo = image('photo', 'v1');
    const out = image('out', 'g1', {
      promptCardId: 'p1',
      prompt: '画一只猫',
      inputVersionIds: ['v1'],
      provider: 'mock',
      model: 'mock',
      quality: 'low',
      size: '1024x1024',
      costUsd: 0,
      jobId: 'j1',
      themeCardId: null,
    });
    const state = { cards: [photo, prompt('p1', ['photo'], 'out', '画一条狗'), out], activeThemeCardId: null };
    expect(isImageCardStale(out, state)).toBe(true);
  });

  it('生效主题规则变了则过期', () => {
    const photo = image('photo', 'v1');
    const p: PromptCard = { ...prompt('p1', ['photo'], 'out'), settings: { ...DEFAULT_PROMPT_SETTINGS, useTheme: true } };
    const original = theme('t1', '圆润');
    const freshState = { cards: [original, photo, p], activeThemeCardId: 't1' };
    const out = image('out', 'g1', {
      promptCardId: 'p1',
      prompt: expectedPromptText(p, freshState),
      inputVersionIds: ['v1'],
      provider: 'mock',
      model: 'mock',
      quality: 'low',
      size: '1024x1024',
      costUsd: 0,
      jobId: 'j1',
      themeCardId: 't1',
    });
    expect(isImageCardStale(out, { ...freshState, cards: [...freshState.cards, out] })).toBe(false);
    const changed = theme('t1', '棱角');
    const state = { cards: [changed, photo, p, out], activeThemeCardId: 't1' };
    expect(isImageCardStale(out, state)).toBe(true);
  });
});

describe('downstreamPromptOrder', () => {
  it('按依赖拓扑排出下游提示词卡', () => {
    const a = prompt('pa', ['in'], 'mid');
    const b = prompt('pb', ['mid'], 'out');
    const state = {
      cards: [image('in', 'v1'), a, image('mid', 'm1'), b, image('out', 'o1')],
      activeThemeCardId: null,
    };
    expect(downstreamPromptOrder(state, ['pa'])).toEqual(['pa', 'pb']);
    expect(regenPromptIdsForSelection(state, new Set(['mid']))).toEqual(['pa', 'pb']);
  });
});
