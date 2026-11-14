import type { ImportSource } from '../../../shared/api';
import { formatCost, formatUsd } from '../../../shared/generation';
import { isImageCard, isPromptCard, isThemeCard, type ImageCard, type PageCard } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { pageBlocks, updatePrompt } from '../document/operations';
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
  createPage(sources: ImportSource[] | null): Promise<PageCard | null>;
}

/**
 * 真实调用自检：按用户设置用 OpenAI 跑一次助手（生成主题卡）和一张最便宜的生图
 * （低质量、1024 方图、1 张），报告结果、耗时和实际花费。预计 1–3 美分。
 */
export async function runRealCheck({ engine, session, tracker, assistant, importInto, createPage }: CheckContext): Promise<void> {
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
  const only = window.anye.flags.realCheck;
  const doc = session.doc;
  if (only === 'blocks') {
    await checkBlocks();
    return finish();
  }
  if (only === 'assistant') {
    if (config.hasApiKey) await checkAssistant();
    else check('助手需要 OpenAI Key', false);
    return finish();
  }
  const imageProvider = config.provider;
  const imageKey = imageProvider === 'siliconflow' ? config.hasSiliconflowKey : imageProvider === 'openai' ? config.hasApiKey : false;
  check('生图供应商是真实服务并且填了 Key', imageKey, `生图供应商 ${imageProvider}`);
  if (!imageKey || imageProvider === 'mock') return finish();
  try {
    timings.imageConnection = await window.anye.testConnection(imageProvider);
    check('生图供应商测试连接', true, String(timings.imageConnection));
  } catch (error) {
    check('生图供应商测试连接', false, error instanceof Error ? error.message : String(error));
    return finish();
  }

  if (only === 'all' && config.assistantProvider === 'openai' && config.hasApiKey) await checkAssistant();
  else if (only === 'all') timings.assistant = '助手设成了本地模拟或没有 OpenAI Key，跳过';

  /** 用真实助手拆解 --check-image 指定的图，报告每个区块相对页面的位置（0–1000） */
  async function checkBlocks(): Promise<void> {
    const path = window.anye.flags.checkImage;
    check('指定了要拆解的图（--check-image=…）', !!path);
    if (!path) return;
    const page = await createPage([{ kind: 'path', path }]);
    check('建出页面框', !!page?.base);
    if (!page) return;
    const started = performance.now();
    const reply = await assistant.decomposePage(page.id);
    timings.decomposeMs = Math.round(performance.now() - started);
    timings.assistant = `${config.assistantProvider} · ${config.assistantProvider === 'newapi' ? config.newapiAssistantModel : config.assistantModel}`;
    const blocks = pageBlocks(doc.get(), page.id);
    check('助手返回了区块', !reply.error && blocks.length > 0, reply.text);
    for (const block of blocks) {
      const r = (v: number, total: number): number => Math.round((v / total) * 1000);
      timings[block.name] = `${block.blockType} x${r(block.x - page.x, page.width)} y${r(block.y - page.y, page.height)} w${r(block.width, page.width)} h${r(block.height, page.height)}`;
    }
    const spreadX = Math.max(...blocks.map((b) => b.x + b.width)) - Math.min(...blocks.map((b) => b.x));
    const spreadY = Math.max(...blocks.map((b) => b.y + b.height)) - Math.min(...blocks.map((b) => b.y));
    check('区块铺开在整页上，没有挤在一角', spreadX > page.width * 0.6 && spreadY > page.height * 0.6, `横向 ${Math.round((spreadX / page.width) * 100)}%，纵向 ${Math.round((spreadY / page.height) * 100)}%`);
    session.selection.set([page.id]);
    const zoom = Math.min((engine.viewport.screenWidth - 80) / page.width, (engine.viewport.screenHeight - 80) / page.height);
    engine.viewport.zoom = zoom;
    engine.viewport.centerOn(page.x + page.width / 2, page.y + page.height / 2);
    engine.invalidateView();
    await wait(1500);
  }

  async function checkAssistant(): Promise<void> {
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
    timings.imageEstimate = formatCost(finished.update.estimateUsd, finished.update.currency);
    timings.imageCost = formatCost(finished.update.costUsd ?? 0, finished.update.currency);
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
