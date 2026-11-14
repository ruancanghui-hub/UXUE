import { join } from 'node:path';
import { costFromUsage, SILICONFLOW_MAX_INPUTS, type GenerationRequest, type ImageUsage, type ProviderId } from '../../shared/generation';
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
