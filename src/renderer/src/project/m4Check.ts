import type { CheckPhase, ImportSource } from '../../../shared/api';
import type { ExportResult } from '../../../shared/export';
import { isImageCard, isPageCard, isPromptCard, isRefCard, type ImageCard, type PageCard } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { placeIntoPage, renameCard, updatePrompt } from '../document/operations';
import type { RightTab } from '../ProjectApp';
import type { AssistantSession } from './AssistantSession';
import type { GenerationTracker } from './GenerationTracker';
import { stableStringify, wait, waitForJobs } from './m2Check';
import type { ProjectSession } from './ProjectSession';

interface CheckContext {
  engine: CanvasEngine;
  session: ProjectSession;
  tracker: GenerationTracker;
  assistant: AssistantSession;
  setRightTab(tab: RightTab): void;
  importInto(sources: ImportSource[], at?: { x: number; y: number }): Promise<void>;
  createPage(sources: ImportSource[] | null): Promise<PageCard | null>;
  exportPage(pageId: string): Promise<ExportResult | null>;
}

type Check = (name: string, ok: boolean, detail?: string) => void;

const ICONS = ['热门寿司', '今日上新', '店长推荐', '全部菜单'];
const EXPECTED_FILE = 'expected.json';
/** 低保真线框（1179 × 2556）里 Banner 区和四个金刚位圆的位置，见 sampleLowFi */
const LOWFI = { width: 1179, banner: { x: 72, y: 300, width: 1035, height: 520 }, iconY: 1060, iconR: 110, iconX: (i: number) => 160 + i * 286 };

/**
 * M4 验收：完整跑一遍 PLAN 第 2 节的寿司首页用例（本地模拟助手 + 本地模拟生成）。
 * 主题卡 → Banner 生成 → 四个金刚位提示词与生成 → 导入低保真原型建页面框 → 把素材放进页面 →
 * 换一个金刚位的版本，页面里的引用跟着变 → 导出 PNG / 分层 SVG / 素材包；重启后再导出一次。
 */
export async function runM4Check(phase: CheckPhase, ctx: CheckContext): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const timings: Record<string, number> = {};
  const check: Check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`[m4-check] ${ok ? '通过' : '失败'} ${name}${detail ? `：${detail}` : ''}`);
  };
  const started = performance.now();
  if (phase === 'write') await writePhase(ctx, check);
  else await verifyPhase(ctx, check);
  timings.totalMs = Math.round(performance.now() - started);
  const report = { phase, createdAt: new Date().toISOString(), passed: checks.every((c) => c.ok), checks, timings };
  await window.anye.writeCheckFile(`report-${phase}.json`, JSON.stringify(report, null, 2));
  await wait(600);
}

