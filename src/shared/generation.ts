/** 生成相关的规则：主进程和渲染进程共用，保证估算、校验和实际请求一致 */

export type ProviderId = 'openai' | 'siliconflow' | 'newapi' | 'mock';
export type AssistantProviderId = 'openai' | 'newapi' | 'mock';
export type Currency = 'USD' | 'CNY';

/**
 * NewAPI（及同类 OpenAI 兼容中转）：地址和模型因站点而异，在设置里填 Base URL 与模型 id。
 * 预设按常见中转「带 image 的 Gemini」列出；站点没有的请用自定义，以 /v1/models 为准。
 */
export const NEWAPI_MODELS = [
  { id: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image（快，推荐试）' },
  { id: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image' },
  { id: 'gemini-3-pro-image', label: 'gemini-3-pro-image' },
  { id: 'gemini-3-pro-image-preview', label: 'gemini-3-pro-image-preview' },
  { id: 'gpt-image-2', label: 'gpt-image-2（改图+文生图）' },
  { id: 'gpt-image-1', label: 'gpt-image-1（若站点有）' },
  { id: 'dall-e-3', label: 'DALL·E 3（仅文生图，若站点有）' },
] as const;
export const DEFAULT_NEWAPI_MODEL = 'gemini-2.5-flash-image';
/** 助手走 NewAPI 时的看图对话模型预设；站点没有的用自定义 */
export const NEWAPI_ASSISTANT_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5（看图稳，推荐）' },
  { id: 'claude-opus-5-5', label: 'claude-opus-5-5（更强，贵）' },
  { id: 'claude-fable-5-1', label: 'claude-fable-5-1' },
] as const;
export const DEFAULT_NEWAPI_ASSISTANT_MODEL = 'claude-sonnet-5-5';
/** 未填写时的占位；真正请求前必须在设置里改成你的中转地址 */
export const DEFAULT_NEWAPI_BASE_URL = '';

/**
 * 硅基流动（国内站，2026-11）：改图只有 Qwen-Image-Edit-2509 支持多张参考图（1–3 张）；
 * 改图模型不接受 image_size，输出尺寸跟随输入图；文生图模型各有推荐尺寸。价格是固定的 ¥/张。
 */
export const SILICONFLOW_EDIT_MODELS = [
  { id: 'Qwen/Qwen-Image-Edit-2509', label: 'Qwen-Image-Edit-2509（1–3 张参考图）', priceCny: 0.3 },
] as const;
export const SILICONFLOW_T2I_MODELS = [
  {
    id: 'Qwen/Qwen-Image',
    label: 'Qwen-Image（中文字渲染强）',
    priceCny: 0.3,
    sizes: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584'],
  },
  {
    id: 'Tongyi-MAI/Z-Image-Turbo',
    label: 'Z-Image-Turbo（便宜、快，适合试方向）',
    priceCny: 0.1,
    sizes: ['512x512', '768x1024', '1024x576', '576x1024'],
  },
] as const;
export const DEFAULT_SILICONFLOW_EDIT_MODEL = 'Qwen/Qwen-Image-Edit-2509';
export const DEFAULT_SILICONFLOW_T2I_MODEL = 'Qwen/Qwen-Image';
export const SILICONFLOW_MAX_INPUTS = 3;

/** 各供应商一次最多接受的输入图数量 */
export function maxInputsFor(provider: ProviderId): number {
  return provider === 'siliconflow' ? SILICONFLOW_MAX_INPUTS : 16;
}

/** 规范化 OpenAI 兼容中转的 Base URL，保证以 /v1 结尾、无尾斜杠 */
export function normalizeOpenAICompatibleBaseUrl(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (!base) throw new Error('还没有填写 NewAPI 地址，请在设置里填中转站 Base URL（例如 https://你的域名）');
  if (!/^https?:\/\//i.test(base)) throw new Error('NewAPI 地址必须以 http:// 或 https:// 开头');
  if (!/\/v1$/i.test(base)) base += '/v1';
  return base;
}

/** 在模型推荐尺寸里挑比例最接近的 */
export function nearestSize(sizes: readonly string[], aspect: number): { width: number; height: number } {
  let best = sizes[0];
  let bestDiff = Infinity;
  for (const size of sizes) {
    const [w, h] = size.split('x').map(Number);
    const diff = Math.abs(Math.log(w / h / aspect));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = size;
    }
  }
  const [width, height] = best.split('x').map(Number);
  return { width, height };
}

export const OPENAI_MODELS = [
  { id: 'gpt-image-2.6-flare', label: 'GPT Image 2.6 Flare（快）' },
  { id: 'gpt-image-2.6-sunburst', label: 'GPT Image 2.6 Sunburst（细节好）' },
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
] as const;
export const DEFAULT_OPENAI_MODEL = 'gpt-image-2.6-flare';

export type Quality = 'low' | 'medium' | 'high' | 'xhigh';
export const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '超高' },
];

