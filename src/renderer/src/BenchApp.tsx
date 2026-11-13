import { useCallback, useEffect, useRef, useState } from 'react';
import type { BenchProgress, BenchReport } from '../../shared/bench';
import { judge, runBenchmark } from './canvas/benchmark';
import type { CanvasEngine, EngineStatus } from './canvas/CanvasEngine';
import { BenchReportCard } from './components/BenchReportCard';
import { CanvasView } from './components/CanvasView';
import { PerfPanel } from './components/PerfPanel';
import { TopBar } from './components/TopBar';

const IMAGE_COUNT = 200;

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing'; progress: BenchProgress | null }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'benchmarking'; name: string; index: number; total: number };

export function BenchApp() {
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [firstPaintMs, setFirstPaintMs] = useState<number | null>(null);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoBenchStarted = useRef(false);
  const { flags } = window.anye;

  const handleEngine = useCallback((next: CanvasEngine | null) => setEngine(next), []);

  useEffect(() => engine?.onStatus(setStatus), [engine]);

  const loadImages = useCallback(async (): Promise<number | null> => {
    if (!engine) return null;
    setError(null);
    setPhase({ kind: 'preparing', progress: null });
    const unsubscribe = window.anye.onBenchProgress((progress) => setPhase({ kind: 'preparing', progress }));
    try {
      const manifest = await window.anye.prepareBench(IMAGE_COUNT);
      setPhase({ kind: 'loading' });
      const elapsed = await engine.loadBench(manifest.images);
      setFirstPaintMs(elapsed);
      setPhase({ kind: 'ready' });
      return elapsed;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase({ kind: 'idle' });
      return null;
    } finally {
      unsubscribe();
    }
  }, [engine]);

  const benchmark = useCallback(async () => {
    if (!engine) return;
    let paintMs = firstPaintMs;
    if (engine.getDoc().get().cards.length === 0 || paintMs === null) {
      paintMs = await loadImages();
      if (paintMs === null) return;
    }
    setReport(null);
    const phases = await runBenchmark(engine, (name, index, total) =>
      setPhase({ kind: 'benchmarking', name, index, total }),
    );
    const draft: Omit<BenchReport, 'verdict'> = {
      createdAt: new Date().toISOString(),
      imageCount: engine.getDoc().get().cards.length,
      uncapped: flags.uncapped,
      devicePixelRatio: window.devicePixelRatio,
      refreshRateHz: engine.getRefreshRateHz(),
      firstPaintAllL0Ms: paintMs,
      phases,
      peakTextureMB: engine.textures.peakMB(),
    };
    const full: BenchReport = { ...draft, verdict: judge(draft) };
    setReport(full);
    setPhase({ kind: 'ready' });
    setSavedPath(await window.anye.saveBenchReport(full));
    return full;
  }, [engine, firstPaintMs, flags.uncapped, loadImages]);

  useEffect(() => {
    if (!engine || !flags.autoBench || autoBenchStarted.current) return;
    autoBenchStarted.current = true;
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await benchmark();
      // 等报告卡片画出来再截图退出
      await new Promise((resolve) => setTimeout(resolve, 600));
      window.anye.quit();
    })();
  }, [engine, flags.autoBench, benchmark]);

  const busy = phase.kind === 'preparing' || phase.kind === 'loading' || phase.kind === 'benchmarking';

  return (
    <div className="app">
      <TopBar
        tool={status?.tool ?? 'select'}
        zoom={status?.zoom ?? 1}
        busy={busy || !engine}
        hasImages={(status?.itemCount ?? 0) > 0}
        onTool={(tool) => engine?.setTool(tool)}
        onFit={() => engine?.fitAll()}
        onLoad={() => void loadImages()}
        onBenchmark={() => void benchmark()}
      />

      <main className="workspace">
        <CanvasView onEngine={handleEngine} />

        {status && <PerfPanel status={status} uncapped={flags.uncapped} firstPaintMs={firstPaintMs} />}

        {status?.itemCount === 0 && phase.kind === 'idle' && (
          <div className="empty-hint">
            <div className="empty-title">画布还是空的</div>
            <div className="empty-body">点右上角「载入 200 张测试图」，或者直接「运行性能测试」。</div>
          </div>
        )}

        {busy && <StatusPill phase={phase} />}
        {error && <div className="error-pill">出错了：{error}</div>}

        {report && <BenchReportCard report={report} savedPath={savedPath} onClose={() => setReport(null)} />}

        <footer className="shortcut-bar">
          <span><kbd>空格</kbd> 拖动画布</span>
          <span><kbd>双指</kbd> 平移 / 捏合缩放</span>
          <span><kbd>⌘</kbd>+<kbd>滚轮</kbd> 缩放</span>
          <span><kbd>⇧1</kbd> 全部</span>
          <span><kbd>⇧2</kbd> 选中</span>
          <span><kbd>⇧0</kbd> 100%</span>
          <span><kbd>⌘A</kbd> 全选</span>
          <span><kbd>⌫</kbd> 删除</span>
        </footer>
      </main>
    </div>
  );
}

function StatusPill({ phase }: { phase: Phase }) {
  let text = '';
  if (phase.kind === 'preparing') {
    text = phase.progress
      ? `正在准备测试图 ${phase.progress.done} / ${phase.progress.total}`
      : '正在准备测试图…';
  } else if (phase.kind === 'loading') {
    text = '正在载入纹理…';
  } else if (phase.kind === 'benchmarking') {
    text = `性能测试 ${phase.index + 1} / ${phase.total}：${phase.name}`;
  }
  return <div className="status-pill">{text}</div>;
}
