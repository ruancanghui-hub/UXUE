import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ImportResult, ImportSource, OpenedProject, ProjectFsChange, RecentProject } from '../shared/api';
import { safeFileName } from '../shared/export';
import { emptyProject, isImageCard, isPageCard, parseProject, PROJECT_FILE, type ProjectFile, type Version } from '../shared/project';
import type { EnsureCacheResult, ImportedImage } from '../shared/workerProtocol';
import type { ImageWorkerClient } from './imageWorkerClient';
import { hashProjectText } from './projectHash';

const RECENT_LIMIT = 10;
const IMPORT_CONCURRENCY = 3;
const CACHE_CONCURRENCY = 2;
const PROJECT_GITIGNORE = '.cache/\n';
/** 自己写盘后忽略一段外部 watch 事件，避免把自己的保存当成外部改动 */
const OWN_SAVE_IGNORE_MS = 2000;
/** project.json 变动防抖：等 rename / 同步盘写完再读 */
const PROJECT_WATCH_DEBOUNCE_MS = 1000;
/** 主题说明放在项目目录的这个子目录里 */
export const THEMES_DIR = 'themes';

export interface ProjectServiceEvents {
  onCacheReady(versionId: string): void;
  onRecentChanged(recent: RecentProject[]): void;
  onFsChange(change: ProjectFsChange): void;
}

