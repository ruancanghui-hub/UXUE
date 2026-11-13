import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { ImportSource, MenuCommand, StartupInfo } from '../../shared/api';
import { PROJECT_HOST } from '../../shared/bench';
import type { RegionId } from '../../shared/project';
import { isTyping, type CanvasEngine, type EngineStatus } from './canvas/CanvasEngine';
import { CanvasView } from './components/CanvasView';
import { Inspector } from './components/Inspector';
import { LayersPanel } from './components/LayersPanel';
import { PerfPanel } from './components/PerfPanel';
import { ProjectTopBar } from './components/ProjectTopBar';
import { Welcome } from './components/Welcome';
import { addCards, addVersions, layoutNewCards, renameCard, setCurrentVersion } from './document/operations';
import { useCommittedDoc, useSelectionIds } from './project/hooks';
import { describeImportErrors, pickImageSources, sourcesFromFiles } from './project/importing';
import { runM1Check } from './project/m1Check';
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
  const [saveState, setSaveState] = useState<{ state: SaveState; error: string | null }>({ state: 'saved', error: null });
  const [cacheBust, setCacheBust] = useState<ReadonlyMap<string, number>>(new Map());
  const [dropActive, setDropActive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sessionRef = useRef<ProjectSession | null>(null);
  const engineRef = useRef<CanvasEngine | null>(null);
  const checkStarted = useRef(false);
  sessionRef.current = session;
  engineRef.current = engine;

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
    [toast],
  );

  useEffect(() => {
    void window.anye.getStartupInfo().then((info) => {
      setStartup(info);
      const target = info.checkDir ?? info.reopen;
      if (target) void openDir(target);
    });
  }, [openDir]);

  useEffect(() => {
    if (!engine || !session) return;
    engine.attach(session.doc, session.selection, {
      assetHost: PROJECT_HOST,
      missingVersionIds: session.missingVersionIds,
      viewport: session.initialViewport(),
    });
    const offViewport = engine.onViewportChange((viewport) => session.updateViewport(viewport));
    const offSave = session.onSaveState((state, error) => setSaveState({ state, error }));
    return () => {
      offViewport();
      offSave();
    };
  }, [engine, session]);

  useEffect(() => engine?.onStatus(setStatus), [engine]);

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

  // ───────────── 菜单命令 ─────────────

  const handleCommand = useCallback(
    async (command: MenuCommand) => {
      const current = sessionRef.current;
      const canvas = engineRef.current;
      const typing = isTyping(document.activeElement);

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
      }
    },
    [importInto, openDir, toast],
  );

  useEffect(() => window.anye.onMenuCommand((command) => void handleCommand(command)), [handleCommand]);

  // ───────────── M1 自检 ─────────────

  useEffect(() => {
    const phase = window.anye.flags.m1Check;
    if (!phase || !engine || !session || checkStarted.current) return;
    checkStarted.current = true;
    void runM1Check(phase, { engine, session, importInto })
      .catch((error: unknown) => console.error(`[m1-check] 异常 ${error instanceof Error ? error.stack : String(error)}`))
      .finally(() => window.anye.quit());
  }, [engine, session, importInto]);

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
        />
      ) : (
        <div className="top-bar top-bar-empty" />
      )}

      <div className="workspace-row">
        {session && engine && (
          <ProjectPanels session={session} side="left" engine={engine} cacheBust={cacheBust} onImportVersion={importAsVersion} />
        )}

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
          <div className="toasts">
            {toasts.map((item) => (
              <div key={item.id} className={`toast ${item.tone}`}>
                {item.text}
              </div>
            ))}
          </div>
        </main>

        {session && engine && (
          <ProjectPanels session={session} side="right" engine={engine} cacheBust={cacheBust} onImportVersion={importAsVersion} />
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
    </div>
  );
}

interface ProjectPanelsProps {
  session: ProjectSession;
  engine: CanvasEngine;
  side: 'left' | 'right';
  cacheBust: ReadonlyMap<string, number>;
  onImportVersion(cardId: string): void;
}

/** 面板只订阅提交后的文档，拖动过程中不会重渲染 */
function ProjectPanels({ session, engine, side, cacheBust, onImportVersion }: ProjectPanelsProps) {
  const state = useCommittedDoc(session.doc);
  const selectedIds = useSelectionIds(session.selection);

  if (side === 'left') {
    return (
      <LayersPanel
        state={state}
        selectedIds={selectedIds}
        missingVersionIds={session.missingVersionIds}
        cacheBust={cacheBust}
        onSelect={(id, additive) => (additive ? session.selection.toggle(id) : session.selection.set([id]))}
        onFocusCard={(id) => {
          session.selection.set([id]);
          engine.zoomToCard(id);
        }}
      />
    );
  }
  return (
    <Inspector
      state={state}
      selectedIds={selectedIds}
      projectName={session.name}
      projectDir={session.dir}
      missingVersionIds={session.missingVersionIds}
      cacheBust={cacheBust}
      onRename={(id, name) => session.doc.apply('重命名', renameCard(session.doc.get(), id, name))}
      onSetCurrentVersion={(id, versionId) =>
        session.doc.apply('切换当前版本', setCurrentVersion(session.doc.get(), id, versionId))
      }
      onImportVersion={onImportVersion}
      onDuplicate={() => engine.duplicateSelection()}
      onDelete={() => engine.deleteSelection()}
      onBringToFront={() => engine.reorderSelection('front')}
      onReveal={(path) => window.anye.revealInFinder(path)}
    />
  );
}
