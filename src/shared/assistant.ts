import { normalizeHex, type ThemeColor, type ThemeRules } from './project';

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
  required: ['reply', 'theme', 'prompts'],
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
  },
} as const;

/** 模型输出再过一遍业务校验：颜色必须是 #RRGGBB，绑定序号必须在范围内，数量有上限 */
export function sanitizeAssistantOutput(
  raw: unknown,
  imageCount: number,
): Pick<AssistantResponse, 'reply' | 'theme' | 'prompts'> {
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
    .slice(0, ASSISTANT_MAX_PROMPTS);

  return { reply: text(value.reply) || '好了。', theme, prompts };
}
