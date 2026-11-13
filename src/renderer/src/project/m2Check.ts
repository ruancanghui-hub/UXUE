import type { CheckPhase, ImportSource } from '../../../shared/api';
import type { FrameSummary } from '../../../shared/bench';
import { isImageCard, isPromptCard, type ImageCard, type PromptCard } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { unionRects } from '../canvas/geometry';
import { updatePrompt, type DocState } from '../document/operations';
import type { GenerationTracker } from './GenerationTracker';
import type { ProjectSession } from './ProjectSession';

interface CheckContext {
  engine: CanvasEngine;
  session: ProjectSession;
  tracker: GenerationTracker;
  importInto(sources: ImportSource[], at?: { x: number; y: number }): Promise<void>;
}

type Check = (name: string, ok: boolean, detail?: string) => void;

const BACKGROUND_IMAGES = 60;
const EXPECTED_FILE = 'expected.json';
const STEP1 = '把 {{Image 1}} 转为简笔画手绘：粗而略不规则的黑色线条、平涂色块、圆润稚拙的造型';
const STEP2 = '把 {{Image 1}} 插图转为 3D：圆润、简化的 3D 图标风格，柔和均匀的棚拍光，不保留黑色描边';
const BUDGET_120_MS = 1000 / 120;

/**
 * M2 验收（本地模拟供应商）：
 * 'write' 画布上先放 60 张图增加负担，然后跑"照片 → 简笔画 → 3D"两步链路（第二步并发两个任务），
 *  生成全程让画布持续平移并记录帧耗时；再检查撤销不会丢掉生成的版本，保存退出。
 * 'verify' 重新打开，核对链路、版本栈和生成记录都在。
 */
export async function runM2Check(phase: CheckPhase, ctx: CheckContext): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const timings: Record<string, number> = {};
  const check: Check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`[m2-check] ${ok ? '通过' : '失败'} ${name}${detail ? `：${detail}` : ''}`);
  };

  if (phase === 'write') await writePhase(ctx, check, timings);
  else await verifyPhase(ctx, check, timings);

  const report = { phase, createdAt: new Date().toISOString(), passed: checks.every((c) => c.ok), checks, timings };
  await window.anye.writeCheckFile(`report-${phase}.json`, JSON.stringify(report, null, 2));
  await wait(600);
}

async function writePhase({ engine, session, tracker, importInto }: CheckContext, check: Check, timings: Record<string, number>): Promise<void> {
  const doc = session.doc;
  const manifest = await window.anye.prepareBench(200);
  const sources: ImportSource[] = manifest.images.map((image) => ({ kind: 'path', path: image.originalPath }));
  const theme = doc.get().regions.find((r) => r.id === 'theme')!;
  const assets = doc.get().regions.find((r) => r.id === 'assets')!;

  await importInto(sources.slice(1, 1 + BACKGROUND_IMAGES), { x: theme.x + theme.width / 2, y: theme.y + theme.height / 2 });
  await importInto(sources.slice(0, 1), { x: assets.x + 900, y: assets.y + assets.height / 2 });
  const photo = doc.get().cards.filter(isImageCard).find((card) => card.x > assets.x)!;
  check('准备画布：60 张背景图 + 1 张照片', doc.get().cards.length === BACKGROUND_IMAGES + 1);
  await engine.whenAllL0Settled();

  // 第一步：照片 → 简笔画
  session.selection.set([photo.id]);
  const prompt1 = engine.createPromptFromSelection();
  doc.apply('编辑提示词', updatePrompt(doc.get(), prompt1.id, { name: '转简笔画', text: STEP1 }));
  check('选中照片按 P 新建的提示词卡自动绑定了它', findPrompt(doc.get(), prompt1.id)?.inputs[0] === photo.id);

  const stopPanning = startPanning(engine);
  engine.perf.startRecording();
  const generateStart = performance.now();

  const job1 = await tracker.submit(session, prompt1.id);
  await waitForJobs(tracker, [job1.update.jobId]);
  const out1 = outputOf(doc.get(), prompt1.id);
  check('第一步生成出 2 个版本的输出图像卡', out1?.versions.length === 2, `版本数 ${out1?.versions.length ?? 0}`);
  check(
    '版本带生成记录（提示词、输入版本、模型）',
    !!out1 && out1.versions.every((v) => v.origin === 'generate' && v.generation?.inputVersionIds[0] === photo.currentVersionId && v.generation.prompt.includes('Image 1')),
  );

  // 第二步：简笔画 → 3D，同一张提示词卡并发两个任务，结果都应进入同一张输出图像卡
  session.selection.set([out1!.id]);
  const prompt2 = engine.createPromptFromSelection();
  doc.apply('编辑提示词', updatePrompt(doc.get(), prompt2.id, { name: '转 3D', text: STEP2 }));
  const [job2, job3] = await Promise.all([tracker.submit(session, prompt2.id), tracker.submit(session, prompt2.id)]);
  await waitForJobs(tracker, [job2.update.jobId, job3.update.jobId]);
  timings.generateChainMs = Math.round(performance.now() - generateStart);

  const perf = engine.perf.stopRecording();
  stopPanning();
  const out2 = outputOf(doc.get(), prompt2.id);
  check('第二步两个并发任务写进同一张输出图像卡', out2?.versions.length === 4, `版本数 ${out2?.versions.length ?? 0}`);
  check('当前版本是最新生成的那张', !!out2 && out2.currentVersionId === out2.versions[out2.versions.length - 1].id);
  check('输出图像卡在提示词卡右侧', !!out2 && out2.x > findPrompt(doc.get(), prompt2.id)!.x);
  reportPerf(check, perf, timings);

  // 撤销到底：提示词卡、照片都会被撤掉，但花钱得到的版本必须还在
  const before = snapshot(doc.get());
  let undoSteps = 0;
  while (doc.canUndo()) {
    doc.undo();
    undoSteps++;
  }
  const afterUndo = doc.get();
  const keptOut1 = afterUndo.cards.find((c) => c.id === out1!.id);
  const keptOut2 = afterUndo.cards.find((c) => c.id === out2!.id);
  check(
    `撤销 ${undoSteps} 步后生成的版本都还在`,
    !!keptOut1 && isImageCard(keptOut1) && keptOut1.versions.length === 2 && !!keptOut2 && isImageCard(keptOut2) && keptOut2.versions.length === 4,
  );
  while (doc.canRedo()) doc.redo();
  check('全部重做后回到撤销前的样子', snapshot(doc.get()) === before);

  engine.fitAll(false);
  await wait(1000);
  await session.flush();
  await window.anye.writeCheckFile(EXPECTED_FILE, stableStringify(session.toProjectFile()));
}

