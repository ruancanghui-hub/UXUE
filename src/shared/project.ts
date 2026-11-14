import { DEFAULT_PROMPT_SETTINGS, MAX_COUNT, MIN_COUNT, QUALITIES, SIZE_OPTIONS, type PromptSettings } from './generation';

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

/** 生成得到的版本记下的来源，方便以后复现和判断是否已过期 */
export interface GenerationRecord {
  promptCardId: string;
  /** 实际发送给模型的提示词全文 */
  prompt: string;
  /** 生成时各输入图像卡的当前版本，按 Image 1、Image 2… 的顺序 */
  inputVersionIds: string[];
  provider: string;
  model: string;
  quality: string;
  size: string;
  /** 这一张分摊到的实际花费（美元；硅基流动等人民币计价的供应商为 0，见 costCny） */
  costUsd: number;
  /** 人民币计价的供应商（硅基流动）这一张的花费 */
  costCny?: number;
  jobId: string;
  /** 生成时附加了规则的生效主题卡；没有附加时为 null */
  themeCardId: string | null;
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
  origin: 'import' | 'generate';
  /** 导入时的原文件名 */
  sourceName?: string;
  generation?: GenerationRecord;
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

/** 画布上的一段结构化提示词；inputs 依次对应 {{Image 1}}、{{Image 2}}… */
export interface PromptCard {
  kind: 'prompt';
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** 输入图像卡 id */
  inputs: string[];
  /** 生成结果所在的图像卡；第一次生成前为 null */
  outputCardId: string | null;
  settings: PromptSettings;
}

export interface ThemeColor {
  /** 在配色里的角色，比如主色、邻近辅助色、深色、暖白 */
  role: string;
  name: string;
  hex: string;
  /** 这个颜色用在哪里 */
  note: string;
}

export interface ThemeRules {
  shape: string;
  material: string;
  lighting: string;
  color: string;
}

/** 承载一套视觉主题的卡片；同一项目可以有多张候选，同一时刻只有一张生效 */
export interface ThemeCard {
  kind: 'theme';
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 产品主题，比如"日式寿司点餐" */
  topic: string;
  keywords: string[];
  cues: string[];
  palette: ThemeColor[];
  rules: ThemeRules;
}

/** 以低保真原型为底、摆放核心素材的框；导出时就是一张高保真页面 */
export interface PageCard {
  kind: 'page';
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 低保真原型；没有时只画背景色 */
  base: Version | null;
  background: string;
  /** 设备预设 id；null 表示按低保真原型（或画布）尺寸 */
  devicePreset: string | null;
  /** 导出倍数，相对页面的逻辑尺寸 */
  exportScale: number;
}

/** 页面框里对某张核心素材的引用：显示它的当前版本 */
export interface RefCard {
  kind: 'ref';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageCardId: string;
  /** 所在页面框；拖出页面后为 null */
  pageId: string | null;
}

export type CanvasCard = ImageCard | PromptCard | ThemeCard | PageCard | RefCard;

export function isPageCard(card: CanvasCard): card is PageCard {
  return card.kind === 'page';
}

export function isRefCard(card: CanvasCard): card is RefCard {
  return card.kind === 'ref';
}

export const DEVICE_PRESETS = [
  { id: 'iphone', label: 'iPhone 393 × 852', width: 393, height: 852 },
  { id: 'android', label: 'Android 360 × 800', width: 360, height: 800 },
  { id: 'ipad', label: 'iPad 820 × 1180', width: 820, height: 1180 },
  { id: 'desktop', label: '桌面 1440 × 900', width: 1440, height: 900 },
  { id: 'desktop-hd', label: '桌面 1920 × 1080', width: 1920, height: 1080 },
] as const;

/** 低保真原型的像素尺寸正好是某个设备的 1/2/3 倍时认出来 */
export function detectPreset(width: number, height: number): { presetId: string; scale: number } | null {
  for (const preset of DEVICE_PRESETS) {
    for (const scale of [1, 2, 3]) {
      if (Math.abs(width - preset.width * scale) <= 2 && Math.abs(height - preset.height * scale) <= 4) {
        return { presetId: preset.id, scale };
      }
    }
  }
  return null;
}

/** 页面的逻辑尺寸：有设备预设用预设，否则用低保真原型像素尺寸，再否则用画布尺寸 */
export function pageLogicalSize(page: PageCard): { width: number; height: number } {
  const preset = DEVICE_PRESETS.find((p) => p.id === page.devicePreset);
  if (preset) return { width: preset.width, height: preset.height };
  if (page.base) return { width: page.base.width, height: page.base.height };
  return { width: Math.round(page.width), height: Math.round(page.height) };
}

export function isImageCard(card: CanvasCard): card is ImageCard {
  return card.kind === 'image';
}

export function isPromptCard(card: CanvasCard): card is PromptCard {
  return card.kind === 'prompt';
}

export function isThemeCard(card: CanvasCard): card is ThemeCard {
  return card.kind === 'theme';
}

export const RULE_LABELS: Record<keyof ThemeRules, string> = {
  shape: '造型',
  material: '材质',
  lighting: '光影',
  color: '色彩协调',
};

/** 生效主题卡附加到提示词末尾的那一段；版本记录里保存的提示词全文包含它 */
export function themeSuffix(theme: ThemeCard): string {
  const lines = [`【视觉主题：${theme.topic || theme.name}】`];
  if (theme.keywords.length) lines.push(`视觉关键词：${theme.keywords.join('、')}`);
  if (theme.cues.length) lines.push(`视觉线索：${theme.cues.join('、')}`);
  if (theme.palette.length) {
    lines.push(`配色：${theme.palette.map((c) => `${c.role}${c.name ? ` ${c.name}` : ''} ${c.hex}${c.note ? `（${c.note}）` : ''}`).join('；')}`);
  }
  const rules = (Object.keys(RULE_LABELS) as (keyof ThemeRules)[])
    .filter((key) => theme.rules[key].trim())
    .map((key) => `${RULE_LABELS[key]}：${theme.rules[key].trim()}`);
  if (rules.length) lines.push(`统一规则：${rules.join('；')}`);
  return lines.join('\n');
}

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (HEX.test(trimmed)) return trimmed.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.toUpperCase()}`;
  return null;
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
  cards: CanvasCard[];
  activeThemeCardId: string | null;
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
  return { schemaVersion: PROJECT_SCHEMA_VERSION, regions: defaultRegions(), cards: [], activeThemeCardId: null, viewport: null };
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

  const cards: CanvasCard[] = [];
  const seen = new Set<string>();
  for (const [index, value] of (Array.isArray(raw.cards) ? raw.cards : []).entries()) {
    const card = !isObject(value)
      ? null
      : value.kind === 'prompt'
        ? parsePromptCard(value)
        : value.kind === 'theme'
          ? parseThemeCard(value)
          : value.kind === 'page'
            ? parsePageCard(value)
            : value.kind === 'ref'
              ? parseRefCard(value)
              : parseCard(value);
    if (!card) {
      warnings.push(`第 ${index + 1} 个对象结构不完整，已跳过`);
      continue;
    }
    if (seen.has(card.id)) {
      warnings.push(`对象 ${card.id} 重复，已跳过后一个`);
      continue;
    }
    seen.add(card.id);
    cards.push(card);
  }

  // 引用到已经不存在的图像卡时去掉引用，保证打开后的结构自洽
  const imageIds = new Set(cards.filter(isImageCard).map((card) => card.id));
  for (const [index, card] of cards.entries()) {
    if (!isPromptCard(card)) continue;
    const inputs = card.inputs.filter((id) => imageIds.has(id));
    const outputCardId = card.outputCardId && imageIds.has(card.outputCardId) ? card.outputCardId : null;
    if (inputs.length !== card.inputs.length || outputCardId !== card.outputCardId) {
      cards[index] = { ...card, inputs, outputCardId };
    }
  }

  const viewport = isObject(raw.viewport) && isFiniteNumber(raw.viewport.originX) && isFiniteNumber(raw.viewport.originY) &&
    isFiniteNumber(raw.viewport.zoom) && raw.viewport.zoom > 0
    ? { originX: raw.viewport.originX, originY: raw.viewport.originY, zoom: raw.viewport.zoom }
    : null;

  // 引用指向的图像卡、所在页面不存在时：图像卡丢了就去掉引用，页面丢了就让它脱离页面
  const pageIds = new Set(cards.filter(isPageCard).map((card) => card.id));
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (!isRefCard(card)) continue;
    if (!imageIds.has(card.imageCardId)) {
      warnings.push('一个素材引用指向的图像卡不存在，已去掉');
      cards.splice(index, 1);
    } else if (card.pageId && !pageIds.has(card.pageId)) {
      cards[index] = { ...card, pageId: null };
    }
  }

  const activeThemeCardId =
    typeof raw.activeThemeCardId === 'string' && cards.some((card) => card.id === raw.activeThemeCardId && isThemeCard(card))
      ? raw.activeThemeCardId
      : null;

  return { project: { schemaVersion: PROJECT_SCHEMA_VERSION, regions, cards, activeThemeCardId, viewport }, warnings };
}

function parsePageCard(value: Record<string, unknown>): PageCard | null {
  if (typeof value.id !== 'string' || !isRect(value) || value.width <= 0 || value.height <= 0) return null;
  const preset = DEVICE_PRESETS.find((p) => p.id === value.devicePreset);
  const scale = isFiniteNumber(value.exportScale) ? Math.round(value.exportScale) : 1;
  return {
    kind: 'page',
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '页面',
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    base: value.base === null ? null : parseVersion(value.base),
    background: normalizeHex(typeof value.background === 'string' ? value.background : '') ?? '#FFFFFF',
    devicePreset: preset ? preset.id : null,
    exportScale: Math.min(4, Math.max(1, scale)),
  };
}

function parseRefCard(value: Record<string, unknown>): RefCard | null {
  if (typeof value.id !== 'string' || typeof value.imageCardId !== 'string' || !isRect(value)) return null;
  if (value.width <= 0 || value.height <= 0) return null;
  return {
    kind: 'ref',
    id: value.id,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    imageCardId: value.imageCardId,
    pageId: typeof value.pageId === 'string' ? value.pageId : null,
  };
}

function parseThemeCard(value: Record<string, unknown>): ThemeCard | null {
  if (typeof value.id !== 'string' || !isRect(value) || value.width <= 0 || value.height <= 0) return null;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  const text = (input: unknown): string => (typeof input === 'string' ? input : '');
  const rules = isObject(value.rules) ? value.rules : {};
  const palette = Array.isArray(value.palette)
    ? value.palette.flatMap((item): ThemeColor[] => {
        if (!isObject(item)) return [];
        const hex = normalizeHex(text(item.hex));
        return hex ? [{ role: text(item.role), name: text(item.name), hex, note: text(item.note) }] : [];
      })
    : [];
  return {
    kind: 'theme',
    id: value.id,
    name: text(value.name) || '视觉主题',
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    topic: text(value.topic),
    keywords: strings(value.keywords),
    cues: strings(value.cues),
    palette,
    rules: { shape: text(rules.shape), material: text(rules.material), lighting: text(rules.lighting), color: text(rules.color) },
  };
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

function parsePromptCard(value: Record<string, unknown>): PromptCard | null {
  if (typeof value.id !== 'string' || !isRect(value) || value.width <= 0 || value.height <= 0) return null;
  const settings = isObject(value.settings) ? value.settings : {};
  const count = isFiniteNumber(settings.count) ? Math.round(settings.count) : DEFAULT_PROMPT_SETTINGS.count;
  return {
    kind: 'prompt',
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '提示词',
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    text: typeof value.text === 'string' ? value.text : '',
    inputs: Array.isArray(value.inputs) ? value.inputs.filter((id): id is string => typeof id === 'string') : [],
    outputCardId: typeof value.outputCardId === 'string' ? value.outputCardId : null,
    settings: {
      count: Math.min(MAX_COUNT, Math.max(MIN_COUNT, count)),
      size: SIZE_OPTIONS.some((o) => o.id === settings.size) ? (settings.size as PromptSettings['size']) : DEFAULT_PROMPT_SETTINGS.size,
      quality: QUALITIES.some((q) => q.id === settings.quality)
        ? (settings.quality as PromptSettings['quality'])
        : DEFAULT_PROMPT_SETTINGS.quality,
      useTheme: typeof settings.useTheme === 'boolean' ? settings.useTheme : DEFAULT_PROMPT_SETTINGS.useTheme,
    },
  };
}

function parseVersion(value: unknown): Version | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.file !== 'string') return null;
  if (!isFiniteNumber(value.width) || !isFiniteNumber(value.height) || value.width <= 0 || value.height <= 0) return null;
  if (value.file.includes('..') || value.file.startsWith('/')) return null;
  const generation = parseGeneration(value.generation);
  return {
    id: value.id,
    file: value.file,
    width: value.width,
    height: value.height,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    origin: value.origin === 'generate' && generation ? 'generate' : 'import',
    ...(typeof value.sourceName === 'string' ? { sourceName: value.sourceName } : {}),
    ...(generation ? { generation } : {}),
  };
}

function parseGeneration(value: unknown): GenerationRecord | null {
  if (!isObject(value) || typeof value.promptCardId !== 'string' || typeof value.prompt !== 'string') return null;
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '');
  return {
    promptCardId: value.promptCardId,
    prompt: value.prompt,
    inputVersionIds: Array.isArray(value.inputVersionIds)
      ? value.inputVersionIds.filter((id): id is string => typeof id === 'string')
      : [],
    provider: text('provider'),
    model: text('model'),
    quality: text('quality'),
    size: text('size'),
    costUsd: isFiniteNumber(value.costUsd) ? value.costUsd : 0,
    ...(isFiniteNumber(value.costCny) ? { costCny: value.costCny } : {}),
    jobId: text('jobId'),
    themeCardId: typeof value.themeCardId === 'string' ? value.themeCardId : null,
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