/** 'match' 跟随第一张输入图的比例 */
export type SizeOption = 'match' | '1024x1024' | '1536x1024' | '1024x1536';
export const SIZE_OPTIONS: { id: SizeOption; label: string }[] = [
  { id: 'match', label: '跟随输入图' },
  { id: '1024x1024', label: '方形 1024' },
  { id: '1536x1024', label: '横向 3:2' },
  { id: '1024x1536', label: '竖向 2:3' },
];

export const MIN_COUNT = 1;
export const MAX_COUNT = 4;

export interface PromptSettings {
  count: number;
  size: SizeOption;
  quality: Quality;
  /** 生成时是否附加生效主题卡的规则 */
  useTheme: boolean;
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = { count: 2, size: 'match', quality: 'medium', useTheme: true };

/** OpenAI 图像接口对自定义尺寸的限制 */
const SIZE_STEP = 16;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;
const MAX_RATIO = 3;
/** "跟随输入图"时的目标像素数，和 1536×1024 相当 */
const MATCH_TARGET_PIXELS = 1536 * 1024;

export function resolveSize(size: SizeOption, firstInput: { width: number; height: number } | null): { width: number; height: number } {
  if (size !== 'match') {
    const [width, height] = size.split('x').map(Number);
    return { width, height };
  }
  if (!firstInput) return { width: 1024, height: 1024 };
  return fitSizeToLimits(firstInput.width / firstInput.height, MATCH_TARGET_PIXELS);
}

/** 按比例和目标像素数算出满足接口限制的宽高（16 的倍数、1:3–3:1、像素数在范围内） */
export function fitSizeToLimits(aspect: number, targetPixels: number): { width: number; height: number } {
  const ratio = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, aspect));
  const pixels = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, targetPixels));
  let width = Math.sqrt(pixels * ratio);
  let height = width / ratio;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  width *= scale;
  height *= scale;
  const snap = (value: number): number => Math.max(SIZE_STEP, Math.round(value / SIZE_STEP) * SIZE_STEP);
  let w = snap(width);
  let h = snap(height);
  while (w * h < MIN_PIXELS) {
    w += SIZE_STEP;
    h = snap(w / ratio);
  }
  while (w * h > MAX_PIXELS) {
    w -= SIZE_STEP;
    h = snap(w / ratio);
  }
  return { width: w, height: h };
}

const IMAGE_REF = /\{\{\s*Image\s+(\d+)\s*\}\}/gi;

export interface RenderedPrompt {
  text: string;
  /** 提示词里引用到的最大图片序号 */
  maxRef: number;
}

/**
 * 把 {{Image N}} 换成模型习惯的写法（输入图按绑定顺序发送）：
 * OpenAI 用 "Image N"，Qwen 改图模型用 "图N"。
 */
export function renderPrompt(template: string, style: 'image' | 'tu' = 'image'): RenderedPrompt {
  let maxRef = 0;
  const text = template.replace(IMAGE_REF, (_match, n: string) => {
    maxRef = Math.max(maxRef, Number(n));
    return style === 'tu' ? `图${n}` : `Image ${n}`;
  });
  return { text: text.trim(), maxRef };
}

