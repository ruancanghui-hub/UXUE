import { join } from 'node:path';
import {
  ASSISTANT_SCHEMA,
  assistantCostUsd,
  sanitizeAssistantOutput,
  type AssistantRequest,
  type AssistantResponse,
  type PromptDraft,
  type ThemeDraft,
} from '../../shared/assistant';
import type { PreparedInput } from '../../shared/workerProtocol';
import { httpFetch } from '../http';
import type { ImageWorkerClient } from '../imageWorkerClient';

const OPENAI_RESPONSES = 'https://api.openai.com/v1/responses';
/** 给助手看的图缩到长边 1024，够看清风格，图像 token 也少 */
const CONTEXT_IMAGE_EDGE = 1024;
const TIMEOUT_MS = 120_000;

const INSTRUCTIONS = `你是「暗夜精灵」里的设计助手，帮设计师为 APP 和桌面应用做视觉主题、核心素材和高保真页面。你只往画布上放卡片（主题卡、提示词卡），不会自己生成图片。

按用户这一次的要求决定输出什么；不需要的部分 theme 给 null、prompts 给空数组。

一、生成 / 提炼主题卡（theme）：
- 无图、纯文字产品主题时：从文字提炼一套视觉规则。
- 有且仅有 1 张上下文图，且用户要求建立 / 提炼视觉主题、视觉方向或品牌线索时：仔细看图（主体、配色、造型、材质、光影、可复用符号），产出主题卡；用户消息里若写了产品主题则优先采用，否则根据画面推断短 topic。这种情况下 prompts 给空数组（除非用户同一句还要求写提示词）。
- name：简短的主题卡名字；topic：产品主题。
- keywords：4–6 个视觉关键词（气质，例如：新鲜、热闹、亲切、有食欲）。
- cues：4–6 个具体的视觉线索（物件、形象、标志性颜色）。
- palette：4–5 个颜色，按"主色、邻近辅助色、深色（标题、正文、轮廓）、暖白（平衡与留白）"组织；hex 用 #RRGGBB（可估计），note 写这个颜色用在哪里、为什么。
- rules：造型（圆润度、比例、视角）、材质（质感、细节密度）、光影（光源、阴影、高光）、色彩协调（明度、饱和度、冷暖与配色策略）。原则是"统一 ≠ 所有元素长得一样，统一 = 不同元素遵循同一套视觉规则"。

二、反推参考图（prompts，inputIndex 为 null）：每张图一条，按「画面主题／构图／造型与材质／光线／色彩」分段，写成能直接拿去生成同风格画面的中文提示词；不出现品牌、Logo 和文字。

三、为选中的图写提示词（prompts）：每张图一条，inputIndex 填那张图的序号；text 里用 {{Image 1}} 指代这张图——每张提示词卡只绑定这一张图，所以永远写 {{Image 1}}。提示词要结构化、具体、可执行：说清楚保留什么、改变什么、不要什么（不要文字、Logo、多余的人物和元素）。

有生效主题卡时，提示词的风格要与它一致，但不要重复主题卡里的规则，生成时系统会自动把规则附加在后面。
reply 用一两句中文说明你做了什么。`;

export interface AssistantProvider {
  ask(request: AssistantRequest, model: string, signal: AbortSignal): Promise<AssistantResponse>;
}

