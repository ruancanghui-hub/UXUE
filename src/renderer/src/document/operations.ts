import { ELEMENT_CATEGORIES, type BlockDraft, type ElementCategory, type ElementDraft, type PromptDraft, type ThemeDraft } from '../../../shared/assistant';
import { DEFAULT_PROMPT_SETTINGS, type PromptSettings } from '../../../shared/generation';
import {
  blockRelativeRect,
  blockTypeLabel,
  canJoinGroup,
  cardGroupId,
  currentVersion,
  detectPreset,
  DEVICE_PRESETS,
  fitRegionHeights,
  regionColumnOf,
  isBlockCard,
  isGroupCard,
  isSketchMark,
  isSketchTextCard,
  SKETCH_FONT_SIZES,
  isImageCard,
  isPageCard,
  isPromptCard,
  isRefCard,
  isThemeCard,
  refDisplayVersion,
  type BlockCard,
  type CanvasCard,
  type SketchFontSize,
  type SketchTextCard,
  type StrokeCard,
  type GroupCard,
  type ImageCard,
  type PageCard,
  type PromptCard,
  type RefCard,
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
        groupId: null,
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
export function removeCards(state: DocState, requested: ReadonlySet<string>): DocState {
  // 页面框带走它里面的引用和区块；图像卡带走指向它的引用；分组框只删框，子卡脱离分组
  const ids = new Set(requested);
  for (const card of state.cards) {
    if (isRefCard(card) && ((card.pageId && requested.has(card.pageId)) || requested.has(card.imageCardId))) ids.add(card.id);
    if ((isBlockCard(card) || isSketchMark(card)) && requested.has(card.pageId)) ids.add(card.id);
  }
  const activeThemeCardId = state.activeThemeCardId && ids.has(state.activeThemeCardId) ? null : state.activeThemeCardId;
  const cards = state.cards
    .filter((card) => !ids.has(card.id))
    .map((card) => {
      let next: CanvasCard = card;
      if (canJoinGroup(card) && card.groupId && ids.has(card.groupId)) next = { ...card, groupId: null };
      if (isPageCard(next)) {
        const baseGone = !!next.baseCardId && ids.has(next.baseCardId);
        const wireframeGone = !!next.wireframePromptId && ids.has(next.wireframePromptId);
        if (!baseGone && !wireframeGone) return next;
        return { ...next, ...(baseGone ? { baseCardId: null } : {}), ...(wireframeGone ? { wireframePromptId: null } : {}) };
      }
      if (isBlockCard(next)) {
        const cropGone = !!next.cropCardId && ids.has(next.cropCardId);
        const promptGone = !!next.promptCardId && ids.has(next.promptCardId);
        if (!cropGone && !promptGone) return next;
        return {
          ...next,
          ...(cropGone ? { cropCardId: null, cropRect: null, cropBaseVersionId: null } : {}),
          ...(promptGone ? { promptCardId: null } : {}),
        };
      }
      if (!isPromptCard(next)) return next;
      if (next.styleRefCardId && ids.has(next.styleRefCardId)) next = withoutStyleRef(next);
      const inputs = next.inputs.filter((id) => !ids.has(id));
      const outputCardId = next.outputCardId && ids.has(next.outputCardId) ? null : next.outputCardId;
      return inputs.length === next.inputs.length && outputCardId === next.outputCardId ? next : { ...next, inputs, outputCardId };
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
  const newIds: string[] = [];
  const pageCopies = new Map<string, string>();
  const copies = state.cards
    .filter((card) => ids.has(card.id))
    .map((card): CanvasCard => {
      let moved: CanvasCard = { ...card, id: makeId(), x: card.x + DUPLICATE_OFFSET, y: card.y + DUPLICATE_OFFSET };
      newIds.push(moved.id);
      if (isPageCard(card)) pageCopies.set(card.id, moved.id);
      if (isPageCard(moved)) moved = { ...moved, wireframePromptId: null };
      if (isPromptCard(moved)) moved = { ...moved, outputCardId: null };
      if (canJoinGroup(moved)) moved = { ...moved, groupId: null };
      if (isBlockCard(moved)) moved = { ...moved, cropCardId: null, cropRect: null, cropBaseVersionId: null, promptCardId: null };
      return moved;
    });
  // 复制页面框时一起复制里面的引用和区块（单独选中的已经在上面复制过）；区块副本不带截图和提示词
  const childCopies = state.cards
    .filter(
      (card): card is RefCard | BlockCard | StrokeCard | SketchTextCard =>
        (isRefCard(card) || isBlockCard(card) || isSketchMark(card)) && !!card.pageId && pageCopies.has(card.pageId) && !ids.has(card.id),
    )
    .map((card): CanvasCard => {
      const moved = { ...card, id: makeId(), x: card.x + DUPLICATE_OFFSET, y: card.y + DUPLICATE_OFFSET, pageId: pageCopies.get(card.pageId!)! };
      return isBlockCard(moved) ? { ...moved, cropCardId: null, cropRect: null, cropBaseVersionId: null, promptCardId: null } : moved;
    });
  return { state: { ...state, cards: [...state.cards, ...copies, ...childCopies] }, newIds };
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
  const target = state.cards.find((card) => card.id === id);
  const version = target && isImageCard(target) ? target.versions.find((v) => v.id === versionId) : undefined;
  if (!version || !target || !isImageCard(target) || target.currentVersionId === versionId) return state;
  const aspect = version.height / version.width;
  // 未锁定的页面引用跟着当前版本走：宽度不变，高度按新比例
  return mapCards(state, (card) => {
    if (card.id === id && isImageCard(card)) return { ...card, currentVersionId: versionId, height: card.width * aspect };
    if (isRefCard(card) && card.imageCardId === id && !card.lockedVersionId) return { ...card, height: card.width * aspect };
    return card;
  });
}

/** 锁定 / 解锁页面引用的显示版本 */
export function setRefLockedVersion(state: DocState, refId: string, lockedVersionId: string | null): DocState {
  return mapCards(state, (card) => {
    if (!isRefCard(card) || card.id !== refId) return card;
    if (card.lockedVersionId === lockedVersionId) return card;
    const source = state.cards.find((c) => c.id === card.imageCardId);
    if (lockedVersionId && (!source || !isImageCard(source) || !source.versions.some((v) => v.id === lockedVersionId))) return card;
    const version = source && isImageCard(source) ? (lockedVersionId ? source.versions.find((v) => v.id === lockedVersionId) : currentVersion(source)) : null;
    if (!version) return { ...card, lockedVersionId };
    const aspect = version.height / version.width;
    return { ...card, lockedVersionId, height: card.width * aspect };
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
    groupId: null,
    purpose: null,
    styleRefCardId: null,
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
      name: prompt && isPromptCard(prompt) ? `${prompt.name} · 结果` : '生成结果',
      x: result.placement.x,
      y: result.placement.y,
      width: result.placement.width,
      height: result.placement.width * (first.height / first.width),
      versions: result.versions,
      currentVersionId: first.id,
      groupId: prompt && isPromptCard(prompt) ? prompt.groupId : null,
    };
    cards = applyWireframeBase([...state.cards, output], result.promptCardId, output);
    const blockRef = refForBlockOutput(state, result.promptCardId, output);
    if (blockRef) cards.push(blockRef);
  }
  cards = cards.map((card) =>
    card.id === result.promptCardId && isPromptCard(card) && card.outputCardId !== result.outputCardId
      ? { ...card, outputCardId: result.outputCardId }
      : card,
  );
  return { ...state, cards };
}

/**
 * 区块的输出图第一次出现时，在区块位置放一个素材引用：宽度对齐区块、竖直居中。
 * id 由输出卡推出来，保证套用到撤销栈每个快照时是同一个引用。
 */
function refForBlockOutput(state: DocState, promptCardId: string, output: ImageCard): RefCard | null {
  const block = state.cards.find((card): card is BlockCard => isBlockCard(card) && card.promptCardId === promptCardId);
  if (!block || !state.cards.some((card) => card.id === block.pageId && isPageCard(card))) return null;
  const version = currentVersion(output);
  const height = block.width * (version.height / version.width);
  return {
    kind: 'ref',
    id: `${output.id}-block`,
    x: block.x,
    y: block.y + (block.height - height) / 2,
    width: block.width,
    height,
    imageCardId: output.id,
    pageId: block.pageId,
    lockedVersionId: null,
  };
}

function needsOutputLink(state: DocState, result: GenerationResult): boolean {
  const prompt = state.cards.find((card) => card.id === result.promptCardId);
  return !!prompt && isPromptCard(prompt) && prompt.outputCardId !== result.outputCardId;
}

/** 第一次生成时输出图像卡的位置：提示词卡右侧，竖直居中；宽度跟随第一张输入图 */
export function outputPlacement(state: DocState, prompt: PromptCard, aspect: number): Rect {
  const firstInput = state.cards.find((card) => card.id === prompt.inputs[0]);
  // 素材清单排成网格，输出宽度固定，绑了大的风格基准图也不会压住旁边的卡
  const width = prompt.purpose === 'element' ? ELEMENT_OUTPUT_WIDTH : firstInput ? Math.min(800, Math.max(240, firstInput.width)) : 400;
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

export function themeFromDraft(
  state: DocState,
  draft: ThemeDraft,
  id: string,
  source: { imageCardId: string; versionId: string } | null = null,
): ThemeCard {
  return {
    kind: 'theme',
    id,
    ...themePlacement(state),
    ...draft,
    groupId: null,
    sourceImageCardId: source?.imageCardId ?? null,
    sourceVersionId: source?.versionId ?? null,
  };
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
  /** 看图提炼主题时写入主题来源；纯文字为 null */
  themeSource: { imageCardId: string; versionId: string } | null = null,
): AppliedDrafts {
  let next = state;
  let themeId: string | null = null;
  if (drafts.theme) {
    themeId = makeId();
    next = addCards(next, [themeFromDraft(next, drafts.theme, themeId, themeSource)]);
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
      groupId: null,
      purpose: null,
      styleRefCardId: null,
    };
    y += PROMPT_CARD_HEIGHT + DRAFT_COLUMN_GAP;
    promptIds.push(card.id);
    return card;
  });
  if (cards.length) next = addCards(next, cards);
  return { state: next, themeId, promptIds };
}

// ───────────────────────── 页面框与素材引用 ─────────────────────────

/** 画布上页面框的宽度：竖版 480、横版 960，高度按逻辑尺寸的比例 */
const PAGE_WIDTH_PORTRAIT = 480;
const PAGE_WIDTH_LANDSCAPE = 960;
const PAGE_GAP = 120;

export function newPageCard(
  state: DocState,
  options: { id: string; name: string; base: Version | null },
): PageCard {
  const detected = options.base ? detectPreset(options.base.width, options.base.height) : { presetId: 'iphone', scale: 3 };
  const logical = detected
    ? DEVICE_PRESETS.find((p) => p.id === detected.presetId)!
    : { width: options.base!.width, height: options.base!.height };
  const width = logical.width >= logical.height ? PAGE_WIDTH_LANDSCAPE : PAGE_WIDTH_PORTRAIT;
  const height = width * (logical.height / logical.width);
  const region = state.regions.find((r) => r.id === 'pages') ?? state.regions[state.regions.length - 1];
  const pages = state.cards.filter(isPageCard);
  const x = pages.length ? Math.max(...pages.map((p) => p.x + p.width)) + PAGE_GAP : (region?.x ?? 0) + PAGE_GAP;
  const y = pages.length ? pages[0].y : (region?.y ?? 0) + PAGE_GAP;
  return {
    kind: 'page',
    id: options.id,
    name: options.name,
    x,
    y,
    width,
    height,
    base: options.base,
    background: '#FFFFFF',
    devicePreset: detected?.presetId ?? null,
    exportScale: detected?.scale ?? 1,
    baseSource: 'own',
    baseCardId: null,
    wireframePromptId: null,
    sketchHidden: false,
  };
}

export function updatePage(state: DocState, id: string, patch: Partial<Omit<PageCard, 'kind' | 'id'>>): DocState {
  return mapCards(state, (card) => (card.id === id && isPageCard(card) ? { ...card, ...patch } : card));
}

/** 换设备预设：宽度不变，高度按预设比例 */
export function setPagePreset(state: DocState, id: string, presetId: string | null): DocState {
  return mapCards(state, (card) => {
    if (card.id !== id || !isPageCard(card) || card.devicePreset === presetId) return card;
    const preset = DEVICE_PRESETS.find((p) => p.id === presetId);
    const logical = preset ?? (card.base ? { width: card.base.width, height: card.base.height } : null);
    const height = logical ? card.width * (logical.height / logical.width) : card.height;
    return { ...card, devicePreset: preset ? preset.id : null, height };
  });
}

/** 页面里摆进素材：每项是一张图像卡和它在画布上的目标位置 */
export function placeIntoPage(
  state: DocState,
  pageId: string,
  items: { imageCardId: string; rect: Rect }[],
  makeId: () => string,
): { state: DocState; refIds: string[] } {
  const refs: RefCard[] = items.map(({ imageCardId, rect }) => ({
    kind: 'ref',
    id: makeId(),
    ...rect,
    imageCardId,
    pageId,
    lockedVersionId: null,
  }));
  return { state: addCards(state, refs), refIds: refs.map((ref) => ref.id) };
}

/** 图像卡拖进页面时的大小：比页面宽就缩到页面宽度的 90%，以松手处为中心 */
export function fitIntoPage(page: Rect, card: Rect, centerX: number, centerY: number): Rect {
  const scale = Math.min(1, (page.width * 0.9) / card.width, (page.height * 0.9) / card.height);
  const width = card.width * scale;
  const height = card.height * scale;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

/** 页面框连同它里面的引用；分组框连同组成员：拖动、微调时一起动 */
export function withPageChildren(state: DocState, ids: Iterable<string>): Set<string> {
  const result = new Set(ids);
  const pages = new Set(state.cards.filter((card) => result.has(card.id) && isPageCard(card)).map((card) => card.id));
  const groups = new Set(state.cards.filter((card) => result.has(card.id) && isGroupCard(card)).map((card) => card.id));
  if (pages.size === 0 && groups.size === 0) return result;
  for (const card of state.cards) {
    if ((isRefCard(card) || isBlockCard(card) || isSketchMark(card)) && card.pageId && pages.has(card.pageId)) result.add(card.id);
    const gid = cardGroupId(card);
    if (gid && groups.has(gid)) result.add(card.id);
  }
  return result;
}

const GROUP_PAD = 24;

/** 把可进组的选中卡编成一组；至少 2 张 */
export function groupCards(state: DocState, ids: ReadonlySet<string>, makeId: () => string): { state: DocState; groupId: string } | null {
  const members = state.cards.filter((card) => ids.has(card.id) && canJoinGroup(card));
  if (members.length < 2) return null;
  const bounds = unionRects(members);
  if (!bounds) return null;
  const groupId = makeId();
  const group: GroupCard = {
    kind: 'group',
    id: groupId,
    name: '分组',
    x: bounds.x - GROUP_PAD,
    y: bounds.y - GROUP_PAD,
    width: bounds.width + GROUP_PAD * 2,
    height: bounds.height + GROUP_PAD * 2,
  };
  const memberIds = new Set(members.map((m) => m.id));
  const cards = state.cards.map((card) =>
    memberIds.has(card.id) && canJoinGroup(card) ? { ...card, groupId } : card,
  );
  return { state: { ...state, cards: [...cards, group] }, groupId };
}

/** 解组：去掉分组框，子卡脱离 */
export function ungroupCards(state: DocState, groupIds: ReadonlySet<string>): DocState {
  const ids = new Set([...groupIds].filter((id) => state.cards.some((c) => c.id === id && isGroupCard(c))));
  if (ids.size === 0) return state;
  const cards = state.cards
    .filter((card) => !(isGroupCard(card) && ids.has(card.id)))
    .map((card) => (canJoinGroup(card) && card.groupId && ids.has(card.groupId) ? { ...card, groupId: null } : card));
  return { ...state, cards };
}

/** 引用按中心点重新认页面：落在哪个页面框里就属于哪个，都不在就脱离页面 */
export function reassignRefPages(state: DocState, refIds: ReadonlySet<string>): DocState {
  const pages = state.cards.filter(isPageCard);
  return mapCards(state, (card) => {
    if (!isRefCard(card) || !refIds.has(card.id)) return card;
    const cx = card.x + card.width / 2;
    const cy = card.y + card.height / 2;
    const page = [...pages].reverse().find((p) => cx >= p.x && cx <= p.x + p.width && cy >= p.y && cy <= p.y + p.height);
    const pageId = page?.id ?? null;
    return pageId === card.pageId ? card : { ...card, pageId };
  });
}

/** 绘制和命中顺序：页面框之后依次是区块、草图笔迹和文字、引用（放好的素材盖在最上面）；组成员紧跟分组框 */
export function renderOrder(cards: readonly CanvasCard[]): CanvasCard[] {
  const pageIds = new Set(cards.filter(isPageCard).map((card) => card.id));
  const groupIds = new Set(cards.filter(isGroupCard).map((card) => card.id));
  const pageChildren = new Map<string, CanvasCard[]>();
  const groupChildren = new Map<string, CanvasCard[]>();
  for (const kindOf of [isBlockCard, isSketchMark] as const) {
    for (const card of cards) {
      if (kindOf(card) && pageIds.has(card.pageId)) {
        const list = pageChildren.get(card.pageId) ?? [];
        list.push(card);
        pageChildren.set(card.pageId, list);
      }
    }
  }
  for (const card of cards) {
    if (isRefCard(card) && card.pageId && pageIds.has(card.pageId)) {
      const list = pageChildren.get(card.pageId) ?? [];
      list.push(card);
      pageChildren.set(card.pageId, list);
    }
    const gid = cardGroupId(card);
    if (gid && groupIds.has(gid)) {
      const list = groupChildren.get(gid) ?? [];
      list.push(card);
      groupChildren.set(gid, list);
    }
  }
  if (pageChildren.size === 0 && groupChildren.size === 0) return [...cards];
  const ordered: CanvasCard[] = [];
  for (const card of cards) {
    if (isRefCard(card) && card.pageId && pageIds.has(card.pageId)) continue;
    if ((isBlockCard(card) || isSketchMark(card)) && pageIds.has(card.pageId)) continue;
    if (cardGroupId(card) && groupIds.has(cardGroupId(card)!)) continue;
    ordered.push(card);
    if (isPageCard(card)) ordered.push(...(pageChildren.get(card.id) ?? []));
    if (isGroupCard(card)) ordered.push(...(groupChildren.get(card.id) ?? []));
  }
  return ordered;
}

/** 画布上显示这张卡片需要的版本：图像卡当前版；引用跟锁定或当前版；页面框是低保真原型 */
export function displayVersion(card: CanvasCard, byId: ReadonlyMap<string, CanvasCard>): Version | null {
  if (isImageCard(card)) return currentVersion(card);
  if (isPageCard(card)) return card.base;
  if (isRefCard(card)) {
    const source = byId.get(card.imageCardId);
    return source && isImageCard(source) ? refDisplayVersion(card, source) : null;
  }
  return null;
}

// ───────────────────────── 区块 ─────────────────────────

const MIN_BLOCK_EDGE = 8;
/** 助手给的区块坐标是 0–1000，相对低保真原型 */
const DRAFT_SCALE = 1000;

export function blockHasOutput(state: DocState, block: BlockCard): boolean {
  const prompt = block.promptCardId ? state.cards.find((card) => card.id === block.promptCardId) : undefined;
  return !!prompt && isPromptCard(prompt) && !!prompt.outputCardId;
}

export function pageBlocks(state: DocState, pageId: string): BlockCard[] {
  return state.cards.filter((card): card is BlockCard => isBlockCard(card) && card.pageId === pageId);
}

/** 拆解结果放进页面框：已经有输出的区块保留，其余换成新提议的 */
export function applyDecomposition(
  state: DocState,
  pageId: string,
  drafts: BlockDraft[],
  makeId: () => string,
): { state: DocState; blockIds: string[] } {
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page) return { state, blockIds: [] };
  const replaced = new Set(pageBlocks(state, pageId).filter((block) => !blockHasOutput(state, block)).map((block) => block.id));
  const next = replaced.size ? { ...state, cards: state.cards.filter((card) => !replaced.has(card.id)) } : state;
  const blocks = drafts.map(
    (draft): BlockCard => ({
      kind: 'block',
      id: makeId(),
      name: draft.name || blockTypeLabel(draft.type),
      x: page.x + (draft.x / DRAFT_SCALE) * page.width,
      y: page.y + (draft.y / DRAFT_SCALE) * page.height,
      width: Math.max(MIN_BLOCK_EDGE, (draft.width / DRAFT_SCALE) * page.width),
      height: Math.max(MIN_BLOCK_EDGE, (draft.height / DRAFT_SCALE) * page.height),
      pageId,
      blockType: draft.type,
      group: draft.group,
      cropCardId: null,
      cropRect: null,
      cropBaseVersionId: null,
      promptCardId: null,
    }),
  );
  return { state: addCards(next, blocks), blockIds: blocks.map((block) => block.id) };
}

/** 手动新建一个区块：页面框正中、宽度 40% */
export function addBlock(state: DocState, pageId: string, makeId: () => string): { state: DocState; blockId: string } | null {
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page) return null;
  const width = page.width * 0.4;
  const height = width * 0.5;
  const block: BlockCard = {
    kind: 'block',
    id: makeId(),
    name: '区块',
    x: page.x + (page.width - width) / 2,
    y: page.y + (page.height - height) / 2,
    width,
    height,
    pageId,
    blockType: 'other',
    group: null,
    cropCardId: null,
    cropRect: null,
    cropBaseVersionId: null,
    promptCardId: null,
  };
  return { state: addCards(state, [block]), blockId: block.id };
}

/** 区块工具在页面框里拖出的一个框；名字先叫「区块」，建好后让用户马上改 */
export function createBlockAt(state: DocState, pageId: string, rect: Rect, makeId: () => string): { state: DocState; blockId: string } | null {
  if (!state.cards.some((card) => card.id === pageId && isPageCard(card))) return null;
  const block: BlockCard = {
    kind: 'block',
    id: makeId(),
    name: '区块',
    ...rect,
    pageId,
    blockType: 'other',
    group: null,
    cropCardId: null,
    cropRect: null,
    cropBaseVersionId: null,
    promptCardId: null,
  };
  return { state: addCards(state, [block]), blockId: block.id };
}

/** 画笔画完的一笔：按世界坐标的点算外接框，点归一化到外接框里 */
export function createStroke(
  state: DocState,
  pageId: string,
  worldPoints: number[],
  lineWidth: number,
  makeId: () => string,
): { state: DocState; strokeId: string } | null {
  if (!state.cards.some((card) => card.id === pageId && isPageCard(card))) return null;
  if (worldPoints.length < 4 || worldPoints.length % 2 !== 0) return null;
  const xs = worldPoints.filter((_, i) => i % 2 === 0);
  const ys = worldPoints.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  // 一笔横线或竖线的外接框有一边是 0，给个最小值免得除零
  const width = Math.max(Math.max(...xs) - minX, 0.001);
  const height = Math.max(Math.max(...ys) - minY, 0.001);
  const points = worldPoints.map((v, i) => (i % 2 === 0 ? (v - minX) / width : (v - minY) / height));
  const stroke: StrokeCard = { kind: 'stroke', id: makeId(), x: minX, y: minY, width, height, pageId, points, lineWidth };
  return { state: addCards(state, [stroke]), strokeId: stroke.id };
}

/** 一笔在世界坐标里的点 */
export function strokeWorldPoints(stroke: StrokeCard): number[] {
  return stroke.points.map((v, i) => (i % 2 === 0 ? stroke.x + v * stroke.width : stroke.y + v * stroke.height));
}

/** 文字工具点出的一段草图文字；内容先空着，建好后让用户马上输入 */
export function createSketchText(
  state: DocState,
  pageId: string,
  at: { x: number; y: number },
  fontSize: SketchFontSize,
  makeId: () => string,
): { state: DocState; textId: string } | null {
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page) return null;
  const size = SKETCH_FONT_SIZES[fontSize];
  const width = Math.min(size * 8, page.x + page.width - at.x);
  const text: SketchTextCard = {
    kind: 'sketchText',
    id: makeId(),
    x: at.x,
    y: at.y,
    width: Math.max(width, size * 2),
    height: size * 1.4,
    pageId,
    text: '',
    fontSize,
  };
  return { state: addCards(state, [text]), textId: text.id };
}

