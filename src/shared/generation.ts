/** 生成相关的规则：主进程和渲染进程共用，保证估算、校验和实际请求一致 */

export type ProviderId = 'openai' | 'mock';

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
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = { count: 2, size: 'match', quality: 'medium' };

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

/** 把 {{Image N}} 换成接口能理解的 "Image N"（输入图按绑定顺序发送） */
export function renderPrompt(template: string): RenderedPrompt {
  let maxRef = 0;
  const text = template.replace(IMAGE_REF, (_match, n: string) => {
    maxRef = Math.max(maxRef, Number(n));
    return `Image ${n}`;
  });
  return { text: text.trim(), maxRef };
}

export function validatePrompt(template: string, inputCount: number): string | null {
  const { text, maxRef } = renderPrompt(template);
  if (!text) return '提示词是空的';
  if (maxRef > inputCount) return `提示词引用了 Image ${maxRef}，但只绑定了 ${inputCount} 张输入图`;
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
  settings: PromptSettings;
  size: { width: number; height: number };
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
  estimateUsd: number;
  /** 实际花费（成功后才有；本地模拟为 0） */
  costUsd?: number;
  versions?: GeneratedVersionInfo[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface GenerationConfig {
  provider: ProviderId;
  model: string;
  hasApiKey: boolean;
  /** 显示用的 Key 末四位 */
  apiKeyHint: string | null;
  calibration: Record<string, number>;
}
