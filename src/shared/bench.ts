export const ASSET_SCHEME = 'ue-asset';
export const BENCH_HOST = 'bench';
export const PROJECT_HOST = 'project';

/** L0 = 256px、L1 = 1024px、L2 = 原图切块 */
export type TextureLevel = 0 | 1 | 2;
export const TEXTURE_LEVELS: readonly TextureLevel[] = [0, 1, 2];

export interface BenchImage {
  key: string;
  width: number;
  height: number;
  /** 原图的绝对路径，M1 自检用它来走真实的导入流程 */
  originalPath: string;
}

export interface BenchManifest {
  images: BenchImage[];
  reused: boolean;
  elapsedMs: number;
}

export interface BenchProgress {
  done: number;
  total: number;
}

export interface FrameSummary {
  frames: number;
  avgFps: number;
  intervalP50: number;
  intervalP95: number;
  intervalP99: number;
  /** 帧间隔超过 10ms（120Hz 预算留 20% 抖动余量）的帧占比 */
  over120Budget: number;
  /** 帧间隔超过 20ms（60Hz 预算留 20% 抖动余量）的帧数 */
  over60Count: number;
  cpuP50: number;
  cpuP95: number;
  cpuMax: number;
  /** 最慢一帧的耗时拆分：脚本驱动 / 视口 / 调度 / 提交纹理 / 渲染 / 本帧提交的纹理块数 */
  worstFrame?: {
    cpuMs: number;
    hooksMs: number;
    viewMs: number;
    scheduleMs: number;
    commitMs: number;
    renderMs: number;
    commits: number;
  };
}

export interface BenchPhaseReport extends FrameSummary {
  name: string;
}

export interface BenchReport {
  createdAt: string;
  imageCount: number;
  uncapped: boolean;
  devicePixelRatio: number;
  refreshRateHz: number;
  /** 载入后到全部 L0 纹理上屏的耗时 */
  firstPaintAllL0Ms: number;
  phases: BenchPhaseReport[];
  peakTextureMB: number;
  verdict: { passed: boolean; reasons: string[] };
}
