import type { PromptDraft, ThemeDraft } from '../../../shared/assistant';
import { DEFAULT_PROMPT_SETTINGS, type PromptSettings } from '../../../shared/generation';
import {
  isImageCard,
  isPromptCard,
  isThemeCard,
  type CanvasCard,
  type ImageCard,
  type PromptCard,
  type Region,
  type RegionId,
  type ThemeCard,
  type Version,
} from '../../../shared/project';
import { unionRects, type Rect } from '../canvas/geometry';

/** 画布文档的一个不可变快照；撤销栈只需要保存快照引用 */
export interface DocState {
  readonly cards: readonly CanvasCard[];
  readonly regions: readonly Region[];
  /** 生效主题卡；它的规则会附加到每一次生成 */
  readonly activeThemeCardId: string | null;
}

const NEW_CARD_GAP = 40;
export const MIN_CARD_EDGE = 16;
export const DUPLICATE_OFFSET = 40;
export const PROMPT_CARD_WIDTH = 360;
export const PROMPT_CARD_HEIGHT = 220;
/** 提示词卡与输入图、输出图之间的水平间距 */
export const CHAIN_GAP = 120;

/** 新导入的图长边最大显示尺寸（画布单位）：一次导入越多，单张越小，整批大致能放进一个区域 */
export function newCardMaxEdge(count: number): number {
  if (count <= 4) return 800;
  if (count <= 16) return 480;
  return 320;
}

export function cardSizeFor(version: Version, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(version.width, version.height));
  return { width: version.width * scale, height: version.height * scale };
}

/** 把新版本排成接近横向矩形的网格，整体中心对准 (centerX, centerY) */
export function layoutNewCards(
  versions: Version[],
  centerX: number,
  centerY: number,
  makeId: () => string,
): ImageCard[] {
  if (versions.length === 0) return [];
  const maxEdge = newCardMaxEdge(versions.length);
  const sizes = versions.map((version) => cardSizeFor(version, maxEdge));
  const perRow = Math.ceil(Math.sqrt(versions.length * 1.6));
  const rows: number[][] = [];
  for (let i = 0; i < versions.length; i += perRow) {
    rows.push(sizes.slice(i, i + perRow).map((_, j) => i + j));
  }
  const rowHeights = rows.map((row) => Math.max(...row.map((i) => sizes[i].height)));
  const rowWidths = rows.map((row) => row.reduce((sum, i) => sum + sizes[i].width, 0) + NEW_CARD_GAP * (row.length - 1));
  const totalWidth = Math.max(...rowWidths);
  const totalHeight = rowHeights.reduce((sum, h) => sum + h, 0) + NEW_CARD_GAP * (rows.length - 1);

  const cards: ImageCard[] = [];
  let y = centerY - totalHeight / 2;
  rows.forEach((row, rowIndex) => {
    let x = centerX - totalWidth / 2;
    for (const i of row) {
      const version = versions[i];
      cards.push({
        kind: 'image',
        id: makeId(),
        name: displayName(version),
        x,
        y: y + (rowHeights[rowIndex] - sizes[i].height) / 2,
        width: sizes[i].width,
        height: sizes[i].height,
        versions: [version],
        currentVersionId: version.id,
      });
      x += sizes[i].width + NEW_CARD_GAP;
    }
    y += rowHeights[rowIndex] + NEW_CARD_GAP;
  });
  return cards;
}

function displayName(version: Version): string {
  const name = version.sourceName?.replace(/\.[^.]+$/, '').trim();
  return name || '图片';
}

export function addCards(state: DocState, cards: CanvasCard[]): DocState {
  return { ...state, cards: [...state.cards, ...cards] };
}

/** 删除卡片时一并去掉提示词卡对它们的引用和生效主题卡，撤销时整体恢复 */
export function removeCards(state: DocState, ids: ReadonlySet<string>): DocState {
  const activeThemeCardId = state.activeThemeCardId && ids.has(state.activeThemeCardId) ? null : state.activeThemeCardId;
  const cards = state.cards
    .filter((card) => !ids.has(card.id))
    .map((card) => {
      if (!isPromptCard(card)) return card;
      const inputs = card.inputs.filter((id) => !ids.has(id));
      const outputCardId = card.outputCardId && ids.has(card.outputCardId) ? null : card.outputCardId;
      return inputs.length === card.inputs.length && outputCardId === card.outputCardId ? card : { ...card, inputs, outputCardId };
    });
  return { ...state, cards, activeThemeCardId };
}

