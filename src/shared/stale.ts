import { renderPrompt } from './generation';
import {
  currentVersion,
  isImageCard,
  isPromptCard,
  isThemeCard,
  themeSuffix,
  type CanvasCard,
  type ImageCard,
  type ProjectFile,
  type PromptCard,
  type ThemeCard,
} from './project';

export interface DocLike {
  cards: readonly CanvasCard[];
  activeThemeCardId: string | null;
}

/** 生效主题卡（与生成时同一规则） */
export function activeThemeOf(state: DocLike): ThemeCard | null {
  if (!state.activeThemeCardId) return null;
  const card = state.cards.find((c) => c.id === state.activeThemeCardId);
  return card && isThemeCard(card) ? card : null;
}

/** 当前若提交生成会发出去的全文（提示词正文 + 可选主题后缀） */
export function expectedPromptText(prompt: PromptCard, state: DocLike): string {
  const theme = prompt.settings.useTheme ? activeThemeOf(state) : null;
  return renderPrompt(prompt.text, 'image').text + (theme ? `\n\n${themeSuffix(theme)}` : '');
}

/**
 * 一张图像卡的当前版本是否已过期：上游输入版、提示词全文或生效主题相对生成时变了。
 * 导入版、没有 generation 记录的不算过期。
 */
export function isImageCardStale(card: ImageCard, state: DocLike): boolean {
  const version = currentVersion(card);
  if (version.origin !== 'generate' || !version.generation) return false;
  const gen = version.generation;
  const prompt = state.cards.find((c) => c.id === gen.promptCardId);
  if (!prompt || !isPromptCard(prompt)) return true;

  if (prompt.inputs.length !== gen.inputVersionIds.length) return true;
  for (let i = 0; i < prompt.inputs.length; i++) {
    const input = state.cards.find((c) => c.id === prompt.inputs[i]);
    if (!input || !isImageCard(input)) return true;
    if (input.currentVersionId !== gen.inputVersionIds[i]) return true;
  }

  const theme = prompt.settings.useTheme ? activeThemeOf(state) : null;
  const expectedThemeId = theme?.id ?? null;
  if ((gen.themeCardId ?? null) !== expectedThemeId) return true;

  if (expectedPromptText(prompt, state) !== gen.prompt) return true;
  return false;
}

/** 项目里所有已过期图像卡 id */
export function staleImageCardIds(state: DocLike): Set<string> {
  const ids = new Set<string>();
  for (const card of state.cards) {
    if (isImageCard(card) && isImageCardStale(card, state)) ids.add(card.id);
  }
  return ids;
}

/**
 * 从起点出发，按生成依赖拓扑排序需要重新生成的提示词卡。
 * 边：提示词卡 → 其 output 图像卡 → 又把该图当作 input 的下游提示词卡。
 */
export function downstreamPromptOrder(state: DocLike, startPromptIds: readonly string[]): string[] {
  const prompts = state.cards.filter(isPromptCard);
  const byOutput = new Map<string, PromptCard>();
  for (const p of prompts) {
    if (p.outputCardId) byOutput.set(p.outputCardId, p);
  }

  const dependents = new Map<string, string[]>();
  for (const p of prompts) {
    for (const inputId of p.inputs) {
      const upstream = byOutput.get(inputId);
      if (!upstream || upstream.id === p.id) continue;
      const list = dependents.get(upstream.id) ?? [];
      list.push(p.id);
      dependents.set(upstream.id, list);
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const order: string[] = [];

  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return;
    if (!prompts.some((p) => p.id === id)) return;
    visiting.add(id);
    for (const child of dependents.get(id) ?? []) visit(child);
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };

  for (const id of startPromptIds) visit(id);
  return order.reverse();
}

/** 选中图像卡时：找出产出它们的提示词卡，再带上全部下游 */
export function regenPromptIdsForSelection(state: DocLike, selectedIds: ReadonlySet<string>): string[] {
  const starts = new Set<string>();
  for (const card of state.cards) {
    if (!isPromptCard(card)) continue;
    if (selectedIds.has(card.id)) starts.add(card.id);
    if (card.outputCardId && selectedIds.has(card.outputCardId)) starts.add(card.id);
  }
  return downstreamPromptOrder(state, [...starts]);
}

export function projectAsDoc(file: ProjectFile): DocLike {
  return { cards: file.cards, activeThemeCardId: file.activeThemeCardId };
}
