import type { DocState } from './operations';

/**
 * 'transient' 拖动、缩放过程中的中间状态，只有画布需要跟上；
 * 'commit' 进入撤销栈的改动；'history' 撤销或重做；'reset' 换了一个项目。
 */
export type DocChange = 'transient' | 'commit' | 'history' | 'reset';

interface HistoryEntry {
  label: string;
  before: DocState;
  after: DocState;
}

const HISTORY_LIMIT = 300;

/** 文档仓库：持有当前快照和撤销栈。所有改动都提交一个新快照，旧快照原样留在栈里。 */
export class DocumentStore {
  private state: DocState;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private gesture: { label: string; before: DocState } | null = null;
  private readonly listeners = new Set<(state: DocState, change: DocChange) => void>();

  /**
   * normalize：每次换快照前套用一次的整理函数（比如区域跟着内容长高）；
   * 必须在没有变化时原样返回，否则每次改动都会多出一个新快照。
   */
  constructor(
    initial: DocState,
    private readonly normalize: (state: DocState) => DocState = (state) => state,
  ) {
    this.state = normalize(initial);
  }

  get(): DocState {
    return this.state;
  }

  subscribe(listener: (state: DocState, change: DocChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(state: DocState): void {
    this.state = this.normalize(state);
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.emit('reset');
  }

  /** 一次性改动：next 和当前快照相同时什么也不做 */
  apply(label: string, raw: DocState): void {
    if (this.gesture) this.commitGesture();
    if (raw === this.state) return;
    const next = this.normalize(raw);
    this.push({ label, before: this.state, after: next });
    this.state = next;
    this.emit('commit');
  }

  /** 拖动这类连续操作：开始时记住起点，中间只更新画面，结束时合成一条历史 */
  beginGesture(label: string): DocState {
    if (this.gesture) this.commitGesture();
    this.gesture = { label, before: this.state };
    return this.state;
  }

  updateGesture(raw: DocState): void {
    if (!this.gesture || raw === this.state) return;
    this.state = this.normalize(raw);
    this.emit('transient');
  }

  commitGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    if (gesture.before === this.state) return;
    this.push({ label: gesture.label, before: gesture.before, after: this.state });
    this.emit('commit');
  }

  cancelGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    if (gesture.before === this.state) return;
    this.state = gesture.before;
    this.emit('transient');
  }

  isGestureActive(): boolean {
    return this.gesture !== null;
  }

  /**
   * 不进撤销栈、并且回溯写进所有历史快照的改动（生成结果）：
   * additive 必须只做追加，套用到任何快照上都安全；presentOnly 只作用于当前状态，比如把当前版本切到新结果。
   */
  applyPermanent(additive: (state: DocState) => DocState, presentOnly: (state: DocState) => DocState = (s) => s): void {
    // 当前状态就是撤销栈顶的结果时，栈顶也要带上 presentOnly，否则"撤销再重做"会回不到现在的样子
    const top = this.undoStack[this.undoStack.length - 1];
    const presentIsTop = !this.gesture && top?.after === this.state;
    const fixed = (state: DocState): DocState => this.normalize(additive(state));
    const rewrite = (entry: HistoryEntry): HistoryEntry => ({ ...entry, before: fixed(entry.before), after: fixed(entry.after) });
    this.undoStack = this.undoStack.map(rewrite);
    this.redoStack = this.redoStack.map(rewrite);
    if (this.gesture) this.gesture = { ...this.gesture, before: fixed(this.gesture.before) };
    const next = this.normalize(presentOnly(additive(this.state)));
    if (presentIsTop) this.undoStack[this.undoStack.length - 1].after = next;
    if (next === this.state) return;
    this.state = next;
    this.emit('commit');
  }

  undo(): string | null {
    if (this.gesture) this.commitGesture();
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    this.state = entry.before;
    this.emit('history');
    return entry.label;
  }

  redo(): string | null {
    if (this.gesture) this.commitGesture();
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    this.state = entry.after;
    this.emit('history');
    return entry.label;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private emit(change: DocChange): void {
    for (const listener of this.listeners) listener(this.state, change);
  }
}
