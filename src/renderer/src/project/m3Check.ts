import type { CheckPhase, ImportSource } from '../../../shared/api';
import { isImageCard, isPromptCard, isThemeCard, type ImageCard, type PromptCard } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import { intersects, unionRects } from '../canvas/geometry';
import { regionOf, renameCard, updatePrompt } from '../document/operations';
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
}

type Check = (name: string, ok: boolean, detail?: string) => void;

const ICONS = ['热门寿司', '今日上新', '店长推荐', '全部菜单'];
const EXPECTED_FILE = 'expected.json';

/**
 * M3 验收（本地模拟助手 + 本地模拟生成）：
 * 'write' 助手根据"日式寿司点餐"生成主题卡并自动生效；选中四个金刚位，助手一次写好四张提示词卡并分别绑定；
 *  生成时生效主题卡的规则确实附加到了提示词里，关掉开关后不附加；保存退出。
 * 'verify' 重新打开，核对主题卡、生效状态、提示词卡和生成记录。
 */
export async function runM3Check(phase: CheckPhase, ctx: CheckContext): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check: Check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`[m3-check] ${ok ? '通过' : '失败'} ${name}${detail ? `：${detail}` : ''}`);
  };
  if (phase === 'write') await writePhase(ctx, check);
  else await verifyPhase(ctx, check);
  const report = { phase, createdAt: new Date().toISOString(), passed: checks.every((c) => c.ok), checks, timings: {} };
  await window.anye.writeCheckFile(`report-${phase}.json`, JSON.stringify(report, null, 2));
  await wait(600);
}