export function validatePrompt(template: string, inputCount: number, maxInputs = 16): string | null {
  const { text, maxRef } = renderPrompt(template);
  if (!text) return '提示词是空的';
  if (maxRef > inputCount) return `提示词引用了 Image ${maxRef}，但只绑定了 ${inputCount} 张输入图`;
  if (inputCount > maxInputs) return `当前供应商一次最多接受 ${maxInputs} 张输入图，现在绑定了 ${inputCount} 张`;
  if (text.length > 32_000) return '提示词超过 32000 字，接口不接受';
  return null;
}

/**
 * 生成前的粗估。官方没有公开 2.5 / 2.6 每张图的 token 数，这里参考 gpt-image-2 的价目表
 * （1024² 低/中/高 $0.006/$0.053/$0.211），按像素数缩放；超高按高的 1.5 倍。
 * 每次真实生成完成后会用实际用量校准（calibration = 实际 / 粗估）。
 */
const BASE_PRICE_PER_1024_SQUARE: Record<Quality, number> = {
  low: 0.006,
  medium: 0.053,
  high: 0.211,
  xhigh: 0.32,
};

export function estimateCostUsd(
  settings: PromptSettings,
  size: { width: number; height: number },
  calibration = 1,
): number {
  const pixelScale = (size.width * size.height) / (1024 * 1024);
  return BASE_PRICE_PER_1024_SQUARE[settings.quality] * pixelScale * settings.count * calibration;
}

/** 接口返回的用量 → 美元（2.5 / 2.6 同价：图像输入 $8、文本输入 $5、图像输出 $30，每百万 token） */
export interface ImageUsage {
  input_tokens?: number;
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  output_tokens?: number;
}

export function costFromUsage(usage: ImageUsage): number {
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const textIn = usage.input_tokens_details?.text_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - imageIn);
  const out = usage.output_tokens ?? 0;
  return (imageIn * 8 + textIn * 5 + out * 30) / 1_000_000;
}

export function calibrationKey(model: string, quality: Quality): string {
  return `${model}:${quality}`;
}