/** origins 是手势开始时的卡片，按绝对偏移计算，避免拖动过程中累积误差 */
export function moveCards(state: DocState, origins: ReadonlyMap<string, CanvasCard>, dx: number, dy: number): DocState {
  return mapCards(state, (card) => {
    const origin = origins.get(card.id);
    return origin ? { ...card, x: origin.x + dx, y: origin.y + dy } : card;
  });
}

/** 以 anchor 为不动点等比缩放；scale 太小时按最小边长截住 */
export function scaleCards(
  state: DocState,
  origins: ReadonlyMap<string, CanvasCard>,
  anchorX: number,
  anchorY: number,
  scale: number,
): DocState {
  let minEdge = Infinity;
  for (const origin of origins.values()) minEdge = Math.min(minEdge, origin.width, origin.height);
  const safeScale = Math.max(scale, MIN_CARD_EDGE / minEdge);
  return mapCards(state, (card) => {
    const origin = origins.get(card.id);
    if (!origin) return card;
    return {
      ...card,
      x: anchorX + (origin.x - anchorX) * safeScale,
      y: anchorY + (origin.y - anchorY) * safeScale,
      width: origin.width * safeScale,
      height: origin.height * safeScale,
    };
  });
}

/** 副本不带生成关系：提示词卡副本不继承输出图，避免两张提示词卡往同一张图里追加版本 */
export function duplicateCards(state: DocState, ids: ReadonlySet<string>, makeId: () => string): { state: DocState; newIds: string[] } {
  const copies = state.cards
    .filter((card) => ids.has(card.id))
    .map((card): CanvasCard => {
      const moved = { ...card, id: makeId(), x: card.x + DUPLICATE_OFFSET, y: card.y + DUPLICATE_OFFSET };
      return isPromptCard(moved) ? { ...moved, outputCardId: null } : moved;
    });
  return { state: { ...state, cards: [...state.cards, ...copies] }, newIds: copies.map((card) => card.id) };
}

export function reorderCards(state: DocState, ids: ReadonlySet<string>, to: 'front' | 'back'): DocState {
  const picked = state.cards.filter((card) => ids.has(card.id));
  const rest = state.cards.filter((card) => !ids.has(card.id));
  return { ...state, cards: to === 'front' ? [...rest, ...picked] : [...picked, ...rest] };
}

export function renameCard(state: DocState, id: string, name: string): DocState {
  return mapCards(state, (card) => (card.id === id ? { ...card, name } : card));
}

/** 切换当前版本：保持宽度和左上角不变，高度跟着新版本的比例走 */
export function setCurrentVersion(state: DocState, id: string, versionId: string): DocState {
  return mapCards(state, (card) => {
    if (card.id !== id || !isImageCard(card) || card.currentVersionId === versionId) return card;
    const version = card.versions.find((v) => v.id === versionId);
    if (!version) return card;
    return { ...card, currentVersionId: versionId, height: card.width * (version.height / version.width) };
  });
}

/** 给图像卡追加版本，并把最后一个设为当前版本 */
export function addVersions(state: DocState, id: string, versions: Version[]): DocState {
  if (versions.length === 0) return state;
  const withVersions = mapCards(state, (card) =>
    card.id === id && isImageCard(card) ? { ...card, versions: [...card.versions, ...versions] } : card,
  );
  return setCurrentVersion(withVersions, id, versions[versions.length - 1].id);
}

// ───────────────────────── 提示词卡 ─────────────────────────

/** 新建提示词卡：有输入图时放在它们右侧，并按从上到下、从左到右的顺序绑定 */
export function createPromptCard(
  state: DocState,
  inputIds: string[],
  fallbackCenter: { x: number; y: number },
  makeId: () => string,
): { state: DocState; card: PromptCard } {
  const inputs = state.cards
    .filter((card): card is ImageCard => isImageCard(card) && inputIds.includes(card.id))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const bounds = unionRects(inputs);
  const x = bounds ? bounds.x + bounds.width + CHAIN_GAP : fallbackCenter.x - PROMPT_CARD_WIDTH / 2;
  const y = bounds ? bounds.y + bounds.height / 2 - PROMPT_CARD_HEIGHT / 2 : fallbackCenter.y - PROMPT_CARD_HEIGHT / 2;
  const card: PromptCard = {
    kind: 'prompt',
    id: makeId(),
    name: '提示词',
    x,
    y,
    width: PROMPT_CARD_WIDTH,
    height: PROMPT_CARD_HEIGHT,
    text: inputs.length > 0 ? inputs.map((_, i) => `{{Image ${i + 1}}}`).join(' ') + ' ' : '',
    inputs: inputs.map((input) => input.id),
    outputCardId: null,
    settings: { ...DEFAULT_PROMPT_SETTINGS },
  };
  return { state: addCards(state, [card]), card };
}