export class OpenAIAssistant implements AssistantProvider {
  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly getApiKey: () => string | null,
  ) {}

  async ask(request: AssistantRequest, model: string, signal: AbortSignal): Promise<AssistantResponse> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置 OpenAI API Key，请在“设置”里填写，或切换到本地模拟');

    const images = await Promise.all(
      request.images.map((image) =>
        this.worker.request<PreparedInput>({
          type: 'prepareInput',
          path: join(request.projectDir, image.file),
          maxEdge: CONTEXT_IMAGE_EDGE,
        }),
      ),
    );
    const content: Record<string, unknown>[] = [{ type: 'input_text', text: describeContext(request) }];
    request.images.forEach((image, i) => {
      content.push({ type: 'input_text', text: `第 ${image.index} 张图：「${image.name}」` });
      content.push({ type: 'input_image', image_url: `data:${images[i].mime};base64,${images[i].base64}`, detail: 'auto' });
    });
    content.push({ type: 'input_text', text: `用户这次的要求：${request.message}` });

    const response = await httpFetch('请求 OpenAI 助手', OPENAI_RESPONSES, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: INSTRUCTIONS,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name: 'assistant_actions', strict: true, schema: ASSISTANT_SCHEMA } },
        max_output_tokens: 6000,
        store: false,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const json = (await response.json().catch(() => null)) as OpenAIResponse | null;
    if (!response.ok) {
      throw new Error(json?.error?.message ? `OpenAI：${json.error.message}` : `OpenAI 返回 HTTP ${response.status}`);
    }
    if (json?.status === 'incomplete') {
      throw new Error(`回答没有写完（${json.incomplete_details?.reason ?? '原因未知'}），可以把要求说得更具体一些再试`);
    }
    const parts = (json?.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
    const refusal = parts.find((part) => part.type === 'refusal');
    if (refusal) throw new Error(`模型拒绝了这个请求：${refusal.refusal ?? ''}`);
    const text = parts.find((part) => part.type === 'output_text')?.text;
    if (!text) throw new Error('OpenAI 没有返回内容');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('OpenAI 返回的不是合法的 JSON');
    }
    const usage = json?.usage;
    return {
      ...sanitizeAssistantOutput(parsed, request.images.length),
      provider: 'openai',
      model,
      costUsd: usage ? assistantCostUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0) : 0,
    };
  }
}

