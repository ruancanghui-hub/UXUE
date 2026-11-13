/** 选择集不进撤销栈；内容没变时不通知，框选时就不会每帧触发 React 更新 */
export class Selection {
  private ids: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<(ids: ReadonlySet<string>) => void>();

  get(): ReadonlySet<string> {
    return this.ids;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  subscribe(listener: (ids: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return;
    this.ids = next;
    for (const listener of this.listeners) listener(this.ids);
  }

  toggle(id: string): void {
    const next = new Set(this.ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.set(next);
  }

  /** 撤销等操作删掉卡片后，把已经不存在的 id 移出选择集 */
  prune(alive: ReadonlySet<string>): void {
    if ([...this.ids].every((id) => alive.has(id))) return;
    this.set([...this.ids].filter((id) => alive.has(id)));
  }
}