export function updatePrompt(state: DocState, id: string, patch: Partial<Pick<PromptCard, 'text' | 'name'>> & { settings?: Partial<PromptSettings> }): DocState {
  return mapCards(state, (card) => {
    if (card.id !== id || !isPromptCard(card)) return card;
    const next = { ...card, ...patch, settings: { ...card.settings, ...patch.settings } };
    const unchanged =
      next.text === card.text &&
      next.name === card.name &&
      next.settings.count === card.settings.count &&
      next.settings.size === card.settings.size &&
      next.settings.quality === card.settings.quality;
    return unchanged ? card : next;
  });
}

/** 绑定输入图：已经绑定过的不重复；提示词卡自己的输出图不能再作为它的输入 */
export function addPromptInput(state: DocState, promptId: string, imageId: string): DocState {
  return mapCards(state, (card) => {
    if (card.id !== promptId || !isPromptCard(card)) return card;
    if (card.inputs.includes(imageId) || card.outputCardId === imageId) return card;
    return { ...card, inputs: [...card.inputs, imageId] };
  });
}

export function removePromptInput(state: DocState, promptId: string, index: number): DocState {
  return mapCards(state, (card) =>
    card.id === promptId && isPromptCard(card) && index >= 0 && index < card.inputs.length
      ? { ...card, inputs: card.inputs.filter((_, i) => i !== index) }
      : card,
  );
}

export function movePromptInput(state: DocState, promptId: string, index: number, delta: -1 | 1): DocState {
  return mapCards(state, (card) => {
    if (card.id !== promptId || !isPromptCard(card)) return card;
    const target = index + delta;
    if (target < 0 || target >= card.inputs.length) return card;
    const inputs = [...card.inputs];
    [inputs[index], inputs[target]] = [inputs[target], inputs[index]];
    return { ...card, inputs };
  });
}

export interface GenerationResult {
  promptCardId: string;
  outputCardId: string;
  versions: Version[];
  /** 第一次生成时新建输出图像卡用的位置（按完成时提示词卡的位置算好） */
  placement: Rect;
}

/**
 * 生成结果是"永久"改动：已经花钱得到的版本不能因为撤销而消失。
 * 这个函数只做追加（输出卡不存在就建、版本没有就加），可以安全地套用到撤销栈里的每一个快照上。
 */
export function applyGenerationResult(state: DocState, result: GenerationResult): DocState {
  if (result.versions.length === 0) return state;
  const existing = state.cards.find((card) => card.id === result.outputCardId);
  let cards: CanvasCard[];
  if (existing && isImageCard(existing)) {
    const known = new Set(existing.versions.map((v) => v.id));
    const fresh = result.versions.filter((v) => !known.has(v.id));
    if (fresh.length === 0 && !needsOutputLink(state, result)) return state;
    cards = state.cards.map((card) =>
      card.id === existing.id && fresh.length > 0 ? { ...existing, versions: [...existing.versions, ...fresh] } : card,
    );
  } else {
    const first = result.versions[0];
    const prompt = state.cards.find((card) => card.id === result.promptCardId);
    const output: ImageCard = {
      kind: 'image',
      id: result.outputCardId,
      name: prompt ? `${prompt.name} · 结果` : '生成结果',
      x: result.placement.x,
      y: result.placement.y,
      width: result.placement.width,
      height: result.placement.width * (first.height / first.width),
      versions: result.versions,
      currentVersionId: first.id,
    };
    cards = [...state.cards, output];
  }
  cards = cards.map((card) =>
    card.id === result.promptCardId && isPromptCard(card) && card.outputCardId !== result.outputCardId
      ? { ...card, outputCardId: result.outputCardId }
      : card,
  );
  return { ...state, cards };
}

function needsOutputLink(state: DocState, result: GenerationResult): boolean {
  const prompt = state.cards.find((card) => card.id === result.promptCardId);
  return !!prompt && isPromptCard(prompt) && prompt.outputCardId !== result.outputCardId;
}

/** 第一次生成时输出图像卡的位置：提示词卡右侧，竖直居中；宽度跟随第一张输入图 */
export function outputPlacement(state: DocState, prompt: PromptCard, aspect: number): Rect {
  const firstInput = state.cards.find((card) => card.id === prompt.inputs[0]);
  const width = firstInput ? Math.min(800, Math.max(240, firstInput.width)) : 400;
  const height = width / aspect;
  return { x: prompt.x + prompt.width + CHAIN_GAP, y: prompt.y + prompt.height / 2 - height / 2, width, height };
}

// ───────────────────────── 主题卡 ─────────────────────────

