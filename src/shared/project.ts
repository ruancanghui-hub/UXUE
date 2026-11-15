import { DEFAULT_PROMPT_SETTINGS, MAX_COUNT, MIN_COUNT, QUALITIES, SIZE_OPTIONS, type PromptSettings } from './generation';

export const PROJECT_FILE = 'project.json';
/** 当前写入版本；打开时兼容 schema 1–3（3 = 页面可叠层栈混排） */
export const PROJECT_SCHEMA_VERSION = 3;
export const PROJECT_SCHEMA_MIN = 1;

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
  /** 所属分组框；不在组内为 null */
  groupId: string | null;
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
  groupId: string | null;
  /** 特殊用途：wireframe 转线框；sketch 布局草图转线框；element 素材清单里的一项 */
  purpose: 'wireframe' | 'sketch' | 'element' | null;
  /** 绑定的风格基准图像卡；有值时它是第 1 个输入 */
  styleRefCardId: string | null;
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
  groupId: string | null;
  /** 主题来源图像卡；纯文字生成时为 null */
  sourceImageCardId: string | null;
  /** 提炼时该图像卡的当前版本；无来源或版本已丢时可为 null */
  sourceVersionId: string | null;
}

/** 把若干卡片框成一组的容器；page/ref 不进组 */
export interface GroupCard {
  kind: 'group';
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** 底稿来源：自己的线框，还是只借布局的成品截图 */
  baseSource: BaseSource;
  /** 底稿来自哪张图像卡（比如转线框的结果）；直接从文件导入的为 null */
  baseCardId: string | null;
  /** 从页面框发起的转线框：这张提示词卡第一次出图就换成底稿 */
  wireframePromptId: string | null;
  /** 草图笔迹和草图文字是否隐藏；草图转线框出图后自动隐藏 */
  sketchHidden: boolean;
  /** 导出时是否带上低保真原型层；默认不带，方便拖进 Figma 精修 */
  exportIncludeBase: boolean;
}

/** 布局草图里手绘的一笔：points 归一化到外接框 [x0, y0, x1, y1, …]，缩放时不用改点 */
export interface StrokeCard {
  kind: 'stroke';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageId: string;
  points: number[];
  /** 画布单位 */
  lineWidth: number;
}

export type SketchFontSize = 'sm' | 'md' | 'lg';
/** 草图文字的字号（画布单位） */
export const SKETCH_FONT_SIZES: Record<SketchFontSize, number> = { sm: 12, md: 18, lg: 28 };

/** 布局草图里写的一段说明文字 */
export interface SketchTextCard {
  kind: 'sketchText';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageId: string;
  text: string;
  fontSize: SketchFontSize;
}

export type BaseSource = 'own' | 'borrowed';

export type BlockType = 'hero' | 'icon' | 'tile' | 'tabbar' | 'illustration' | 'other';

export const BLOCK_TYPES: { id: BlockType; label: string }[] = [
  { id: 'hero', label: '顶部视觉 / Banner' },
  { id: 'icon', label: '金刚位图标' },
  { id: 'tile', label: '瓷片' },
  { id: 'tabbar', label: '底部导航图标' },
  { id: 'illustration', label: '主插图' },
  { id: 'other', label: '其他' },
];

export function blockTypeLabel(type: BlockType): string {
  return BLOCK_TYPES.find((t) => t.id === type)?.label ?? '其他';
}

/** 相对页面框的矩形，0–1 */
export interface RelativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 页面框里要单独生成一张核心素材的一块；只属于一个页面框 */
export interface BlockCard {
  kind: 'block';
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageId: string;
  blockType: BlockType;
  /** 区块组名，比如"金刚位"；不成组为 null */
  group: string | null;
  /** 区块截图图像卡 */
  cropCardId: string | null;
  /** 截图时区块相对页面框的位置；和现在不同就是截图过时 */
  cropRect: RelativeRect | null;
  /** 截图时页面框的低保真原型版本；页面框换了底稿截图也过时 */
  cropBaseVersionId: string | null;
  promptCardId: string | null;
}