interface OpenAIResponse {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function describeContext(request: AssistantRequest): string {
  const lines = [`项目：${request.projectName}`];
  lines.push(request.activeTheme ? `当前生效的主题卡：\n${request.activeTheme}` : '当前没有生效的主题卡。');
  if (request.selectedPrompts.length) {
    lines.push('选中的提示词卡：');
    for (const prompt of request.selectedPrompts) lines.push(`- 「${prompt.name}」：${prompt.text}`);
  }
  lines.push(request.images.length ? `选中的图像卡共 ${request.images.length} 张，见下方。` : '没有选中图像卡。');
  if (request.history.length) {
    lines.push('最近的对话：');
    for (const turn of request.history) lines.push(`${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`);
  }
  return lines.join('\n');
}

// ───────────────────────── 本地模拟 ─────────────────────────

/** 取自想法文档里"日式寿司点餐"的那一套视觉方向 */
const SUSHI_THEME: ThemeDraft = {
  name: '寿司点餐 · 热闹食欲',
  topic: '日式寿司点餐',
  keywords: ['新鲜', '热闹', '亲切', '有食欲'],
  cues: ['寿司', '餐盘', '回转轨道', 'IP 形象', '红色'],
  palette: [
    { role: '主色', name: '金枪鱼红', hex: '#E8473C', note: '品牌识别与关键按钮，传递新鲜和食欲' },
    { role: '邻近辅助色', name: '玉子橘黄', hex: '#F5A431', note: '活力与食欲，用在标签、点缀和插画高光' },
    { role: '深色', name: '海苔墨', hex: '#2B2A2E', note: '标题、正文和轮廓线，增强信息对比' },
    { role: '暖白', name: '米饭暖白', hex: '#FFF6EA', note: '大面积底色，平衡红色与其它颜色的冲撞' },
  ],
  rules: {
    shape: '圆润饱满、比例略带卡通感，统一采用正面略俯视的视角',
    material: '哑光为主，米粒、鱼肉纹理点到为止，细节密度中等',
    lighting: '左上方柔和主光，浅淡投影，高光克制',
    color: '保留核心红色，扩展邻近的橘黄；用深色承担信息对比，用暖白稳定整体画面；整体明度偏高、饱和度适中、偏暖',
  },
};

export class MockAssistant implements AssistantProvider {
  async ask(request: AssistantRequest, _model: string, signal: AbortSignal): Promise<AssistantResponse> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500 + Math.random() * 600);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('已取消', 'AbortError'));
      });
    });
    const message = request.message;
    const base = { provider: 'mock' as const, model: 'local-mock', costUsd: 0 };

    if (/主题|视觉方向|品牌线索/.test(message)) {
      const fromImage = request.images.length === 1;
      const topic = extractTopic(message) || (fromImage ? `基于「${request.images[0].name}」` : request.projectName);
      const theme = /寿司/.test(topic) || (fromImage && /寿司/.test(request.images[0].name))
        ? { ...SUSHI_THEME, topic: extractTopic(message) || SUSHI_THEME.topic, name: SUSHI_THEME.name }
        : genericTheme(topic);
      const reply = fromImage
        ? `（本地模拟）已从参考图「${request.images[0].name}」提炼视觉主题，可在主题卡里改色板和规则。`
        : `（本地模拟）为「${topic}」做了一张主题卡。`;
      return { ...base, reply, theme, prompts: [] };
    }
    if (/反推/.test(message) && request.images.length) {
      const prompts: PromptDraft[] = request.images.map((image) => ({
        name: `反推 · ${image.name}`,
        text: [
          `【画面主题】与「${image.name}」同风格的画面。`,
          '【构图】主体居中，四周留出呼吸空间。',
          '【造型与材质】圆润简化的造型，哑光材质，细节适中。',
          '【光线】柔和均匀的棚拍光，浅淡阴影。',
          '【色彩】清爽、饱和但不刺眼；不出现文字和 Logo。',
        ].join('\n'),
        inputIndex: null,
      }));
      return { ...base, reply: `（本地模拟）反推了 ${prompts.length} 张图。`, theme: null, prompts };
    }
    if (request.images.length) {
      const goal = message.replace(/^(请|帮我)?(为|给)?(选中的?)?(图|这些图)?(各)?(写|生成)?(一条)?/, '').trim() || '主题化的功能图标';
      const prompts: PromptDraft[] = request.images.map((image) => ({
        name: `${image.name} · 提示词`,
        text: `把 {{Image 1}}「${image.name}」做成${goal}：保留主体的识别特征，圆润简化，视觉重量与同组其它图标接近；不要文字、Logo 和多余元素。`,
        inputIndex: image.index,
      }));
      return { ...base, reply: `（本地模拟）给 ${prompts.length} 张图各写了一条提示词，已经分别绑定。`, theme: null, prompts };
    }
    const names = message.split(/[、，,；;\s]+/).filter((part) => part.length >= 2 && part.length <= 8).slice(0, 8);
    const prompts: PromptDraft[] = names.map((name) => ({ name, text: `为「${name}」画一个主题化的功能图标，圆润简化，不要文字。`, inputIndex: null }));
    return { ...base, reply: `（本地模拟）写了 ${prompts.length} 条提示词。`, theme: null, prompts };
  }
}

function extractTopic(message: string): string {
  const quoted = message.match(/[「“"]([^」”"]+)[」”"]/);
  if (quoted) return quoted[1].trim();
  const after = message.split(/[:：]/)[1];
  return after?.trim() ?? '';
}

function genericTheme(topic: string): ThemeDraft {
  let hash = 0;
  for (const ch of topic) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const hex = (h: number, s: number, l: number): string => {
    const a = (s * Math.min(l, 1 - l)) / 1;
    const f = (n: number): string => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
  };
  return {
    name: `${topic} · 视觉主题`,
    topic,
    keywords: ['清晰', '友好', '可信赖', '有活力'],
    cues: ['核心物件', '品牌形象', '主色块'],
    palette: [
      { role: '主色', name: '主色', hex: hex(hue, 0.7, 0.5), note: '品牌识别与关键操作' },
      { role: '邻近辅助色', name: '辅助色', hex: hex((hue + 30) % 360, 0.75, 0.58), note: '点缀与插画高光' },
      { role: '深色', name: '深色', hex: '#26262C', note: '标题、正文、轮廓' },
      { role: '暖白', name: '暖白', hex: '#FBF7F0', note: '大面积底色' },
    ],
    rules: { shape: '圆润、比例统一', material: '哑光、细节适中', lighting: '柔和顶光、浅阴影', color: '明度偏高、饱和适中' },
  };
}
