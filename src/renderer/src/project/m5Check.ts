import type { CheckPhase, ImportSource } from '../../../shared/api';
import type { ExportResult } from '../../../shared/export';
import {
  isBlockCard,
  isBlockCropStale,
  isGroupCard,
  isImageCard,
  isPageCard,
  isPromptCard,
  isRefCard,
  type BlockCard,
  type CanvasCard,
  type ImageCard,
  type PageCard,
  type PromptCard,
} from '../../../shared/project';
import { isImageCardStale } from '../../../shared/stale';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import {
  createBlockAt,
  createSketchText,
  createStroke,
  elementPrompts,
  moveCards,
  pageBlocks,
  setStyleBenchmark,
  sketchMarks,
  updateBlock,
  updatePage,
  updateSketchText,
  wireframeFromPage,
} from '../document/operations';
import type { AssistantSession } from './AssistantSession';
import type { GenerationTracker } from './GenerationTracker';
import { stableStringify, wait, waitForJobs } from './m2Check';
import type { ProjectSession } from './ProjectSession';
import { startSketchWireframe } from './sketch';
import { themeMarkdownFor } from './themeMarkdown';

interface CheckContext {
  engine: CanvasEngine;
  session: ProjectSession;
  tracker: GenerationTracker;
  assistant: AssistantSession;
  createPage(sources: ImportSource[] | null): Promise<PageCard | null>;
  exportPage(pageId: string): Promise<ExportResult | null>;
}

type Check = (name: string, ok: boolean, detail?: string) => void;

const EXPECTED_FILE = 'expected.json';
/** 本地模拟拆解给出的区块数：Banner + 4 金刚位 + 2 瓷片 + 4 底部导航 */
const MOCK_BLOCK_COUNT = 11;

/**
 * M5 验收：页面区块（本地模拟助手 + 本地模拟生成）。
 * 低保真原型建页面框 → 拆解 → 为区块写提示词（真实裁截图）→ 生成三个区块，结果自动放回 →
 * 挪一个区块，截图过时，更新截图后下游已过期 → 重拆保留已出图区块 → 导出；重启后核对。
 */
export async function runM5Check(phase: CheckPhase, ctx: CheckContext): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check: Check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`[m5-check] ${ok ? '通过' : '失败'} ${name}${detail ? `：${detail}` : ''}`);
  };
  const started = performance.now();
  if (phase === 'write') await writePhase(ctx, check);
  else await verifyPhase(ctx, check);
  const report = {
    phase,
    createdAt: new Date().toISOString(),
    passed: checks.every((c) => c.ok),
    checks,
    timings: { totalMs: Math.round(performance.now() - started) },
  };
  await window.anye.writeCheckFile(`report-${phase}.json`, JSON.stringify(report, null, 2));
  await wait(600);
}

