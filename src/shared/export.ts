import {
  isBlockCard,
  isDecorCard,
  isImageCard,
  isPageStackable,
  isRefCard,
  pageLogicalSize,
  refDisplayVersion,
  type BlockCard,
  type CanvasCard,
  type PageCard,
} from './project';

export interface ExportLayer {
  /** 图层名：引用的图像卡名字，重名时加序号 */
  name: string;
  /** 相对项目目录的原图 */
  file: string;
  versionId: string;
  /** 导出像素坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportShape {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  /** 导出像素圆角 */
  cornerRadius: number;
}

/** 可叠层栈一项：从下到上 */
export type ExportStackItem = { kind: 'shape'; shape: ExportShape } | { kind: 'image'; layer: ExportLayer };

export interface PageExportPlan {
  pageName: string;
  /** 导出像素尺寸 */
  width: number;
  height: number;
  /** 逻辑尺寸（素材包和清单里的坐标单位） */
  logicalWidth: number;
  logicalHeight: number;
  exportScale: number;
  background: string;
  base: { file: string } | null;
  /** 从下到上的可叠层（装饰与素材交错） */
  stack: ExportStackItem[];
  /** 仅装饰，从下到上（派生自 stack，兼容旧调用） */
  shapes: ExportShape[];
  /** 仅素材，从下到上（派生自 stack） */
  layers: ExportLayer[];
  /** 区块只写进坐标清单（逻辑坐标），不画进 PNG / SVG */
  blocks: { name: string; type: string; group: string | null; x: number; y: number; width: number; height: number }[];
}

/** 页面框 + 里面的素材引用 / 页面装饰 → 导出用的像素坐标；画布单位按页面宽度换算 */
export function planPageExport(page: PageCard, cards: readonly CanvasCard[]): PageExportPlan {
  const logical = pageLogicalSize(page);
  const width = Math.max(1, Math.round(logical.width * page.exportScale));
  const height = Math.max(1, Math.round(logical.height * page.exportScale));
  const scaleX = width / page.width;
  const scaleY = height / page.height;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const used = new Map<string, number>();
  let decorIndex = 0;

  const stack: ExportStackItem[] = [];
  for (const card of cards) {
    if (!isPageStackable(card) || card.pageId !== page.id) continue;
    if (isDecorCard(card)) {
      decorIndex += 1;
      const rx = Math.min(card.cornerRadius, logical.width, logical.height);
      stack.push({
        kind: 'shape',
        shape: {
          name: decorIndex === 1 ? '装饰' : `装饰 ${decorIndex}`,
          x: Math.round((card.x - page.x) * scaleX),
          y: Math.round((card.y - page.y) * scaleY),
          width: Math.max(1, Math.round(card.width * scaleX)),
          height: Math.max(1, Math.round(card.height * scaleY)),
          fill: card.fill,
          cornerRadius: Math.max(0, Math.round(rx * page.exportScale)),
        },
      });
      continue;
    }
    if (!isRefCard(card)) continue;
    const source = byId.get(card.imageCardId);
    if (!source || !isImageCard(source)) continue;
    const version = refDisplayVersion(card, source);
    if (!version) continue;
    const count = (used.get(source.name) ?? 0) + 1;
    used.set(source.name, count);
    stack.push({
      kind: 'image',
      layer: {
        name: count === 1 ? source.name : `${source.name} ${count}`,
        file: version.file,
        versionId: version.id,
        x: Math.round((card.x - page.x) * scaleX),
        y: Math.round((card.y - page.y) * scaleY),
        width: Math.max(1, Math.round(card.width * scaleX)),
        height: Math.max(1, Math.round(card.height * scaleY)),
      },
    });
  }

  const shapes = stack.filter((item): item is { kind: 'shape'; shape: ExportShape } => item.kind === 'shape').map((item) => item.shape);
  const layers = stack.filter((item): item is { kind: 'image'; layer: ExportLayer } => item.kind === 'image').map((item) => item.layer);

  return {
    pageName: page.name,
    width,
    height,
    logicalWidth: logical.width,
    logicalHeight: logical.height,
    exportScale: page.exportScale,
    background: page.background,
    base: page.exportIncludeBase && page.base ? { file: page.base.file } : null,
    stack,
    shapes,
    layers,
    blocks: cards
      .filter((card): card is BlockCard => isBlockCard(card) && card.pageId === page.id)
      .map((block) => ({
        name: block.name,
        type: block.blockType,
        group: block.group,
        x: round2(((block.x - page.x) / page.width) * logical.width),
        y: round2(((block.y - page.y) / page.height) * logical.height),
        width: round2((block.width / page.width) * logical.width),
        height: round2((block.height / page.height) * logical.height),
      })),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 文件夹 / 文件名里不能出现的字符换成下划线 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '未命名';
}

export interface ExportResult {
  /** 相对项目目录 */
  folder: string;
  files: string[];
  png: { width: number; height: number };
  svg: { layers: string[]; bytes: number };
}