async function verifyPhase({ engine, session }: CheckContext, check: Check, timings: Record<string, number>): Promise<void> {
  const expected = await window.anye.readCheckFile(EXPECTED_FILE);
  check('找到上一次退出前的状态', expected !== null);
  if (!expected) return;
  check('重新打开后状态完全一致', stableStringify(session.toProjectFile()) === expected);

  const state = session.doc.get();
  const prompts = state.cards.filter(isPromptCard);
  const [first, second] = [prompts.find((p) => p.name === '转简笔画'), prompts.find((p) => p.name === '转 3D')];
  const out1 = first ? outputOf(state, first.id) : undefined;
  const out2 = second ? outputOf(state, second.id) : undefined;
  check('链路完整：照片 → 转简笔画 → 结果 → 转 3D → 结果', !!out1 && !!out2 && second?.inputs[0] === out1.id && !!first?.inputs[0]);
  check(
    '生成记录保存下来了',
    !!out2 && out2.versions.every((v) => v.generation?.promptCardId === second!.id && v.generation.provider === 'mock'),
  );

  timings.allL0SettledMs = await engine.whenAllL0Settled();
  check('全部缩略图可用', engine.textures.failedCount() === 0, `失败 ${engine.textures.failedCount()} 张`);

  const chain = [first, out1, second, out2].filter((card): card is PromptCard | ImageCard => !!card);
  const bounds = unionRects(chain);
  if (bounds) {
    engine.viewport.zoom = Math.min((engine.viewport.screenWidth - 160) / bounds.width, (engine.viewport.screenHeight - 160) / bounds.height);
    engine.viewport.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    engine.invalidateView();
  }
  if (second) session.selection.set([second.id]);
  await wait(1200);
}

function reportPerf(check: Check, perf: FrameSummary | null, timings: Record<string, number>): void {
  if (!perf) {
    check('生成过程中画布持续渲染', false, '没有记录到帧');
    return;
  }
  timings.framesDuringGeneration = perf.frames;
  timings.worstFrameCpuMs = perf.cpuMax;
  timings.over20msFrames = perf.over60Count;
  check('生成过程中最慢一帧 CPU ≤ 8.33ms', perf.cpuMax <= BUDGET_120_MS, `最慢 ${perf.cpuMax}ms，p95 ${perf.cpuP95}ms，共 ${perf.frames} 帧`);
  check('生成过程中超过 20ms 的帧少于 1%', perf.over60Count / perf.frames < 0.01, `${perf.over60Count} / ${perf.frames}`);
}

/** 生成期间让画布在两个区域之间来回平移，模拟用户一边等一边浏览 */
function startPanning(engine: CanvasEngine): () => void {
  const start = performance.now();
  const doc = engine.getDoc();
  const bounds = unionRects([...doc.get().regions.slice(0, 2)])!;
  engine.viewport.zoom = Math.min(engine.viewport.screenWidth / (bounds.width * 0.5), 0.3);
  return engine.addFrameHook((now) => {
    const t = (now - start) / 4000;
    engine.viewport.centerOn(bounds.x + bounds.width * (0.5 + 0.35 * Math.sin(t * Math.PI * 2)), bounds.y + bounds.height / 2);
    engine.invalidateView();
  });
}

export async function waitForJobs(tracker: GenerationTracker, jobIds: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const pending = tracker.list().filter((job) => jobIds.includes(job.update.jobId) && (job.update.status === 'queued' || job.update.status === 'running'));
    if (pending.length === 0) {
      const failed = tracker.list().find((job) => jobIds.includes(job.update.jobId) && job.update.status !== 'succeeded');
      if (failed) throw new Error(`任务 ${failed.update.jobId} ${failed.update.status}：${failed.update.error ?? ''}`);
      return;
    }
    await wait(100);
  }
  throw new Error('等待生成任务超时');
}

function findPrompt(state: DocState, id: string): PromptCard | undefined {
  const card = state.cards.find((c) => c.id === id);
  return card && isPromptCard(card) ? card : undefined;
}

function outputOf(state: DocState, promptId: string): ImageCard | undefined {
  const prompt = findPrompt(state, promptId);
  const card = prompt?.outputCardId ? state.cards.find((c) => c.id === prompt.outputCardId) : undefined;
  return card && isImageCard(card) ? card : undefined;
}

function snapshot(state: DocState): string {
  return stableStringify({ cards: state.cards, regions: state.regions });
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
