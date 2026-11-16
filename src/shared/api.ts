import type { AssistantRequest, AssistantResponse } from './assistant';
import type { ConfigImportResult } from './configTransfer';
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
  kind: 'project' | 'assets' | 'docs';
  path: string;
}

export type ProjectDocRole = import('./projectDocs').ProjectDocRole;

export interface ProjectDocSnapshot {
  role: ProjectDocRole;
  relativePath: string;
  label: string;
  description: string;
  /** 文件是否已在磁盘上（ensure 后应为 true） */
  exists: boolean;
  content: string;
  absolutePath: string;
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
  m5Check: CheckPhase | null;
  /** 真实调用自检：按设置跑一次助手和一张生图，会产生少量费用；可以只测其中一项 */
  realCheck: false | 'all' | 'assistant' | 'image' | 'blocks';
  /** --real-check=blocks 时拆解的图片路径（--check-image=…） */
  checkImage: string | null;
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

export type ImportSource =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; name: string; bytes: Uint8Array }
  /** 从项目里已有的原图裁一块（像素坐标），比如区块截图 */
  | { kind: 'crop'; name: string; file: string; rect: { left: number; top: number; width: number; height: number } }
  /** 布局草图示意图：白底上按像素坐标画灰框并写上名字 */
  | { kind: 'sketch'; name: string; width: number; height: number; boxes: SketchBox[]; strokes: SketchStroke[]; texts: SketchLabel[] };

/** 示意图上的一笔：points 是像素 [x0, y0, x1, y1, …] */
export interface SketchStroke {
  points: number[];
  width: number;
}

/** 示意图上的一段草图文字：x / y 是左上角像素 */
export interface SketchLabel {
  text: string;
  x: number;
  y: number;
  fontSize: number;
}

export interface SketchBox {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  | 'alignLeft'
  | 'alignCenterX'
  | 'alignRight'
  | 'alignTop'
  | 'alignCenterY'
  | 'alignBottom'
  | 'distributeX'
  | 'distributeY'
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
  | 'toWireframe'
  | 'copyThemeMarkdown'
  | 'saveThemeMarkdown'
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
  copyText(text: string): Promise<void>;
  /** 主题说明写到当前项目的 themes/名字.md（同名覆盖），返回完整路径 */
  saveThemeMarkdown(name: string, markdown: string): Promise<string>;
  /** 列出四类项目文稿（缺失则先写入模板） */
  listProjectDocs(): Promise<ProjectDocSnapshot[]>;
  readProjectDoc(role: ProjectDocRole): Promise<ProjectDocSnapshot>;
  writeProjectDoc(role: ProjectDocRole, content: string): Promise<ProjectDocSnapshot>;
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
  /** 导出模型配置（含明文 API Key 和提示词模板）；返回文件路径，取消为 null */
  exportConfig(): Promise<string | null>;
  /** 导入模型配置；取消为 null */
  importConfig(): Promise<(ConfigImportResult & { config: GenerationConfig }) | null>;
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