/** 页面框里对某张核心素材的引用：默认跟当前版本；可锁定到指定版本 */
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
  /** 钉死的版本；有值则不再跟随图像卡的当前版本 */
  lockedVersionId: string | null;
}

/** 页面框里的圆角填充矩形底板；不是图像卡 */
export interface DecorCard {
  kind: 'decor';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageId: string;
  /** #RRGGBB */
  fill: string;
  /** 逻辑像素圆角；画布上按页面宽高比换算 */
  cornerRadius: number;
}

export type CanvasCard =
  | ImageCard
  | PromptCard
  | ThemeCard
  | PageCard
  | RefCard
  | GroupCard
  | BlockCard
  | StrokeCard
  | SketchTextCard
  | DecorCard;

export function isPageCard(card: CanvasCard): card is PageCard {
  return card.kind === 'page';
}

export function isBlockCard(card: CanvasCard): card is BlockCard {
  return card.kind === 'block';
}

export function isStrokeCard(card: CanvasCard): card is StrokeCard {
  return card.kind === 'stroke';
}

export function isSketchTextCard(card: CanvasCard): card is SketchTextCard {
  return card.kind === 'sketchText';
}

export function isDecorCard(card: CanvasCard): card is DecorCard {
  return card.kind === 'decor';
}

/** 草图笔迹和草图文字：只属于一个页面框的草图素材 */
export function isSketchMark(card: CanvasCard): card is StrokeCard | SketchTextCard {
  return card.kind === 'stroke' || card.kind === 'sketchText';
}

/** 只属于一个页面框、页面框删了就带走的子卡（不含可拖出页面的素材引用） */
export function isPageBoundChild(card: CanvasCard): card is BlockCard | StrokeCard | SketchTextCard | DecorCard {
  return isBlockCard(card) || isSketchMark(card) || isDecorCard(card);
}

/** 区块现在相对页面框的位置 */
export function blockRelativeRect(block: BlockCard, page: PageCard): RelativeRect {
  return {
    x: (block.x - page.x) / page.width,
    y: (block.y - page.y) / page.height,
    width: block.width / page.width,
    height: block.height / page.height,
  };
}

const CROP_TOLERANCE = 0.005;

/** 区块相对低保真原型挪了位置或改了大小，截图就过时；整个页面框一起动不算 */
export function isBlockCropStale(block: BlockCard, page: PageCard): boolean {
  if (!block.cropCardId || !block.cropRect) return false;
  if (block.cropBaseVersionId && block.cropBaseVersionId !== page.base?.id) return true;
  const now = blockRelativeRect(block, page);
  const before = block.cropRect;
  return (
    Math.abs(now.x - before.x) > CROP_TOLERANCE ||
    Math.abs(now.y - before.y) > CROP_TOLERANCE ||
    Math.abs(now.width - before.width) > CROP_TOLERANCE ||
    Math.abs(now.height - before.height) > CROP_TOLERANCE
  );
}

