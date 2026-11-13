import type { OpenedProject } from '../../../shared/api';
import { PROJECT_SCHEMA_VERSION, type ProjectFile, type ViewportState } from '../../../shared/project';
import { DocumentStore } from '../document/DocumentStore';
import type { DocState } from '../document/operations';
import { Selection } from '../document/Selection';

const SAVE_AFTER_EDIT_MS = 300;
const SAVE_AFTER_VIEWPORT_MS = 1000;

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** 当前打开的项目：文档、选择集、视口，以及自动保存 */
export class ProjectSession {
  readonly doc: DocumentStore;
  readonly selection = new Selection();
  readonly dir: string;
  readonly name: string;
  missingVersionIds: Set<string>;

  private viewport: ViewportState | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private saveState: SaveState = 'saved';
  private lastError: string | null = null;
  private readonly saveListeners = new Set<(state: SaveState, error: string | null) => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(opened: OpenedProject) {
    this.dir = opened.dir;
    this.name = opened.name;
    this.missingVersionIds = new Set(opened.missingVersionIds);
    this.viewport = opened.file.viewport;
    this.doc = new DocumentStore({ cards: opened.file.cards, regions: opened.file.regions });
    this.unsubscribe = this.doc.subscribe((_state, change) => {
      if (change !== 'transient' && change !== 'reset') this.scheduleSave(SAVE_AFTER_EDIT_MS);
    });
  }

  initialViewport(): ViewportState | null {
    return this.viewport;
  }

  updateViewport(viewport: ViewportState): void {
    this.viewport = viewport;
    this.scheduleSave(SAVE_AFTER_VIEWPORT_MS);
  }

  onSaveState(listener: (state: SaveState, error: string | null) => void): () => void {
    this.saveListeners.add(listener);
    listener(this.saveState, this.lastError);
    return () => this.saveListeners.delete(listener);
  }

  /** 立刻把还没写盘的改动保存掉（关窗、切换项目、自检时调用） */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.saving) await this.saving;
    if (this.dirty) await this.saveNow();
  }

  toProjectFile(state: DocState = this.doc.get()): ProjectFile {
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      regions: [...state.regions],
      cards: [...state.cards],
      viewport: this.viewport,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
    this.saveListeners.clear();
  }

  private scheduleSave(delay: number): void {
    if (this.disposed) return;
    this.dirty = true;
    this.setSaveState('pending');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.saveNow();
    }, delay);
  }

  private async saveNow(): Promise<void> {
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    this.setSaveState('saving');
    const task = window.anye
      .saveProject(this.dir, this.toProjectFile())
      .then(() => {
        if (!this.dirty) this.setSaveState('saved');
      })
      .catch((error: unknown) => {
        this.dirty = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setSaveState('error');
      });
    this.saving = task;
    await task;
    this.saving = null;
  }

  private setSaveState(state: SaveState): void {
    if (state !== 'error') this.lastError = null;
    if (this.saveState === state) return;
    this.saveState = state;
    for (const listener of this.saveListeners) listener(state, this.lastError);
  }
}
