import {
  ASSISTANT_MAX_BLOCKS,
  ASSISTANT_MAX_IMAGES,
  type AssistantRequest,
  type AssistantResponse,
} from '../../../shared/assistant';
import {
  blockPixelRect,
  currentVersion,
  isBlockCard,
  isImageCard,
  isPageCard,
  isPromptCard,
  isThemeCard,
  themeSuffix,
  type BlockCard,
  type ImageCard,
  type PageCard,
  type ThemeCard,
  type Version,
} from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import {
  applyAssistantDrafts,
  applyBlockPrompts,
  applyDecomposition,
  applyElementList,
  elementPrompts,
  pageBlocks,
  placeBlockCrops,
} from '../document/operations';
import { activeTheme } from './GenerationTracker';
import type { ProjectSession } from './ProjectSession';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  error?: boolean;
  created?: { themeId: string | null; promptIds: string[] };
  costUsd?: number;
  provider?: string;
}

const HISTORY_TURNS = 8;

/** 用户是否在要主题卡（文字或从参考图提炼） */
export function wantsThemeCard(message: string): boolean {
  return /主题卡|视觉主题|视觉方向|品牌线索|提炼.*主题|从.*图.*主题|生成一套视觉主题/.test(message);
}

/** 一个项目的助手对话：只在内存里，换项目就清空 */
export class AssistantSession {
  private messages: AssistantMessage[] = [];
  private busy = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly session: ProjectSession,
    private readonly engine: CanvasEngine,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): AssistantMessage[] {
    return this.messages;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** 选中的图像卡（含原图缺失的），用于数量校验 */
  selectedImageCards(): ImageCard[] {
    const state = this.session.doc.get();
    return state.cards
      .filter((card): card is ImageCard => isImageCard(card) && this.session.selection.has(card.id))
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** 选中的图像卡按从上到下、从左到右排好，就是发给助手的 第 1、2… 张图 */
  contextImages(): ImageCard[] {
    return this.selectedImageCards()
      .filter((card) => !this.session.missingVersionIds.has(card.currentVersionId))
      .slice(0, ASSISTANT_MAX_IMAGES);
  }

  async send(text: string): Promise<AssistantMessage> {
    const message = text.trim();
    if (!message || this.busy) throw new Error('助手正在忙');
    const { session } = this;
    const state = session.doc.get();
    const selectedImages = this.selectedImageCards();
    let images = this.contextImages();

    if (wantsThemeCard(message)) {
      if (selectedImages.length >= 2) {
        return this.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '从参考图提炼主题一次只支持一张参考图，请只选中一张后再试。',
          error: true,
        });
      }
      if (selectedImages.length === 1) {
        if (images.length === 0) {
          return this.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            text: '选中的参考图原文件不见了，无法提炼主题。',
            error: true,
          });
        }
        images = images.slice(0, 1);
      }
    }

    const theme = activeTheme(state);
    const request: AssistantRequest = {
      projectDir: session.dir,
      projectName: session.name,
      message,
      history: this.messages
        .filter((m) => !m.error)
        .slice(-HISTORY_TURNS)
        .map((m) => ({ role: m.role, text: m.text })),
      images: images.map((card, i) => ({ index: i + 1, name: card.name, file: currentVersion(card).file })),
      activeTheme: theme ? themeSuffix(theme) : null,
      selectedPrompts: state.cards
        .filter(isPromptCard)
        .filter((card) => session.selection.has(card.id))
        .map((card) => ({ name: card.name, text: card.text })),
    };

    const themeSource =
      wantsThemeCard(message) && images.length === 1
        ? { imageCardId: images[0].id, versionId: currentVersion(images[0]).id }
        : null;

    this.push({ id: crypto.randomUUID(), role: 'user', text: message });
    this.busy = true;
    this.emit();
    try {
      const response = await window.anye.askAssistant(request);
      let created: AssistantMessage['created'];
      if (response.theme || response.prompts.length) {
        const applied = applyAssistantDrafts(
          session.doc.get(),
          response,
          images.map((card) => card.id),
          this.engine.viewCenterWorld(),
          () => crypto.randomUUID(),
          response.theme ? themeSource : null,
        );
        const parts = [response.theme ? '主题卡' : '', response.prompts.length ? `${response.prompts.length} 张提示词卡` : ''].filter(Boolean);
        session.doc.apply(`助手：新建${parts.join('和')}`, applied.state);
        created = { themeId: applied.themeId, promptIds: applied.promptIds };
        session.selection.set([...(applied.themeId ? [applied.themeId] : []), ...applied.promptIds]);
      }
      return this.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: response.reply,
        created,
        costUsd: response.costUsd,
        provider: response.provider,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
      return this.push({ id: crypto.randomUUID(), role: 'assistant', text, error: true });
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  // ───────────────────────── 素材清单 ─────────────────────────

  /** 从主题卡（默认生效主题卡）列出素材清单，落成核心素材区里按类别分组的提示词卡；scope 是可选的范围说明 */
  async listElements(scope: string, themeId: string | null = null): Promise<AssistantMessage> {
    const state = this.session.doc.get();
    const id = themeId ?? state.activeThemeCardId;
    const theme = id ? state.cards.find((card): card is ThemeCard => card.id === id && isThemeCard(card)) : undefined;
    if (!theme) return this.fail('还没有生效主题卡，先生成或选一张主题卡再列素材清单。');
    const range = scope.trim();
    return this.run(`从主题卡「${theme.name}」列出素材清单${range ? `：${range}` : ''}`, async () => {
      const response = await window.anye.askAssistant({
        ...this.baseRequest(range ? `列出素材清单，范围：${range}` : '列出素材清单'),
        task: 'elementList',
        activeTheme: themeSuffix(theme),
        existingElements: elementPrompts(this.session.doc.get()).map((prompt) => prompt.name),
      });
      if (response.elements.length === 0) return { response, text: `${response.reply}（没有列出新的素材）` };
      const applied = applyElementList(this.session.doc.get(), response.elements, () => crypto.randomUUID());
      this.session.doc.apply(`素材清单：新建 ${applied.promptIds.length} 张提示词卡`, applied.state);
      this.session.selection.set(applied.promptIds);
      return { response, created: { themeId: null, promptIds: applied.promptIds } };
    });
  }

  // ───────────────────────── 区块 ─────────────────────────

  /** 拆解：助手看页面框的低保真原型，提议一组区块；已有输出的区块保留 */
  async decomposePage(pageId: string): Promise<AssistantMessage> {
    const { session } = this;
    const page = session.doc.get().cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
    const problem = !page
      ? '找不到这个页面框。'
      : !page.base
        ? '这个页面框还没有低保真原型，先选一张线框图或截图。'
        : session.missingVersionIds.has(page.base.id)
          ? '低保真原型的原文件不见了，无法拆解。'
          : null;
    if (problem || !page?.base) return this.fail(problem ?? '无法拆解。');

    return this.run(`拆解页面「${page.name}」`, async () => {
      const response = await window.anye.askAssistant({
        ...this.baseRequest('把这个页面拆解成区块'),
        task: 'decompose',
        baseSource: page.baseSource,
        images: [{ index: 1, name: `${page.name} · 低保真原型`, file: page.base!.file }],
      });
      if (response.blocks.length === 0) return { response, text: `${response.reply}（没有识别出区块，可以手动新增）` };
      const applied = applyDecomposition(session.doc.get(), pageId, response.blocks, () => crypto.randomUUID());
      session.doc.apply('拆解页面', applied.state);
      session.selection.set(applied.blockIds);
      return { response };
    });
  }

  /** 为区块写提示词：先给还没有截图的区块裁截图，再让助手一次看完全部截图写提示词卡 */
  async writeBlockPrompts(pageId: string): Promise<AssistantMessage> {
    const { session } = this;
    const state = session.doc.get();
    const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
    if (!page?.base) return this.fail('这个页面框还没有低保真原型。');
    if (pageBlocks(state, pageId).length === 0) return this.fail('页面里还没有区块，先点「拆解」或手动新增区块。');

    return this.run(`为「${page.name}」的区块写提示词`, async () => {
      const uncropped = pageBlocks(session.doc.get(), pageId).filter((block) => !block.cropCardId);
      const crops = await this.cropBlocks(page, uncropped);
      if (crops.length) {
        const placed = placeBlockCrops(session.doc.get(), pageId, crops, () => crypto.randomUUID());
        session.doc.apply('区块截图', placed.state);
      }

      const now = session.doc.get();
      const targets = pageBlocks(now, pageId)
        .filter((block) => block.cropCardId && !block.promptCardId)
        .map((block) => ({ block, crop: now.cards.find((card): card is ImageCard => card.id === block.cropCardId && isImageCard(card)) }))
        .filter((item): item is { block: BlockCard; crop: ImageCard } => !!item.crop && !session.missingVersionIds.has(item.crop.currentVersionId))
        .slice(0, ASSISTANT_MAX_BLOCKS);
      if (targets.length === 0) return { response: null, text: '每个区块都已经有提示词卡了。' };

      const response = await window.anye.askAssistant({
        ...this.baseRequest('为这些区块各写一条提示词'),
        task: 'blockPrompts',
        baseSource: page.baseSource,
        images: targets.map(({ crop }, i) => ({ index: i + 1, name: crop.name, file: currentVersion(crop).file })),
        blocks: targets.map(({ block }, i) => ({ index: i + 1, name: block.name, type: block.blockType, group: block.group })),
      });
      const applied = applyBlockPrompts(session.doc.get(), targets.map((t) => t.block), response.prompts, () => crypto.randomUUID());
      if (applied.promptIds.length) {
        session.doc.apply(`助手：为区块写了 ${applied.promptIds.length} 张提示词卡`, applied.state);
        session.selection.set(applied.promptIds);
      }
      return { response, created: { themeId: null, promptIds: applied.promptIds } };
    });
  }

  /** 更新截图：按区块现在的位置重新裁一次，追加为截图卡的新版本（下游随之已过期）；失败写进对话 */
  async refreshBlockCrop(blockId: string): Promise<void> {
    const state = this.session.doc.get();
    const block = state.cards.find((card): card is BlockCard => card.id === blockId && isBlockCard(card));
    const page = block ? state.cards.find((card): card is PageCard => card.id === block.pageId && isPageCard(card)) : undefined;
    if (!block || !page) return;
    try {
      const crops = await this.cropBlocks(page, [block]);
      if (crops.length === 0) throw new Error(`「${block.name}」太小，或已经移出了低保真原型，无法裁剪`);
      this.session.doc.apply('更新区块截图', placeBlockCrops(this.session.doc.get(), page.id, crops, () => crypto.randomUUID()).state);
    } catch (error) {
      this.fail(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
    }
  }

  private async cropBlocks(page: PageCard, blocks: BlockCard[]): Promise<{ blockId: string; version: Version }[]> {
    const base = page.base;
    if (!base) return [];
    const results = await Promise.all(
      blocks.map(async (block) => {
        const rect = blockPixelRect(block, page);
        if (!rect) return null;
        const result = await window.anye.importImages([{ kind: 'crop', name: `${block.name}.png`, file: base.file, rect }]);
        if (result.errors.length) throw new Error(`裁剪「${block.name}」失败：${result.errors[0].message}`);
        return result.versions[0] ? { blockId: block.id, version: result.versions[0] } : null;
      }),
    );
    return results.filter((item): item is { blockId: string; version: Version } => item !== null);
  }

  private baseRequest(message: string): AssistantRequest {
    const theme = activeTheme(this.session.doc.get());
    return {
      projectDir: this.session.dir,
      projectName: this.session.name,
      message,
      history: [],
      images: [],
      activeTheme: theme ? themeSuffix(theme) : null,
      selectedPrompts: [],
    };
  }

  private fail(text: string): AssistantMessage {
    return this.push({ id: crypto.randomUUID(), role: 'assistant', text, error: true });
  }

  /** 区块流程的通用外壳：记一条用户消息、占住助手、把结果或错误写进对话 */
  private async run(
    userText: string,
    task: () => Promise<{ response: AssistantResponse | null; text?: string; created?: AssistantMessage['created'] }>,
  ): Promise<AssistantMessage> {
    if (this.busy) return this.fail('助手正在忙，稍后再试。');
    this.push({ id: crypto.randomUUID(), role: 'user', text: userText });
    this.busy = true;
    this.emit();
    try {
      const { response, text, created } = await task();
      return this.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: text ?? response?.reply ?? '好了。',
        created,
        costUsd: response?.costUsd,
        provider: response?.provider,
      });
    } catch (error) {
      return this.fail(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private push(message: AssistantMessage): AssistantMessage {
    this.messages = [...this.messages, message];
    this.emit();
    return message;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