/** 区块在低保真原型原图上的像素范围（夹在原图内） */
export function blockPixelRect(
  block: BlockCard,
  page: PageCard,
): { left: number; top: number; width: number; height: number } | null {
  if (!page.base) return null;
  const rel = blockRelativeRect(block, page);
  const left = Math.max(0, Math.round(rel.x * page.base.width));
  const top = Math.max(0, Math.round(rel.y * page.base.height));
  const right = Math.min(page.base.width, Math.round((rel.x + rel.width) * page.base.width));
  const bottom = Math.min(page.base.height, Math.round((rel.y + rel.height) * page.base.height));
  if (right - left < 4 || bottom - top < 4) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function isRefCard(card: CanvasCard): card is RefCard {
  return card.kind === 'ref';
}

export function isGroupCard(card: CanvasCard): card is GroupCard {
  return card.kind === 'group';
}

/** 可以放进分组框的卡片 */
export function canJoinGroup(card: CanvasCard): card is ImageCard | PromptCard | ThemeCard {
  return card.kind === 'image' || card.kind === 'prompt' || card.kind === 'theme';
}

export function cardGroupId(card: CanvasCard): string | null {
  return canJoinGroup(card) ? card.groupId : null;
}

export const DEVICE_PRESETS = [
  { id: 'iphone', label: 'iPhone 16 / 16 Pro 393 × 852', width: 393, height: 852 },
  { id: 'iphone-max', label: 'iPhone 16 Plus / Pro Max 430 × 932', width: 430, height: 932 },
  { id: 'iphone-mini', label: 'iPhone mini 375 × 812', width: 375, height: 812 },
  { id: 'iphone-se', label: 'iPhone SE 375 × 667', width: 375, height: 667 },
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

export const REGION_WIDTH = 12000;
/** 区域的最小高度；内容往下超出时自动长高 */
export const REGION_MIN_HEIGHT = 4000;
const REGION_GAP = 600;
/** 区域底边留在最低内容下面的空白 */
const REGION_BOTTOM_PAD = 600;
/** 2026-11 之前的区域宽度；打开旧项目时按它迁移 */
const LEGACY_REGION_WIDTH = 6000;

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
    height: REGION_MIN_HEIGHT,
  }));
}