/** 改草图文字：外接框宽度跟着内容走，按单行估算 */
export function updateSketchText(state: DocState, id: string, patch: Partial<Pick<SketchTextCard, 'text' | 'fontSize'>>): DocState {
  return mapCards(state, (card) => {
    if (card.id !== id || !isSketchTextCard(card)) return card;
    const next = { ...card, ...patch };
    if (next.text === card.text && next.fontSize === card.fontSize) return card;
    const size = SKETCH_FONT_SIZES[next.fontSize];
    const longest = Math.max(2, ...next.text.split('\n').map((line) => line.length));
    const lines = Math.max(1, next.text.split('\n').length);
    return { ...next, width: longest * size * 1.05, height: lines * size * 1.4 };
  });
}

export function sketchMarks(state: DocState, pageId: string): (StrokeCard | SketchTextCard)[] {
  return state.cards.filter((card): card is StrokeCard | SketchTextCard => isSketchMark(card) && card.pageId === pageId);
}

export function updateBlock(state: DocState, id: string, patch: Partial<Pick<BlockCard, 'name' | 'blockType' | 'group'>>): DocState {
  return mapCards(state, (card) => {
    if (card.id !== id || !isBlockCard(card)) return card;
    const next = { ...card, ...patch };
    return next.name === card.name && next.blockType === card.blockType && next.group === card.group ? card : next;
  });
}

