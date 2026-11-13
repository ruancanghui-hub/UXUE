import {
  renderPrompt,
  resolveSize,
  validatePrompt,
  type GenerationRequest,
  type JobUpdate,
  type PromptSettings,
} from '../../../shared/generation';
import {
  currentVersion,
  isImageCard,
  isPromptCard,
  isThemeCard,
  themeSuffix,
  type ImageCard,
  type ThemeCard,
  type Version,
} from '../../../shared/project';
import type { PromptJobView } from '../canvas/PromptNode';
import { applyGenerationResult, outputPlacement, setCurrentVersion, type DocState } from '../document/operations';
import type { ProjectSession } from './ProjectSession';

export interface TrackedJob {
  update: JobUpdate;
  projectDir: string;
  promptCardId: string;
  outputCardId: string;
  promptName: string;
  prompt: string;
  inputVersionIds: string[];
  /** 附加了规则的生效主题卡 */
  themeCardId: string | null;
  settings: PromptSettings;
  size: { width: number; height: number };
  submittedAt: number;
}

const KEEP_FINISHED = 30;
/** 失败状态在提示词卡上保留一段时间再消失 */
const FAILED_VISIBLE_MS = 15_000;

/** 渲染进程这一侧的生成任务：提交、跟踪状态、把结果永久写进文档 */
export class GenerationTracker {
  private readonly jobs = new Map<string, TrackedJob>();
  /** 同一张提示词卡还没有输出图时，并发的几个任务要写进同一张新图像卡 */
  private readonly reservedOutputs = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly failureListeners = new Set<(job: TrackedJob) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly getSession: () => ProjectSession | null) {
    this.unsubscribe = window.anye.onGenerationUpdate((update) => this.onUpdate(update));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (job: TrackedJob) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  list(): TrackedJob[] {
    return [...this.jobs.values()].sort((a, b) => b.submittedAt - a.submittedAt);
  }

  hasActive(): boolean {
    return [...this.jobs.values()].some((job) => job.update.status === 'queued' || job.update.status === 'running');
  }

  /** 提交前的检查，返回出错原因；没问题返回 null */
  check(session: ProjectSession, promptCardId: string): string | null {
    const state = session.doc.get();
    const prompt = state.cards.find((card) => card.id === promptCardId);
    if (!prompt || !isPromptCard(prompt)) return '找不到这张提示词卡';
    const inputs = prompt.inputs.map((id) => state.cards.find((card) => card.id === id)).filter((c): c is ImageCard => !!c && isImageCard(c));
    const missing = inputs.find((card) => session.missingVersionIds.has(card.currentVersionId));
    if (missing) return `输入图「${missing.name}」的原图文件不见了`;
    return validatePrompt(prompt.text, inputs.length);
  }

  async submit(session: ProjectSession, promptCardId: string): Promise<TrackedJob> {
    const problem = this.check(session, promptCardId);
    if (problem) throw new Error(problem);
    const state = session.doc.get();
    const prompt = state.cards.find((card) => card.id === promptCardId);
    if (!prompt || !isPromptCard(prompt)) throw new Error('找不到这张提示词卡');

    const inputs = prompt.inputs
      .map((id) => state.cards.find((card) => card.id === id))
      .filter((card): card is ImageCard => !!card && isImageCard(card))
      .map(currentVersion);
    const existingOutput = prompt.outputCardId && state.cards.some((card) => card.id === prompt.outputCardId);
    let outputCardId = existingOutput ? prompt.outputCardId! : this.reservedOutputs.get(promptCardId);
    if (!outputCardId) {
      outputCardId = crypto.randomUUID();
      this.reservedOutputs.set(promptCardId, outputCardId);
    }

    const theme = prompt.settings.useTheme ? activeTheme(state) : null;
    const rendered = renderPrompt(prompt.text).text + (theme ? `\n\n${themeSuffix(theme)}` : '');
    const size = resolveSize(prompt.settings.size, inputs[0] ?? null);
    const request: GenerationRequest = {
      jobId: crypto.randomUUID(),
      projectDir: session.dir,
      promptCardId,
      outputCardId,
      prompt: rendered,
      inputs: inputs.map((version) => ({ versionId: version.id, file: version.file })),
      settings: { ...prompt.settings },
      size,
    };
    const job: TrackedJob = {
      update: { jobId: request.jobId, status: 'queued', provider: 'openai', model: '', estimateUsd: 0 },
      projectDir: session.dir,
      promptCardId,
      outputCardId,
      promptName: prompt.name,
      prompt: rendered,
      inputVersionIds: inputs.map((version) => version.id),
      themeCardId: theme?.id ?? null,
      settings: request.settings,
      size,
      submittedAt: Date.now(),
    };
    this.jobs.set(request.jobId, job);
    this.emit();
    try {
      job.update = { ...(await window.anye.submitGeneration(request)), ...(job.update.status !== 'queued' ? job.update : {}) };
    } catch (error) {
      this.jobs.delete(request.jobId);
      this.emit();
      throw error;
    }
    this.emit();
    return job;
  }

  cancel(jobId: string): void {
    window.anye.cancelGeneration(jobId);
  }

  /** 换项目时取消还没完成的任务，结果不会写进新项目 */
  cancelAll(): void {
    window.anye.cancelAllGenerations();
  }

  dismiss(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && job.update.status !== 'queued' && job.update.status !== 'running') {
      this.jobs.delete(jobId);
      this.emit();
    }
  }

  /** 每张提示词卡最近一个任务的状态，给画布显示用 */
  views(): Map<string, PromptJobView> {
    const views = new Map<string, PromptJobView>();
    const now = Date.now();
    for (const job of [...this.jobs.values()].sort((a, b) => a.submittedAt - b.submittedAt)) {
      const { status } = job.update;
      const aspect = job.size.width / job.size.height;
      if (status === 'queued') views.set(job.promptCardId, { status: 'queued', startedAt: job.submittedAt, aspect });
      else if (status === 'running') views.set(job.promptCardId, { status: 'running', startedAt: job.update.startedAt ?? job.submittedAt, aspect });
      else if (status === 'failed' && now - (job.update.finishedAt ?? now) < FAILED_VISIBLE_MS) {
        views.set(job.promptCardId, { status: 'failed', error: job.update.error ?? '未知错误' });
      } else if (!views.has(job.promptCardId) || status === 'succeeded') {
        views.set(job.promptCardId, null);
      }
    }
    return views;
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.failureListeners.clear();
  }

  private onUpdate(update: JobUpdate): void {
    const job = this.jobs.get(update.jobId);
    if (!job) return;
    job.update = update;
    if (update.status === 'succeeded') this.applyResult(job);
    if (update.status === 'failed') for (const listener of this.failureListeners) listener(job);
    if (update.status !== 'queued' && update.status !== 'running') {
      if (!this.hasPendingFor(job.promptCardId)) this.reservedOutputs.delete(job.promptCardId);
      this.trimFinished();
    }
    this.emit();
  }

  /** 生成结果不进撤销栈并写进所有历史快照：撤销只会把当前版本切回去，花钱得到的版本不会丢 */
  private applyResult(job: TrackedJob): void {
    const session = this.getSession();
    if (!session || session.dir !== job.projectDir || !job.update.versions?.length) return;
    const createdAt = new Date().toISOString();
    const share = (job.update.costUsd ?? 0) / job.update.versions.length;
    const versions: Version[] = job.update.versions.map((info) => ({
      id: info.id,
      file: info.file,
      width: info.width,
      height: info.height,
      createdAt,
      origin: 'generate',
      generation: {
        promptCardId: job.promptCardId,
        prompt: job.prompt,
        inputVersionIds: job.inputVersionIds,
        provider: job.update.provider,
        model: job.update.model,
        quality: job.settings.quality,
        size: `${job.size.width}x${job.size.height}`,
        costUsd: share,
        jobId: job.update.jobId,
        themeCardId: job.themeCardId,
      },
    }));

    const state = session.doc.get();
    const prompt = state.cards.find((card) => card.id === job.promptCardId);
    const first = versions[0];
    const placement =
      prompt && isPromptCard(prompt)
        ? outputPlacement(state, prompt, first.width / first.height)
        : { x: 0, y: 0, width: 400, height: (400 * first.height) / first.width };
    const result = { promptCardId: job.promptCardId, outputCardId: job.outputCardId, versions, placement };
    session.doc.applyPermanent(
      (s) => applyGenerationResult(s, result),
      (s) => setCurrentVersion(s, job.outputCardId, versions[versions.length - 1].id),
    );
  }

  private hasPendingFor(promptCardId: string): boolean {
    return [...this.jobs.values()].some(
      (job) => job.promptCardId === promptCardId && (job.update.status === 'queued' || job.update.status === 'running'),
    );
  }

  private trimFinished(): void {
    const finished = this.list().filter((job) => job.update.status !== 'queued' && job.update.status !== 'running');
    for (const job of finished.slice(KEEP_FINISHED)) this.jobs.delete(job.update.jobId);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 当前生效的主题卡 */
export function activeTheme(state: DocState): ThemeCard | null {
  const card = state.cards.find((c) => c.id === state.activeThemeCardId);
  return card && isThemeCard(card) ? card : null;
}
