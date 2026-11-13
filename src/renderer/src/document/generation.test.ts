import { describe, expect, it } from 'vitest';
import { costFromUsage, fitSizeToLimits, renderPrompt, resolveSize, validatePrompt } from '../../../shared/generation';
import { defaultRegions, isImageCard, isPromptCard, type ImageCard, type PromptCard, type Version } from '../../../shared/project';
import { DocumentStore } from './DocumentStore';
import {
  addCards,
  addPromptInput,
  applyGenerationResult,
  createPromptCard,
  duplicateCards,
  layoutNewCards,
  moveCards,
  removeCards,
  setCurrentVersion,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `id-${++counter}`;

function version(id: string, width = 1000, height = 1000): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

function withPhoto(): { state: DocState; photo: ImageCard } {
  const [photo] = layoutNewCards([version('photo')], 0, 0, makeId);
  return { state: addCards({ cards: [], regions: defaultRegions() }, [photo]), photo };
}

function prompt(state: DocState, id: string): PromptCard {
  const card = state.cards.find((c) => c.id === id);
  if (!card || !isPromptCard(card)) throw new Error('not a prompt');
  return card;
}

function image(state: DocState, id: string): ImageCard {
  const card = state.cards.find((c) => c.id === id);
  if (!card || !isImageCard(card)) throw new Error('not an image');
  return card;
}

describe('提示词卡', () => {
  it('从选中的图新建：放在右侧，自动绑定并写好 {{Image N}}', () => {
    const { state, photo } = withPhoto();
    const { state: next, card } = createPromptCard(state, [photo.id], { x: 0, y: 0 }, makeId);
    expect(card.inputs).toEqual([photo.id]);
    expect(card.text).toBe('{{Image 1}} ');
    expect(card.x).toBeGreaterThan(photo.x + photo.width);
    expect(next.cards).toHaveLength(2);
  });

  it('绑定不重复，也不能把自己的输出图当输入', () => {
    const { state, photo } = withPhoto();
    const { state: s1, card } = createPromptCard(state, [photo.id], { x: 0, y: 0 }, makeId);
    expect(addPromptInput(s1, card.id, photo.id)).toBe(s1);
    const s2 = applyGenerationResult(s1, { promptCardId: card.id, outputCardId: 'out', versions: [version('g1')], placement: { x: 0, y: 0, width: 400, height: 400 } });
    expect(addPromptInput(s2, card.id, 'out')).toBe(s2);
  });

  it('删除输入图时去掉绑定，撤销时恢复', () => {
    const { state, photo } = withPhoto();
    const { state: s1, card } = createPromptCard(state, [photo.id], { x: 0, y: 0 }, makeId);
    const s2 = removeCards(s1, new Set([photo.id]));
    expect(prompt(s2, card.id).inputs).toEqual([]);
    expect(prompt(s1, card.id).inputs).toEqual([photo.id]);
  });

  it('提示词卡的副本不继承输出图', () => {
    const { state, photo } = withPhoto();
    const { state: s1, card } = createPromptCard(state, [photo.id], { x: 0, y: 0 }, makeId);
    const s2 = applyGenerationResult(s1, { promptCardId: card.id, outputCardId: 'out', versions: [version('g1')], placement: { x: 0, y: 0, width: 400, height: 400 } });
    const { state: s3, newIds } = duplicateCards(s2, new Set([card.id]), makeId);
    expect(prompt(s3, newIds[0]).outputCardId).toBeNull();
    expect(prompt(s3, newIds[0]).inputs).toEqual([photo.id]);
  });
});

describe('生成结果', () => {
  const placement = { x: 1000, y: 0, width: 400, height: 400 };

  it('第一次生成新建输出图像卡并连到提示词卡，之后追加版本', () => {
    const { state, photo } = withPhoto();
    const { state: s1, card } = createPromptCard(state, [photo.id], { x: 0, y: 0 }, makeId);
    const s2 = applyGenerationResult(s1, { promptCardId: card.id, outputCardId: 'out', versions: [version('g1', 2000, 1000)], placement });
    expect(prompt(s2, card.id).outputCardId).toBe('out');
    expect(image(s2, 'out')).toMatchObject({ x: 1000, width: 400, height: 200, currentVersionId: 'g1' });
    const s3 = applyGenerationResult(s2, { promptCardId: card.id, outputCardId: 'out', versions: [version('g2'), version('g3')], placement });
    expect(image(s3, 'out').versions.map((v) => v.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('重复套用同一个结果不会重复追加', () => {
    const { state, photo } = withPhoto();
    const { state: s1, card } = createPromptCard(state, [photo.id], { x: 0, y: 0 }, makeId);
    const result = { promptCardId: card.id, outputCardId: 'out', versions: [version('g1')], placement };
    const once = applyGenerationResult(s1, result);
    expect(applyGenerationResult(once, result)).toBe(once);
  });

  it('撤销不会丢掉生成的版本；撤销再重做回到原样', () => {
    const { state, photo } = withPhoto();
    const store = new DocumentStore(state);
    const { state: s1, card } = createPromptCard(store.get(), [photo.id], { x: 0, y: 0 }, makeId);
    store.apply('新建提示词卡', s1);
    store.apply('移动', moveCards(store.get(), new Map([[photo.id, photo]]), 50, 0));

    const result = { promptCardId: card.id, outputCardId: 'out', versions: [version('g1'), version('g2')], placement };
    store.applyPermanent((s) => applyGenerationResult(s, result), (s) => setCurrentVersion(s, 'out', 'g2'));
    const present = store.get();
    expect(image(present, 'out').currentVersionId).toBe('g2');

    store.undo();
    store.undo();
    expect(image(store.get(), 'out').versions).toHaveLength(2);
    expect(store.get().cards.some((c) => c.id === card.id)).toBe(false);

    store.redo();
    store.redo();
    expect(store.get()).toEqual(present);
  });
});

describe('生成参数', () => {
  it('跟随输入图比例时满足接口限制：16 的倍数、比例不超过 3:1、像素数在范围内', () => {
    for (const [w, h] of [
      [2048, 1024],
      [1000, 4000],
      [300, 300],
      [8000, 1000],
    ]) {
      const size = resolveSize('match', { width: w, height: h });
      expect(size.width % 16).toBe(0);
      expect(size.height % 16).toBe(0);
      expect(Math.max(size.width / size.height, size.height / size.width)).toBeLessThanOrEqual(3.05);
      expect(size.width * size.height).toBeGreaterThanOrEqual(655_360);
      expect(size.width * size.height).toBeLessThanOrEqual(8_294_400);
    }
    expect(fitSizeToLimits(2, 1536 * 1024)).toEqual({ width: 1776, height: 880 });
    expect(resolveSize('1536x1024', null)).toEqual({ width: 1536, height: 1024 });
  });

  it('{{Image N}} 渲染成 Image N，并检查引用是否越界', () => {
    expect(renderPrompt('把 {{Image 1}} 和 {{ image 2 }} 合在一起').text).toBe('把 Image 1 和 Image 2 合在一起');
    expect(validatePrompt('把 {{Image 2}} 转为 3D', 1)).toMatch(/Image 2/);
    expect(validatePrompt('   ', 0)).toMatch(/空/);
    expect(validatePrompt('画一只猫', 0)).toBeNull();
  });

  it('按接口返回的用量算实际花费', () => {
    const usd = costFromUsage({ input_tokens: 1300, input_tokens_details: { image_tokens: 1000, text_tokens: 300 }, output_tokens: 4000 });
    expect(usd).toBeCloseTo((1000 * 8 + 300 * 5 + 4000 * 30) / 1_000_000);
  });
});