/** 单个区块自由缩放：对角固定，另一角跟着指针走 */
export function resizeBlock(state: DocState, origin: BlockCard, anchorX: number, anchorY: number, pointX: number, pointY: number): DocState {
  const left = Math.min(anchorX, pointX);
  const top = Math.min(anchorY, pointY);
  const width = Math.max(MIN_BLOCK_EDGE, Math.abs(pointX - anchorX));
  const height = Math.max(MIN_BLOCK_EDGE, Math.abs(pointY - anchorY));
  const x = pointX < anchorX ? anchorX - width : left;
  const y = pointY < anchorY ? anchorY - height : top;
  return mapCards(state, (card) => (card.id === origin.id ? { ...card, x, y, width, height } : card));
}

const CROP_COLUMN = 280;
const BLOCK_ROW_GAP = 60;
const BLOCK_REGION_PAD = 160;

/**
 * 区块截图放进核心素材区：每个页面一个分组框，每个区块一行（截图 → 提示词卡 → 输出）。
 * 已有截图的区块给截图追加新版本；没有的新建截图卡。都记下截图时的相对位置。
 */
export function placeBlockCrops(
  state: DocState,
  pageId: string,
  crops: { blockId: string; version: Version }[],
  makeId: () => string,
): { state: DocState; groupId: string | null } {
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page || crops.length === 0) return { state, groupId: null };
  let next = state;
  const blocks = new Map(pageBlocks(state, pageId).map((block) => [block.id, block]));

  const existingCrop = [...blocks.values()]
    .map((block) => (block.cropCardId ? state.cards.find((card) => card.id === block.cropCardId) : undefined))
    .find((card): card is ImageCard => !!card && isImageCard(card));
  let group = existingCrop?.groupId
    ? state.cards.find((card): card is GroupCard => card.id === existingCrop.groupId && isGroupCard(card))
    : undefined;

  const fresh: ImageCard[] = [];
  const region = state.regions.find((r) => r.id === 'assets') ?? state.regions[0];
  const members = group ? state.cards.filter((card) => cardGroupId(card) === group!.id) : [];
  const left = group ? group.x + GROUP_PAD : (region?.x ?? 0) + BLOCK_REGION_PAD;
  let y = group
    ? Math.max(group.y + GROUP_PAD, ...members.map((card) => card.y + card.height + BLOCK_ROW_GAP))
    : Math.max(
        (region?.y ?? 0) + BLOCK_REGION_PAD,
        ...state.cards.filter((card) => regionOf(state, card) === 'assets').map((card) => card.y + card.height + BLOCK_REGION_PAD),
      );
  const groupId = group?.id ?? makeId();
  let bottom = y;

  for (const { blockId, version } of crops) {
    const block = blocks.get(blockId);
    if (!block) continue;
    const cropRect = blockRelativeRect(block, page);
    const existing = block.cropCardId ? next.cards.find((card) => card.id === block.cropCardId) : undefined;
    if (existing && isImageCard(existing)) {
      next = addVersions(next, existing.id, [version]);
      next = mapCards(next, (card) =>
        card.id === blockId && isBlockCard(card) ? { ...card, cropRect, cropBaseVersionId: page.base?.id ?? null } : card,
      );
      continue;
    }
    const size = cardSizeFor(version, CROP_COLUMN);
    const outputWidth = Math.min(800, Math.max(240, size.width));
    const rowHeight = Math.max(size.height, PROMPT_CARD_HEIGHT, outputWidth * (size.height / size.width));
    const card: ImageCard = {
      kind: 'image',
      id: makeId(),
      name: `${block.name} · 截图`,
      x: left,
      y: y + (rowHeight - size.height) / 2,
      width: size.width,
      height: size.height,
      versions: [version],
      currentVersionId: version.id,
      groupId,
    };
    fresh.push(card);
    next = mapCards(next, (c) =>
      c.id === blockId && isBlockCard(c) ? { ...c, cropCardId: card.id, cropRect, cropBaseVersionId: page.base?.id ?? null } : c,
    );
    bottom = y + rowHeight;
    y = bottom + BLOCK_ROW_GAP;
  }
  if (fresh.length === 0) return { state: next, groupId: group?.id ?? null };

  const rowWidth = CROP_COLUMN + CHAIN_GAP + PROMPT_CARD_WIDTH + CHAIN_GAP + CROP_COLUMN;
  if (group) {
    const height = Math.max(group.height, bottom + GROUP_PAD - group.y);
    const width = Math.max(group.width, rowWidth + GROUP_PAD * 2);
    next = mapCards(next, (card) => (card.id === group!.id ? { ...card, width, height } : card));
  } else {
    const top = Math.min(...fresh.map((card) => card.y));
    group = {
      kind: 'group',
      id: groupId,
      name: `${page.name} · 区块`,
      x: left - GROUP_PAD,
      y: top - GROUP_PAD,
      width: rowWidth + GROUP_PAD * 2,
      height: bottom - top + GROUP_PAD * 2,
    };
    next = addCards(next, [group]);
  }
  return { state: addCards(next, fresh), groupId };
}

