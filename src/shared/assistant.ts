import { BLOCK_TYPES, normalizeHex, type BaseSource, type BlockType, type ThemeColor, type ThemeRules } from './project';

/** 助手用的文本 / 看图模型（2026-11）：每百万 token 的输入、输出价格 */
export const ASSISTANT_MODELS = [
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra（快、看图好，推荐）', input: 1, output: 5 },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol（更强）', input: 2, output: 10 },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna（最便宜）', input: 0.1, output: 0.5 },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra（旗舰，贵）', input: 10, output: 50 },
] as const;
export const DEFAULT_ASSISTANT_MODEL = 'gpt-6.1-terra';

export function assistantCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = ASSISTANT_MODELS.find((m) => m.id === model) ?? ASSISTANT_MODELS[0];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** 一次最多带给助手的图片数量 */
export const ASSISTANT_MAX_IMAGES = 8;
export const ASSISTANT_MAX_PROMPTS = 12;
/** 为区块写提示词时一次最多的区块数（截图很小，可以多带一些） */
export const ASSISTANT_MAX_BLOCKS = 24;

/**
 * chat：普通对话；decompose：拆解第 1 张图（低保真原型）为区块；
 * blockPrompts：第 N 张图是第 N 个区块的截图，为每个区块写一条提示词。
 */
export type AssistantTask = 'chat' | 'decompose' | 'blockPrompts' | 'elementList';

export type ElementCategory = 'icon' | 'illustration' | 'decor' | 'pattern';
export const ELEMENT_CATEGORIES: { id: ElementCategory; label: string }[] = [
  { id: 'icon', label: '图标' },
  { id: 'illustration', label: '插画' },
  { id: 'decor', label: '装饰元素' },
  { id: 'pattern', label: '纹样 / 背景' },
];
export const MAX_ELEMENTS = 16;

/** 素材清单里的一项：text 是能直接拿去文生图的提示词 */
export interface ElementDraft {
  name: string;
  category: ElementCategory;
  /** 在页面里的用途 */
  usage: string;
  /** 出自哪条视觉线索 */
  cue: string;
  text: string;
}

/** 为区块写提示词时，每张截图对应的区块信息 */
export interface AssistantBlockContext {
  index: number;
  name: string;
  type: BlockType;
  group: string | null;
}

export interface AssistantContextImage {
  /** 在这次请求里的序号，从 1 开始；提示词卡草稿用它指明绑定哪张图 */
  index: number;
  name: string;
  /** 相对项目目录的原图 */
  file: string;
}

export interface AssistantRequest {
  projectDir: string;
  projectName: string;
  message: string;
  history: { role: 'user' | 'assistant'; text: string }[];
  images: AssistantContextImage[];
  /** 生效主题卡的文字版（themeSuffix） */
  activeTheme: string | null;
  selectedPrompts: { name: string; text: string }[];
  /** 缺省为 chat */
  task?: AssistantTask;
  /** blockPrompts 时每张图对应的区块 */
  blocks?: AssistantBlockContext[];
  /** decompose / blockPrompts 时的底稿来源 */
  baseSource?: BaseSource;
  /** elementList 时项目里已有的清单项名字，避免重复 */
  existingElements?: string[];
}

/** 助手提议的区块；坐标 0–1000，相对第 1 张图 */
export interface BlockDraft {
  name: string;
  type: BlockType;
  group: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ThemeDraft {
  name: string;
  topic: string;
  keywords: string[];
  cues: string[];
  palette: ThemeColor[];
  rules: ThemeRules;
}

export interface PromptDraft {
  name: string;
  text: string;
  /** 绑定第几张上下文图（从 1 开始）；null 表示不绑定 */
  inputIndex: number | null;
}

export interface AssistantResponse {
  reply: string;
  theme: ThemeDraft | null;
  prompts: PromptDraft[];
  blocks: BlockDraft[];
  elements: ElementDraft[];
  provider: 'openai' | 'newapi' | 'mock';
  model: string;
  /** NewAPI 中转按站点计价，拿不到真实单价时为 0 */
  costUsd: number;
}

const stringArray = { type: 'array', items: { type: 'string' } };

/** 严格模式的结构化输出：根是对象、所有字段必填、可空字段用 null 联合 */
export const ASSISTANT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'theme', 'prompts', 'blocks', 'elements'],
  properties: {
    reply: { type: 'string', description: '给用户看的简短中文回复' },
    theme: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'topic', 'keywords', 'cues', 'palette', 'rules'],
          properties: {
            name: { type: 'string' },
            topic: { type: 'string' },
            keywords: stringArray,
            cues: stringArray,
            palette: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['role', 'name', 'hex', 'note'],
                properties: {
                  role: { type: 'string' },
                  name: { type: 'string' },
                  hex: { type: 'string', description: '#RRGGBB' },
                  note: { type: 'string' },
                },
              },
            },
            rules: {
              type: 'object',
              additionalProperties: false,
              required: ['shape', 'material', 'lighting', 'color'],
              properties: {
                shape: { type: 'string' },
                material: { type: 'string' },
                lighting: { type: 'string' },
                color: { type: 'string' },
              },
            },
          },
        },
      ],
    },
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'text', 'inputIndex'],
        properties: {
          name: { type: 'string' },
          text: { type: 'string' },
          inputIndex: { type: ['integer', 'null'] },
        },
      },
    },
    blocks: {
      type: 'array',
      description: '只在拆解页面时填写；坐标是第 1 张图上的像素（图的尺寸写在上下文里），左上角为原点',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'group', 'x', 'y', 'width', 'height'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: BLOCK_TYPES.map((t) => t.id) },
          group: { type: ['string', 'null'] },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
    },
    elements: {
      type: 'array',
      description: '只在列素材清单时填写',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'category', 'usage', 'cue', 'text'],
        properties: {
          name: { type: 'string' },
          category: { type: 'string', enum: ELEMENT_CATEGORIES.map((c) => c.id) },
          usage: { type: 'string' },
          cue: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
} as const;

