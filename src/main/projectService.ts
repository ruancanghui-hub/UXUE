import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ImportResult, ImportSource, OpenedProject, RecentProject } from '../shared/api';
import { emptyProject, isImageCard, parseProject, PROJECT_FILE, type ProjectFile, type Version } from '../shared/project';
import type { EnsureCacheResult, ImportedImage } from '../shared/workerProtocol';
import type { ImageWorkerClient } from './imageWorkerClient';

const RECENT_LIMIT = 10;
const IMPORT_CONCURRENCY = 3;
const CACHE_CONCURRENCY = 2;
const PROJECT_GITIGNORE = '.cache/\n';

export interface ProjectServiceEvents {
  onCacheReady(versionId: string): void;
  onRecentChanged(recent: RecentProject[]): void;
}

/** 一个窗口同一时刻只打开一个项目；所有读写都限制在当前项目目录内 */
export class ProjectService {
  private current: { dir: string } | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private cacheGeneration = 0;

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
    }

    this.current = { dir };
    this.onRootChanged(dir);
    if (this.trackRecent) await this.touchRecent(dir);

    const versions = project.cards.filter(isImageCard).flatMap((card) => card.versions);
    const missing = await Promise.all(
      versions.map(async (version) => ((await exists(join(dir, version.file))) ? null : version.id)),
    );
    void this.ensureCaches(dir, versions);

    return {
      dir,
      name: basename(dir),
      file: project,
      missingVersionIds: missing.filter((id): id is string => id !== null),
      warnings,
    };
  }

  /** 写入串行化；先写临时文件再改名，写到一半断电也不会留下半个 project.json */
  save(dir: string, project: ProjectFile): Promise<void> {
    if (this.current?.dir !== dir) return Promise.reject(new Error('只能保存当前打开的项目'));
    const run = async (): Promise<void> => {
      const target = join(dir, PROJECT_FILE);
      const temp = `${target}.tmp`;
      await writeFile(temp, JSON.stringify(project, null, 2));
      await rename(temp, target);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async importImages(sources: ImportSource[]): Promise<ImportResult> {
    const dir = this.current?.dir;
    if (!dir) throw new Error('还没有打开项目');
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
        } catch (error) {
          errors.push({ name, message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, lane));
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

  private async initializeDirectory(dir: string, project: ProjectFile): Promise<void> {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, PROJECT_FILE), JSON.stringify(project, null, 2));
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

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}