async function writePhase({ engine, session, tracker, assistant, importInto }: CheckContext, check: Check): Promise<void> {
  const doc = session.doc;
  const manifest = await window.anye.prepareBench(200);
  const assets = doc.get().regions.find((r) => r.id === 'assets')!;
  // 四张方图当金刚位
  const squares = manifest.images.filter((image) => image.width === image.height).slice(0, 4);
  await importInto(
    squares.map((image) => ({ kind: 'path', path: image.originalPath })),
    { x: assets.x + 1400, y: assets.y + 1000 },
  );
  const icons = doc.get().cards.filter(isImageCard);
  icons.forEach((card, i) => doc.apply('重命名', renameCard(doc.get(), card.id, ICONS[i])));
  check('准备四个金刚位', doc.get().cards.filter(isImageCard).length === 4);

  // 1. 主题卡
  session.selection.set([]);
  const themeReply = await assistant.send('为「日式寿司点餐」生成一套视觉主题');
  const theme = doc.get().cards.find(isThemeCard);
  check('助手生成了主题卡', !!theme && !themeReply.error, themeReply.text);
  check('第一张主题卡自动设为生效', !!theme && doc.get().activeThemeCardId === theme.id);
  check(
    '主题卡内容完整：关键词、线索、4 个颜色、4 条统一规则',
    !!theme &&
      theme.keywords.includes('新鲜') &&
      theme.cues.length >= 4 &&
      theme.palette.length === 4 &&
      theme.palette.every((c) => /^#[0-9A-F]{6}$/.test(c.hex)) &&
      Object.values(theme.rules).every((rule) => rule.length > 0),
  );
  check('主题卡放在视觉主题区', !!theme && regionOf(doc.get(), theme) === 'theme');

  // 2. 四个金刚位的提示词卡一次写好
  const iconIds = doc.get().cards.filter(isImageCard).map((card) => card.id);
  session.selection.set(iconIds);
  const before = doc.get();
  const promptReply = await assistant.send('给选中的图各写一条金刚位图标提示词：3D 图标风格');
  const prompts = doc.get().cards.filter(isPromptCard);
  check('四张提示词卡一次写好', prompts.length === 4 && !promptReply.error, promptReply.text);
  check(
    '每张提示词卡绑定了对应的金刚位，并用 {{Image 1}} 指代它',
    prompts.every((p) => p.inputs.length === 1 && iconIds.includes(p.inputs[0]) && p.text.includes('{{Image 1}}')) &&
      new Set(prompts.map((p) => p.inputs[0])).size === 4,
  );
  check('新建的提示词卡互不重叠', noOverlap(prompts));
  doc.undo();
  check('撤销一步就撤掉助手这一次新建的全部卡片', doc.get() === before);
  doc.redo();

  // 3. 生成时附加主题规则；关掉开关后不附加
  const [withTheme, withoutTheme] = doc.get().cards.filter(isPromptCard);
  doc.apply('修改生成参数', updatePrompt(doc.get(), withoutTheme.id, { settings: { useTheme: false, count: 1 } }));
  doc.apply('修改生成参数', updatePrompt(doc.get(), withTheme.id, { settings: { count: 1 } }));
  const jobs = await Promise.all([tracker.submit(session, withTheme.id), tracker.submit(session, withoutTheme.id)]);
  await waitForJobs(tracker, jobs.map((job) => job.update.jobId));
  const recordOf = (prompt: PromptCard) => {
    const fresh = doc.get().cards.find((c) => c.id === prompt.id);
    const output = fresh && isPromptCard(fresh) ? doc.get().cards.find((c) => c.id === fresh.outputCardId) : undefined;
    return output && isImageCard(output) ? output.versions[0].generation : undefined;
  };
  const on = recordOf(withTheme);
  const off = recordOf(withoutTheme);
  check('开着开关：生成的提示词里附加了主题规则', !!on && on.prompt.includes('【视觉主题') && on.themeCardId === theme?.id);
  check('关掉开关：不附加', !!off && !off.prompt.includes('【视觉主题') && off.themeCardId === null);

  // 4. 再来一张候选主题卡，不应抢走生效状态
  session.selection.set([]);
  await assistant.send('为「日式寿司点餐 · 夜间版」生成一套视觉主题');
  const themes = doc.get().cards.filter(isThemeCard);
  check('第二张主题卡作为候选，生效的仍是第一张', themes.length === 2 && doc.get().activeThemeCardId === theme?.id);
  check('两张主题卡并排不重叠', noOverlap(themes));

  engine.fitAll(false);
  await wait(800);
  await session.flush();
  await window.anye.writeCheckFile(EXPECTED_FILE, stableStringify(session.toProjectFile()));
}

async function verifyPhase({ engine, session, setRightTab }: CheckContext, check: Check): Promise<void> {
  const expected = await window.anye.readCheckFile(EXPECTED_FILE);
  check('找到上一次退出前的状态', expected !== null);
  if (!expected) return;
  check('重新打开后状态完全一致', stableStringify(session.toProjectFile()) === expected);
  const state = session.doc.get();
  const themes = state.cards.filter(isThemeCard);
  check('两张主题卡和生效状态都在', themes.length === 2 && themes.some((t) => t.id === state.activeThemeCardId));
  check('四张提示词卡都还绑定着金刚位', state.cards.filter(isPromptCard).filter((p) => p.inputs.length === 1).length === 4);
  await engine.whenAllL0Settled();
  check('全部缩略图可用', engine.textures.failedCount() === 0);

  const active = themes.find((t) => t.id === state.activeThemeCardId);
  if (active) {
    session.selection.set([active.id]);
    focusOn(engine, unionRects(themes)!);
  }
  setRightTab('inspector');
  await wait(1400);
}

function focusOn(engine: CanvasEngine, bounds: { x: number; y: number; width: number; height: number }): void {
  const zoom = Math.min((engine.viewport.screenWidth - 120) / bounds.width, (engine.viewport.screenHeight - 120) / bounds.height);
  engine.viewport.zoom = zoom;
  engine.viewport.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  engine.invalidateView();
}

function noOverlap(cards: (PromptCard | ImageCard | { x: number; y: number; width: number; height: number })[]): boolean {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) if (intersects(cards[i], cards[j])) return false;
  }
  return true;
}