const MAX_BLOCK_DRAFTS = 40;

/**
 * 把助手给的区块坐标统一换成 0–1000（sanitizeAssistantOutput 之前调用）。
 * 要求模型给像素，但不同模型会自作主张给 0–1 小数或 0–1000，这里按取值范围判断：
 * 全部 ≤ 1 当小数；不超出图片像素范围当像素；否则当 0–1000。
 */
export function normalizeBlockCoordinates(raw: unknown, imageWidth: number, imageHeight: number): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).blocks)) return raw;
  const value = raw as Record<string, unknown>;
  const num = (input: unknown): number => (typeof input === 'number' && Number.isFinite(input) ? input : 0);
  const items = (value.blocks as unknown[]).map((item) => (item ?? {}) as Record<string, unknown>);
  if (items.length === 0) return raw;
  const right = Math.max(...items.map((b) => num(b.x) + num(b.width)));
  const bottom = Math.max(...items.map((b) => num(b.y) + num(b.height)));
  const [sx, sy] =
    right <= 1.01 && bottom <= 1.01
      ? [1000, 1000]
      : right <= imageWidth * 1.03 && bottom <= imageHeight * 1.03
        ? [1000 / imageWidth, 1000 / imageHeight]
        : [1, 1];
  return {
    ...value,
    blocks: items.map((b) => ({
      ...b,
      x: num(b.x) * sx,
      y: num(b.y) * sy,
      width: num(b.width) * sx,
      height: num(b.height) * sy,
    })),
  };
}

/** 模型输出再过一遍业务校验：颜色必须是 #RRGGBB，绑定序号必须在范围内，区块坐标夹在 0–1000，数量有上限 */
export function sanitizeAssistantOutput(
  raw: unknown,
  imageCount: number,
  maxPrompts: number = ASSISTANT_MAX_PROMPTS,
): Pick<AssistantResponse, 'reply' | 'theme' | 'prompts' | 'blocks' | 'elements'> {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (input: unknown): string => (typeof input === 'string' ? input.trim() : '');
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.map(text).filter(Boolean).slice(0, 12) : [];

  let theme: ThemeDraft | null = null;
  if (value.theme && typeof value.theme === 'object') {
    const t = value.theme as Record<string, unknown>;
    const rules = (t.rules ?? {}) as Record<string, unknown>;
    theme = {
      name: text(t.name) || '视觉主题',
      topic: text(t.topic),
      keywords: strings(t.keywords),
      cues: strings(t.cues),
      palette: (Array.isArray(t.palette) ? t.palette : []).flatMap((item): ThemeColor[] => {
        const c = (item ?? {}) as Record<string, unknown>;
        const hex = normalizeHex(text(c.hex));
        return hex ? [{ role: text(c.role), name: text(c.name), hex, note: text(c.note) }] : [];
      }).slice(0, 8),
      rules: { shape: text(rules.shape), material: text(rules.material), lighting: text(rules.lighting), color: text(rules.color) },
    };
  }

  const prompts = (Array.isArray(value.prompts) ? value.prompts : [])
    .map((item): PromptDraft | null => {
      const p = (item ?? {}) as Record<string, unknown>;
      const body = text(p.text);
      if (!body) return null;
      const index = typeof p.inputIndex === 'number' && Number.isInteger(p.inputIndex) ? p.inputIndex : null;
      return { name: text(p.name) || '提示词', text: body, inputIndex: index && index >= 1 && index <= imageCount ? index : null };
    })
    .filter((p): p is PromptDraft => p !== null)
    .slice(0, maxPrompts);

  const clamp = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) ? Math.min(1000, Math.max(0, Math.round(input))) : 0;
  const blocks = (Array.isArray(value.blocks) ? value.blocks : [])
    .map((item): BlockDraft | null => {
      const b = (item ?? {}) as Record<string, unknown>;
      const x = clamp(b.x);
      const y = clamp(b.y);
      const width = Math.min(clamp(b.width), 1000 - x);
      const height = Math.min(clamp(b.height), 1000 - y);
      if (width < 5 || height < 5) return null;
      const type = BLOCK_TYPES.some((t) => t.id === b.type) ? (b.type as BlockType) : 'other';
      return { name: text(b.name), type, group: text(b.group) || null, x, y, width, height };
    })
    .filter((b): b is BlockDraft => b !== null)
    .slice(0, MAX_BLOCK_DRAFTS);

  const elements = (Array.isArray(value.elements) ? value.elements : [])
    .map((item): ElementDraft | null => {
      const e = (item ?? {}) as Record<string, unknown>;
      const name = text(e.name);
      const body = text(e.text);
      if (!name || !body) return null;
      const category = ELEMENT_CATEGORIES.some((c) => c.id === e.category) ? (e.category as ElementCategory) : 'icon';
      return { name, category, usage: text(e.usage), cue: text(e.cue), text: body };
    })
    .filter((e): e is ElementDraft => e !== null)
    .slice(0, MAX_ELEMENTS);

  return { reply: text(value.reply) || '好了。', theme, prompts, blocks, elements };
}