/**
 * 助手为区块写的提示词放上画布：每个区块一张，绑定它的截图，放在截图右侧、和截图同组。
 * blocks 的顺序就是发给助手的第 1、2… 张图。
 */
export function applyBlockPrompts(
  state: DocState,
  blocks: BlockCard[],
  drafts: PromptDraft[],
  makeId: () => string,
): { state: DocState; promptIds: string[] } {
  let next = state;
  const promptIds: string[] = [];
  const prompts: PromptCard[] = [];
  for (const draft of drafts) {
    const block = draft.inputIndex ? blocks[draft.inputIndex - 1] : undefined;
    if (!block?.cropCardId || block.promptCardId) continue;
    const crop = next.cards.find((card): card is ImageCard => card.id === block.cropCardId && isImageCard(card));
    if (!crop) continue;
    const card: PromptCard = {
      kind: 'prompt',
      id: makeId(),
      name: block.name,
      x: crop.x + CROP_COLUMN + CHAIN_GAP,
      y: crop.y + crop.height / 2 - PROMPT_CARD_HEIGHT / 2,
      width: PROMPT_CARD_WIDTH,
      height: PROMPT_CARD_HEIGHT,
      text: draft.text,
      inputs: [crop.id],
      outputCardId: null,
      settings: { ...DEFAULT_PROMPT_SETTINGS, count: 1 },
      groupId: crop.groupId,
      purpose: null,
      styleRefCardId: null,
    };
    prompts.push(card);
    promptIds.push(card.id);
    next = mapCards(next, (c) => (c.id === block.id && isBlockCard(c) ? { ...c, promptCardId: card.id } : c));
  }
  if (prompts.length) next = addCards(next, prompts);
  return { state: next, promptIds };
}

