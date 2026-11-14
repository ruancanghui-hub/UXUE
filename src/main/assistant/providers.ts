import { join } from 'node:path';
import {
  ASSISTANT_MAX_BLOCKS,
  ASSISTANT_MAX_PROMPTS,
  ASSISTANT_SCHEMA,
  assistantCostUsd,
  normalizeBlockCoordinates,
  sanitizeAssistantOutput,
  type AssistantRequest,
  type AssistantResponse,
  type BlockDraft,
  type ElementDraft,
  type PromptDraft,
  type ThemeDraft,
} from '../../shared/assistant';
import { normalizeOpenAICompatibleBaseUrl } from '../../shared/generation';
import { newApiErrorMessage } from '../generation/providers';
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

四、拆解页面（任务为「拆解」时，blocks）：第 1 张图是一个 APP / 桌面页面的低保真原型（线框或截图）。把页面里需要单独生成图片素材的块框出来：
- type 只能是：hero（顶部视觉 / Banner / 大主视觉）、icon（金刚位等功能入口图标）、tile（瓷片区、卡片里的插画图形）、tabbar（底部导航图标）、illustration（登录页、空状态等主插图）、other。
- 一排图标里每个图标单独一个区块，框住图标本身（不含下方文字）；同一排的 group 填同一个组名，比如「金刚位」「底部导航」；不成排的 group 为 null。
- 纯文字、输入框、按钮、列表文字、状态栏不要框。区块不要嵌套。
- x、y、width、height 是第 1 张图上的像素坐标（图的尺寸写在图片说明里），左上角为原点；框要紧贴目标的外沿，不要偏移，也不要包进旁边的文字和按钮。
- name 用简短中文，比如「Banner」「金刚位 1 · 热门」。这个任务里 theme 为 null、prompts 为空数组。

五、为区块写提示词（任务为「为区块写提示词」时，prompts）：第 N 张图是第 N 个区块从原型裁下的截图，上下文里写了每个区块的名字、类型和组。
- 每个区块一条提示词，inputIndex 填 N；text 用 {{Image 1}} 指代这张截图（每张提示词卡只绑定这一张）。
- 说清楚：沿用截图的构图、比例、主体位置和留白；画什么内容（结合区块名字和产品主题）；不要什么（文字、Logo、水印、多余元素）。
- hero：画面饱满，在原型里放标题文字的位置留出有氛围的视觉空区（不是纯白）。
- icon / tabbar：单个物件居中，造型简洁、识别度高，纯色背景（用生效主题卡里的浅底或暖白色），同组图标视觉重量、视角、细节密度一致。
- tile / illustration：主体明确、构图完整，背景和页面底色协调。
- 底稿是「借鉴的成品截图」时，只借鉴布局和构图，不照搬截图里的具体内容、元素、角色和文字。
- 这个任务里 theme 为 null、blocks 为空数组。

六、列素材清单（任务为「列素材清单」时，elements）：根据生效主题卡回答三个问题——产品是什么（产品主题）、希望用户感受到什么（视觉关键词）、哪些视觉元素能持续表达这种感觉（视觉线索）——推导出接下来要设计的核心素材。
- 共 8–16 项，以图标为主（功能入口、导航、状态），再加少量插画（Banner、空状态、登录页主图）、装饰元素（点缀小物、分隔、角标）、纹样 / 背景（可平铺的底纹）。
- category 只能是 icon、illustration、decor、pattern；每项写 name（简短中文，如「握寿司图标」）、usage（用在页面哪里）、cue（出自哪条视觉线索）。
- text 是能直接拿去文生图的中文提示词：画什么（具体物件和造型）、用在哪（比如「首页金刚位，缩到 48px 也要认得出」）、构图（icon / decor：单个物件居中、纯色浅底背景；pattern：能无缝平铺；illustration：主体明确、留出放文字的空间）、不要什么（文字、Logo、水印）。不要重复主题卡里的配色和统一规则，生成时会自动附加。
- 上下文里列出的已有清单项不要重复；用户写了范围说明（比如「个人页要用的」）就按范围列。
- 这个任务里 theme 为 null、prompts 和 blocks 为空数组。

