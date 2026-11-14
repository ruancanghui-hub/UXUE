import { ASSISTANT_MAX_IMAGES, type AssistantRequest } from '../../../shared/assistant';
import { currentVersion, isImageCard, isPromptCard, themeSuffix, type ImageCard } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { applyAssistantDrafts } from '../document/operations';
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

  private push(message: AssistantMessage): AssistantMessage {
    this.messages = [...this.messages, message];
    this.emit();
    return message;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
