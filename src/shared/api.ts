import type { BenchManifest, BenchProgress, BenchReport } from './bench';
import type { ProjectFile, Version } from './project';

export interface LaunchFlags {
  /** 解除 vsync 与帧率上限，用于在 60Hz 屏幕上测出真实余量 */
  uncapped: boolean;
  /** 启动后自动载入测试图、跑性能测试、写报告并退出 */
  autoBench: boolean;
  /** M1 验收自检：'write' 导入并操作后退出，'verify' 重新打开并核对 */
  m1Check: 'write' | 'verify' | null;
}

export interface RecentProject {
  dir: string;
  name: string;
  openedAt: string;
}

export interface StartupInfo {
  recent: RecentProject[];
  /** 上次打开、并且目录还在的项目 */
  reopen: string | null;
  /** M1 自检使用的临时项目目录 */
  checkDir: string | null;
}

export interface OpenedProject {
  dir: string;
  name: string;
  file: ProjectFile;
  /** 原图文件已经不在的版本 id */
  missingVersionIds: string[];
  warnings: string[];
}

export type ImportSource = { kind: 'path'; path: string } | { kind: 'bytes'; name: string; bytes: Uint8Array };

export interface ImportResult {
  versions: Version[];
  errors: { name: string; message: string }[];
}

export type MenuCommand =
  | 'newProject'
  | 'openProject'
  | 'importImages'
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'duplicate'
  | 'bringToFront'
  | 'sendToBack'
  | 'fitAll'
  | 'zoomToSelection'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'region:theme'
  | 'region:assets'
  | 'region:pages'
  | 'toggleFocus'
  | 'togglePerf'
  | `openRecent:${string}`;

export interface AnyeApi {
  flags: LaunchFlags;

  getStartupInfo(): Promise<StartupInfo>;
  chooseNewProjectDir(): Promise<string | null>;
  chooseProjectDir(): Promise<string | null>;
  openProject(dir: string): Promise<OpenedProject>;
  saveProject(dir: string, file: ProjectFile): Promise<void>;
  pickImages(): Promise<string[]>;
  importImages(sources: ImportSource[]): Promise<ImportResult>;
  getPathForFile(file: File): string;
  revealInFinder(path: string): void;
  onCacheReady(listener: (versionId: string) => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  /** 窗口关闭前主进程会要求把未保存的改动写盘 */
  onFlushRequest(handler: () => Promise<void>): () => void;
  writeCheckFile(name: string, content: string): Promise<string>;
  readCheckFile(name: string): Promise<string | null>;

  prepareBench(count: number): Promise<BenchManifest>;
  onBenchProgress(listener: (progress: BenchProgress) => void): () => void;
  saveBenchReport(report: BenchReport): Promise<string>;
  quit(): void;
}