async function writePhase({ engine, session, tracker, assistant, createPage, exportPage }: CheckContext, check: Check): Promise<void> {
  const doc = session.doc;
  const blocksOf = (pageId: string): BlockCard[] => pageBlocks(doc.get(), pageId);
  const find = (id: string | null): CanvasCard | undefined => (id ? doc.get().cards.find((c) => c.id === id) : undefined);
  const imageOf = (id: string | null): ImageCard | undefined => {
    const found = find(id);
    return found && isImageCard(found) ? found : undefined;
  };
  const promptOf = (id: string | null): PromptCard | undefined => {
    const found = find(id);
    return found && isPromptCard(found) ? found : undefined;
  };

  // 0. 主题说明：复制到剪贴板、存进 themes/
  await assistant.send('为「日式寿司点餐」生成一套视觉主题');
  const themeId = doc.get().activeThemeCardId;
  const forClip = themeId ? themeMarkdownFor(doc.get(), themeId, session.name, false) : null;
  check('生效主题卡能写成主题说明', !!forClip && forClip.markdown.includes('## 配色') && forClip.markdown.includes('> 使用说明'));
  if (forClip && themeId) {
    await window.anye.copyText(forClip.markdown);
    const saved = await window.anye.saveThemeMarkdown(forClip.name, themeMarkdownFor(doc.get(), themeId, session.name, true)!.markdown);
    check('主题说明存进项目的 themes/', saved.endsWith(`/themes/${forClip.name}.md`), saved);
  }

  // 0b. 素材清单 → 生成两项 → 以第一项结果为风格基准 → 带基准再生成一项
  await assistant.listElements('首页要用的');
  const listed = elementPrompts(doc.get());
  const listGroups = doc.get().cards.filter((c) => c.kind === 'group' && c.name.startsWith('素材清单'));
  check('从主题卡列出素材清单，按类别分组', listed.length >= 8 && listed.length <= 16 && listGroups.length >= 3, `${listed.length} 项、${listGroups.length} 组`);
  const [firstItem, secondItem, thirdItem] = listed;
  const listJobs = await Promise.all([firstItem, secondItem].map((p) => tracker.submit(session, p.id)));
  await waitForJobs(tracker, listJobs.map((job) => job.update.jobId), 60_000);
  const firstOut = promptOf(firstItem.id)?.outputCardId ?? null;
  check('清单项可以直接文生图', !!firstOut && !!promptOf(secondItem.id)?.outputCardId);
  if (firstOut) {
    doc.apply('设为风格基准', setStyleBenchmark(doc.get(), firstOut));
    const bound = elementPrompts(doc.get()).filter((p) => p.outputCardId !== firstOut);
    check('设风格基准后其余清单卡都绑定它做 Image 1', bound.every((p) => p.inputs[0] === firstOut && p.styleRefCardId === firstOut));
    const secondOut = imageOf(promptOf(secondItem.id)?.outputCardId ?? null);
    check('已生成的清单项因为换了参考图标成已过期', !!secondOut && isImageCardStale(secondOut, doc.get()));
    const styled = await tracker.submit(session, thirdItem.id);
    await waitForJobs(tracker, [styled.update.jobId], 60_000);
    const thirdOut = imageOf(promptOf(thirdItem.id)?.outputCardId ?? null);
    check('带风格基准生成一项', !!thirdOut && thirdOut.versions[0].generation?.inputVersionIds.length === 1);
  }

  // 1. 页面框
  const page = await createPage([{ kind: 'path', path: await window.anye.sampleLowFi() }]);
  check('从低保真原型新建页面框', !!page?.base);
  if (!page) return;

  // 2. 拆解
  await assistant.decomposePage(page.id);
  const blocks = blocksOf(page.id);
  check('拆解出区块，类型和组齐全', blocks.length === MOCK_BLOCK_COUNT && blocks.filter((b) => b.group === '金刚位').length === 4, `${blocks.length} 个`);
  check('区块都在页面框里', blocks.every((b) => b.x >= page.x - 1 && b.y >= page.y - 1 && b.x + b.width <= page.x + page.width + 1 && b.y + b.height <= page.y + page.height + 1));
  doc.undo();
  check('撤销一步拿掉全部区块', blocksOf(page.id).length === 0);
  doc.redo();

  // 3. 为区块写提示词：真实裁截图 + 本地模拟助手
  await assistant.writeBlockPrompts(page.id);
  const written = blocksOf(page.id);
  const crops = written.map((b) => imageOf(b.cropCardId));
  check('每个区块都裁出了截图', crops.every(Boolean));
  const base = page.base!;
  const aspectOk = written.every((b, i) => {
    const v = crops[i]?.versions[0];
    if (!v) return false;
    const expected = (b.width / page.width) * base.width / ((b.height / page.height) * base.height);
    return Math.abs(v.width / v.height - expected) < 0.05 * expected;
  });
  check('截图比例和区块一致', aspectOk);
  const group = doc.get().cards.find((c) => isGroupCard(c) && c.name === `${page.name} · 区块`);
  check('截图放进核心素材区的分组框', !!group && crops.every((c) => c?.groupId === group.id));
  const prompts = written.map((b) => promptOf(b.promptCardId));
  check('每个区块一张提示词卡，绑定自己的截图', prompts.every((p, i) => p && p.inputs.length === 1 && p.inputs[0] === crops[i]?.id));
  await engine.whenAllL0Settled();
  check('截图缩略图都能显示', engine.textures.failedCount() === 0);

  // 4. 生成三个区块：Banner 和两个金刚位
  const picked = [written.find((b) => b.blockType === 'hero')!, ...written.filter((b) => b.blockType === 'icon').slice(0, 2)];
  const jobs = await Promise.all(picked.map((b) => tracker.submit(session, b.promptCardId!)));
  await waitForJobs(tracker, jobs.map((job) => job.update.jobId), 90_000);
  const refs = doc.get().cards.filter(isRefCard).filter((ref) => ref.pageId === page.id);
  const placedOk = picked.every((b) => {
    const prompt = promptOf(b.promptCardId);
    const ref = refs.find((r) => r.imageCardId === prompt?.outputCardId);
    return !!ref && Math.abs(ref.x - b.x) < 0.5 && Math.abs(ref.width - b.width) < 0.5 && engine.boundKeyFor(ref.id) !== null;
  });
  check('三个区块出图后自动放回页面里的区块位置', refs.length === 3 && placedOk, `${refs.length} 个引用`);

  // 5. 挪一个已出图的区块 → 截图过时 → 更新截图 → 下游已过期
  const banner = picked[0];
  doc.apply('移动', moveCards(doc.get(), new Map([[banner.id, banner]]), 0, 12));
  const pageNow = find(page.id) as PageCard;
  const moved = blocksOf(page.id).find((b) => b.id === banner.id)!;
  check('区块相对原型挪动后截图过时', isBlockCropStale(moved, pageNow));
  await assistant.refreshBlockCrop(banner.id);
  const refreshed = blocksOf(page.id).find((b) => b.id === banner.id)!;
  const bannerCrop = imageOf(refreshed.cropCardId);
  const bannerPrompt = promptOf(refreshed.promptCardId);
  const bannerOut = imageOf(bannerPrompt?.outputCardId ?? null);
  check('更新截图追加新版本，不再过时', bannerCrop?.versions.length === 2 && !isBlockCropStale(refreshed, pageNow));
  check('Banner 的输出图标成已过期', !!bannerOut && isImageCardStale(bannerOut, doc.get()));

  // 6. 重拆：已出图的三个区块保留
  await assistant.decomposePage(page.id);
  const after = blocksOf(page.id);
  check('重新拆解保留已出图的区块', picked.every((b) => after.some((a) => a.id === b.id)) && after.length === MOCK_BLOCK_COUNT + 3, `${after.length} 个`);
  doc.undo();
  check('撤销重拆，恢复原来的区块', blocksOf(page.id).length === MOCK_BLOCK_COUNT);

  // 7. 导出：区块不进 SVG
  const result = await exportPage(page.id);
  check('导出整页，SVG 只有三个素材层', !!result && result.svg.layers.length === 3, result?.svg.layers.join('、'));

  // 8. 转线框：从页面框发起，出图后自动换底稿
  const baseBefore = (find(page.id) as PageCard).base?.id;
  const started = wireframeFromPage(doc.get(), page.id, () => crypto.randomUUID());
  if (started) doc.apply('转线框', started.state);
  check(
    '从页面框发起转线框：底稿复制成图像卡、建好转线框提示词卡',
    !!started && !!imageOf(started.sourceId) && promptOf(started.promptId)?.purpose === 'wireframe' && !promptOf(started.promptId)?.settings.useTheme,
  );
  if (started) {
    const job = await tracker.submit(session, started.promptId);
    await waitForJobs(tracker, [job.update.jobId], 60_000);
    const wired = find(page.id) as PageCard;
    check('线框出图后自动换成页面框底稿，底稿来源变为借鉴', !!wired.base && wired.base.id !== baseBefore && wired.baseSource === 'borrowed' && !wired.wireframePromptId);
    check('换底稿后区块截图都标成过时', blocksOf(page.id).every((b) => isBlockCropStale(b, wired)));
    await engine.whenAllL0Settled();
    check('换底稿后缩略图可用', engine.textures.failedCount() === 0);
  }

  // 9. 布局草图：空白页面框里画三个区块 → 草图转线框 → 出图后换成底稿
  const blank = await createPage(null);
  check('新建空白页面框', !!blank && !blank.base);
  if (blank) {
    const drafts = [
      { name: 'Banner', rect: { x: 0.05, y: 0.1, width: 0.9, height: 0.22 } },
      { name: '金刚位 ×4', rect: { x: 0.05, y: 0.36, width: 0.9, height: 0.1 } },
      { name: '商品列表', rect: { x: 0.05, y: 0.5, width: 0.9, height: 0.4 } },
    ];
    for (const draft of drafts) {
      const r = draft.rect;
      const created = createBlockAt(doc.get(), blank.id, { x: blank.x + r.x * blank.width, y: blank.y + r.y * blank.height, width: r.width * blank.width, height: r.height * blank.height }, () => crypto.randomUUID());
      if (created) doc.apply('画区块', updateBlock(created.state, created.blockId, { name: draft.name }));
    }
    check('空白页面框里画出三个草图区块', blocksOf(blank.id).length === 3);
    const at = (rx: number, ry: number): [number, number] => [blank.x + rx * blank.width, blank.y + ry * blank.height];
    const strokes = [
      [...at(0.1, 0.93), ...at(0.5, 0.95), ...at(0.9, 0.93)],
      [...at(0.8, 0.03), ...at(0.85, 0.06), ...at(0.9, 0.03)],
    ];
    for (const points of strokes) {
      const created = createStroke(doc.get(), blank.id, points, 2, () => crypto.randomUUID());
      if (created) doc.apply('画草图', created.state);
    }
    const textCreated = createSketchText(doc.get(), blank.id, { x: at(0.05, 0.02)[0], y: at(0.05, 0.02)[1] }, 'md', () => crypto.randomUUID());
    if (textCreated) doc.apply('写草图文字', updateSketchText(textCreated.state, textCreated.textId, { text: '顶部要有城市切换' }));
    check('画了两笔草图笔迹、写了一段草图文字', sketchMarks(doc.get(), blank.id).length === 3);
    const sketchPromptId = await startSketchWireframe(session, blank.id);
    const sketchSource = imageOf(promptOf(sketchPromptId)?.inputs[0] ?? null);
    check('画出布局草图示意图（逻辑尺寸 3 倍）', !!sketchSource && sketchSource.versions[0].width === 1179 && sketchSource.versions[0].height === 2556);
    const sketchJob = await tracker.submit(session, sketchPromptId);
    await waitForJobs(tracker, [sketchJob.update.jobId], 60_000);
    const sketched = find(blank.id) as PageCard;
    check('草图转线框出图后换成页面框底稿，底稿来源是自己的线框', !!sketched.base && sketched.baseSource === 'own' && blocksOf(blank.id).length === 3);
    check('出图后草图自动隐藏，笔迹和文字的数据还在', sketched.sketchHidden && sketchMarks(doc.get(), blank.id).length === 3);
    doc.apply('显示草图', updatePage(doc.get(), blank.id, { sketchHidden: false }));
    const shown = !(find(blank.id) as PageCard).sketchHidden;
    doc.apply('隐藏草图', updatePage(doc.get(), blank.id, { sketchHidden: true }));
    check('「显示草图」开关能打开再关上', shown && (find(blank.id) as PageCard).sketchHidden);
    await engine.whenAllL0Settled();
    check('示意图和线框缩略图可用', engine.textures.failedCount() === 0);
  }

  session.selection.set([page.id]);
  engine.zoomToCard(page.id);
  await wait(1200);
  await session.flush();
  await window.anye.writeCheckFile(EXPECTED_FILE, stableStringify(session.toProjectFile()));
}

async function verifyPhase({ engine, session }: CheckContext, check: Check): Promise<void> {
  const expected = await window.anye.readCheckFile(EXPECTED_FILE);
  check('找到上一次退出前的状态', expected !== null);
  if (!expected) return;
  check('重新打开后状态完全一致', stableStringify(session.toProjectFile()) === expected);
  const state = session.doc.get();
  const page = state.cards.find(isPageCard);
  const firstPageBlocks = page ? state.cards.filter(isBlockCard).filter((b) => b.pageId === page.id) : [];
  check('区块都还在，且都连着截图和提示词卡', firstPageBlocks.length === MOCK_BLOCK_COUNT && firstPageBlocks.every((b) => b.cropCardId && b.promptCardId));
  await engine.whenAllL0Settled();
  check('全部缩略图可用', engine.textures.failedCount() === 0);
  if (!page) return;
  session.selection.set([page.id]);
  const zoom = Math.min((engine.viewport.screenWidth - 80) / page.width, (engine.viewport.screenHeight - 80) / page.height);
  engine.viewport.zoom = zoom;
  engine.viewport.centerOn(page.x + page.width / 2, page.y + page.height / 2);
  engine.invalidateView();
  await wait(1500);
}