// ───────────────────────── 素材清单与风格基准 ─────────────────────────

const ELEMENT_OUTPUT_WIDTH = 400;
const ELEMENT_COLUMNS = 3;
const ELEMENT_COLUMN_WIDTH = PROMPT_CARD_WIDTH + CHAIN_GAP + ELEMENT_OUTPUT_WIDTH + 80;
const ELEMENT_ROW_HEIGHT = ELEMENT_OUTPUT_WIDTH + 60;
const ELEMENT_GROUP_GAP = 120;

const ELEMENT_SIZE: Record<ElementCategory, PromptSettings['size']> = {
  icon: '1024x1024',
  decor: '1024x1024',
  pattern: '1024x1024',
  illustration: '1536x1024',
};

export const STYLE_REF_SENTENCE = '【画风参照】画风、线条、材质、光影与 {{Image 1}} 保持一致，但不要复制它的内容和构图。';

/**
 * 素材清单落到核心素材区：每个类别一个分组框，排在已有内容下方；组内 3 列网格，
 * 列宽留出输出图的位置。已有风格基准时新卡直接绑定它。
 */
export function applyElementList(
  state: DocState,
  drafts: ElementDraft[],
  makeId: () => string,
): { state: DocState; promptIds: string[]; groupIds: string[] } {
  if (drafts.length === 0) return { state, promptIds: [], groupIds: [] };
  const region = state.regions.find((r) => r.id === 'assets') ?? state.regions[0];
  const left = (region?.x ?? 0) + BLOCK_REGION_PAD;
  let top = Math.max(
    (region?.y ?? 0) + BLOCK_REGION_PAD,
    ...state.cards.filter((card) => regionOf(state, card) === 'assets').map((card) => card.y + card.height + BLOCK_REGION_PAD),
  );
  const benchmark = currentStyleBenchmark(state);
  const cards: CanvasCard[] = [];
  const promptIds: string[] = [];
  const groupIds: string[] = [];
  for (const category of ELEMENT_CATEGORIES) {
    const items = drafts.filter((draft) => draft.category === category.id);
    if (items.length === 0) continue;
    const groupId = makeId();
    const rows = Math.ceil(items.length / ELEMENT_COLUMNS);
    const columns = Math.min(ELEMENT_COLUMNS, items.length);
    items.forEach((draft, i) => {
      const prompt: PromptCard = {
        kind: 'prompt',
        id: makeId(),
        name: draft.name,
        x: left + (i % ELEMENT_COLUMNS) * ELEMENT_COLUMN_WIDTH,
        y: top + Math.floor(i / ELEMENT_COLUMNS) * ELEMENT_ROW_HEIGHT + (ELEMENT_ROW_HEIGHT - PROMPT_CARD_HEIGHT) / 2,
        width: PROMPT_CARD_WIDTH,
        height: PROMPT_CARD_HEIGHT,
        text: draft.text,
        inputs: [],
        outputCardId: null,
        settings: { count: 1, size: ELEMENT_SIZE[draft.category], quality: 'medium', useTheme: true },
        groupId,
        purpose: 'element',
        styleRefCardId: null,
      };
      cards.push(benchmark ? withStyleRef(prompt, benchmark) : prompt);
      promptIds.push(prompt.id);
    });
    const group: GroupCard = {
      kind: 'group',
      id: groupId,
      name: `素材清单 · ${category.label}`,
      x: left - GROUP_PAD,
      y: top - GROUP_PAD,
      width: columns * ELEMENT_COLUMN_WIDTH - 80 + GROUP_PAD * 2,
      height: rows * ELEMENT_ROW_HEIGHT + GROUP_PAD * 2,
    };
    cards.push(group);
    groupIds.push(groupId);
    top += rows * ELEMENT_ROW_HEIGHT + GROUP_PAD * 2 + ELEMENT_GROUP_GAP;
  }
  return { state: addCards(state, cards), promptIds, groupIds };
}