/** 区域按列归属：中心点横坐标落在区域宽度内、且不在区域顶部之上，就算这一列（不看底边，区域会长高） */
export function regionColumnOf(regions: readonly Region[], rect: { x: number; y: number; width: number; height: number }): Region | null {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return regions.find((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y) ?? null;
}

/**
 * 每个区域的高度 = max(最小高度, 这一列内容的最底边 − 区域顶部 + 留白)；内容删掉后会缩回去。
 * 高度都没变时返回原来的数组，调用方可以靠引用判断有没有变化。
 */
export function fitRegionHeights(regions: readonly Region[], cards: readonly CanvasCard[]): readonly Region[] {
  const bottoms = new Map<RegionId, number>();
  for (const card of cards) {
    const region = regionColumnOf(regions, card);
    if (region) bottoms.set(region.id, Math.max(bottoms.get(region.id) ?? -Infinity, card.y + card.height));
  }
  let changed = false;
  const next = regions.map((region) => {
    const bottom = bottoms.get(region.id);
    const height = Math.max(REGION_MIN_HEIGHT, bottom === undefined ? 0 : bottom - region.y + REGION_BOTTOM_PAD);
    if (height === region.height) return region;
    changed = true;
    return { ...region, height };
  });
  return changed ? next : regions;
}

export function emptyProject(): ProjectFile {
  return { schemaVersion: PROJECT_SCHEMA_VERSION, regions: defaultRegions(), cards: [], activeThemeCardId: null, viewport: null };
}

export function currentVersion(card: ImageCard): Version {
  return card.versions.find((version) => version.id === card.currentVersionId) ?? card.versions[card.versions.length - 1];
}

/** 引用显示的版本：锁定版优先，否则当前版 */
export function refDisplayVersion(ref: RefCard, source: ImageCard): Version | null {
  if (ref.lockedVersionId) {
    return source.versions.find((v) => v.id === ref.lockedVersionId) ?? null;
  }
  return currentVersion(source);
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
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion < PROJECT_SCHEMA_MIN || raw.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(`project.json 的版本是 ${String(raw.schemaVersion)}，这个版本的暗夜精灵只认识 ${PROJECT_SCHEMA_MIN}–${PROJECT_SCHEMA_VERSION}`);
  }

  const defaults = defaultRegions();
  let regions = defaults.map((fallback) => {
    const found = Array.isArray(raw.regions) ? raw.regions.find((r) => isObject(r) && r.id === fallback.id) : undefined;
    if (isObject(found) && isRect(found)) {
      return { ...fallback, x: found.x, y: found.y, width: found.width, height: found.height };
    }
    return fallback;
  });
  // 旧项目的区域只有 6000 宽：区域按新布局放宽，后面两列的内容整体右移（在读卡片之后做）
  const legacyRegions = regions.some((region) => region.width <= LEGACY_REGION_WIDTH) ? regions : null;
  if (legacyRegions) regions = defaults.map((fallback, i) => ({ ...fallback, y: legacyRegions[i].y }));

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
              : value.kind === 'group'
                ? parseGroupCard(value)
                : value.kind === 'block'
                  ? parseBlockCard(value)
                  : value.kind === 'stroke'
                    ? parseStrokeCard(value)
                    : value.kind === 'sketchText'
                      ? parseSketchTextCard(value)
                      : value.kind === 'decor'
                        ? parseDecorCard(value)
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
    const styleRefCardId = card.styleRefCardId && inputs.includes(card.styleRefCardId) ? card.styleRefCardId : null;
    if (inputs.length !== card.inputs.length || outputCardId !== card.outputCardId || styleRefCardId !== card.styleRefCardId) {
      cards[index] = { ...card, inputs, outputCardId, styleRefCardId };
    }
  }

  if (legacyRegions) {
    migrateLegacyColumns(cards, legacyRegions, regions);
    warnings.push('区域已放大到原来的两倍宽，核心素材区和高保真页面区的内容已整体右移');
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
    } else {
      let next = card;
      if (card.pageId && !pageIds.has(card.pageId)) next = { ...next, pageId: null };
      if (card.lockedVersionId) {
        const source = cards.find((c): c is ImageCard => isImageCard(c) && c.id === card.imageCardId);
        if (!source?.versions.some((v) => v.id === card.lockedVersionId)) next = { ...next, lockedVersionId: null };
      }
      if (next !== card) cards[index] = next;
    }
  }

  // 草图笔迹、文字、页面装饰：页面框不在就丢掉
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if ((isSketchMark(card) || isDecorCard(card)) && !pageIds.has(card.pageId)) {
      warnings.push(isDecorCard(card) ? '一块页面装饰所在的页面框不存在，已去掉' : '一条草图笔迹或文字所在的页面框不存在，已去掉');
      cards.splice(index, 1);
    }
  }

  // 区块：页面框不在就丢掉；截图卡、提示词卡不在就断开
  const promptIds = new Set(cards.filter(isPromptCard).map((card) => card.id));
  for (const [index, card] of cards.entries()) {
    if (!isPageCard(card)) continue;
    const baseCardId = card.baseCardId && imageIds.has(card.baseCardId) ? card.baseCardId : null;
    const wireframePromptId = card.wireframePromptId && promptIds.has(card.wireframePromptId) ? card.wireframePromptId : null;
    if (baseCardId !== card.baseCardId || wireframePromptId !== card.wireframePromptId) cards[index] = { ...card, baseCardId, wireframePromptId };
  }
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (!isBlockCard(card)) continue;
    if (!pageIds.has(card.pageId)) {
      warnings.push('一个区块所在的页面框不存在，已去掉');
      cards.splice(index, 1);
      continue;
    }
    const cropCardId = card.cropCardId && imageIds.has(card.cropCardId) ? card.cropCardId : null;
    const promptCardId = card.promptCardId && promptIds.has(card.promptCardId) ? card.promptCardId : null;
    if (cropCardId !== card.cropCardId || promptCardId !== card.promptCardId) {
      cards[index] = {
        ...card,
        cropCardId,
        cropRect: cropCardId ? card.cropRect : null,
        cropBaseVersionId: cropCardId ? card.cropBaseVersionId : null,
        promptCardId,
      };
    }
  }

  // 分组：组不存在则子卡脱离；page/ref 不应带 groupId（解析时已忽略）
  const groupIds = new Set(cards.filter(isGroupCard).map((card) => card.id));
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    const gid = cardGroupId(card);
    if (gid && !groupIds.has(gid)) {
      if (canJoinGroup(card)) cards[index] = { ...card, groupId: null };
    }
  }

  // 主题来源：图像卡没了整段清掉；版本没了只清 versionId
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    if (!isThemeCard(card) || !card.sourceImageCardId) continue;
    const source = cards.find((c) => c.id === card.sourceImageCardId);
    if (!source || !isImageCard(source)) {
      warnings.push('一张主题卡的来源参考图不存在，已去掉主题来源');
      cards[index] = { ...card, sourceImageCardId: null, sourceVersionId: null };
    } else if (card.sourceVersionId && !source.versions.some((v) => v.id === card.sourceVersionId)) {
      cards[index] = { ...card, sourceVersionId: null };
    }
  }

  const activeThemeCardId =
    typeof raw.activeThemeCardId === 'string' && cards.some((card) => card.id === raw.activeThemeCardId && isThemeCard(card))
      ? raw.activeThemeCardId
      : null;

  // schema < 3：可叠层仍按「先装饰后引用」画；把该视觉序写回数组，之后靠数组顺序混排
  const orderedCards = raw.schemaVersion < 3 ? migrateLegacyPageStackOrder(cards) : cards;

  return { project: { schemaVersion: PROJECT_SCHEMA_VERSION, regions, cards: orderedCards, activeThemeCardId, viewport }, warnings };
}

