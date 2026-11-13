export const PROJECT_FILE = 'project.json';
export const PROJECT_SCHEMA_VERSION = 1;

export type RegionId = 'theme' | 'assets' | 'pages';

/** 画布上按阶段划分的区域：视觉主题区、核心素材区、高保真页面区 */
export interface Region {
  id: RegionId;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一次导入或生成得到的一张图片 */
export interface Version {
  id: string;
  /** 相对项目目录的原图路径 */
  file: string;
  /** 原图像素尺寸 */
  width: number;
  height: number;
  createdAt: string;
  origin: 'import';
  /** 导入时的原文件名 */
  sourceName?: string;
}

/** 画布上带版本栈的图片对象 */
export interface ImageCard {
  kind: 'image';
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  versions: Version[];
  currentVersionId: string;
}

export interface ViewportState {
  originX: number;
  originY: number;
  zoom: number;
}

export interface ProjectFile {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  regions: Region[];
  /** 数组顺序即绘制顺序，越靠后越在上层 */
  cards: ImageCard[];
  viewport: ViewportState | null;
}

const REGION_WIDTH = 6000;
const REGION_HEIGHT = 4000;
const REGION_GAP = 600;

export function defaultRegions(): Region[] {
  const names: [RegionId, string][] = [
    ['theme', '视觉主题区'],
    ['assets', '核心素材区'],
    ['pages', '高保真页面区'],
  ];
  return names.map(([id, name], index) => ({
    id,
    name,
    x: index * (REGION_WIDTH + REGION_GAP),
    y: 0,
    width: REGION_WIDTH,
    height: REGION_HEIGHT,
  }));
}

export function emptyProject(): ProjectFile {
  return { schemaVersion: PROJECT_SCHEMA_VERSION, regions: defaultRegions(), cards: [], viewport: null };
}

export function currentVersion(card: ImageCard): Version {
  return card.versions.find((version) => version.id === card.currentVersionId) ?? card.versions[card.versions.length - 1];
}

export interface ParseResult {
  project: ProjectFile;
  /** 被跳过的无效内容，打开项目时提示给用户 */
  warnings: string[];
}

/** 读入 project.json：结构不对的部分跳过并记下原因，不因为一处坏数据打不开整个项目 */
export function parseProject(raw: unknown): ParseResult {
  const warnings: string[] = [];
  if (!isObject(raw)) throw new Error('project.json 不是一个 JSON 对象');
  if (raw.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`project.json 的版本是 ${String(raw.schemaVersion)}，这个版本的暗夜精灵只认识 ${PROJECT_SCHEMA_VERSION}`);
  }

  const defaults = defaultRegions();
  const regions = defaults.map((fallback) => {
    const found = Array.isArray(raw.regions) ? raw.regions.find((r) => isObject(r) && r.id === fallback.id) : undefined;
    if (isObject(found) && isRect(found)) {
      return { ...fallback, x: found.x, y: found.y, width: found.width, height: found.height };
    }
    return fallback;
  });

  const cards: ImageCard[] = [];
  const seen = new Set<string>();
  for (const [index, value] of (Array.isArray(raw.cards) ? raw.cards : []).entries()) {
    const card = parseCard(value);
    if (!card) {
      warnings.push(`第 ${index + 1} 个图像卡结构不完整，已跳过`);
      continue;
    }
    if (seen.has(card.id)) {
      warnings.push(`图像卡 ${card.id} 重复，已跳过后一个`);
      continue;
    }
    seen.add(card.id);
    cards.push(card);
  }

  const viewport = isObject(raw.viewport) && isFiniteNumber(raw.viewport.originX) && isFiniteNumber(raw.viewport.originY) &&
    isFiniteNumber(raw.viewport.zoom) && raw.viewport.zoom > 0
    ? { originX: raw.viewport.originX, originY: raw.viewport.originY, zoom: raw.viewport.zoom }
    : null;

  return { project: { schemaVersion: PROJECT_SCHEMA_VERSION, regions, cards, viewport }, warnings };
}

function parseCard(value: unknown): ImageCard | null {
  if (!isObject(value) || value.kind !== 'image' || typeof value.id !== 'string' || !isRect(value)) return null;
  if (value.width <= 0 || value.height <= 0) return null;
  const versions = Array.isArray(value.versions) ? value.versions.map(parseVersion).filter((v): v is Version => v !== null) : [];
  if (versions.length === 0) return null;
  const currentVersionId = versions.some((v) => v.id === value.currentVersionId)
    ? (value.currentVersionId as string)
    : versions[versions.length - 1].id;
  return {
    kind: 'image',
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '未命名',
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    versions,
    currentVersionId,
  };
}

function parseVersion(value: unknown): Version | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.file !== 'string') return null;
  if (!isFiniteNumber(value.width) || !isFiniteNumber(value.height) || value.width <= 0 || value.height <= 0) return null;
  if (value.file.includes('..') || value.file.startsWith('/')) return null;
  return {
    id: value.id,
    file: value.file,
    width: value.width,
    height: value.height,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    origin: 'import',
    ...(typeof value.sourceName === 'string' ? { sourceName: value.sourceName } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRect(value: Record<string, unknown>): value is Record<string, unknown> & { x: number; y: number; width: number; height: number } {
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.width) && isFiniteNumber(value.height);
}
