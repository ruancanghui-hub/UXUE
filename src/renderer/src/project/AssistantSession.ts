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

  /** 选中的图像卡按从上到下、从左到右排好，就是发给助手的 第 1、2… 张图 */
  contextImages(): ImageCard[] {
    const state = this.session.doc.get();
    return state.cards
      .filter((card): card is ImageCard => isImageCard(card) && this.session.selection.has(card.id))
      .filter((card) => !this.session.missingVersionIds.has(card.currentVersionId))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, ASSISTANT_MAX_IMAGES);
  }

  async send(text: string): Promise<AssistantMessage> {
    const message = text.trim();
    if (!message || this.busy) throw new Error('助手正在忙');
    const { session } = this;
    const state = session.doc.get();
    const images = this.contextImages();
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
