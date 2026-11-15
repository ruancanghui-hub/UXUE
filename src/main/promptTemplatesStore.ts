import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptTemplate } from '../shared/api';
import { DEFAULT_PROMPT_SETTINGS, MAX_COUNT, MIN_COUNT, QUALITIES, SIZE_OPTIONS, type PromptSettings } from '../shared/generation';
import { normalizeFeelings } from '../shared/uiFeelings';

/**
 * 全局提示词模板，存在 userData/prompt-templates.json，跨项目复用。
 */
export class PromptTemplatesStore {
  private items: PromptTemplate[] = [];
  private loaded = false;

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'prompt-templates.json'), 'utf8')) as unknown;
      this.items = Array.isArray(raw) ? raw.map(parseTemplate).filter((item): item is PromptTemplate => item !== null) : [];
    } catch {
      this.items = [];
    }
  }

  list(): PromptTemplate[] {
    return this.items.map(clone);
  }

  async create(name: string, text: string, settings?: PromptSettings): Promise<PromptTemplate> {
    const item: PromptTemplate = {
      id: randomUUID(),
      name: name.trim() || '未命名模板',
      text,
      ...(settings ? { defaultSettings: normalizeSettings(settings) } : {}),
    };
    this.items = [...this.items, item];
    await this.persist();
    return clone(item);
  }

  async update(id: string, patch: Partial<Pick<PromptTemplate, 'name' | 'text' | 'defaultSettings'>>): Promise<PromptTemplate | null> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const prev = this.items[index];
    const next: PromptTemplate = {
      id: prev.id,
      name: patch.name !== undefined ? patch.name.trim() || prev.name : prev.name,
      text: patch.text !== undefined ? patch.text : prev.text,
    };
    const settings = patch.defaultSettings !== undefined ? patch.defaultSettings : prev.defaultSettings;
    if (settings) next.defaultSettings = normalizeSettings(settings);
    this.items = this.items.map((item, i) => (i === index ? next : item));
    await this.persist();
    return clone(next);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return false;
    await this.persist();
    return true;
  }

  /** 导入别处导出的模板：同 id 覆盖，新的追加 */
  async importMany(templates: PromptTemplate[]): Promise<number> {
    const incoming = templates.map(parseTemplate).filter((item): item is PromptTemplate => item !== null);
    if (incoming.length === 0) return 0;
    const byId = new Map(incoming.map((item) => [item.id, item]));
    const kept = this.items.map((item) => byId.get(item.id) ?? item);
    const added = incoming.filter((item) => !this.items.some((existing) => existing.id === item.id));
    this.items = [...kept, ...added];
    await this.persist();
    return incoming.length;
  }

  private async persist(): Promise<void> {
    await writeFile(join(this.dir, 'prompt-templates.json'), JSON.stringify(this.items, null, 2));
  }
}

function clone(item: PromptTemplate): PromptTemplate {
  return {
    ...item,
    ...(item.defaultSettings ? { defaultSettings: { ...item.defaultSettings } } : {}),
  };
}

function parseTemplate(value: unknown): PromptTemplate | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.text !== 'string') return null;
  const item: PromptTemplate = { id: raw.id, name: raw.name, text: raw.text };
  if (raw.defaultSettings && typeof raw.defaultSettings === 'object') {
    item.defaultSettings = normalizeSettings(raw.defaultSettings as PromptSettings);
  }
  return item;
}

function normalizeSettings(settings: PromptSettings): PromptSettings {
  const count = Number(settings.count);
  return {
    count: Number.isFinite(count) ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(count))) : DEFAULT_PROMPT_SETTINGS.count,
    size: SIZE_OPTIONS.some((o) => o.id === settings.size) ? settings.size : DEFAULT_PROMPT_SETTINGS.size,
    quality: QUALITIES.some((q) => q.id === settings.quality) ? settings.quality : DEFAULT_PROMPT_SETTINGS.quality,
    useTheme: settings.useTheme !== false,
    feelings: normalizeFeelings(settings.feelings),
  };
}