/** 一个窗口同一时刻只打开一个项目；所有读写都限制在当前项目目录内 */
export class ProjectService {
  private current: { dir: string } | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private cacheGeneration = 0;
  private watcher: FSWatcher | null = null;
  private ignoreUntil = 0;
  /** 最近一次自己写入（或打开时读到）的 project.json 内容指纹 */
  private lastSavedHash: string | null = null;
  private projectWatchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly worker: ImageWorkerClient,
    private readonly recentFile: string,
    private readonly events: ProjectServiceEvents,
    private readonly onRootChanged: (dir: string) => void,
    /** 自检用的临时项目不进最近项目列表 */
    private readonly trackRecent: boolean,
  ) {}

  currentDir(): string | null {
    return this.current?.dir ?? null;
  }

  async open(dir: string): Promise<OpenedProject> {
    await this.writeChain;
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`找不到目录：${dir}`);

    const file = join(dir, PROJECT_FILE);
    let project: ProjectFile;
    let warnings: string[] = [];
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text === null) {
      project = emptyProject();
      await this.initializeDirectory(dir, project);
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('project.json 已损坏，不是合法的 JSON');
      }
      ({ project, warnings } = parseProject(raw));
      this.lastSavedHash = hashProjectText(text);
    }

    this.current = { dir };
    this.onRootChanged(dir);
    this.startWatch(dir);
    if (this.trackRecent) await this.touchRecent(dir);

    const versions = collectVersions(project);
    const missing = await this.missingIds(dir, versions);
    void this.ensureCaches(dir, versions);

    return {
      dir,
      name: basename(dir),
      file: project,
      missingVersionIds: missing,
      warnings,
    };
  }

  /** 写入串行化；先写临时文件再改名，写到一半断电也不会留下半个 project.json */
  save(dir: string, project: ProjectFile): Promise<void> {
    if (this.current?.dir !== dir) return Promise.reject(new Error('只能保存当前打开的项目'));
    this.ignoreUntil = Date.now() + OWN_SAVE_IGNORE_MS;
    const run = async (): Promise<void> => {
      const target = join(dir, PROJECT_FILE);
      const temp = `${target}.tmp`;
      const text = JSON.stringify(project, null, 2);
      await writeFile(temp, text);
      await rename(temp, target);
      this.lastSavedHash = hashProjectText(text);
      this.ignoreUntil = Date.now() + OWN_SAVE_IGNORE_MS;
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }

  /** 按当前 project.json 里的版本重新检查原图是否还在，并补缓存 */
  async refreshMissing(): Promise<string[]> {
    const dir = this.current?.dir;
    if (!dir) return [];
    const text = await readFile(join(dir, PROJECT_FILE), 'utf8');
    const { project } = parseProject(JSON.parse(text));
    const versions = collectVersions(project);
    const missing = await this.missingIds(dir, versions);
    void this.ensureCaches(dir, versions);
    return missing;
  }

  async saveThemeMarkdown(name: string, markdown: string): Promise<string> {
    const dir = this.current?.dir;
    if (!dir) throw new Error('还没有打开项目');
    await mkdir(join(dir, THEMES_DIR), { recursive: true });
    const path = join(dir, THEMES_DIR, `${safeFileName(name)}.md`);
    await writeFile(path, markdown);
    return path;
  }

  async importImages(sources: ImportSource[]): Promise<ImportResult> {
    const dir = this.current?.dir;
    if (!dir) throw new Error('还没有打开项目');
    this.ignoreUntil = Date.now() + OWN_SAVE_IGNORE_MS;
    const versions: (Version | null)[] = new Array(sources.length).fill(null);
    const errors: ImportResult['errors'] = [];

    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < sources.length) {
        const index = next++;
        const source = sources[index];
        const name = source.kind === 'path' ? basename(source.path) : source.name;
        const key = randomUUID();
        try {
          if (source.kind === 'crop' && (source.file.includes('..') || source.file.startsWith('/'))) {
            throw new Error('裁剪的原图路径不合法');
          }
          if (source.kind === 'sketch' && !(source.width > 0 && source.height > 0 && source.width <= 8000 && source.height <= 8000)) {
            throw new Error('布局草图的尺寸不合法');
          }
          const imported = await this.worker.request<ImportedImage>({ type: 'importImage', dir, key, source });
          versions[index] = {
            id: key,
            file: imported.file,
            width: imported.width,
            height: imported.height,
            createdAt: new Date().toISOString(),
            origin: 'import',
            sourceName: name,
          };
          this.ignoreUntil = Date.now() + OWN_SAVE_IGNORE_MS;
        } catch (error) {
          errors.push({ name, message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, lane));
    this.ignoreUntil = Date.now() + OWN_SAVE_IGNORE_MS;
    return { versions: versions.filter((v): v is Version => v !== null), errors };
  }

  async readRecent(): Promise<RecentProject[]> {
    try {
      const list = JSON.parse(await readFile(this.recentFile, 'utf8')) as RecentProject[];
      return Array.isArray(list) ? list.filter((item) => typeof item?.dir === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 最近项目里第一个目录还在的 */
  async findReopen(): Promise<string | null> {
    for (const item of await this.readRecent()) {
      const info = await stat(item.dir).catch(() => null);
      if (info?.isDirectory()) return item.dir;
    }
    return null;
  }

  private startWatch(dir: string): void {
    this.stopWatch();
    try {
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename || Date.now() < this.ignoreUntil) return;
        const relative = filename.replace(/\\/g, '/');
        if (relative.startsWith('.cache/') || relative === '.cache' || relative.endsWith('.tmp') || relative.endsWith('.DS_Store')) {
          return;
        }
        if (relative === PROJECT_FILE || relative.endsWith(`/${PROJECT_FILE}`)) {
          this.scheduleProjectChangeCheck(dir);
          return;
        }
        if (relative === 'assets' || relative.startsWith('assets/')) {
          this.events.onFsChange({ kind: 'assets', path: join(dir, relative) });
        }
      });
      this.watcher.on('error', (error) => console.warn('[watch]', error));
    } catch (error) {
      console.warn('[watch] 无法监听项目目录', error);
    }
  }

  /** 防抖后读盘：内容与自己上次写入相同则忽略（同步盘原样回写） */
  private scheduleProjectChangeCheck(dir: string): void {
    if (this.projectWatchTimer) clearTimeout(this.projectWatchTimer);
    this.projectWatchTimer = setTimeout(() => {
      this.projectWatchTimer = null;
      void this.emitProjectChangeIfExternal(dir);
    }, PROJECT_WATCH_DEBOUNCE_MS);
  }

  private async emitProjectChangeIfExternal(dir: string): Promise<void> {
    if (this.current?.dir !== dir) return;
    if (Date.now() < this.ignoreUntil) return;
    try {
      const text = await readFile(join(dir, PROJECT_FILE), 'utf8');
      const hash = hashProjectText(text);
      if (this.lastSavedHash && hash === this.lastSavedHash) return;
      this.events.onFsChange({ kind: 'project', path: join(dir, PROJECT_FILE) });
    } catch (error) {
      console.warn('[watch] 读取 project.json 失败', error);
    }
  }

  private stopWatch(): void {
    if (this.projectWatchTimer) {
      clearTimeout(this.projectWatchTimer);
      this.projectWatchTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private async missingIds(dir: string, versions: Version[]): Promise<string[]> {
    const missing = await Promise.all(
      versions.map(async (version) => ((await exists(join(dir, version.file))) ? null : version.id)),
    );
    return missing.filter((id): id is string => id !== null);
  }

  private async initializeDirectory(dir: string, project: ProjectFile): Promise<void> {
    this.ignoreUntil = Date.now() + OWN_SAVE_IGNORE_MS;
    await mkdir(join(dir, 'assets'), { recursive: true });
    const text = JSON.stringify(project, null, 2);
    await writeFile(join(dir, PROJECT_FILE), text);
    this.lastSavedHash = hashProjectText(text);
    if (!(await exists(join(dir, '.gitignore')))) await writeFile(join(dir, '.gitignore'), PROJECT_GITIGNORE);
  }

  private async touchRecent(dir: string): Promise<void> {
    const list = (await this.readRecent()).filter((item) => item.dir !== dir);
    list.unshift({ dir, name: basename(dir), openedAt: new Date().toISOString() });
    const trimmed = list.slice(0, RECENT_LIMIT);
    await writeFile(this.recentFile, JSON.stringify(trimmed, null, 2));
    this.events.onRecentChanged(trimmed);
  }

  /** 后台检查每个版本的缓存，缺了就从原图重建；切换项目后旧的检查自动停止 */
  private async ensureCaches(dir: string, versions: Version[]): Promise<void> {
    const generation = ++this.cacheGeneration;
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < versions.length && generation === this.cacheGeneration) {
        const version = versions[next++];
        try {
          const result = await this.worker.request<EnsureCacheResult>({
            type: 'ensureCache',
            dir,
            key: version.id,
            file: version.file,
          });
          if (result.status === 'rebuilt' && generation === this.cacheGeneration) {
            this.events.onCacheReady(version.id);
          }
        } catch (error) {
          console.warn(`[cache] ${version.id} 重建失败`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: CACHE_CONCURRENCY }, lane));
  }
}

function collectVersions(project: ProjectFile): Version[] {
  return [
    ...project.cards.filter(isImageCard).flatMap((card) => card.versions),
    ...project.cards.filter(isPageCard).flatMap((card) => (card.base ? [card.base] : [])),
  ];
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}