export function elementPrompts(state: DocState): PromptCard[] {
  return state.cards.filter((card): card is PromptCard => isPromptCard(card) && card.purpose === 'element');
}

/** 当前的风格基准：清单提示词卡上绑定的那张（同时只有一张） */
export function currentStyleBenchmark(state: DocState): string | null {
  return elementPrompts(state).find((prompt) => prompt.styleRefCardId)?.styleRefCardId ?? null;
}

function withoutStyleRef(prompt: PromptCard): PromptCard {
  if (!prompt.styleRefCardId) return prompt;
  const text = prompt.text.replace(`${STYLE_REF_SENTENCE}\n`, '').replace(STYLE_REF_SENTENCE, '').trim();
  return { ...prompt, inputs: prompt.inputs.filter((id) => id !== prompt.styleRefCardId), styleRefCardId: null, text };
}

function withStyleRef(prompt: PromptCard, imageCardId: string): PromptCard {
  const base = withoutStyleRef(prompt);
  return {
    ...base,
    inputs: [imageCardId, ...base.inputs.filter((id) => id !== imageCardId)],
    styleRefCardId: imageCardId,
    text: `${STYLE_REF_SENTENCE}\n${base.text}`,
  };
}

/**
 * 设风格基准：全部清单提示词卡（输出就是这张图的那张除外）换绑到它；null 就是取消。
 * 已生成的因为输入变了，会被判为已过期。
 */
