import type { AssistantRequest, AssistantResponse } from './assistant';
import type { BenchManifest, BenchProgress, BenchReport } from './bench';
import type { ExportResult, PageExportPlan } from './export';
import type {
  AssistantProviderId,
  GenerationConfig,
  GenerationRequest,
  JobUpdate,
  PromptSettings,
  ProviderId,
} from './generation';
import type { ProjectFile, Version } from './project';

export interface PromptTemplate {
  id: string;
  name: string;
  text: string;
  defaultSettings?: PromptSettings;
}

export interface ProjectFsChange {
  kind: 'project' | 'assets';
  path: string;
}

export type CheckPhase = 'write' | 'verify';

export interface LaunchFlags {
  /** 解除 vsync 与帧率上限，用于在 60Hz 屏幕上测出真实余量 */
  uncapped: boolean;
  /** 启动后自动载入测试图、跑性能测试、写报告并退出 */
  autoBench: boolean;
  /** M1 验收自检：'write' 导入并操作后退出，'verify' 重新打开并核对 */
  m1Check: CheckPhase | null;
  /** M2 验收自检：用本地模拟跑"照片 → 简笔画 → 3D"两步链路 */
  m2Check: CheckPhase | null;
  /** M3 验收自检：用本地模拟助手生成主题卡、为四个金刚位写提示词卡 */
  m3Check: CheckPhase | null;
  /** M4 验收自检：完整跑一遍寿司首页（主题 → 素材 → 页面 → 导出） */
  m4Check: CheckPhase | null;
  /** 真实调用自检：按设置跑一次助手和一张生图，会产生少量费用；可以只测其中一项 */
  realCheck: false | 'all' | 'assistant' | 'image';
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
  | 'groupSelection'
  | 'ungroupSelection'
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
  | 'newPrompt'
  | 'generate'
  | 'openSettings'
  | 'toggleAssistant'
  | 'newPageFromLowFi'
  | 'newBlankPage'
  | 'exportPage'
  | 'commandPalette'
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
  /** 项目目录被外部改动时（忽略自己保存后的短窗口） */
  onProjectFsChange(listener: (change: ProjectFsChange) => void): () => void;
  /** 窗口关闭前主进程会要求把未保存的改动写盘 */
  onFlushRequest(handler: () => Promise<void>): () => void;
  writeCheckFile(name: string, content: string): Promise<string>;
  readCheckFile(name: string): Promise<string | null>;

  getGenerationConfig(): Promise<GenerationConfig>;
  updateGenerationConfig(patch: {
    provider?: ProviderId;
    model?: string;
    assistantModel?: string;
    assistantProvider?: AssistantProviderId;
    siliconflowEditModel?: string;
    siliconflowT2iModel?: string;
    newapiBaseUrl?: string;
    newapiModel?: string;
    newapiAssistantModel?: string;
  }): Promise<GenerationConfig>;
  setApiKey(provider: 'openai' | 'siliconflow' | 'newapi', key: string | null): Promise<GenerationConfig>;
  testConnection(provider: 'openai' | 'siliconflow' | 'newapi'): Promise<string>;
  submitGeneration(request: GenerationRequest): Promise<JobUpdate>;
  cancelGeneration(jobId: string): void;
  cancelAllGenerations(): void;
  retryDownload(jobId: string): Promise<void>;
  onGenerationUpdate(listener: (update: JobUpdate) => void): () => void;
  askAssistant(request: AssistantRequest): Promise<AssistantResponse>;
  exportPage(projectDir: string, plan: PageExportPlan): Promise<ExportResult>;
  /** 开发和验收用：生成一张首页低保真线框图，返回它的路径 */
  sampleLowFi(): Promise<string>;

  listPromptTemplates(): Promise<PromptTemplate[]>;
  createPromptTemplate(name: string, text: string, settings?: PromptSettings): Promise<PromptTemplate>;
  updatePromptTemplate(
    id: string,
    patch: Partial<Pick<PromptTemplate, 'name' | 'text' | 'defaultSettings'>>,
  ): Promise<PromptTemplate | null>;
  removePromptTemplate(id: string): Promise<boolean>;
  /** 重新检查当前项目里原图是否还在，返回缺失的 version id */
  refreshMissingVersions(): Promise<string[]>;

  prepareBench(count: number): Promise<BenchManifest>;
  onBenchProgress(listener: (progress: BenchProgress) => void): () => void;
  saveBenchReport(report: BenchReport): Promise<string>;
  quit(): void;
}
