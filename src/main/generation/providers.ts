import { join } from 'node:path';
import { costFromUsage, type GenerationRequest, type ImageUsage, type ProviderId } from '../../shared/generation';
import type { MockGenerateResult, PreparedInput } from '../../shared/workerProtocol';
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
      size: `${request.size.width}x${request.size.height}`,
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
    const response = await fetch(OPENAI_BASE + endpoint, {
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
    const response = await fetch(`${OPENAI_BASE}/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return `连接正常，可以使用 ${model}`;
    const json = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
  }
}

/** 本地模拟：不联网、不花钱，延迟 1–2.5 秒后返回基于输入图变换的结果，用于开发和自动验收 */
export class MockProvider implements ImageProvider {
  readonly id = 'mock' as const;

  constructor(private readonly worker: ImageWorkerClient) {}

  async generate(request: GenerationRequest, _model: string, signal: AbortSignal): Promise<ProviderResult> {
    await abortableDelay(1000 + Math.random() * 1500, signal);
    const result = await this.worker.request<MockGenerateResult>({
      type: 'mockGenerate',
      inputs: request.inputs.map((input) => join(request.projectDir, input.file)),
      prompt: request.prompt,
      width: request.size.width,
      height: request.size.height,
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
