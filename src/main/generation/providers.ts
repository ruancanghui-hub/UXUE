import { join } from 'node:path';
import {
  costFromUsage,
  normalizeOpenAICompatibleBaseUrl,
  SILICONFLOW_MAX_INPUTS,
  type GenerationRequest,
  type ImageUsage,
  type ProviderId,
  type Quality,
} from '../../shared/generation';
import type { MockGenerateResult, PreparedInput } from '../../shared/workerProtocol';
import { httpFetch } from '../http';
import type { ImageWorkerClient } from '../imageWorkerClient';

export interface ProviderResult {
  images: Uint8Array[];
  /** 实际花费；null 表示接口没返回用量，只能用估算 */
  costUsd: number | null;
}

export interface ImageProvider {
  readonly id: ProviderId;
  generate(request: GenerationRequest, model: string, signal: AbortSignal): Promise<ProviderResult>;
}

/** 生成成功、已经计费，但结果没下载下来：带上结果链接，1 小时内可以重新下载 */
export class DownloadFailedError extends Error {
  constructor(
    message: string,
    readonly urls: string[],
    readonly expiresAt: number,
  ) {
    super(message);
  }
}

const RESULT_URL_TTL_MS = 60 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;

/** 下载硅基流动的结果图，失败时退避重试 */
export async function downloadResults(urls: string[], signal?: AbortSignal): Promise<Uint8Array[]> {
  const images: Uint8Array[] = [];
  for (const url of urls) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const timeout = AbortSignal.timeout(120_000);
        const response = await httpFetch('下载硅基流动的生成结果', url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) throw new Error(`下载硅基流动的生成结果失败（HTTP ${response.status}）`);
        images.push(new Uint8Array(await response.arrayBuffer()));
        lastError = null;
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    if (lastError) throw lastError;
  }
  return images;
}

const OPENAI_BASE = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * OpenAI 图像接口：有输入图走 /images/edits（输入图以 base64 数据地址放进 JSON，最多 16 张），
 * 没有输入图走 /images/generations。GPT Image 系列总是返回 b64_json。
 */