不是拆解任务时 blocks 给空数组；不是列素材清单任务时 elements 给空数组。
reply 用一两句中文说明你做了什么。`;

const TASK_LABELS = { chat: '普通对话', decompose: '拆解', blockPrompts: '为区块写提示词', elementList: '列素材清单' } as const;
/** 区块截图本来就小，缩到长边 512 就够看清 */
const BLOCK_IMAGE_EDGE = 512;
/** 拆解时把原型放大或缩小到长边 1024：太小的截图模型看不清图标边界 */
const DECOMPOSE_IMAGE_EDGE = 1024;

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
          maxEdge: imageEdge(request),
          enlarge: request.task === 'decompose',
        }),
      ),
    );
    const content: Record<string, unknown>[] = [{ type: 'input_text', text: describeContext(request) }];
    request.images.forEach((image, i) => {
      content.push({ type: 'input_text', text: imageLabel(request, image.index, image.name, images[i]) });
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
        max_output_tokens: maxOutputTokens(request),
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
      ...sanitizeAssistantOutput(normalizeBlockCoordinates(parsed, images[0]?.width ?? 1000, images[0]?.height ?? 1000), request.images.length, maxPromptsFor(request)),
      provider: 'openai',
      model,
      costUsd: usage ? assistantCostUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0) : 0,
    };
  }
}

/**
 * NewAPI 中转：走 OpenAI 兼容的 /chat/completions（Claude、Gemini 等由中转转换）。
 * 各家对 json_schema 支持不一，这里只在提示里约定输出 JSON，再从回复里取出 JSON 对象。
 */
export class NewApiAssistant implements AssistantProvider {
  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly getApiKey: () => string | null,
    private readonly getBaseUrl: () => string,
  ) {}

  async ask(request: AssistantRequest, model: string, signal: AbortSignal): Promise<AssistantResponse> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置 NewAPI Key，请在“设置”里填写，或切换到本地模拟');
    const base = normalizeOpenAICompatibleBaseUrl(this.getBaseUrl());

    const images = await Promise.all(
      request.images.map((image) =>
        this.worker.request<PreparedInput>({
          type: 'prepareInput',
          path: join(request.projectDir, image.file),
          maxEdge: imageEdge(request),
          enlarge: request.task === 'decompose',
        }),
      ),
    );
    const content: Record<string, unknown>[] = [{ type: 'text', text: describeContext(request) }];
    request.images.forEach((image, i) => {
      content.push({ type: 'text', text: imageLabel(request, image.index, image.name, images[i]) });
      content.push({ type: 'image_url', image_url: { url: `data:${images[i].mime};base64,${images[i].base64}` } });
    });
    content.push({ type: 'text', text: `用户这次的要求：${request.message}` });

    const response = await httpFetch('请求 NewAPI 助手', `${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `${INSTRUCTIONS}\n\n${JSON_OUTPUT_RULE}` },
          { role: 'user', content },
        ],
        max_tokens: maxOutputTokens(request),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const json = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
    if (!response.ok) throw new Error(newApiErrorMessage(json?.error?.message, response.status));
    const choice = json?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error('回答没有写完（超出长度），可以把要求说得更具体一些再试');
    }
    const text = messageText(choice?.message?.content);
    if (!text) throw new Error('NewAPI 没有返回内容');

    const parsed = extractJsonObject(text);
    if (parsed === null) throw new Error('NewAPI 返回的不是合法的 JSON，可以换一个对话模型再试');
    return {
      ...sanitizeAssistantOutput(normalizeBlockCoordinates(parsed, images[0]?.width ?? 1000, images[0]?.height ?? 1000), request.images.length, maxPromptsFor(request)),
      provider: 'newapi',
      model,
      costUsd: 0,
    };
  }
}

const JSON_OUTPUT_RULE = `只输出一个 JSON 对象，不要 Markdown 代码块，不要任何额外文字。必须符合这个 JSON Schema：
${JSON.stringify(ASSISTANT_SCHEMA)}`;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | { type?: string; text?: string }[] | null }; finish_reason?: string }[];
  error?: { message?: string };
}

function messageText(content: string | { type?: string; text?: string }[] | null | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('').trim();
  return '';
}

/** 模型偶尔会包一层 ```json 或前后带话，取第一个 { 到最后一个 } 再解析 */
function extractJsonObject(text: string): unknown {
  const candidates = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, '')];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 试下一个
    }
  }
  return null;
}

