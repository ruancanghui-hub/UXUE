import type { BenchProgress } from './bench';

export interface GeneratedImage {
  key: string;
  width: number;
  height: number;
  /** 原图，相对项目目录 */
  original: string;
}

export interface ImportedImage {
  /** 相对项目目录的原图路径 */
  file: string;
  width: number;
  height: number;
}

export type WorkerRequest =
  | { requestId: number; type: 'prepareBench'; dir: string; count: number }
  | { requestId: number; type: 'selfTest'; dir: string }
  | {
      requestId: number;
      type: 'importImage';
      dir: string;
      key: string;
      source: { kind: 'path'; path: string } | { kind: 'bytes'; name: string; bytes: Uint8Array };
    }
  | { requestId: number; type: 'ensureCache'; dir: string; key: string; file: string }
  /** 把输入图缩到长边 ≤ 2048 的 PNG，减小上传体积和图像输入 token */
  | { requestId: number; type: 'prepareInput'; path: string; maxEdge?: number }
  /** 导出一个页面：整页 PNG、分层 SVG、素材包（每个素材 @1x/@2x/@3x）和清单 */
  | ({ requestId: number; type: 'exportPage' } & ExportRequest)
  /** 开发和验收用：生成一张 iPhone 3 倍尺寸的首页低保真线框图 */
  | { requestId: number; type: 'sampleLowFi'; path: string }
  /** 本地模拟生成：基于输入图做明显可辨的变换，不联网 */
  | {
      requestId: number;
      type: 'mockGenerate';
      inputs: string[];
      prompt: string;
      width: number;
      height: number;
      count: number;
      seed: number;
    };

export type ExportRequest = { dir: string; folder: string; plan: import('./export').PageExportPlan };

export interface PreparedInput {
  base64: string;
  mime: 'image/png';
}

export interface MockGenerateResult {
  images: Uint8Array[];
}

export type WorkerMessage =
  | { requestId: number; type: 'progress'; progress: BenchProgress }
  | { requestId: number; type: 'result'; ok: true; data: unknown }
  | { requestId: number; type: 'result'; ok: false; error: string };

export interface PrepareBenchResult {
  images: GeneratedImage[];
  reused: boolean;
}

export interface SelfTestResult {
  sharpVersion: string;
  files: { file: string; width: number; height: number; format: string }[];
}

export interface EnsureCacheResult {
  /** 'fresh' 缓存本来就是好的；'rebuilt' 刚重建；'missing' 原图不在，无法重建 */
  status: 'fresh' | 'rebuilt' | 'missing';
}