export class OpenAIProvider implements ImageProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly getApiKey: () => string | null,
  ) {}

  async generate(request: GenerationRequest, model: string, signal: AbortSignal): Promise<ProviderResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置 OpenAI API Key，请在“设置”里填写，或切换到本地模拟');
    if (request.inputs.length > 16) throw new Error('OpenAI 一次最多接受 16 张输入图');

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      n: request.settings.count,
      size: request.size ? `${request.size.width}x${request.size.height}` : 'auto',
      quality: request.settings.quality,
      output_format: 'png',
    };
    if (request.inputs.length > 0) {
      const prepared = await Promise.all(
        request.inputs.map((input) =>
          this.worker.request<PreparedInput>({ type: 'prepareInput', path: join(request.projectDir, input.file) }),
        ),
      );
      body.images = prepared.map((image) => ({ image_url: `data:${image.mime};base64,${image.base64}` }));
    }

    const endpoint = request.inputs.length > 0 ? '/images/edits' : '/images/generations';
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await httpFetch('请求 OpenAI 生图', OPENAI_BASE + endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout]),
    });
    const json = (await response.json().catch(() => null)) as {
      data?: { b64_json?: string }[];
      usage?: ImageUsage;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(json?.error?.message ? `OpenAI：${json.error.message}` : `OpenAI 返回 HTTP ${response.status}`);
    }
    const images = (json?.data ?? [])
      .map((item) => item.b64_json)
      .filter((data): data is string => !!data)
      .map((data) => new Uint8Array(Buffer.from(data, 'base64')));
    if (images.length === 0) throw new Error('OpenAI 没有返回图片');
    return { images, costUsd: json?.usage ? costFromUsage(json.usage) : null };
  }

  /** 用模型详情接口验证 Key 是否可用，不产生费用 */
  async testConnection(model: string): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置 API Key');
    const response = await httpFetch('连接 OpenAI', `${OPENAI_BASE}/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return `连接正常，可以使用 ${model}`;
    const json = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
  }
}

const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';
/** 给硅基流动的参考图缩到长边 1536：Qwen 改图模型内部按约 1MP 处理，再大只是浪费上传 */
const SILICONFLOW_INPUT_EDGE = 1536;

/**
 * 硅基流动（国内站）：改图和文生图都走 /images/generations。
 * 有输入图时用 image / image2 / image3 传参考图（base64 数据地址），不传 image_size；
 * 每次请求只出一张，要几张就发几次。结果是 1 小时内有效的链接，拿到后立刻下载。
 * X-Enable-Watermark: 0 关掉接口加的可见水印（按平台规定，最终成品需要自己加 AI 生成标识）。
 */
export class SiliconFlowProvider implements ImageProvider {
  readonly id = 'siliconflow' as const;

  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly getApiKey: () => string | null,
  ) {}

  async generate(request: GenerationRequest, model: string, signal: AbortSignal): Promise<ProviderResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置硅基流动 API Key，请在“设置”里填写');
    if (request.inputs.length > SILICONFLOW_MAX_INPUTS) throw new Error(`硅基流动一次最多接受 ${SILICONFLOW_MAX_INPUTS} 张参考图`);

    const body: Record<string, unknown> = { model, prompt: request.prompt };
    if (request.inputs.length > 0) {
      const prepared = await Promise.all(
        request.inputs.map((input) =>
          this.worker.request<PreparedInput>({ type: 'prepareInput', path: join(request.projectDir, input.file), maxEdge: SILICONFLOW_INPUT_EDGE }),
        ),
      );
      prepared.forEach((image, i) => {
        body[i === 0 ? 'image' : `image${i + 1}`] = `data:${image.mime};base64,${image.base64}`;
      });
    } else if (request.size) {
      body.image_size = `${request.size.width}x${request.size.height}`;
    }

    const urls: string[] = [];
    for (let i = 0; i < request.settings.count; i++) {
      const response = await httpFetch('请求硅基流动生图', `${SILICONFLOW_BASE}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Enable-Watermark': '0' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const text = await response.text();
      let json: { images?: { url?: string }[]; data?: { url?: string }[]; message?: string } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!response.ok) {
        throw new Error(`硅基流动：${json?.message ?? (text.trim().slice(0, 200) || `HTTP ${response.status}`)}`);
      }
      const url = (json?.images ?? json?.data ?? [])[0]?.url;
      if (!url) throw new Error('硅基流动没有返回图片');
      urls.push(url);
    }
    const expiresAt = Date.now() + RESULT_URL_TTL_MS;
    try {
      // 硅基流动按张固定计价，花费由队列按价目表计算
      return { images: await downloadResults(urls, signal), costUsd: null };
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new DownloadFailedError(
        `生成成功了（已计费），但结果没下载下来：${reason}。如果开着代理软件，把 siliconflow.cn 设成直连后点"重新下载"（1 小时内有效）`,
        urls,
        expiresAt,
      );
    }
  }

  /**
   * 用模型列表验证 Key，并确认设置里选的模型可用，不产生费用。
   * 硅基流动 2026-08-14 停用了查余额的 /v1/user/info，目前没有替代接口，余额只能在控制台看。
   */
  async testConnection(models: string[]): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置硅基流动 API Key');
    const response = await httpFetch('连接硅基流动', `${SILICONFLOW_BASE}/models?type=image`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let json: { data?: { id?: string }[]; message?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) throw new Error(json?.message ?? (text.trim().slice(0, 200) || `HTTP ${response.status}`));
    const available = new Set((json?.data ?? []).map((model) => model.id));
    const missing = models.filter((id) => !available.has(id));
    if (missing.length) throw new Error(`Key 有效，但账号下没有这些模型：${missing.join('、')}`);
    return `连接正常，可以使用 ${models.join('、')}（余额请在 cloud.siliconflow.cn 控制台查看）`;
  }
}

/**
 * NewAPI 等 OpenAI 兼容中转：Base URL + Bearer Key，走 /images/generations 或 /images/edits。
 * 结果可能是 b64_json 或 url（url 则下载）；计费以接口 usage 为准，没有则退回粗估。
 */