interface OpenAIResponse {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function imageEdge(request: AssistantRequest): number {
  if (request.task === 'decompose') return DECOMPOSE_IMAGE_EDGE;
  return request.task === 'blockPrompts' ? BLOCK_IMAGE_EDGE : CONTEXT_IMAGE_EDGE;
}

function imageLabel(request: AssistantRequest, index: number, name: string, image: PreparedInput): string {
  if (request.task === 'decompose') return `第 ${index} 张图：「${name}」，尺寸 ${image.width} × ${image.height} 像素`;
  const block = request.blocks?.find((b) => b.index === index);
  if (!block) return `第 ${index} 张图：「${name}」`;
  return `第 ${index} 张图：区块「${block.name}」，类型 ${block.type}${block.group ? `，组「${block.group}」` : ''}`;
}

function maxPromptsFor(request: AssistantRequest): number {
  return request.task === 'blockPrompts' ? ASSISTANT_MAX_BLOCKS : ASSISTANT_MAX_PROMPTS;
}

function maxOutputTokens(request: AssistantRequest): number {
  if (request.task === 'blockPrompts') return 16_000;
  return request.task === 'elementList' ? 10_000 : 6000;
}

function describeContext(request: AssistantRequest): string {
  const lines = [`项目：${request.projectName}`, `任务：${TASK_LABELS[request.task ?? 'chat']}`];
  if (request.baseSource) lines.push(`底稿来源：${request.baseSource === 'borrowed' ? '借鉴的成品截图' : '自己的线框'}`);
  if (request.existingElements?.length) lines.push(`已有的清单项（不要重复）：${request.existingElements.join('、')}`);
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

/** 本地模拟的拆解结果：一张常见的 APP 首页 */
const MOCK_HOME_BLOCKS: BlockDraft[] = [
  { name: 'Banner', type: 'hero', group: null, x: 40, y: 110, width: 920, height: 230 },
  ...['热门', '上新', '推荐', '全部'].map((label, i) => ({
    name: `金刚位 ${i + 1} · ${label}`,
    type: 'icon' as const,
    group: '金刚位',
    x: 70 + i * 230,
    y: 380,
    width: 170,
    height: 80,
  })),
  { name: '瓷片 · 左', type: 'tile', group: '瓷片', x: 40, y: 520, width: 450, height: 220 },
  { name: '瓷片 · 右', type: 'tile', group: '瓷片', x: 510, y: 520, width: 450, height: 220 },
  ...['首页', '分类', '购物车', '我的'].map((label, i) => ({
    name: `底部导航 · ${label}`,
    type: 'tabbar' as const,
    group: '底部导航',
    x: 80 + i * 240,
    y: 925,
    width: 90,
    height: 45,
  })),
];

/** 本地模拟的素材清单：每条线索一个图标，再加插画、装饰和纹样各一项 */
function mockElements(cues: string[]): ElementDraft[] {
  const icons = cues.slice(0, 6).map((cue): ElementDraft => ({
    name: `${cue}图标`,
    category: 'icon',
    usage: '首页金刚位',
    cue,
    text: `画一个「${cue}」功能图标：单个物件居中，造型简洁，缩到 48px 也要认得出，纯色浅底背景；不要文字、Logo 和水印。`,
  }));
  const main = cues[0] ?? '主体';
  return [
    ...icons,
    { name: 'Banner 主插画', category: 'illustration', usage: '首页 Banner', cue: main, text: `画一张以「${main}」为主体的横幅插画，右侧留出放标题文字的空间；不要文字和 Logo。` },
    { name: '点缀小物', category: 'decor', usage: '卡片角标与分隔', cue: cues[1] ?? main, text: `画一个小巧的「${cues[1] ?? main}」点缀元素，单个物件居中，纯色浅底背景；不要文字。` },
    { name: '页面底纹', category: 'pattern', usage: '页面背景', cue: cues[2] ?? main, text: `画一张由「${cues[2] ?? main}」简化图形组成、能无缝平铺的浅色底纹；不要文字。` },
  ];
}

const MOCK_BLOCK_PROMPTS: Record<BlockDraft['type'], string> = {
  hero: '画一张饱满的横幅主视觉，标题文字的位置留出有氛围的视觉空区。',
  icon: '画一个居中的单个功能图标，造型简洁、识别度高，纯色浅底背景，同组图标视觉重量一致。',
  tile: '画一张瓷片插画，主体明确、构图完整，背景与页面底色协调。',
  tabbar: '画一个简洁的底部导航图标，单个物件居中，纯色浅底背景，同组图标风格一致。',
  illustration: '画一张主插图，主体明确、构图完整，背景与页面底色协调。',
  other: '按截图的构图画出这一块的素材。',
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
    const base = { provider: 'mock' as const, model: 'local-mock', costUsd: 0, blocks: [] as BlockDraft[], elements: [] as ElementDraft[] };

    if (request.task === 'elementList') {
      const cues = (request.activeTheme?.match(/视觉线索：(.+)/)?.[1] ?? '主体物件、品牌形象').split('、').map((c) => c.trim()).filter(Boolean);
      const taken = new Set(request.existingElements ?? []);
      const elements = mockElements(cues).filter((element) => !taken.has(element.name));
      return { ...base, reply: `（本地模拟）从主题卡列出了 ${elements.length} 项素材。`, theme: null, prompts: [], elements };
    }

    if (request.task === 'decompose') {
      return { ...base, reply: `（本地模拟）把页面拆成了 ${MOCK_HOME_BLOCKS.length} 个区块，可以拖动、缩放或删掉不需要的。`, theme: null, prompts: [], blocks: MOCK_HOME_BLOCKS };
    }
    if (request.task === 'blockPrompts') {
      const borrowed = request.baseSource === 'borrowed' ? '只借鉴截图的布局和构图，不照搬里面的内容和文字；' : '';
      const prompts: PromptDraft[] = (request.blocks ?? []).map((block) => ({
        name: block.name,
        text: `${MOCK_BLOCK_PROMPTS[block.type]}（区块「${block.name}」）沿用 {{Image 1}} 的构图、比例和留白；${borrowed}不要文字、Logo 和水印。`,
        inputIndex: block.index,
      }));
      return { ...base, reply: `（本地模拟）为 ${prompts.length} 个区块各写了一条提示词，已经绑定各自的截图。`, theme: null, prompts };
    }

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
