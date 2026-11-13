import type { BenchPhaseReport, BenchReport, FrameSummary } from '../../../shared/bench';
import type { CanvasCard } from '../../../shared/project';
import { moveCards } from '../document/operations';
import type { CanvasEngine } from './CanvasEngine';
import { unionRects, type Rect } from './geometry';

interface Phase {
  name: string;
  durationMs: number;
  setup(engine: CanvasEngine, bounds: Rect): void;
  step(engine: CanvasEngine, bounds: Rect, t: number): void;
  teardown?(engine: CanvasEngine): void;
}

const SETTLE_MS = 400;

function fitZoom(engine: CanvasEngine, bounds: Rect): number {
  const { screenWidth, screenHeight } = engine.viewport;
  return Math.min((screenWidth - 96) / bounds.width, (screenHeight - 96) / bounds.height);
}

function createPhases(): Phase[] {
  let dragOrigins = new Map<string, CanvasCard>();

  return [
    {
      name: '全景浏览（L0）',
      durationMs: 3000,
      setup(engine, bounds) {
        engine.viewport.zoom = fitZoom(engine, bounds);
        engine.viewport.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      },
      step(engine, bounds, t) {
        const offset = Math.sin(t * Math.PI * 3) * bounds.width * 0.15;
        engine.viewport.centerOn(bounds.x + bounds.width / 2 + offset, bounds.y + bounds.height / 2);
      },
    },
    {
      name: '中景快速平移（持续加载 L1）',
      durationMs: 4500,
      setup(engine, bounds) {
        engine.viewport.zoom = 1;
        engine.viewport.centerOn(bounds.x, bounds.y + bounds.height * 0.2);
      },
      step(engine, bounds, t) {
        const rows = 3;
        const progress = t * rows;
        const row = Math.min(rows - 1, Math.floor(progress));
        const along = progress - row;
        const x = row % 2 === 0 ? along : 1 - along;
        engine.viewport.centerOn(
          bounds.x + bounds.width * x,
          bounds.y + bounds.height * (0.2 + 0.3 * row),
        );
      },
    },
    {
      name: '全景 ↔ L2 往返缩放',
      durationMs: 5000,
      setup(engine, bounds) {
        engine.viewport.zoom = fitZoom(engine, bounds);
        engine.viewport.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      },
      step(engine, bounds, t) {
        const cycles = 2.5;
        const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * cycles);
        const minLog = Math.log(fitZoom(engine, bounds));
        const maxLog = Math.log(6);
        const targets = engine.getDoc().get().cards;
        const target = targets[Math.floor(t * cycles) * 37 % targets.length];
        const zoom = Math.exp(minLog + (maxLog - minLog) * wave);
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        const focusX = target.x + target.width / 2;
        const focusY = target.y + target.height / 2;
        engine.viewport.zoom = zoom;
        engine.viewport.centerOn(centerX + (focusX - centerX) * wave, centerY + (focusY - centerY) * wave);
      },
    },
    {
      name: '同时拖动 50 张图',
      durationMs: 3000,
      setup(engine, bounds) {
        engine.viewport.zoom = fitZoom(engine, bounds) * 1.4;
        engine.viewport.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const selected = engine.getDoc().get().cards.slice(0, 50);
        engine.getSelection().set(selected.map((card) => card.id));
        dragOrigins = new Map(selected.map((card) => [card.id, card]));
        engine.getDoc().beginGesture('移动');
      },
      step(engine, _bounds, t) {
        const angle = t * Math.PI * 4;
        const doc = engine.getDoc();
        doc.updateGesture(moveCards(doc.get(), dragOrigins, Math.cos(angle) * 900 - 900, Math.sin(angle) * 900));
      },
      teardown(engine) {
        engine.getDoc().cancelGesture();
        engine.getSelection().set([]);
      },
    },
    {
      name: '中景快速甩动',
      durationMs: 3000,
      setup(engine, bounds) {
        engine.viewport.zoom = 0.5;
        engine.viewport.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      },
      step(engine, bounds, t) {
        const angle = t * Math.PI * 6;
        engine.viewport.centerOn(
          bounds.x + bounds.width / 2 + Math.cos(angle) * bounds.width * 0.35,
          bounds.y + bounds.height / 2 + Math.sin(angle * 1.3) * bounds.height * 0.35,
        );
      },
    },
  ];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runPhase(engine: CanvasEngine, phase: Phase, bounds: Rect): Promise<FrameSummary | null> {
  return new Promise((resolve) => {
    let startedAt = 0;
    engine.perf.startRecording();
    const remove = engine.addFrameHook((now) => {
      if (startedAt === 0) startedAt = now;
      const t = (now - startedAt) / phase.durationMs;
      if (t >= 1) {
        remove();
        resolve(engine.perf.stopRecording());
        return;
      }
      phase.step(engine, bounds, t);
      engine.invalidateView();
    });
  });
}

export async function runBenchmark(
  engine: CanvasEngine,
  onPhase: (name: string, index: number, total: number) => void,
): Promise<BenchPhaseReport[]> {
  const bounds = unionRects(engine.getDoc().get().cards);
  if (!bounds) return [];
  const phases = createPhases();
  const reports: BenchPhaseReport[] = [];
  engine.textures.resetPeak();

  for (const [index, phase] of phases.entries()) {
    onPhase(phase.name, index, phases.length);
    phase.setup(engine, bounds);
    engine.invalidateView();
    await wait(SETTLE_MS);
    const summary = await runPhase(engine, phase, bounds);
    phase.teardown?.(engine);
    if (summary) reports.push({ name: phase.name, ...summary });
  }

  engine.fitAll(false);
  return reports;
}

const BUDGET_120_MS = 1000 / 120;

/**
 * 判定是否满足 PLAN 第 6 节的性能预算。
 * 不限帧率模式下 GPU 命令队列会严重积压，纹理上传要排队等队列清空，
 * 所以那种模式只用来看渲染吞吐量，卡顿只在开着 vsync 的模式下判定。
 */
export function judge(report: Omit<BenchReport, 'verdict'>): BenchReport['verdict'] {
  const reasons: string[] = [];
  if (report.firstPaintAllL0Ms > 1000) {
    reasons.push(`全部 L0 上屏耗时 ${report.firstPaintAllL0Ms}ms，超过 1000ms`);
  }
  for (const phase of report.phases) {
    if (report.uncapped) {
      if (phase.avgFps < 120) reasons.push(`${phase.name}：不限帧率下平均 ${phase.avgFps}fps，低于 120fps`);
    } else {
      if (phase.cpuMax > BUDGET_120_MS) {
        reasons.push(`${phase.name}：最慢一帧 CPU 耗时 ${phase.cpuMax}ms，超过 120Hz 预算 8.33ms`);
      }
      const target = report.refreshRateHz * 0.95;
      if (phase.avgFps < target) {
        reasons.push(`${phase.name}：平均 ${phase.avgFps}fps，低于屏幕刷新率 ${report.refreshRateHz}Hz 的 95%`);
      }
      if (phase.over60Count / phase.frames > 0.01) {
        reasons.push(`${phase.name}：${phase.over60Count} 帧超过 20ms（掉帧率超过 1%）`);
      }
    }
  }
  return { passed: reasons.length === 0, reasons };
}