export class NewApiProvider implements ImageProvider {
  readonly id = 'newapi' as const;

  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly getApiKey: () => string | null,
    private readonly getBaseUrl: () => string,
  ) {}

  async generate(request: GenerationRequest, model: string, signal: AbortSignal): Promise<ProviderResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置 NewAPI Key，请在“设置”里填写');
    const base = normalizeOpenAICompatibleBaseUrl(this.getBaseUrl());
    const dalle = /^dall-e/i.test(model);
    const openAiImage = /^gpt-image/i.test(model);
    if (dalle && request.inputs.length > 0) {
      throw new Error('DALL·E 不支持参考图改图，请改用 gemini-*-image / gpt-image-1，或先解绑输入图做文生图');
    }
    if (dalle && request.settings.count > 1 && /^dall-e-3/i.test(model)) {
      throw new Error('DALL·E 3 一次只能生成 1 张，请把数量改成 1');
    }

    const size = request.size ? `${request.size.width}x${request.size.height}` : 'auto';
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      n: request.settings.count,
      size,
    };

    // OpenAI 家族才带 quality / output_format；Gemini 等中转模型多半不认这些字段
    if (dalle) {
      body.response_format = 'b64_json';
      body.quality = mapDalleQuality(request.settings.quality);
    } else if (openAiImage) {
      body.quality = request.settings.quality === 'xhigh' ? 'high' : request.settings.quality;
      body.output_format = 'png';
    }

    if (request.inputs.length > 0) {
      if (request.inputs.length > 16) throw new Error('一次最多接受 16 张输入图');
      const prepared = await Promise.all(
        request.inputs.map((input) =>
          this.worker.request<PreparedInput>({ type: 'prepareInput', path: join(request.projectDir, input.file) }),
        ),
      );
      body.images = prepared.map((image) => ({ image_url: `data:${image.mime};base64,${image.base64}` }));
    }

    const endpoint = request.inputs.length > 0 ? '/images/edits' : '/images/generations';
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await httpFetch('请求 NewAPI 生图', `${base}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout]),
    });
    const json = (await response.json().catch(() => null)) as {
      data?: { b64_json?: string; url?: string }[];
      usage?: ImageUsage;
      error?: { message?: string };
    } | null;
    if (!response.ok) throw new Error(newApiErrorMessage(json?.error?.message, response.status));

    const images: Uint8Array[] = [];
    const urls: string[] = [];
    for (const item of json?.data ?? []) {
      if (item.b64_json) images.push(new Uint8Array(Buffer.from(item.b64_json, 'base64')));
      else if (item.url) urls.push(item.url);
    }
    if (urls.length) {
      try {
        images.push(...(await downloadResults(urls, signal)));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new DownloadFailedError(
          `NewAPI 已生成但下载失败：${reason}`,
          urls,
          Date.now() + RESULT_URL_TTL_MS,
        );
      }
    }
    if (images.length === 0) throw new Error('NewAPI 没有返回图片');
    return { images, costUsd: json?.usage ? costFromUsage(json.usage) : null };
  }

  async testConnection(model: string): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('还没有设置 NewAPI Key');
    const base = normalizeOpenAICompatibleBaseUrl(this.getBaseUrl());
    const response = await httpFetch('连接 NewAPI', `${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => null)) as {
      data?: { id?: string }[];
      error?: { message?: string };
    } | null;
    if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
    const ids = (json?.data ?? []).map((item) => item.id).filter((id): id is string => !!id);
    const imageish = ids.filter((id) => /image|dall-e|flux|sdxl|midjourney|imagen/i.test(id));
    const sampleSource = imageish.length ? imageish : ids;
    const sample = sampleSource.slice(0, 8).join('、');
    const more = sampleSource.length > 8 ? '…' : '';
    const quota = await this.keyQuota(base, apiKey);
    const quotaNote = quota ? `；${quota}` : '';
    if (ids.length && model && !ids.includes(model)) {
      return `连接正常${quotaNote}；当前站点模型列表里没有「${model}」，请改成站点里的生图模型 id（${imageish.length ? '生图相关' : '已列出'} ${Math.min(8, sampleSource.length)} 个：${sample}${more}）`;
    }
    return ids.length
      ? imageish.length
        ? `连接正常${quotaNote}；站点约 ${ids.length} 个模型，其中生图相关 ${imageish.length} 个（如 ${sample}${more}）`
        : `连接正常${quotaNote}；站点可用模型约 ${ids.length} 个`
      : `连接正常${quotaNote}（未返回模型列表，仍可尝试生图）`;
  }

  /**
   * NewAPI 的 OpenAI 兼容账单接口返回的是「这个 Key（令牌）」的额度，不是账户余额；
   * 令牌设了额度上限时，账户有钱也会报 quota 不足。接口不存在时返回 null。
   */
  private async keyQuota(base: string, apiKey: string): Promise<string | null> {
    try {
      const headers = { Authorization: `Bearer ${apiKey}` };
      const signal = AbortSignal.timeout(10_000);
      const [subRes, usageRes] = await Promise.all([
        httpFetch('查询 NewAPI 令牌额度', `${base}/dashboard/billing/subscription`, { headers, signal }),
        httpFetch('查询 NewAPI 令牌用量', `${base}/dashboard/billing/usage`, { headers, signal }),
      ]);
      if (!subRes.ok) return null;
      const sub = (await subRes.json().catch(() => null)) as { hard_limit_usd?: number } | null;
      const usage = usageRes.ok ? ((await usageRes.json().catch(() => null)) as { total_usage?: number } | null) : null;
      const limit = sub?.hard_limit_usd;
      if (typeof limit !== 'number') return null;
      if (limit >= 100_000_000) return '这个 Key 是无限额度';
      const usedUsd = typeof usage?.total_usage === 'number' ? usage.total_usage / 100 : null;
      return usedUsd === null
        ? `这个 Key 的额度上限 $${limit.toFixed(2)}`
        : `这个 Key 剩余约 $${Math.max(0, limit - usedUsd).toFixed(2)}（上限 $${limit.toFixed(2)}）`;
    } catch {
      return null;
    }
  }
}

