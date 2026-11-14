import { randomUUID } from 'node:crypto';
import {
  calibrationKey,
  estimateCostUsd,
  planGeneration,
  type GeneratedVersionInfo,
  type GenerationRequest,
  type JobUpdate,
  type ProviderId,
} from '../../shared/generation';
import type { ImportedImage } from '../../shared/workerProtocol';
import type { ImageWorkerClient } from '../imageWorkerClient';
import { DownloadFailedError, downloadResults, type ImageProvider } from './providers';
import type { GenerationSettingsStore } from './settingsStore';

const CONCURRENCY = 2;

interface Job {
  request: GenerationRequest;
  provider: ImageProvider;
  model: string;
  /** 未校准的粗估，用来和实际花费对比、更新校准系数 */
  rawEstimateUsd: number;
  update: JobUpdate;
  controller: AbortController;
}

/** 生成队列在主进程里：渲染进程关掉面板、切走区域都不影响任务；最多同时跑两个 */
export class GenerationQueue {
  private readonly jobs = new Map<string, Job>();
  /** 生成成功但下载失败的任务，1 小时内可以重新下载 */
  private readonly pendingDownloads = new Map<string, { job: Job; urls: string[]; expiresAt: number }>();
  private readonly waiting: string[] = [];
  private running = 0;

  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly settings: GenerationSettingsStore,
    private readonly providers: Record<ProviderId, ImageProvider>,
    private readonly emit: (update: JobUpdate) => void,
    /** 自检时强制用本地模拟，不读也不改用户设置 */
    private readonly forcedProvider: ProviderId | null,
  ) {}

  submit(request: GenerationRequest): JobUpdate {
    const config = this.settings.config();
    const providerId = this.forcedProvider ?? config.provider;
    const provider = this.providers[providerId];
    const plan = planGeneration({ ...config, provider: providerId }, request.settings, request.firstInputSize, request.inputs.length);
    const rawEstimateUsd = providerId === 'openai' && request.size ? estimateCostUsd(request.settings, request.size) : 0;
    const model = plan.model;
    const update: JobUpdate = {
      jobId: request.jobId,
      status: 'queued',
      provider: providerId,
      model,
      currency: plan.currency,
      estimateUsd: plan.estimate,
    };
    this.jobs.set(request.jobId, { request, provider, model, rawEstimateUsd, update, controller: new AbortController() });
    this.waiting.push(request.jobId);
    this.emit(update);
    this.pump();
    return update;
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.update.status === 'succeeded' || job.update.status === 'failed' || job.update.status === 'canceled') return;
    job.controller.abort();
    const index = this.waiting.indexOf(jobId);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.finish(job, { status: 'canceled' });
    }
  }

  cancelAll(): void {
    for (const jobId of [...this.jobs.keys()]) this.cancel(jobId);
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.waiting.length > 0) {
      const job = this.jobs.get(this.waiting.shift()!);
      if (job) void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    this.running++;
    this.update(job, { status: 'running', startedAt: Date.now() });
    try {
      const result = await job.provider.generate(job.request, job.model, job.controller.signal);
      await this.complete(job, result.images, result.costUsd);
    } catch (error) {
      if (job.controller.signal.aborted) this.finish(job, { status: 'canceled' });
      else if (error instanceof DownloadFailedError) {
        this.pendingDownloads.set(job.request.jobId, { job, urls: error.urls, expiresAt: error.expiresAt });
        this.finish(job, { status: 'failed', error: error.message, retryDownloadUntil: error.expiresAt });
      } else this.finish(job, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running--;
      this.pump();
    }
  }

  /** 重新下载已经生成、计过费的结果 */
  async retryDownload(jobId: string): Promise<void> {
    const pending = this.pendingDownloads.get(jobId);
    if (!pending) throw new Error('这个任务没有可以重新下载的结果');
    if (Date.now() > pending.expiresAt) {
      this.pendingDownloads.delete(jobId);
      throw new Error('结果链接已经过期（超过 1 小时），只能重新生成');
    }
    const { job } = pending;
    this.jobs.set(jobId, job);
    this.update(job, { status: 'running', error: undefined, retryDownloadUntil: undefined });
    try {
      const images = await downloadResults(pending.urls);
      this.pendingDownloads.delete(jobId);
      await this.complete(job, images, null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.finish(job, { status: 'failed', error: `重新下载还是失败：${reason}`, retryDownloadUntil: pending.expiresAt });
    }
  }

  private async complete(job: Job, images: Uint8Array[], reportedCost: number | null): Promise<void> {
    // OpenAI 按返回用量算；硅基流动按张固定计价，实际花费 = 实际张数 × 单价
    const costUsd =
      reportedCost ?? (job.update.provider === 'siliconflow'
        ? (job.update.estimateUsd / Math.max(1, job.request.settings.count)) * images.length
        : job.update.estimateUsd);
    const versions: GeneratedVersionInfo[] = [];
    for (const bytes of images) {
      const id = randomUUID();
      const imported = await this.worker.request<ImportedImage>({
        type: 'importImage',
        dir: job.request.projectDir,
        key: id,
        source: { kind: 'bytes', name: `${id}.png`, bytes },
      });
      versions.push({ id, file: imported.file, width: imported.width, height: imported.height });
    }
    if (reportedCost !== null && job.rawEstimateUsd > 0) {
      await this.settings.recordCalibration(calibrationKey(job.model, job.request.settings.quality), reportedCost / job.rawEstimateUsd);
    }
    this.finish(job, { status: 'succeeded', versions, costUsd });
  }

  private finish(job: Job, patch: Partial<JobUpdate>): void {
    this.update(job, { ...patch, finishedAt: Date.now() });
    this.jobs.delete(job.request.jobId);
  }

  private update(job: Job, patch: Partial<JobUpdate>): void {
    job.update = { ...job.update, ...patch };
    this.emit(job.update);
  }
}
