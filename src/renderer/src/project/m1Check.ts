import type { ImportSource } from '../../../shared/api';
import type { RegionId } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { unionRects } from '../canvas/geometry';
import {
  addVersions,
  moveCards,
  renameCard,
  reorderCards,
  scaleCards,
  setCurrentVersion,
  type DocState,
} from '../document/operations';
import type { ProjectSession } from './ProjectSession';

interface CheckContext {
  engine: CanvasEngine;
  session: ProjectSession;
  importInto(sources: ImportSource[], at?: { x: number; y: number }): Promise<void>;
}

interface CheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

const IMPORT_COUNT = 100;
const EXPECTED_FILE = 'expected.json';

/**
 * M1 验收：'write' 导入 100 张图、做一串编辑、逐步撤销到空再全部重做、保存后退出；
 * 'verify' 在新进程里重新打开同一个项目，核对状态和退出前完全一致、纹理全部可用。
 */
export async function runM1Check(phase: 'write' | 'verify', ctx: CheckContext): Promise<void> {
  const checks: CheckItem[] = [];
  const timings: Record<string, number> = {};
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
    console.log(`[m1-check] ${ok ? '通过' : '失败'} ${name}${detail ? `：${detail}` : ''}`);
  };

  if (phase === 'write') await writePhase(ctx, check, timings);
  else await verifyPhase(ctx, check, timings);

  const report = { phase, createdAt: new Date().toISOString(), passed: checks.every((c) => c.ok), checks, timings };
  await window.anye.writeCheckFile(`report-${phase}.json`, JSON.stringify(report, null, 2));
  await wait(600);
}