export const THEME_CARD_WIDTH = 420;
export const THEME_CARD_HEIGHT = 500;
const THEME_GAP = 60;

/** 新主题卡放进视觉主题区，排在已有主题卡的右边 */
function themePlacement(state: DocState): Rect {
  const region = state.regions.find((r) => r.id === 'theme') ?? state.regions[0];
  const themes = state.cards.filter(isThemeCard);
  const right = themes.reduce((max, card) => Math.max(max, card.x + card.width), region ? region.x + THEME_GAP - THEME_GAP : 0);
  const x = themes.length ? right + THEME_GAP : (region?.x ?? 0) + THEME_GAP * 2;
  const y = themes.length ? themes[0].y : (region?.y ?? 0) + THEME_GAP * 2;
  return { x, y, width: THEME_CARD_WIDTH, height: THEME_CARD_HEIGHT };
}

export function themeFromDraft(state: DocState, draft: ThemeDraft, id: string): ThemeCard {
  return { kind: 'theme', id, ...themePlacement(state), ...draft };
}

export function setActiveTheme(state: DocState, id: string | null): DocState {
  if (state.activeThemeCardId === id) return state;
  if (id !== null && !state.cards.some((card) => card.id === id && isThemeCard(card))) return state;
  return { ...state, activeThemeCardId: id };
}

export function updateTheme(state: DocState, id: string, patch: Partial<Omit<ThemeCard, 'kind' | 'id'>>): DocState {
  return mapCards(state, (card) => (card.id === id && isThemeCard(card) ? { ...card, ...patch } : card));
}

export interface AppliedDrafts {
  state: DocState;
  themeId: string | null;
  promptIds: string[];
}

const DRAFT_COLUMN_GAP = 40;

/**
 * 把助手的草稿一次性放上画布（一条撤销记录）：
 * 主题卡进视觉主题区，还没有生效主题卡时自动设为生效；
 * 绑定了图的提示词卡在这些图右侧排成一列，没绑定的放在 fallback 附近。
 */
export function applyAssistantDrafts(
  state: DocState,
  drafts: { theme: ThemeDraft | null; prompts: PromptDraft[] },
  contextImageIds: string[],
  fallbackCenter: { x: number; y: number },
  makeId: () => string,
): AppliedDrafts {
  let next = state;
  let themeId: string | null = null;
  if (drafts.theme) {
    themeId = makeId();
    next = addCards(next, [themeFromDraft(next, drafts.theme, themeId)]);
    if (!next.activeThemeCardId) next = { ...next, activeThemeCardId: themeId };
  }

  const images = new Map(
    next.cards.filter((card): card is ImageCard => isImageCard(card) && contextImageIds.includes(card.id)).map((card) => [card.id, card]),
  );
  const bound = drafts.prompts
    .map((draft) => ({ draft, image: draft.inputIndex ? images.get(contextImageIds[draft.inputIndex - 1]) : undefined }))
    .sort((a, b) => (a.image && b.image ? a.image.y - b.image.y || a.image.x - b.image.x : 0));
  const anchor = unionRects([...images.values()]);
  const columnHeight = bound.length * PROMPT_CARD_HEIGHT + Math.max(0, bound.length - 1) * DRAFT_COLUMN_GAP;
  const columnX = anchor ? anchor.x + anchor.width + CHAIN_GAP : fallbackCenter.x - PROMPT_CARD_WIDTH / 2;
  let y = (anchor ? anchor.y + anchor.height / 2 : fallbackCenter.y) - columnHeight / 2;

  const promptIds: string[] = [];
  const cards: PromptCard[] = bound.map(({ draft, image }) => {
    const card: PromptCard = {
      kind: 'prompt',
      id: makeId(),
      name: draft.name,
      x: columnX,
      y,
      width: PROMPT_CARD_WIDTH,
      height: PROMPT_CARD_HEIGHT,
      text: draft.text,
      inputs: image ? [image.id] : [],
      outputCardId: null,
      settings: { ...DEFAULT_PROMPT_SETTINGS },
    };
    y += PROMPT_CARD_HEIGHT + DRAFT_COLUMN_GAP;
    promptIds.push(card.id);
    return card;
  });
  if (cards.length) next = addCards(next, cards);
  return { state: next, themeId, promptIds };
}

export function regionOf(state: DocState, card: Rect): RegionId | null {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  const region = state.regions.find((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height);
  return region?.id ?? null;
}

function mapCards(state: DocState, fn: (card: CanvasCard) => CanvasCard): DocState {
  let changed = false;
  const cards = state.cards.map((card) => {
    const next = fn(card);
    if (next !== card) changed = true;
    return next;
  });
  return changed ? { ...state, cards } : state;
}
