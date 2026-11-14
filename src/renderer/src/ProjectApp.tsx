import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { ImportSource, MenuCommand, StartupInfo } from '../../shared/api';
import { PROJECT_HOST } from '../../shared/bench';
import { planPageExport, type ExportResult } from '../../shared/export';
import type { GenerationConfig, PromptSettings } from '../../shared/generation';
import { isPageCard, type PageCard, type RegionId } from '../../shared/project';
import { isTyping, type CanvasEngine, type EngineStatus } from './canvas/CanvasEngine';
import { AssistantPanel } from './components/AssistantPanel';
import { CanvasView } from './components/CanvasView';
import { Inspector, type InspectorHandle } from './components/Inspector';
import { LayersPanel } from './components/LayersPanel';
import { PerfPanel } from './components/PerfPanel';
import { ProjectTopBar } from './components/ProjectTopBar';
import { QueuePanel } from './components/QueuePanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Welcome } from './components/Welcome';
import {
  addCards,
  addVersions,
  fitIntoPage,
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
import { runRealCheck } from './project/realCheck';
import { ProjectSession, type SaveState } from './project/ProjectSession';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const TOAST_MS = { info: 1600, error: 7000 };

export function ProjectApp() {
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [startup, setStartup] = useState<StartupInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [importing, setImporting] = useState(0);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [showPerf, setShowPerf] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
    const offEdit = engine.onEditRequest(() => {
      setRightTab('inspector');
      requestAnimationFrame(() => requestAnimationFrame(() => inspectorRef.current?.focusPrompt()));
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
      current.doc.apply('替换低保真原型', updatePage(current.doc.get(), pageId, { base }));
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
      }
    },
    [createPage, exportPage, generate, importInto, openDir, toast],
  );

  useEffect(() => window.anye.onMenuCommand((command) => void handleCommand(command)), [handleCommand]);

  // ───────────── 验收自检 ─────────────

  useEffect(() => {
    const { m1Check, m2Check, m3Check, m4Check, realCheck } = window.anye.flags;
    if ((!m1Check && !m2Check && !m3Check && !m4Check && !realCheck) || !engine || !session || !assistant || checkStarted.current) return;
    checkStarted.current = true;
    const run = m1Check
      ? runM1Check(m1Check, { engine, session, importInto })
      : m2Check
        ? runM2Check(m2Check, { engine, session, importInto, tracker })
        : m3Check
          ? runM3Check(m3Check, { engine, session, importInto, tracker, assistant, setRightTab })
          : m4Check
            ? runM4Check(m4Check, { engine, session, importInto, tracker, assistant, setRightTab, createPage, exportPage })
            : runRealCheck({ engine, session, importInto, tracker, assistant });
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
        : config.hasApiKey ? 'OpenAI' : 'OpenAI · 未设置 Key';

  return (
    <div className="app">
      {session ? (
        <ProjectTopBar
          projectName={session.name}
          saveState={saveState.state}
          saveError={saveState.error}
          tool={status?.tool ?? 'select'}
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
            providerLabel={providerLabel}
            session={session}
            engine={engine}
            cacheBust={cacheBust}
            config={config}
            jobs={jobs}
            onImportVersion={importAsVersion}
            onGenerate={generate}
            exports={exports}
            onReplaceLowFi={replaceLowFi}
            onExportPage={exportPage}
            onPlaceInPage={placeInPage}
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
  providerLabel: string;
  config: GenerationConfig | null;
  jobs: TrackedJob[];
  onImportVersion(cardId: string): void;
  onGenerate(promptId: string): void;
  exports: ReadonlyMap<string, ExportResult | 'running' | { error: string }>;
  onReplaceLowFi(pageId: string): void;
  onExportPage(pageId: string): void;
  onPlaceInPage(imageCardId: string, pageId: string): void;
}

const RightPanel = memo(forwardRef<InspectorHandle, RightPanelProps>(function RightPanel(
  { tab, onTab, assistant, providerLabel, session, engine, cacheBust, config, jobs, onImportVersion, onGenerate, exports, onReplaceLowFi, onExportPage, onPlaceInPage },
  ref,
) {
  const state = useCommittedDoc(session.doc);
  const selectedIds = useSelectionIds(session.selection);
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
          providerLabel={providerLabel}
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
      onRemoveInput={(id, index) => doc.apply('解除绑定', removePromptInput(doc.get(), id, index))}
      onMoveInput={(id, index, delta) => doc.apply('调整输入顺序', movePromptInput(doc.get(), id, index, delta))}
      onSettings={(id, settings: Partial<PromptSettings>) => doc.apply('修改生成参数', updatePrompt(doc.get(), id, { settings }))}
      onSelectCard={(id) => {
        session.selection.set([id]);
        engine.zoomToCard(id);
      }}
      onNewPrompt={() => engine.createPromptFromSelection()}
      onUpdateTheme={(id, patch) => doc.apply('编辑主题卡', updateTheme(doc.get(), id, patch))}
      onSetActiveTheme={(id) => doc.apply(id ? '设为生效主题卡' : '取消生效主题卡', setActiveTheme(doc.get(), id))}
      onUpdatePage={(id, patch) => doc.apply('编辑页面框', updatePage(doc.get(), id, patch))}
      onSetPagePreset={(id, presetId) => doc.apply('更换设备', setPagePreset(doc.get(), id, presetId))}
      exports={exports}
      onReplaceLowFi={onReplaceLowFi}
      onExportPage={onExportPage}
      onPlaceInPage={onPlaceInPage}
    />
  );
}));
