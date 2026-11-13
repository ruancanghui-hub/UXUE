import type { ImportSource } from '../../../shared/api';
import { formatUsd } from '../../../shared/generation';
import { isImageCard, isPromptCard, isThemeCard, type ImageCard } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { updatePrompt } from '../document/operations';
import type { AssistantSession } from './AssistantSession';
import type { GenerationTracker } from './GenerationTracker';
import { wait, waitForJobs } from './m2Check';
import type { ProjectSession } from './ProjectSession';

interface CheckContext {
  engine: CanvasEngine;
  session: ProjectSession;
  tracker: GenerationTracker;
  assistant: AssistantSession;
  importInto(sources: ImportSource[], at?: { x: number; y: number }): Promise<void>;
}

/**
 * 真实调用自检：按用户设置用 OpenAI 跑一次助手（生成主题卡）和一张最便宜的生图
 * （低质量、1024 方图、1 张），报告结果、耗时和实际花费。预计 1–3 美分。
 */
export async function runRealCheck({ engine, session, tracker, assistant, importInto }: CheckContext): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const timings: Record<string, number | string> = {};
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
    console.log(`[real-check] ${ok ? '通过' : '失败'} ${name}${detail ? `：${detail}` : ''}`);
  };
  const finish = async (): Promise<void> => {
    const report = { phase: 'write', createdAt: new Date().toISOString(), passed: checks.every((c) => c.ok), checks, timings };
    await window.anye.writeCheckFile('report-write.json', JSON.stringify(report, null, 2));
    await wait(800);
  };

  const config = await window.anye.getGenerationConfig();
  check('设置里选的是 OpenAI 并且填了 API Key', config.provider === 'openai' && config.hasApiKey, `供应商 ${config.provider}，Key ${config.hasApiKey ? `已保存（…${config.apiKeyHint}）` : '没有'}`);
  if (config.provider !== 'openai' || !config.hasApiKey) return finish();

  try {
    timings.connection = await window.anye.testConnection();
    check('测试连接', true, String(timings.connection));
  } catch (error) {
    check('测试连接', false, error instanceof Error ? error.message : String(error));
    return finish();
  }

  // 助手
  const doc = session.doc;
  const askStart = performance.now();
  const reply = await assistant.send('为「日式寿司点餐」生成一套视觉主题');
  timings.assistantMs = Math.round(performance.now() - askStart);
  timings.assistantModel = config.assistantModel;
  timings.assistantCost = formatUsd(reply.costUsd ?? 0);
  const theme = doc.get().cards.find(isThemeCard);
  check('助手真实调用返回了主题卡', !reply.error && !!theme, reply.text);
  if (theme) {
    check(
      '主题卡内容可用：有关键词、配色和统一规则',
      theme.keywords.length >= 3 && theme.palette.length >= 3 && Object.values(theme.rules).filter(Boolean).length >= 3,
      `关键词 ${theme.keywords.join('、')}；配色 ${theme.palette.map((c) => `${c.role}${c.hex}`).join(' ')}`,
    );
  }

  // 生图
  const manifest = await window.anye.prepareBench(200);
  const square = manifest.images.find((image) => image.width === image.height)!;
  const assets = doc.get().regions.find((r) => r.id === 'assets')!;
  await importInto([{ kind: 'path', path: square.originalPath }], { x: assets.x + 600, y: assets.y + 600 });
  const photo = doc.get().cards.find(isImageCard)!;
  session.selection.set([photo.id]);
  const prompt = engine.createPromptFromSelection();
  doc.apply(
    '编辑提示词',
    updatePrompt(doc.get(), prompt.id, {
      name: '真实生图测试',
      text: '把 {{Image 1}} 转为一个圆润、简化的 3D 图标：保留主体的轮廓和配色，柔和棚拍光，纯色背景，不要文字。',
      settings: { count: 1, quality: 'low', size: '1024x1024' },
    }),
  );
  const genStart = performance.now();
  try {
    const job = await tracker.submit(session, prompt.id);
    await waitForJobs(tracker, [job.update.jobId], 180_000);
    const finished = tracker.list().find((j) => j.update.jobId === job.update.jobId)!;
    timings.generateMs = Math.round(performance.now() - genStart);
    timings.imageModel = finished.update.model;
    timings.imageEstimate = formatUsd(finished.update.estimateUsd);
    timings.imageCost = formatUsd(finished.update.costUsd ?? 0);
    const fresh = doc.get().cards.find((c) => c.id === prompt.id);
    const output = fresh && isPromptCard(fresh) ? doc.get().cards.find((c) => c.id === fresh.outputCardId) : undefined;
    const version = output && isImageCard(output) ? (output as ImageCard).versions[0] : undefined;
    check('真实生图成功，结果进了输出图像卡', !!version, version ? `${version.width} × ${version.height}` : '没有结果');
    check('生图花费按实际用量算出来了', (finished.update.costUsd ?? 0) > 0, `估算 ${timings.imageEstimate}，实际 ${timings.imageCost}`);
    if (output) {
      session.selection.set([output.id]);
      engine.zoomToSelection();
    }
  } catch (error) {
    timings.generateMs = Math.round(performance.now() - genStart);
    check('真实生图成功，结果进了输出图像卡', false, error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
  }

  await engine.whenAllL0Settled();
  await wait(1500);
  return finish();
}