export function formatCost(value: number, currency: Currency): string {
  if (currency === 'CNY') return value === 0 ? '¥0' : `¥${value.toFixed(value < 1 ? 2 : 1)}`;
  return formatUsd(value);
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

// ───────────────────────── 生成任务 ─────────────────────────

export interface GenerationInput {
  versionId: string;
  /** 相对项目目录 */
  file: string;
}

export interface GenerationRequest {
  jobId: string;
  projectDir: string;
  promptCardId: string;
  outputCardId: string;
  /** 已渲染（{{Image N}} 已替换）的提示词 */
  prompt: string;
  inputs: GenerationInput[];
  /** 第一张输入图的原图尺寸，主进程据此按同一套规则选模型和尺寸 */
  firstInputSize: { width: number; height: number } | null;
  settings: PromptSettings;
  /** 发给接口的尺寸；硅基流动改图模型输出跟随输入图，为 null */
  size: { width: number; height: number } | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface GeneratedVersionInfo {
  id: string;
  file: string;
  width: number;
  height: number;
}

export interface JobUpdate {
  jobId: string;
  status: JobStatus;
  provider: ProviderId;
  model: string;
  /** 估算和实际花费的币种：OpenAI 美元，硅基流动人民币 */
  currency: Currency;
  estimateUsd: number;
  /** 实际花费（成功后才有；本地模拟为 0）；单位见 currency */
  costUsd?: number;
  versions?: GeneratedVersionInfo[];
  error?: string;
  /** 生成成功但下载失败时，到这个时间之前可以重新下载（毫秒时间戳） */
  retryDownloadUntil?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface GenerationConfig {
  provider: ProviderId;
  model: string;
  /** 助手用的文本 / 看图模型 */
  assistantModel: string;
  /** 助手走哪家：和生图供应商分开选；NewAPI 复用中转的 Base URL 与 Key */
  assistantProvider: AssistantProviderId;
  /** 助手走 NewAPI 时用的看图对话模型 id（以中转站 /models 为准） */
  newapiAssistantModel: string;
  hasApiKey: boolean;
  /** 显示用的 Key 末四位 */
  apiKeyHint: string | null;
  hasSiliconflowKey: boolean;
  siliconflowKeyHint: string | null;
  siliconflowEditModel: string;
  siliconflowT2iModel: string;
  /** NewAPI 中转站根地址（可含或不含 /v1） */
  newapiBaseUrl: string;
  /** NewAPI 生图模型 id（以中转站 /models 为准，常见 gemini-*-image） */
  newapiModel: string;
  hasNewapiKey: boolean;
  newapiKeyHint: string | null;
  calibration: Record<string, number>;
}

// ───────────────────────── 按供应商估算 ─────────────────────────

export interface ProviderPlan {
  provider: ProviderId;
  /** 实际调用的模型 */
  model: string;
  /** 发给接口的尺寸；硅基流动改图模型输出跟随输入图，这里是 null */
  size: { width: number; height: number } | null;
  /** 界面上显示的尺寸说明 */
  sizeLabel: string;
  estimate: number;
  currency: Currency;
  promptStyle: 'image' | 'tu';
  maxInputs: number;
}

/** 一张提示词卡在当前设置下会怎么调用：模型、尺寸、估算花费 */
export function planGeneration(
  config: Pick<
    GenerationConfig,
    'provider' | 'model' | 'calibration' | 'siliconflowEditModel' | 'siliconflowT2iModel' | 'newapiModel'
  >,
  settings: PromptSettings,
  firstInput: { width: number; height: number } | null,
  inputCount: number,
): ProviderPlan {
  const base = resolveSize(settings.size, firstInput);
  if (config.provider === 'siliconflow') {
    if (inputCount > 0) {
      const model = SILICONFLOW_EDIT_MODELS.find((m) => m.id === config.siliconflowEditModel) ?? SILICONFLOW_EDIT_MODELS[0];
      return {
        provider: 'siliconflow',
        model: model.id,
        size: null,
        sizeLabel: '跟随输入图（改图模型不支持指定尺寸）',
        estimate: model.priceCny * settings.count,
        currency: 'CNY',
        promptStyle: 'tu',
        maxInputs: SILICONFLOW_MAX_INPUTS,
      };
    }
    const model = SILICONFLOW_T2I_MODELS.find((m) => m.id === config.siliconflowT2iModel) ?? SILICONFLOW_T2I_MODELS[0];
    const size = nearestSize(model.sizes, base.width / base.height);
    return {
      provider: 'siliconflow',
      model: model.id,
      size,
      sizeLabel: `${size.width} × ${size.height}`,
      estimate: model.priceCny * settings.count,
      currency: 'CNY',
      promptStyle: 'image',
      maxInputs: SILICONFLOW_MAX_INPUTS,
    };
  }
  if (config.provider === 'newapi') {
    const model = (config.newapiModel || DEFAULT_NEWAPI_MODEL).trim() || DEFAULT_NEWAPI_MODEL;
    const size = /^dall-e-3/i.test(model)
      ? nearestSize(['1024x1024', '1792x1024', '1024x1792'], base.width / base.height)
      : /^dall-e-2/i.test(model)
        ? { width: 1024, height: 1024 }
        : base;
    const calibration = config.calibration[calibrationKey(model, settings.quality)] ?? 1;
    return {
      provider: 'newapi',
      model,
      size,
      sizeLabel: `${size.width} × ${size.height}`,
      estimate: estimateCostUsd(settings, size, calibration),
      currency: 'USD',
      promptStyle: 'image',
      maxInputs: 16,
    };
  }
  const model = config.provider === 'mock' ? 'local-mock' : config.model;
  const calibration = config.calibration[calibrationKey(model, settings.quality)] ?? 1;
  return {
    provider: config.provider,
    model,
    size: base,
    sizeLabel: `${base.width} × ${base.height}`,
    estimate: config.provider === 'mock' ? 0 : estimateCostUsd(settings, base, calibration),
    currency: 'USD',
    promptStyle: 'image',
    maxInputs: maxInputsFor(config.provider),
  };
}