async function writePhase(ctx: CheckContext, check: Check): Promise<void> {
  const { engine, session, tracker, assistant, importInto, createPage, exportPage } = ctx;
  const doc = session.doc;
  const images = () => doc.get().cards.filter(isImageCard);

  // 1. 视觉主题
  await assistant.send('为「日式寿司点餐」生成一套视觉主题');
  check('主题卡生成并生效', !!doc.get().activeThemeCardId);

  // 2. 参考图：一张横图做 Banner 参考，四张方图做金刚位
  const manifest = await window.anye.prepareBench(200);
  const wide = manifest.images.find((image) => image.width === 2 * image.height)!;
  const squares = manifest.images.filter((image) => image.width === image.height).slice(0, 4);
  const assets = doc.get().regions.find((r) => r.id === 'assets')!;
  await importInto([{ kind: 'path', path: wide.originalPath }], { x: assets.x + 700, y: assets.y + 600 });
  const bannerRef = images()[0];
  doc.apply('重命名', renameCard(doc.get(), bannerRef.id, 'Banner 参考'));
  await importInto(squares.map((image) => ({ kind: 'path', path: image.originalPath })), { x: assets.x + 700, y: assets.y + 2000 });
  const iconRefs = images().filter((card) => card.id !== bannerRef.id);
  iconRefs.forEach((card, i) => doc.apply('重命名', renameCard(doc.get(), card.id, `${ICONS[i]} 参考`)));
  check('导入 1 张 Banner 参考和 4 张金刚位参考', images().length === 5);

  // 3. Banner
  session.selection.set([bannerRef.id]);
  const bannerPrompt = engine.createPromptFromSelection();
  doc.apply('编辑提示词', updatePrompt(doc.get(), bannerPrompt.id, {
    name: 'Banner',
    text: '把 {{Image 1}} 的布局改成寿司摊 Banner：外围是棚布、灯笼、寿司和木质柜台，中央留出安静的浅黄色空区',
    settings: { count: 1 },
  }));

  // 4. 四个金刚位：助手一次写好，各生成一张
  session.selection.set(iconRefs.map((card) => card.id));
  await assistant.send('给选中的图各写一条金刚位图标提示词：3D 图标风格');
  const iconPrompts = doc.get().cards.filter(isPromptCard).filter((card) => card.id !== bannerPrompt.id);
  for (const prompt of iconPrompts) doc.apply('修改生成参数', updatePrompt(doc.get(), prompt.id, { settings: { count: 1 } }));
  check('助手写好四张金刚位提示词卡', iconPrompts.length === 4);

  const jobs = await Promise.all([bannerPrompt.id, ...iconPrompts.map((p) => p.id)].map((id) => tracker.submit(session, id)));
  await waitForJobs(tracker, jobs.map((job) => job.update.jobId), 90_000);
  const outputOf = (promptId: string): ImageCard | undefined => {
    const prompt = doc.get().cards.find((c) => c.id === promptId);
    const output = prompt && isPromptCard(prompt) ? doc.get().cards.find((c) => c.id === prompt.outputCardId) : undefined;
    return output && isImageCard(output) ? output : undefined;
  };
  const bannerOut = outputOf(bannerPrompt.id)!;
  const iconOuts = iconRefs.map((ref) => {
    const prompt = doc.get().cards.find((c) => isPromptCard(c) && c.inputs[0] === ref.id)!;
    return outputOf(prompt.id)!;
  });
  check('Banner 和四个金刚位都生成好了', !!bannerOut && iconOuts.every(Boolean));
  doc.apply('重命名', renameCard(doc.get(), bannerOut.id, 'Banner'));
  iconOuts.forEach((card, i) => doc.apply('重命名', renameCard(doc.get(), card.id, ICONS[i])));

  // 5. 低保真原型 → 页面框
  const lowFi = await window.anye.sampleLowFi();
  const page = await createPage([{ kind: 'path', path: lowFi }]);
  check('从低保真原型新建页面框，认出 iPhone 3 倍图', !!page && page.devicePreset === 'iphone' && page.exportScale === 3, page ? `${page.devicePreset} @${page.exportScale}x` : '没建出来');
  if (!page) return;

  // 6. 素材放进页面：Banner 盖住线框里的 Banner 区，四个金刚位盖住四个圆
  const s = page.width / LOWFI.width;
  const items = [
    { imageCardId: bannerOut.id, rect: { x: page.x + LOWFI.banner.x * s, y: page.y + LOWFI.banner.y * s, width: LOWFI.banner.width * s, height: LOWFI.banner.width * s * (bannerOut.height / bannerOut.width) } },
    ...iconOuts.map((card, i) => ({
      imageCardId: card.id,
      rect: { x: page.x + (LOWFI.iconX(i) - LOWFI.iconR) * s, y: page.y + (LOWFI.iconY - LOWFI.iconR) * s, width: 2 * LOWFI.iconR * s, height: 2 * LOWFI.iconR * s },
    })),
  ];
  const beforePlace = doc.get();
  doc.apply('放入页面', placeIntoPage(doc.get(), page.id, items, () => crypto.randomUUID()).state);
  const refs = doc.get().cards.filter(isRefCard).filter((ref) => ref.pageId === page.id);
  check('五个素材放进页面，原图像卡留在原处', refs.length === 5 && images().every((card) => beforePlace.cards.find((c) => c.id === card.id)?.x === card.x));
  doc.undo();
  check('撤销一步就拿掉这五个引用', doc.get().cards.filter(isRefCard).length === 0);
  doc.redo();

  // 7. 换版本：给"热门寿司"再生成一张，页面里的引用跟着换
  const firstIcon = iconOuts[0];
  const firstRef = doc.get().cards.filter(isRefCard).find((ref) => ref.imageCardId === firstIcon.id)!;
  const keyBefore = engine.boundKeyFor(firstRef.id);
  const iconPrompt = doc.get().cards.find((c) => isPromptCard(c) && c.outputCardId === firstIcon.id)!;
  const regen = await tracker.submit(session, iconPrompt.id);
  await waitForJobs(tracker, [regen.update.jobId]);
  const updatedIcon = doc.get().cards.find((c) => c.id === firstIcon.id) as ImageCard;
  const keyAfter = engine.boundKeyFor(firstRef.id);
  check(
    '金刚位换了当前版本，页面里的引用跟着显示新版本',
    updatedIcon.versions.length === 2 && keyAfter === updatedIcon.currentVersionId && keyAfter !== keyBefore,
  );

  // 8. 导出
  const result = await exportPage(page.id);
  checkExport(check, result, '');

  engine.zoomToCard(page.id);
  await wait(1200);
  await session.flush();
  await window.anye.writeCheckFile(EXPECTED_FILE, stableStringify(session.toProjectFile()));
}

async function verifyPhase({ engine, session, exportPage, setRightTab }: CheckContext, check: Check): Promise<void> {
  const expected = await window.anye.readCheckFile(EXPECTED_FILE);
  check('找到上一次退出前的状态', expected !== null);
  if (!expected) return;
  check('重新打开后状态完全一致', stableStringify(session.toProjectFile()) === expected);
  const state = session.doc.get();
  const page = state.cards.find(isPageCard);
  check('页面框和五个引用都在', !!page && state.cards.filter((c) => isRefCard(c) && c.pageId === page.id).length === 5);
  await engine.whenAllL0Settled();
  check('全部缩略图可用（含低保真原型）', engine.textures.failedCount() === 0);
  if (!page) return;
  checkExport(check, await exportPage(page.id), '重启后');

  session.selection.set([page.id]);
  setRightTab('inspector');
  const zoom = Math.min((engine.viewport.screenWidth - 80) / page.width, (engine.viewport.screenHeight - 80) / page.height);
  engine.viewport.zoom = zoom;
  engine.viewport.centerOn(page.x + page.width / 2, page.y + page.height / 2);
  engine.invalidateView();
  await wait(1500);
}

function checkExport(check: Check, result: ExportResult | null, prefix: string): void {
  check(`${prefix}导出整页 PNG 1179 × 2556（iPhone 3 倍）`, !!result && result.png.width === 1179 && result.png.height === 2556, result ? `${result.png.width} × ${result.png.height}` : '导出失败');
  check(
    `${prefix}分层 SVG 里五个素材各占一层，层名就是图像卡名字`,
    !!result && ['Banner', ...ICONS].every((name) => result.svg.layers.includes(name)) && result.svg.layers.length === 5,
    result?.svg.layers.join('、'),
  );
  check(`${prefix}素材包每个素材都有 @1x`, !!result && ['Banner', ...ICONS].every((name) => result.files.includes(`assets/${name}@1x.png`)));
}
