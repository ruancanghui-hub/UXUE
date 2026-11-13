import type { FrameSummary } from '../../../shared/bench';

const BUDGET_120 = 1000 / 120;
const BUDGET_60 = 1000 / 60;
const IDLE_AFTER_MS = 300;

export interface FrameBreakdown {
  hooksMs: number;
  viewMs: number;
  scheduleMs: number;
  commitMs: number;
  renderMs: number;
  commits: number;
}

interface Recording {
  intervals: number[];
  cpuTimes: number[];
  worst: (FrameBreakdown & { cpuMs: number }) | null;
}

/**
 * 记录每一帧的间隔和 CPU 耗时（更新 + 提交渲染）。
 * 画布按需渲染：只有上一个 rAF 也渲染了，这一帧的间隔才计入统计；
 * 连续渲染中出现的长间隔就是真实卡顿，必须计入。
 */
export class PerfMonitor {
  private intervals: number[] = [];
  private cpuTimes: number[] = [];
  private lastRenderAt = 0;
  private recording: Recording | null = null;

  recordFrame(frameStart: number, cpuMs: number, renderedPreviousTick: boolean, breakdown: FrameBreakdown): void {
    const interval = frameStart - this.lastRenderAt;
    const counted = renderedPreviousTick && this.lastRenderAt > 0;
    this.lastRenderAt = frameStart;
    if (!counted) return;
    this.intervals.push(interval);
    this.cpuTimes.push(cpuMs);
    if (this.intervals.length > 240) {
      this.intervals.shift();
      this.cpuTimes.shift();
    }
    const recording = this.recording;
    if (recording) {
      recording.intervals.push(interval);
      recording.cpuTimes.push(cpuMs);
      if (!recording.worst || cpuMs > recording.worst.cpuMs) recording.worst = { cpuMs, ...breakdown };
    }
  }

  /** 最近约 2 秒的统计，供性能面板展示 */
  recent(): FrameSummary | null {
    return summarize(this.intervals, this.cpuTimes);
  }

  isIdle(now: number): boolean {
    return now - this.lastRenderAt > IDLE_AFTER_MS;
  }

  startRecording(): void {
    this.recording = { intervals: [], cpuTimes: [], worst: null };
  }

  stopRecording(): FrameSummary | null {
    const recording = this.recording;
    this.recording = null;
    if (!recording) return null;
    const summary = summarize(recording.intervals, recording.cpuTimes);
    if (summary && recording.worst) {
      summary.worstFrame = {
        cpuMs: round(recording.worst.cpuMs),
        hooksMs: round(recording.worst.hooksMs),
        viewMs: round(recording.worst.viewMs),
        scheduleMs: round(recording.worst.scheduleMs),
        commitMs: round(recording.worst.commitMs),
        renderMs: round(recording.worst.renderMs),
        commits: recording.worst.commits,
      };
    }
    return summary;
  }
}

export function summarize(intervals: number[], cpuTimes: number[]): FrameSummary | null {
  if (intervals.length === 0) return null;
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const sortedCpu = [...cpuTimes].sort((a, b) => a - b);
  const total = intervals.reduce((sum, value) => sum + value, 0);
  return {
    frames: intervals.length,
    avgFps: round((intervals.length / total) * 1000),
    intervalP50: round(percentile(sortedIntervals, 0.5)),
    intervalP95: round(percentile(sortedIntervals, 0.95)),
    intervalP99: round(percentile(sortedIntervals, 0.99)),
    over120Budget: round(intervals.filter((value) => value > BUDGET_120 * 1.2).length / intervals.length),
    over60Count: intervals.filter((value) => value > BUDGET_60 * 1.2).length,
    cpuP50: round(percentile(sortedCpu, 0.5)),
    cpuP95: round(percentile(sortedCpu, 0.95)),
    cpuMax: round(sortedCpu[sortedCpu.length - 1]),
  };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