/** 旧视觉序（每页全部装饰 → 全部引用）写进 cards 里可叠层槽位的相对顺序 */
export function migrateLegacyPageStackOrder(cards: CanvasCard[]): CanvasCard[] {
  const pageIds = cards.filter(isPageCard).map((card) => card.id);
  let next: CanvasCard[] = cards;
  let changed = false;
  for (const pageId of pageIds) {
    const stackIds = next.filter((card) => isPageStackable(card) && card.pageId === pageId).map((card) => card.id);
    if (stackIds.length === 0) continue;
    const desired = [
      ...next.filter((card) => isDecorCard(card) && card.pageId === pageId).map((card) => card.id),
      ...next.filter((card) => isRefCard(card) && card.pageId === pageId).map((card) => card.id),
    ];
    if (desired.every((id, index) => id === stackIds[index])) continue;
    next = applyPageStackOrder(next, pageId, desired);
    changed = true;
  }
  return changed ? next : cards;
}

/** 页面装饰或带 pageId 的素材引用：同一页共用可叠层栈 */
export function isPageStackable(card: CanvasCard): card is DecorCard | RefCard {
  return (isDecorCard(card) || isRefCard(card)) && !!card.pageId;
}

/** 把某页可叠层对象按 orderedIds（从下到上）填回它们在数组里原有的槽位 */
export function applyPageStackOrder(cards: readonly CanvasCard[], pageId: string, orderedIds: readonly string[]): CanvasCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  let index = 0;
  return cards.map((card) => {
    if (!isPageStackable(card) || card.pageId !== pageId) return card;
    const id = orderedIds[index++];
    return byId.get(id) ?? card;
  });
}

/**
 * 旧布局的卡片按中心点所在的旧列平移到新列：主题区及左边不动，
 * 核心素材区右移到新的核心素材区，高保真页面区及更右边右移到新的高保真页面区。
 */
function migrateLegacyColumns(cards: CanvasCard[], before: readonly Region[], after: readonly Region[]): void {
  const shifts = after.map((region, i) => region.x - before[i].x);
  for (const [index, card] of cards.entries()) {
    const cx = card.x + card.width / 2;
    let column = 0;
    for (let i = before.length - 1; i > 0; i--) {
      if (cx >= before[i].x) {
        column = i;
        break;
      }
    }
    const dx = shifts[column];
    if (dx) cards[index] = { ...card, x: card.x + dx };
  }
}