export function setStyleBenchmark(state: DocState, imageCardId: string | null): DocState {
  if (imageCardId && !state.cards.some((card) => card.id === imageCardId && isImageCard(card))) return state;
  return mapCards(state, (card) => {
    if (!isPromptCard(card) || card.purpose !== 'element') return card;
    if (!imageCardId || card.outputCardId === imageCardId) return withoutStyleRef(card);
    return card.styleRefCardId === imageCardId ? card : withStyleRef(card, imageCardId);
  });
}

// ───────────────────────── 转线框 ─────────────────────────

export const WIREFRAME_PROMPT = [
  '把 {{Image 1}} 改画成黑白线框图（低保真原型）。',
  '【保留】原图的整体布局、每个元素的位置和大小、卡片和按钮的圆角形状、状态栏和导航栏，以及所有原文字（字体换成简洁的黑色无衬线体）。',
  '【改画】图标、插画、角色和照片全部重画成简洁的黑色线描：线宽统一，只勾轮廓，不填色。',
  '【配色】背景纯白；卡片用黑色细描边；按钮和输入框用浅灰色填充；除此之外不要任何颜色。',
  '【不要】渐变、阴影、质感、光效、照片纹理；不要增加或删除元素，画面比例与原图一致。',
].join('\n');

const WIREFRAME_SETTINGS: PromptSettings = { count: 1, size: 'match', quality: 'medium', useTheme: false };

/** 在图像卡右侧建一张转线框提示词卡：固定提示词、绑定这张图、不附加主题规则 */
export function createWireframePrompt(
  state: DocState,
  imageCardId: string,
  makeId: () => string,
): { state: DocState; promptId: string } | null {
  if (!state.cards.some((card) => card.id === imageCardId && isImageCard(card))) return null;
  const created = createPromptCard(state, [imageCardId], { x: 0, y: 0 }, makeId);
  const promptId = created.card.id;
  const next = mapCards(created.state, (card) =>
    card.id === promptId && isPromptCard(card)
      ? { ...card, name: '转线框', text: WIREFRAME_PROMPT, settings: { ...WIREFRAME_SETTINGS }, purpose: 'wireframe' as const }
      : card,
  );
  return { state: next, promptId };
}

const WIREFRAME_SOURCE_EDGE = 320;

/**
 * 从页面框发起转线框：底稿复制成图像卡放在页面框左侧（整条链不压住页面框），
 * 建转线框提示词卡，页面框记下它，第一次出图就换成底稿。
 */
export function wireframeFromPage(
  state: DocState,
  pageId: string,
  makeId: () => string,
): { state: DocState; promptId: string; sourceId: string } | null {
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page?.base) return null;
  return pageWireframeChain(state, page, page.base, `${page.name} · 原截图`, 'wireframe', makeId);
}