async function writePhase(
  { engine, session, importInto }: CheckContext,
  check: (name: string, ok: boolean, detail?: string) => void,
  timings: Record<string, number>,
): Promise<void> {
  const doc = session.doc;
  // 和性能测试共用同一批 200 张测试图，避免数量不同导致测试图缓存被重建
  const manifest = await window.anye.prepareBench(200);
  const sources: ImportSource[] = manifest.images
    .slice(0, IMPORT_COUNT + 2)
    .map((image) => ({ kind: 'path', path: image.originalPath }));
  const assets = doc.get().regions.find((r) => r.id === 'assets')!;

  const checkpoints: string[] = [snapshot(doc.get())];
  const importStart = performance.now();
  await importInto(sources.slice(0, IMPORT_COUNT), { x: assets.x + assets.width / 2, y: assets.y + assets.height / 2 });
  timings.import100Ms = Math.round(performance.now() - importStart);
  check('导入 100 张图', doc.get().cards.length === IMPORT_COUNT, `实际 ${doc.get().cards.length} 张，用时 ${timings.import100Ms}ms`);
  checkpoints.push(snapshot(doc.get()));

  engine.fitAll(false);
  timings.allL0SettledMs = await engine.whenAllL0Settled();
  check('全部缩略图可用', engine.textures.failedCount() === 0, `失败 ${engine.textures.failedCount()} 张`);

  const ids = doc.get().cards.map((card) => card.id);
  const pick = (from: number, to: number): Set<string> => new Set(ids.slice(from, to));
  const originsOf = (set: Set<string>) => new Map(doc.get().cards.filter((c) => set.has(c.id)).map((c) => [c.id, c]));
  const step = (name: string, run: () => void | Promise<void>) => async (): Promise<void> => {
    await run();
    checkpoints.push(snapshot(doc.get()));
    stepNames.push(name);
  };
  const stepNames: string[] = ['导入图片'];

  const extra = await window.anye.importImages(sources.slice(IMPORT_COUNT));

  const steps = [
    step('拖动 10 张', () => {
      const origins = originsOf(pick(0, 10));
      doc.beginGesture('移动');
      for (let i = 1; i <= 10; i++) doc.updateGesture(moveCards(doc.get(), origins, i * 30, i * 20));
      doc.commitGesture();
    }),
    step('等比缩放 5 张', () => {
      const origins = originsOf(pick(10, 15));
      const bounds = unionRects(origins.values())!;
      doc.beginGesture('缩放');
      doc.updateGesture(scaleCards(doc.get(), origins, bounds.x, bounds.y, 1.6));
      doc.commitGesture();
    }),
    step('方向键微调', () => {
      session.selection.set(pick(20, 25));
      engine.nudgeSelection(10, 0);
    }),
    step('创建副本', () => {
      session.selection.set(pick(30, 33));
      engine.duplicateSelection();
    }),
    step('重命名', () => doc.apply('重命名', renameCard(doc.get(), ids[40], '金刚位 · 热门寿司'))),
    step('导入为新版本', () => doc.apply('导入新版本', addVersions(doc.get(), ids[50], extra.versions))),
    step('切换当前版本', () => {
      const card = doc.get().cards.find((c) => c.id === ids[50])!;
      doc.apply('切换当前版本', setCurrentVersion(doc.get(), card.id, card.versions[1].id));
    }),
    step('移到最前', () => doc.apply('移到最前', reorderCards(doc.get(), pick(60, 63), 'front'))),
    step('删除 5 张', () => {
      session.selection.set(pick(70, 75));
      engine.deleteSelection();
    }),
    step('移到视觉主题区', () => {
      const theme = doc.get().regions.find((r) => r.id === ('theme' satisfies RegionId))!;
      const origins = originsOf(pick(80, 85));
      const bounds = unionRects(origins.values())!;
      doc.apply(
        '移动',
        moveCards(doc.get(), origins, theme.x + 400 - bounds.x, theme.y + 400 - bounds.y),
      );
    }),
  ];
  for (const run of steps) await run();
  check('额外导入 2 个版本', extra.versions.length === 2, `实际 ${extra.versions.length} 个`);

  let undoOk = true;
  let undoDetail = '';
  for (let i = checkpoints.length - 2; i >= 0; i--) {
    const label = doc.undo();
    if (snapshot(doc.get()) !== checkpoints[i]) {
      undoOk = false;
      undoDetail = `撤销「${label}」后和第 ${i} 步记录的状态不一致`;
      break;
    }
  }
  check(`逐步撤销 ${checkpoints.length - 1} 步回到空项目`, undoOk && doc.get().cards.length === 0 && !doc.canUndo(), undoDetail);

  let redoOk = true;
  let redoDetail = '';
  for (let i = 1; i < checkpoints.length; i++) {
    doc.redo();
    if (snapshot(doc.get()) !== checkpoints[i]) {
      redoOk = false;
      redoDetail = `重做「${stepNames[i - 1]}」后状态不一致`;
      break;
    }
  }
  check(`逐步重做 ${checkpoints.length - 1} 步`, redoOk && !doc.canRedo(), redoDetail);

  const final = doc.get();
  check('最终图像卡数量', final.cards.length === IMPORT_COUNT + 3 - 5, `实际 ${final.cards.length} 张`);

  engine.fitAll(false);
  await wait(1200);
  await session.flush();
  await window.anye.writeCheckFile(EXPECTED_FILE, stableStringify(session.toProjectFile()));
}

async function verifyPhase(
  { engine, session }: CheckContext,
  check: (name: string, ok: boolean, detail?: string) => void,
  timings: Record<string, number>,
): Promise<void> {
  const expected = await window.anye.readCheckFile(EXPECTED_FILE);
  check('找到上一次退出前的状态', expected !== null);
  if (!expected) return;

  const actual = stableStringify(session.toProjectFile());
  check('重新打开后状态完全一致', actual === expected, actual === expected ? undefined : firstDifference(expected, actual));
  check('没有缺失的原图', session.missingVersionIds.size === 0, `缺失 ${session.missingVersionIds.size} 个`);

  timings.allL0SettledMs = await engine.whenAllL0Settled();
  check('全部缩略图可用', engine.textures.failedCount() === 0, `失败 ${engine.textures.failedCount()} 张，用时 ${timings.allL0SettledMs}ms`);

  const multiVersion = session.doc.get().cards.find((card) => card.versions.length > 1);
  check('版本栈保留下来了', multiVersion?.versions.length === 3, `版本数 ${multiVersion?.versions.length ?? 0}`);
  if (multiVersion) session.selection.set([multiVersion.id]);
  engine.fitAll(false);
  await wait(800);
}

function snapshot(state: DocState): string {
  return stableStringify({ cards: state.cards, regions: state.regions });
}

/** 键排序后再序列化，比较时不受对象键顺序影响 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `第 ${i} 个字符开始不同：期望「${a.slice(Math.max(0, i - 40), i + 40)}」，实际「${b.slice(Math.max(0, i - 40), i + 40)}」`;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