function parseGroupId(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseGroupCard(value: Record<string, unknown>): GroupCard | null {
  if (typeof value.id !== 'string' || !isRect(value) || value.width <= 0 || value.height <= 0) return null;
  return {
    kind: 'group',
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '分组',
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
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
    baseSource: value.baseSource === 'borrowed' ? 'borrowed' : 'own',
    baseCardId: typeof value.baseCardId === 'string' ? value.baseCardId : null,
    wireframePromptId: typeof value.wireframePromptId === 'string' ? value.wireframePromptId : null,
    sketchHidden: value.sketchHidden === true,
    exportIncludeBase: value.exportIncludeBase === true,
  };
}

function parseDecorCard(value: Record<string, unknown>): DecorCard | null {
  if (typeof value.id !== 'string' || typeof value.pageId !== 'string' || !isRect(value)) return null;
  if (value.width <= 0 || value.height <= 0) return null;
  const fill = normalizeHex(typeof value.fill === 'string' ? value.fill : '') ?? '#E8E8ED';
  const cornerRadius = isFiniteNumber(value.cornerRadius) ? Math.max(0, value.cornerRadius) : 12;
  return {
    kind: 'decor',
    id: value.id,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    pageId: value.pageId,
    fill,
    cornerRadius,
  };
}

function parseStrokeCard(value: Record<string, unknown>): StrokeCard | null {
  if (typeof value.id !== 'string' || typeof value.pageId !== 'string' || !isRect(value)) return null;
  if (!Array.isArray(value.points) || value.points.length < 4 || value.points.length % 2 !== 0) return null;
  if (!value.points.every(isFiniteNumber)) return null;
  return {
    kind: 'stroke',
    id: value.id,
    x: value.x,
    y: value.y,
    width: Math.max(value.width, 0.001),
    height: Math.max(value.height, 0.001),
    pageId: value.pageId,
    points: value.points as number[],
    lineWidth: isFiniteNumber(value.lineWidth) && value.lineWidth > 0 ? value.lineWidth : 2,
  };
}

function parseSketchTextCard(value: Record<string, unknown>): SketchTextCard | null {
  if (typeof value.id !== 'string' || typeof value.pageId !== 'string' || !isRect(value) || value.width <= 0 || value.height <= 0) return null;
  const fontSize = value.fontSize === 'sm' || value.fontSize === 'lg' ? value.fontSize : 'md';
  return {
    kind: 'sketchText',
    id: value.id,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    pageId: value.pageId,
    text: typeof value.text === 'string' ? value.text : '',
    fontSize,
  };
}

function parseBlockCard(value: Record<string, unknown>): BlockCard | null {
  if (typeof value.id !== 'string' || typeof value.pageId !== 'string' || !isRect(value)) return null;
  if (value.width <= 0 || value.height <= 0) return null;
  const blockType = BLOCK_TYPES.some((t) => t.id === value.blockType) ? (value.blockType as BlockType) : 'other';
  const crop = isObject(value.cropRect) && isRect(value.cropRect) ? value.cropRect : null;
  return {
    kind: 'block',
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : blockTypeLabel(blockType),
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    pageId: value.pageId,
    blockType,
    group: typeof value.group === 'string' && value.group.trim() ? value.group : null,
    cropCardId: typeof value.cropCardId === 'string' ? value.cropCardId : null,
    cropRect: crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : null,
    cropBaseVersionId: typeof value.cropBaseVersionId === 'string' ? value.cropBaseVersionId : null,
    promptCardId: typeof value.promptCardId === 'string' ? value.promptCardId : null,
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
    lockedVersionId: typeof value.lockedVersionId === 'string' ? value.lockedVersionId : null,
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
    groupId: parseGroupId(value.groupId),
    sourceImageCardId: typeof value.sourceImageCardId === 'string' ? value.sourceImageCardId : null,
    sourceVersionId: typeof value.sourceVersionId === 'string' ? value.sourceVersionId : null,
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
    groupId: parseGroupId(value.groupId),
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
    groupId: parseGroupId(value.groupId),
    purpose: value.purpose === 'wireframe' || value.purpose === 'sketch' || value.purpose === 'element' ? value.purpose : null,
    styleRefCardId: typeof value.styleRefCardId === 'string' ? value.styleRefCardId : null,
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