export const SKETCH_WIREFRAME_PROMPT = [
  '{{Image 1}} 是一张页面布局草图：每个灰色方框代表页面上的一块内容，框里写着它是什么。把它画成一张黑白线框图（低保真原型）。',
  '【布局】严格保持每个框的位置和大小，不要增加或删除区块；框之外保持留白。',
  '【按名字画】把每个框画成对应的界面元素：Banner / 主视觉画成带占位插图的横幅；金刚位、入口、图标画成一排圆形或圆角图标加短文字（名字里写了 ×N 就画 N 个）；搜索画成输入框；列表、商品、推荐画成卡片列表；底部导航画成一排图标加文字；标题、文字画成标题文字和灰色文字条。',
  '【手绘】手绘的线条和圆圈是大致的形状提示，手写的文字是说明，按意思画成对应的界面元素，不要照描笔迹。',
  '【风格】背景纯白，黑色细线描，按钮和输入框浅灰填充；图标和插图都是简洁线描；不要颜色、渐变、阴影；不要把草图的灰色方框和框名原样画出来。',
].join('\n');

/**
 * 布局草图转线框：程序画好的示意图作为图像卡放在页面框左侧，接一张「草图转线框」提示词卡，
 * 页面框记下它，第一次出图就换成底稿（底稿来源是自己的线框）。
 */
export function sketchToWireframe(
  state: DocState,
  pageId: string,
  sketch: Version,
  makeId: () => string,
): { state: DocState; promptId: string; sourceId: string } | null {
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page) return null;
  return pageWireframeChain(state, page, sketch, `${page.name} · 布局草图`, 'sketch', makeId);
}

function pageWireframeChain(
  state: DocState,
  page: PageCard,
  version: Version,
  name: string,
  purpose: 'wireframe' | 'sketch',
  makeId: () => string,
): { state: DocState; promptId: string; sourceId: string } | null {
  const size = cardSizeFor(version, WIREFRAME_SOURCE_EDGE);
  const outputWidth = Math.min(800, Math.max(240, size.width));
  const chainWidth = size.width + CHAIN_GAP + PROMPT_CARD_WIDTH + CHAIN_GAP + outputWidth;
  const source: ImageCard = {
    kind: 'image',
    id: makeId(),
    name,
    x: page.x - chainWidth - CHAIN_GAP,
    y: page.y,
    width: size.width,
    height: size.height,
    versions: [version],
    currentVersionId: version.id,
    groupId: null,
  };
  const created = createWireframePrompt(addCards(state, [source]), source.id, makeId);
  if (!created) return null;
  const next = mapCards(created.state, (card) => {
    if (card.id === page.id && isPageCard(card)) return { ...card, wireframePromptId: created.promptId };
    if (purpose === 'sketch' && card.id === created.promptId && isPromptCard(card)) {
      return { ...card, name: '草图转线框', text: SKETCH_WIREFRAME_PROMPT, purpose: 'sketch' as const };
    }
    return card;
  });
  return { state: next, promptId: created.promptId, sourceId: source.id };
}

/** 这张图像卡是不是某张转线框提示词卡的输出 */
export function isWireframeOutput(state: DocState, imageCardId: string): boolean {
  return state.cards.some((card) => isPromptCard(card) && card.purpose === 'wireframe' && card.outputCardId === imageCardId);
}

/** 换底稿：跟随原型尺寸的页面框高度按新比例走；baseSource 为 null 时保留原来的底稿来源 */
function withBase(page: PageCard, version: Version, baseCardId: string | null, baseSource: PageCard['baseSource'] | null): PageCard {
  const height = page.devicePreset ? page.height : page.width * (version.height / version.width);
  return {
    ...page,
    base: version,
    baseCardId,
    height,
    wireframePromptId: null,
    baseSource: baseSource ?? page.baseSource,
  };
}

/** 用图像卡的当前版本做页面框的低保真原型 */
export function setPageBaseFromCard(state: DocState, pageId: string, imageCardId: string): DocState {
  const source = state.cards.find((card): card is ImageCard => card.id === imageCardId && isImageCard(card));
  if (!source) return state;
  const wireframe = isWireframeOutput(state, imageCardId);
  return mapCards(state, (card) => (card.id === pageId && isPageCard(card) ? withBase(card, currentVersion(source), imageCardId, wireframe ? 'borrowed' : null) : card));
}

/** 用图像卡的当前版本新建页面框 */
export function newPageFromImageCard(state: DocState, imageCardId: string, makeId: () => string): { state: DocState; pageId: string } | null {
  const source = state.cards.find((card): card is ImageCard => card.id === imageCardId && isImageCard(card));
  if (!source) return null;
  const version = currentVersion(source);
  const page = newPageCard(state, { id: makeId(), name: source.name.replace(/ · 结果$/, ''), base: version });
  const wireframe = isWireframeOutput(state, imageCardId);
  const created: PageCard = { ...page, baseCardId: source.id, baseSource: wireframe ? 'borrowed' : 'own' };
  return { state: addCards(state, [created]), pageId: created.id };
}

/** 从页面框发起的转线框第一次出图：换成底稿（幂等，可套用到撤销栈每个快照） */
function applyWireframeBase(cards: CanvasCard[], promptCardId: string, output: ImageCard): CanvasCard[] {
  const prompt = cards.find((card): card is PromptCard => card.id === promptCardId && isPromptCard(card));
  const borrowed = prompt?.purpose !== 'sketch';
  return cards.map((card) =>
    isPageCard(card) && card.wireframePromptId === promptCardId
      ? { ...withBase(card, currentVersion(output), output.id, borrowed ? 'borrowed' : 'own'), ...(borrowed ? {} : { sketchHidden: true }) }
      : card,
  );
}

export function updatePageBaseSource(state: DocState, pageId: string, baseSource: PageCard['baseSource']): DocState {
  return mapCards(state, (card) => (card.id === pageId && isPageCard(card) && card.baseSource !== baseSource ? { ...card, baseSource } : card));
}
export function regionOf(state: DocState, card: Rect): RegionId | null {
  return regionColumnOf(state.regions, card)?.id ?? null;
}

/** 区域高度跟着内容走；高度没变时返回同一个快照 */
export function fitRegionsToContent(state: DocState): DocState {
  const regions = fitRegionHeights(state.regions, state.cards);
  return regions === state.regions ? state : { ...state, regions };
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
