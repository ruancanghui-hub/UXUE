import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { ImportSource, MenuCommand, ProjectFsChange, StartupInfo } from '../../shared/api';
import { PROJECT_HOST } from '../../shared/bench';
import { planPageExport, type ExportResult } from '../../shared/export';
import type { GenerationConfig, PromptSettings } from '../../shared/generation';
import { isImageCard, isPageCard, type PageCard, type RegionId } from '../../shared/project';
import { isTyping, type CanvasEngine, type EngineStatus } from './canvas/CanvasEngine';
import { AssistantPanel } from './components/AssistantPanel';
import { CanvasView } from './components/CanvasView';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { Inspector, type InspectorHandle } from './components/Inspector';
import { LayersPanel } from './components/LayersPanel';
import { PerfPanel } from './components/PerfPanel';
import { ProjectTopBar } from './components/ProjectTopBar';
import { QueuePanel } from './components/QueuePanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Welcome } from './components/Welcome';
import {
  addBlock,
  addCards,
  addVersions,
  createWireframePrompt,
  fitIntoPage,
  newPageFromImageCard,
  setPageBaseFromCard,
  setStyleBenchmark,
  updateSketchText,
  wireframeFromPage,
  layoutNewCards,
  newPageCard,
  placeIntoPage,
  setPagePreset,
  updatePage,
  movePromptInput,
  removePromptInput,
  renameCard,
  setActiveTheme,
  setCurrentVersion,
  setRefLockedVersion,
  nudgeSiblingOrder,
  resizeRefLogical,
  updateBlock,
  updateDecor,
  updatePrompt,
  updateTheme,
} from './document/operations';
import { AssistantSession } from './project/AssistantSession';
import { GenerationTracker, type TrackedJob } from './project/GenerationTracker';
import { useCommittedDoc, useSelectionIds } from './project/hooks';
import { describeImportErrors, pickImageSources, sourcesFromFiles } from './project/importing';
import { runM1Check } from './project/m1Check';
import { runM2Check } from './project/m2Check';
import { runM3Check } from './project/m3Check';
import { runM4Check } from './project/m4Check';
import { runM5Check } from './project/m5Check';
import { runRealCheck } from './project/realCheck';
import { startSketchWireframe } from './project/sketch';
import { targetThemeId, themeMarkdownFor } from './project/themeMarkdown';
import { ProjectSession, type SaveState } from './project/ProjectSession';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const TOAST_MS = { info: 1600, error: 7000 };

const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: 'newProject', label: '新建项目…', hint: '⌘N' },
  { id: 'openProject', label: '打开项目…', hint: '⌘O' },
  { id: 'importImages', label: '导入图片…', hint: '⌘⇧K' },
  { id: 'undo', label: '撤销', hint: '⌘Z' },
  { id: 'redo', label: '重做', hint: '⌘⇧Z' },
  { id: 'generate', label: '生成', hint: '⌘↩' },
  { id: 'toggleAssistant', label: '助手', hint: '⌘J' },
  { id: 'openSettings', label: '设置…', hint: '⌘,' },
  { id: 'region:theme', label: '跳到视觉主题区', hint: '⌘1' },
  { id: 'region:assets', label: '跳到核心素材区', hint: '⌘2' },
  { id: 'region:pages', label: '跳到高保真页面区', hint: '⌘3' },
  { id: 'exportPage', label: '导出选中的页面', hint: '⌘⇧E' },
  { id: 'groupSelection', label: '编组', hint: '⌘G' },
  { id: 'ungroupSelection', label: '解组', hint: '⌘⇧G' },
  { id: 'newPrompt', label: '新建提示词卡', hint: 'P' },
  { id: 'selectAll', label: '全选', hint: '⌘A' },
  { id: 'duplicate', label: '创建副本', hint: '⌘D' },
  { id: 'fitAll', label: '缩放到全部', hint: '⇧1' },
  { id: 'zoomToSelection', label: '缩放到选中', hint: '⇧2' },
  { id: 'toggleFocus', label: '只看当前区域', hint: '⌘⇧F' },
  { id: 'newBlankPage', label: '新建空白页面框', hint: 'F' },
  { id: 'newPageFromLowFi', label: '从低保真原型新建页面框…', hint: '⌘⇧L' },
  { id: 'toWireframe', label: '转线框（选中的截图或页面框）' },
  { id: 'copyThemeMarkdown', label: '复制主题说明（Markdown）' },
  { id: 'saveThemeMarkdown', label: '存为主题说明（themes/名字.md）' },
  { id: 'togglePerf', label: '性能面板' },
];

