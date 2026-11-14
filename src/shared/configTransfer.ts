import type { PromptTemplate } from './api';
import type { PromptSettings } from './generation';

/** 换电脑用的配置文件：模型设置 + 明文 API Key + 提示词模板库 */
export const CONFIG_FORMAT = 'anye-config';
export const CONFIG_VERSION = 1;
export const CONFIG_FILE_NAME = '暗夜精灵配置.json';

export const CONFIG_SETTING_KEYS = [
  'provider',
  'model',
  'assistantProvider',
  'assistantModel',
  'siliconflowEditModel',
  'siliconflowT2iModel',
  'newapiBaseUrl',
  'newapiModel',
  'newapiAssistantModel',
] as const;

export type ConfigSettings = Partial<Record<(typeof CONFIG_SETTING_KEYS)[number], string>>;

export interface ConfigKeys {
  openai: string | null;
  siliconflow: string | null;
  newapi: string | null;
}

export interface ConfigExport {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  exportedAt: string;
  settings: ConfigSettings;
  keys: ConfigKeys;
  templates: PromptTemplate[];
}

export interface ConfigImportResult {
  keyCount: number;
  templateCount: number;
}

export function buildConfigExport(settings: ConfigSettings, keys: ConfigKeys, templates: PromptTemplate[], now = new Date()): ConfigExport {
  const picked: ConfigSettings = {};
  for (const key of CONFIG_SETTING_KEYS) if (typeof settings[key] === 'string') picked[key] = settings[key];
  return { format: CONFIG_FORMAT, version: CONFIG_VERSION, exportedAt: now.toISOString(), settings: picked, keys, templates };
}

/**
 * 读配置文件：不是这个格式就报错；字段类型不对的跳过（设置值是否合法由设置存储再校验一遍）。
 */
export function parseConfigExport(raw: unknown): ConfigExport {
  const value = isObject(raw) ? raw : null;
  if (!value || value.format !== CONFIG_FORMAT) throw new Error('这不是暗夜精灵的配置文件');
  if (value.version !== CONFIG_VERSION) throw new Error(`配置文件版本是 ${String(value.version)}，这个版本的暗夜精灵只认识 ${CONFIG_VERSION}`);

  const settingsRaw = isObject(value.settings) ? value.settings : {};
  const settings: ConfigSettings = {};
  for (const key of CONFIG_SETTING_KEYS) if (typeof settingsRaw[key] === 'string') settings[key] = settingsRaw[key] as string;

  const keysRaw = isObject(value.keys) ? value.keys : {};
  const key = (name: keyof ConfigKeys): string | null =>
    typeof keysRaw[name] === 'string' && (keysRaw[name] as string).trim() ? (keysRaw[name] as string).trim() : null;

  const templates = (Array.isArray(value.templates) ? value.templates : []).flatMap((item): PromptTemplate[] => {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.text !== 'string') return [];
    const template: PromptTemplate = { id: item.id, name: item.name, text: item.text };
    if (isObject(item.defaultSettings)) template.defaultSettings = item.defaultSettings as unknown as PromptSettings;
    return [template];
  });

  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    settings,
    keys: { openai: key('openai'), siliconflow: key('siliconflow'), newapi: key('newapi') },
    templates,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