/** 中转站的报错多是英文原文；余额不足时补一句中文说明 */
export function newApiErrorMessage(message: string | undefined, status: number): string {
  if (!message) return `NewAPI 返回 HTTP ${status}`;
  const quota = /quota|insufficient|balance|credit|余额|额度/i.test(message);
  return quota
    ? `NewAPI：额度不足。若账户有余额，多半是这个 Key（令牌）设了额度上限——到站点「令牌」页把它改成无限额度或调高（${message}）`
    : `NewAPI：${message}`;
}

function mapDalleQuality(quality: Quality): 'standard' | 'hd' {
  return quality === 'high' || quality === 'xhigh' ? 'hd' : 'standard';
}

/** 本地模拟：不联网、不花钱，延迟 1–2.5 秒后返回基于输入图变换的结果，用于开发和自动验收 */
export class MockProvider implements ImageProvider {
  readonly id = 'mock' as const;

  constructor(private readonly worker: ImageWorkerClient) {}

  async generate(request: GenerationRequest, _model: string, signal: AbortSignal): Promise<ProviderResult> {
    await abortableDelay(1000 + Math.random() * 1500, signal);
    const size = request.size ?? request.firstInputSize ?? { width: 1024, height: 1024 };
    const result = await this.worker.request<MockGenerateResult>({
      type: 'mockGenerate',
      inputs: request.inputs.map((input) => join(request.projectDir, input.file)),
      prompt: request.prompt,
      width: Math.min(2048, size.width),
      height: Math.min(2048, Math.round((Math.min(2048, size.width) / size.width) * size.height)),
      count: request.settings.count,
      seed: hash(request.jobId),
    });
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    return { images: result.images, costUsd: 0 };
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('已取消', 'AbortError'));
      },
      { once: true },
    );
  });
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}