export function ProjectApp() {
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [startup, setStartup] = useState<StartupInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [importing, setImporting] = useState(0);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [showPerf, setShowPerf] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [config, setConfig] = useState<GenerationConfig | null>(null);
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [saveState, setSaveState] = useState<{ state: SaveState; error: string | null }>({ state: 'saved', error: null });
  const [cacheBust, setCacheBust] = useState<ReadonlyMap<string, number>>(new Map());
  const [dropActive, setDropActive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>('inspector');
  const [exports, setExports] = useState<ReadonlyMap<string, ExportResult | 'running' | { error: string }>>(new Map());
  const sessionRef = useRef<ProjectSession | null>(null);
  const engineRef = useRef<CanvasEngine | null>(null);
  const inspectorRef = useRef<InspectorHandle>(null);
  const checkStarted = useRef(false);
  const fsPrompting = useRef(false);
  const assetsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tracker] = useState(() => new GenerationTracker(() => sessionRef.current));
  sessionRef.current = session;
  engineRef.current = engine;
  const assistant = useMemo(() => (session && engine ? new AssistantSession(session, engine) : null), [session, engine]);

  const handleEngine = useCallback((next: CanvasEngine | null) => setEngine(next), []);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), TOAST_MS[tone]);
  }, []);

  // ───────────── 项目 ─────────────

  const openDir = useCallback(
    async (dir: string): Promise<ProjectSession | null> => {
      setOpening(true);
      try {
        await sessionRef.current?.flush();
        if (tracker.hasActive()) {
          tracker.cancelAll();
          toast('切换项目，已取消还没完成的生成任务');
        }
        const opened = await window.anye.openProject(dir);
        const next = new ProjectSession(opened);
        sessionRef.current?.dispose();
        setSession(next);
        setCacheBust(new Map());
        for (const warning of opened.warnings) toast(warning, 'error');
        if (opened.missingVersionIds.length > 0) {
          toast(`${opened.missingVersionIds.length} 个版本的原图文件不见了，对应的图像卡显示为“缺失”`, 'error');
        }
        return next;
      } catch (error) {
        toast(`打开项目失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        return null;
      } finally {
        setOpening(false);
      }
    },
    [toast, tracker],
  );

  useEffect(() => {
    void window.anye.getStartupInfo().then((info) => {
      setStartup(info);
      const target = info.checkDir ?? info.reopen;
      if (target) void openDir(target);
    });
    void window.anye.getGenerationConfig().then(setConfig);
  }, [openDir]);

  useEffect(() => {
    if (!engine || !session) return;
    engine.attach(session.doc, session.selection, {
      assetHost: PROJECT_HOST,
      missingVersionIds: session.missingVersionIds,
      viewport: session.initialViewport(),
    });
    engine.setJobViews(tracker.views());
    const offViewport = engine.onViewportChange((viewport) => session.updateViewport(viewport));
    const offSave = session.onSaveState((state, error) => setSaveState({ state, error }));
    const offEdit = engine.onEditRequest((cardId) => {
      setRightTab('inspector');
      const isBlock = session.doc.get().cards.some((card) => card.id === cardId && (card.kind === 'block' || card.kind === 'sketchText'));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => (isBlock ? inspectorRef.current?.focusName() : inspectorRef.current?.focusPrompt())),
      );
    });
    return () => {
      offViewport();
      offSave();
      offEdit();
    };
  }, [engine, session, tracker]);

  useEffect(() => engine?.onStatus(setStatus), [engine]);

  useEffect(() => {
    const sync = (): void => {
      setJobs(tracker.list());
      engineRef.current?.setJobViews(tracker.views());
    };
    const offJobs = tracker.subscribe(sync);
    const offFailure = tracker.onFailure((job) => toast(`「${job.promptName}」生成失败：${job.update.error}`, 'error'));
    // 失败状态过一段时间后从提示词卡上消失
    const timer = setInterval(() => engineRef.current?.setJobViews(tracker.views()), 5000);
    return () => {
      offJobs();
      offFailure();
      clearInterval(timer);
    };
  }, [tracker, toast]);

  useEffect(() => window.anye.onFlushRequest(async () => sessionRef.current?.flush()), []);

  useEffect(
    () =>
      window.anye.onCacheReady((versionId) => {
        engineRef.current?.retryTexture(versionId);
        setCacheBust((map) => new Map(map).set(versionId, (map.get(versionId) ?? 0) + 1));
      }),
    [],
  );

  const reloadFromDisk = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    await openDir(current.dir);
  }, [openDir]);

  const refreshAssets = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const before = current.missingVersionIds.size;
      const missing = await window.anye.refreshMissingVersions();
      current.missingVersionIds = new Set(missing);
      engineRef.current?.setMissingVersionIds(current.missingVersionIds);
      setCacheBust(new Map());
      if (missing.length !== before) {
        if (missing.length > 0) toast(`${missing.length} 个版本的原图文件不见了`, 'error');
        else toast('缺失的原图已恢复');
      }
    } catch (error) {
      toast(`刷新素材失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [toast]);

  useEffect(
    () =>
      window.anye.onProjectFsChange((change: ProjectFsChange) => {
        const current = sessionRef.current;
        if (!current) return;
        if (change.kind === 'assets') {
          if (assetsRefreshTimer.current) clearTimeout(assetsRefreshTimer.current);
          assetsRefreshTimer.current = setTimeout(() => {
            assetsRefreshTimer.current = null;
            void refreshAssets();
          }, 400);
          return;
        }
        if (fsPrompting.current) return;
        fsPrompting.current = true;
        const dirty = current.isDirty();
        const reload = dirty
          ? window.confirm('项目文件已在外部被修改。\n\n确定 = 丢弃本地未保存改动并重新加载\n取消 = 保留本地修改')
          : window.confirm('项目文件已在外部被修改，是否重新加载？');
        fsPrompting.current = false;
        if (reload) void reloadFromDisk();
      }),
    [refreshAssets, reloadFromDisk],
  );

  // ───────────── 导入 ─────────────

  const importInto = useCallback(
    async (sources: ImportSource[], at?: { x: number; y: number }) => {
      const current = sessionRef.current;
      const canvas = engineRef.current;
      if (!current || !canvas || sources.length === 0) return;
      setImporting((n) => n + sources.length);
      try {
        const result = await window.anye.importImages(sources);
        const center = at ?? canvas.viewCenterWorld();
        const cards = layoutNewCards(result.versions, center.x, center.y, () => crypto.randomUUID());
        if (cards.length > 0) {
          current.doc.apply('导入图片', addCards(current.doc.get(), cards));
          current.selection.set(cards.map((card) => card.id));
        }
        const errors = describeImportErrors(result);
        if (errors) toast(errors, 'error');
      } catch (error) {
        toast(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        setImporting((n) => n - sources.length);
      }
    },
    [toast],
  );

  const importAsVersion = useCallback(
    async (cardId: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const sources = await pickImageSources();
      if (sources.length === 0) return;
      setImporting((n) => n + sources.length);
      try {
        const result = await window.anye.importImages(sources);
        current.doc.apply('导入新版本', addVersions(current.doc.get(), cardId, result.versions));
        const errors = describeImportErrors(result);
        if (errors) toast(errors, 'error');
      } finally {
        setImporting((n) => n - sources.length);
      }
    },
    [toast],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (isTyping(event.target) || !event.clipboardData || event.clipboardData.files.length === 0) return;
      event.preventDefault();
      void sourcesFromFiles(event.clipboardData.files).then((sources) => importInto(sources));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [importInto]);

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDropActive(false);
    const canvas = engineRef.current;
    if (!canvas || !sessionRef.current) return;
    const at = canvas.clientToWorld(event.clientX, event.clientY);
    void sourcesFromFiles(event.dataTransfer.files).then((sources) => importInto(sources, at));
  };

  // ───────────── 生成 ─────────────

  const generate = useCallback(
    async (promptId: string) => {
      const current = sessionRef.current;
      if (!current) return;
      if (current.doc.isGestureActive()) current.doc.commitGesture();
      try {
        await tracker.submit(current, promptId);
      } catch (error) {
        toast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error), 'error');
      }
    },
    [toast, tracker],
  );

  /** 按拓扑顺序依次提交；前一个完成后再发下一个，保证下游吃到新版本 */
  const regenDownstream = useCallback(
    async (promptIds: string[]) => {
      for (const id of promptIds) await generate(id);
    },
    [generate],
  );

  // ───────────── 页面 ─────────────

  /** 新建页面框；传了图片就用第一张作为低保真原型（导入流程和普通图片一样） */
  const createPage = useCallback(
    async (sources: ImportSource[] | null): Promise<PageCard | null> => {
      const current = sessionRef.current;
      const canvas = engineRef.current;
      if (!current || !canvas) return null;
      let base = null;
      if (sources) {
        if (sources.length === 0) return null;
        const result = await window.anye.importImages(sources.slice(0, 1));
        base = result.versions[0] ?? null;
        if (!base) {
          toast(describeImportErrors(result) ?? '低保真原型导入失败', 'error');
          return null;
        }
      }
      const pages = current.doc.get().cards.filter(isPageCard).length;
      const name = base?.sourceName?.replace(/\.[^.]+$/, '') || (pages === 0 ? '首页' : `页面 ${pages + 1}`);
      const page = newPageCard(current.doc.get(), { id: crypto.randomUUID(), name, base });
      current.doc.apply('新建页面框', addCards(current.doc.get(), [page]));
      current.selection.set([page.id]);
      canvas.zoomToCard(page.id);
      return page;
    },
    [toast],
  );

  const replaceLowFi = useCallback(
    async (pageId: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const sources = await pickImageSources();
      if (sources.length === 0) return;
      const result = await window.anye.importImages(sources.slice(0, 1));
      const base = result.versions[0];
      if (!base) {
        toast(describeImportErrors(result) ?? '低保真原型导入失败', 'error');
        return;
      }
      current.doc.apply('替换低保真原型', updatePage(current.doc.get(), pageId, { base, baseCardId: null, wireframePromptId: null }));
    },
    [toast],
  );

  const exportPage = useCallback(
    async (pageId: string): Promise<ExportResult | null> => {
      const current = sessionRef.current;
      if (!current) return null;
      const state = current.doc.get();
      const page = state.cards.find((card) => card.id === pageId);
      if (!page || !isPageCard(page)) return null;
      const plan = planPageExport(page, state.cards);
      const missing = plan.layers.find((layer) => current.missingVersionIds.has(layer.versionId));
      if (missing) {
        toast(`素材「${missing.name}」的原图不见了，无法导出`, 'error');
        return null;
      }
      setExports((map) => new Map(map).set(pageId, 'running'));
      try {
        const result = await window.anye.exportPage(current.dir, plan);
        setExports((map) => new Map(map).set(pageId, result));
        toast(`「${page.name}」已导出到 ${result.folder}`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
        setExports((map) => new Map(map).set(pageId, { error: message }));
        toast(`导出失败：${message}`, 'error');
        return null;
      }
    },
    [toast],
  );

  const placeInPage = useCallback((imageCardId: string, pageId: string) => {
    const current = sessionRef.current;
    if (!current) return;
    const state = current.doc.get();
    const page = state.cards.find((card) => card.id === pageId);
    const card = state.cards.find((c) => c.id === imageCardId);
    if (!page || !card) return;
    const rect = fitIntoPage(page, card, page.x + page.width / 2, page.y + page.height / 2);
    const placed = placeIntoPage(state, pageId, [{ imageCardId, rect }], () => crypto.randomUUID());
    current.doc.apply('放入页面', placed.state);
    current.selection.set(placed.refIds);
  }, []);

  // ───────────── 菜单命令 ─────────────

  const handleCommand = useCallback(
    async (command: MenuCommand) => {
      const current = sessionRef.current;
      const canvas = engineRef.current;
      const typing = isTyping(document.activeElement);
      // ⌘↩ 在助手输入框里不触发生成
      if (command === 'generate' && document.activeElement?.classList.contains('assistant-input')) return;

      if (command === 'newProject' || command === 'openProject') {
        const dir = command === 'newProject' ? await window.anye.chooseNewProjectDir() : await window.anye.chooseProjectDir();
        if (dir) await openDir(dir);
        return;
      }
      if (command.startsWith('openRecent:')) {
        await openDir(command.slice('openRecent:'.length));
        return;
      }
      if (command === 'togglePerf') {
        setShowPerf((value) => !value);
        return;
      }
      if (command === 'openSettings') {
        setShowSettings(true);
        return;
      }
      if (command === 'commandPalette') {
        setShowPalette(true);
        return;
      }
      if (command === 'toggleAssistant') {
        setRightTab((tab) => (tab === 'assistant' ? 'inspector' : 'assistant'));
        return;
      }
      if (!current || !canvas) return;

      switch (command) {
        case 'importImages':
          await importInto(await pickImageSources());
          break;
        case 'undo':
        case 'redo': {
          if (typing) {
            document.execCommand(command);
            break;
          }
          const label = command === 'undo' ? current.doc.undo() : current.doc.redo();
          if (label) toast(`${command === 'undo' ? '撤销' : '重做'}：${label}`);
          break;
        }
        case 'selectAll':
          if (typing) document.execCommand('selectAll');
          else canvas.selectAll();
          break;
        case 'duplicate':
          if (!typing) canvas.duplicateSelection();
          break;
        case 'groupSelection':
          if (!typing) canvas.groupSelection();
          break;
        case 'ungroupSelection':
          if (!typing) canvas.ungroupSelection();
          break;
        case 'bringToFront':
          canvas.reorderSelection('front');
          break;
        case 'sendToBack':
          canvas.reorderSelection('back');
          break;
        case 'fitAll':
          canvas.fitAll();
          break;
        case 'zoomToSelection':
          canvas.zoomToSelection();
          break;
        case 'zoomIn':
          canvas.zoomBy(2);
          break;
        case 'zoomOut':
          canvas.zoomBy(0.5);
          break;
        case 'zoomReset':
          canvas.setZoom(1);
          break;
        case 'region:theme':
        case 'region:assets':
        case 'region:pages':
          canvas.flyToRegion(command.slice('region:'.length) as RegionId);
          break;
        case 'toggleFocus':
          canvas.setFocusRegion(canvas.getFocusRegion() ? null : canvas.regionAtViewCenter());
          break;
        case 'newPrompt':
          if (!typing) canvas.createPromptFromSelection();
          break;
        case 'newPageFromLowFi':
          await createPage(await pickImageSources());
          break;
        case 'newBlankPage':
          if (!typing) await createPage(null);
          break;
        case 'exportPage': {
          const pages = current.doc.get().cards.filter((card) => isPageCard(card) && current.selection.has(card.id));
          if (pages.length === 0) toast('先选中一个页面框');
          for (const page of pages) await exportPage(page.id);
          break;
        }
        case 'generate': {
          const prompts = current.doc.get().cards.filter((card) => card.kind === 'prompt' && current.selection.has(card.id));
          if (prompts.length === 0) toast('先选中一张提示词卡');
          for (const prompt of prompts) await generate(prompt.id);
          break;
        }
        case 'copyThemeMarkdown':
        case 'saveThemeMarkdown': {
          const themeId = targetThemeId(current.doc.get(), current.selection.get());
          const md = themeId ? themeMarkdownFor(current.doc.get(), themeId, current.name, command === 'saveThemeMarkdown') : null;
          if (!md) {
            toast('先选中一张主题卡，或设一张生效主题卡');
            break;
          }
          try {
            if (command === 'copyThemeMarkdown') {
              await window.anye.copyText(md.markdown);
              toast(`已复制「${md.name}」的主题说明`);
            } else {
              const path = await window.anye.saveThemeMarkdown(md.name, md.markdown);
              toast(`已存到 themes/${path.split('/').pop()}`);
            }
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error');
          }
          break;
        }
        case 'toWireframe': {
          const state = current.doc.get();
          const selected = state.cards.filter((card) => current.selection.has(card.id));
          const [only] = selected;
          const created =
            selected.length === 1 && isImageCard(only)
              ? createWireframePrompt(state, only.id, () => crypto.randomUUID())
              : selected.length === 1 && isPageCard(only)
                ? wireframeFromPage(state, only.id, () => crypto.randomUUID())
                : null;
          if (!created) {
            toast('先选中一张截图或一个有低保真原型的页面框');
            break;
          }
          current.doc.apply('转线框', created.state);
          await generate(created.promptId);
          break;
        }
      }
    },
    [createPage, exportPage, generate, importInto, openDir, toast],
  );

  useEffect(() => window.anye.onMenuCommand((command) => void handleCommand(command)), [handleCommand]);

  // ───────────── 验收自检 ─────────────

  useEffect(() => {
    const { m1Check, m2Check, m3Check, m4Check, m5Check, realCheck } = window.anye.flags;
    if ((!m1Check && !m2Check && !m3Check && !m4Check && !m5Check && !realCheck) || !engine || !session || !assistant || checkStarted.current) return;
    checkStarted.current = true;
    const run = m1Check
      ? runM1Check(m1Check, { engine, session, importInto })
      : m2Check
        ? runM2Check(m2Check, { engine, session, importInto, tracker })
        : m3Check
          ? runM3Check(m3Check, { engine, session, importInto, tracker, assistant, setRightTab })
          : m4Check
            ? runM4Check(m4Check, { engine, session, importInto, tracker, assistant, setRightTab, createPage, exportPage })
            : m5Check
              ? runM5Check(m5Check, { engine, session, tracker, assistant, createPage, exportPage })
              : runRealCheck({ engine, session, importInto, tracker, assistant, createPage });
    void run
      .catch((error: unknown) => console.error(`[check] 异常 ${error instanceof Error ? error.stack : String(error)}`))
      .finally(() => window.anye.quit());
  }, [engine, session, importInto, tracker, assistant, createPage, exportPage]);

  const providerLabel = !config
    ? ''
    : config.provider === 'mock'
      ? '本地模拟'
      : config.provider === 'siliconflow'
        ? config.hasSiliconflowKey ? '硅基流动' : '硅基流动 · 未设置 Key'
        : config.provider === 'newapi'
          ? config.hasNewapiKey ? 'NewAPI 中转' : 'NewAPI · 未设置 Key'
          : config.hasApiKey ? 'OpenAI' : 'OpenAI · 未设置 Key';

  const assistantLabel = !config
    ? ''
    : config.assistantProvider === 'mock'
      ? '助手 · 本地模拟'
      : config.assistantProvider === 'newapi'
        ? config.hasNewapiKey ? `助手 · ${config.newapiAssistantModel}` : '助手 · NewAPI 未设置 Key'
        : config.hasApiKey ? `助手 · ${config.assistantModel}` : '助手 · OpenAI 未设置 Key';

  return (
    <div className="app">
      {session ? (
        <ProjectTopBar
          projectName={session.name}
          saveState={saveState.state}
          saveError={saveState.error}
          tool={status?.tool ?? 'select'}
          penWidth={status?.penWidth ?? 'thin'}
          onPenWidth={(width) => engine?.setPenWidth(width)}
          zoom={status?.zoom ?? 1}
          focusRegion={status?.focusRegion ?? null}
          onRegion={(id) => engine?.flyToRegion(id)}
          onToggleFocus={() => void handleCommand('toggleFocus')}
          onTool={(tool) => engine?.setTool(tool)}
          onFit={() => engine?.fitAll()}
          onImport={() => void handleCommand('importImages')}
          providerLabel={providerLabel}
          onSettings={() => setShowSettings(true)}
        />
      ) : (
        <div className="top-bar top-bar-empty" />
      )}

      <div className="workspace-row">
        {session && engine && <LeftPanel session={session} engine={engine} cacheBust={cacheBust} />}

        <main
          className={`workspace ${dropActive ? 'drop-active' : ''}`}
          onDragOver={(event) => {
            if (!session) return;
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
        >
          <CanvasView onEngine={handleEngine} />
          {showPerf && status && <PerfPanel status={status} uncapped={false} firstPaintMs={null} />}
          {session && status?.itemCount === 0 && importing === 0 && (
            <div className="empty-hint">
              <div className="empty-title">把图片拖进来</div>
              <div className="empty-body">也可以直接粘贴，或者按 ⌘⇧K 导入</div>
            </div>
          )}
          {importing > 0 && <div className="status-pill">正在导入 {importing} 张图片…</div>}
          {session && (
            <QueuePanel
              jobs={jobs}
              onCancel={(jobId) => tracker.cancel(jobId)}
              onDismiss={(jobId) => tracker.dismiss(jobId)}
              onRetryDownload={(jobId) =>
                void window.anye.retryDownload(jobId).catch((error: unknown) =>
                  toast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error), 'error'),
                )
              }
              onSelectPrompt={(id) => {
                session.selection.set([id]);
                engine?.zoomToCard(id);
              }}
            />
          )}
          <div className="toasts">
            {toasts.map((item) => (
              <div key={item.id} className={`toast ${item.tone}`}>
                {item.text}
              </div>
            ))}
          </div>
        </main>

        {session && engine && assistant && (
          <RightPanel
            ref={inspectorRef}
            tab={rightTab}
            onTab={setRightTab}
            assistant={assistant}
            assistantLabel={assistantLabel}
            session={session}
            engine={engine}
            cacheBust={cacheBust}
            config={config}
            jobs={jobs}
            onImportVersion={importAsVersion}
            onGenerate={generate}
            onRegenDownstream={regenDownstream}
            exports={exports}
            onReplaceLowFi={replaceLowFi}
            onExportPage={exportPage}
            onPlaceInPage={placeInPage}
            onToast={toast}
          />
        )}
      </div>

      {!session && startup && (
        <Welcome
          recent={startup.recent}
          busy={opening}
          onNew={() => void handleCommand('newProject')}
          onOpen={() => void handleCommand('openProject')}
          onOpenRecent={(dir) => void openDir(dir)}
        />
      )}
      {showSettings && config && <SettingsDialog config={config} onChange={setConfig} onClose={() => setShowSettings(false)} />}
      <CommandPalette
        open={showPalette}
        commands={PALETTE_COMMANDS}
        onClose={() => setShowPalette(false)}
        onRun={(command) => void handleCommand(command)}
      />
    </div>
  );
}

interface PanelProps {
  session: ProjectSession;
  engine: CanvasEngine;
  cacheBust: ReadonlyMap<string, number>;
}

/**
 * 面板只订阅提交后的文档，拖动过程中不会重渲染；
 * 用 memo 隔开 ProjectApp 每秒 4 次的状态刷新，否则图层列表会跟着整体重渲染、挤占画布的帧。
 */
const LeftPanel = memo(function LeftPanel({ session, engine, cacheBust }: PanelProps) {
  const state = useCommittedDoc(session.doc);
  const selectedIds = useSelectionIds(session.selection);
  const onSelect = useCallback(
    (id: string, additive: boolean) => (additive ? session.selection.toggle(id) : session.selection.set([id])),
    [session],
  );
  const onFocusCard = useCallback(
    (id: string) => {
      session.selection.set([id]);
      engine.zoomToCard(id);
    },
    [session, engine],
  );
  return (
    <LayersPanel
      state={state}
      selectedIds={selectedIds}
      missingVersionIds={session.missingVersionIds}
      cacheBust={cacheBust}
      onSelect={onSelect}
      onFocusCard={onFocusCard}
    />
  );
});

export type RightTab = 'inspector' | 'assistant';

interface RightPanelProps extends PanelProps {
  tab: RightTab;
  onTab(tab: RightTab): void;
  assistant: AssistantSession;
  assistantLabel: string;
  config: GenerationConfig | null;
  jobs: TrackedJob[];
  onImportVersion(cardId: string): void;
  onGenerate(promptId: string): void;
  onRegenDownstream(promptIds: string[]): void;
  exports: ReadonlyMap<string, ExportResult | 'running' | { error: string }>;
  onReplaceLowFi(pageId: string): void;
  onExportPage(pageId: string): void;
  onPlaceInPage(imageCardId: string, pageId: string): void;
  onToast(text: string, tone?: 'info' | 'error'): void;
}

const RightPanel = memo(forwardRef<InspectorHandle, RightPanelProps>(function RightPanel(
  { tab, onTab, assistant, assistantLabel, session, engine, cacheBust, config, jobs, onImportVersion, onGenerate, onRegenDownstream, exports, onReplaceLowFi, onExportPage, onPlaceInPage, onToast },
  ref,
) {
  const state = useCommittedDoc(session.doc);
  const selectedIds = useSelectionIds(session.selection);
  const assistantBusy = useSyncExternalStore(
    (listener) => assistant.subscribe(listener),
    () => assistant.isBusy(),
  );
  const doc = session.doc;
  const tabs = (
    <div className="panel-tabs">
      <button className={tab === 'inspector' ? 'active' : ''} onClick={() => onTab('inspector')}>
        属性
      </button>
      <button className={tab === 'assistant' ? 'active' : ''} onClick={() => onTab('assistant')} title="助手（⌘J）">
        助手
      </button>
    </div>
  );
  if (tab === 'assistant') {
    return (
      <aside className="side-panel inspector assistant-side">
        {tabs}
        <AssistantPanel
          assistant={assistant}
          state={state}
          selectedIds={selectedIds}
          projectName={session.name}
          providerLabel={assistantLabel}
          onSelectCards={(ids) => session.selection.set(ids)}
        />
      </aside>
    );
  }
  return (
    <Inspector
      tabs={tabs}
      ref={ref}
      state={state}
      doc={doc}
      selectedIds={selectedIds}
      projectName={session.name}
      projectDir={session.dir}
      missingVersionIds={session.missingVersionIds}
      cacheBust={cacheBust}
      config={config}
      jobs={jobs}
      onRename={(id, name) => doc.apply('重命名', renameCard(doc.get(), id, name))}
      onSetCurrentVersion={(id, versionId) => doc.apply('切换当前版本', setCurrentVersion(doc.get(), id, versionId))}
      onImportVersion={onImportVersion}
      onDuplicate={() => engine.duplicateSelection()}
      onDelete={() => engine.deleteSelection()}
      onBringToFront={() => engine.reorderSelection('front')}
      onReveal={(path) => window.anye.revealInFinder(path)}
      onGenerate={onGenerate}
      onRegenDownstream={onRegenDownstream}
      onLockRef={(refId, lockedVersionId) =>
        doc.apply(lockedVersionId ? '锁定版本' : '解锁版本', setRefLockedVersion(doc.get(), refId, lockedVersionId))
      }
      onResizeRef={(refId, logical, lockAspect) =>
        doc.apply('调整引用尺寸', resizeRefLogical(doc.get(), refId, logical, lockAspect))
      }
      onUpdateDecor={(id, patch) => doc.apply('编辑页面装饰', updateDecor(doc.get(), id, patch))}
      onNudgeSiblingOrder={(id, direction) =>
        doc.apply(direction === 'forward' ? '上移一层' : '下移一层', nudgeSiblingOrder(doc.get(), id, direction))
      }
      onRemoveInput={(id, index) => doc.apply('解除绑定', removePromptInput(doc.get(), id, index))}
      onMoveInput={(id, index, delta) => doc.apply('调整输入顺序', movePromptInput(doc.get(), id, index, delta))}
      onSettings={(id, settings: Partial<PromptSettings>) => doc.apply('修改生成参数', updatePrompt(doc.get(), id, { settings }))}
      onSelectCard={(id) => {
        session.selection.set([id]);
        engine.zoomToCard(id);
      }}
      onNewPrompt={() => engine.createPromptFromSelection()}
      onCreatePromptFromTemplate={(template) => engine.createPromptFromTemplate(template)}
      onUpdateTheme={(id, patch) => doc.apply('编辑主题卡', updateTheme(doc.get(), id, patch))}
      onSetActiveTheme={(id) => doc.apply(id ? '设为生效主题卡' : '取消生效主题卡', setActiveTheme(doc.get(), id))}
      onUpdatePage={(id, patch) => doc.apply('编辑页面框', updatePage(doc.get(), id, patch))}
      onSetPagePreset={(id, presetId) => doc.apply('更换设备', setPagePreset(doc.get(), id, presetId))}
      exports={exports}
      onReplaceLowFi={onReplaceLowFi}
      onExportPage={onExportPage}
      onPlaceInPage={onPlaceInPage}
      blockActions={{
        busy: assistantBusy,
        decompose: (pageId) => void assistant.decomposePage(pageId),
        writePrompts: (pageId) => void assistant.writeBlockPrompts(pageId),
        addBlock: (pageId) => {
          const added = addBlock(doc.get(), pageId, () => crypto.randomUUID());
          if (!added) return;
          doc.apply('新增区块', added.state);
          session.selection.set([added.blockId]);
        },
        update: (id, patch) => doc.apply('编辑区块', updateBlock(doc.get(), id, patch)),
        refreshCrop: (blockId) => void assistant.refreshBlockCrop(blockId),
        updateSketchText: (id, patch) => doc.apply('编辑草图文字', updateSketchText(doc.get(), id, patch)),
        sketchToWireframe: (pageId) =>
          void startSketchWireframe(session, pageId)
            .then((promptId) => onGenerate(promptId))
            .catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error), 'error')),
      }}
      elementActions={{
        busy: assistantBusy,
        list: (themeId) => void assistant.listElements('', themeId),
        setBenchmark: (imageCardId) =>
          doc.apply(imageCardId ? '设为风格基准' : '取消风格基准', setStyleBenchmark(doc.get(), imageCardId)),
      }}
      themeMarkdownActions={{
        copy: async (themeId) => {
          const md = themeMarkdownFor(doc.get(), themeId, session.name, false);
          if (!md) throw new Error('找不到这张主题卡');
          await window.anye.copyText(md.markdown);
        },
        save: async (themeId) => {
          const md = themeMarkdownFor(doc.get(), themeId, session.name, true);
          if (!md) throw new Error('找不到这张主题卡');
          return window.anye.saveThemeMarkdown(md.name, md.markdown);
        },
      }}
      wireframeActions={{
        fromImage: (imageCardId) => {
          const created = createWireframePrompt(doc.get(), imageCardId, () => crypto.randomUUID());
          if (!created) return;
          doc.apply('转线框', created.state);
          session.selection.set([created.promptId]);
          onGenerate(created.promptId);
        },
        fromPage: (pageId) => {
          const created = wireframeFromPage(doc.get(), pageId, () => crypto.randomUUID());
          if (!created) return;
          doc.apply('转线框', created.state);
          onGenerate(created.promptId);
        },
        newPage: (imageCardId) => {
          const created = newPageFromImageCard(doc.get(), imageCardId, () => crypto.randomUUID());
          if (!created) return;
          doc.apply('用图像卡新建页面框', created.state);
          session.selection.set([created.pageId]);
          engine.zoomToCard(created.pageId);
        },
        useBaseCard: (pageId) => {
          const page = doc.get().cards.find((c): c is PageCard => c.id === pageId && isPageCard(c));
          if (page?.baseCardId) doc.apply('换低保真原型', setPageBaseFromCard(doc.get(), pageId, page.baseCardId));
        },
      }}
    />
  );
}));
