import { currentVersion, isImageCard, isRefCard, pageLogicalSize, type CanvasCard, type PageCard } from './project';

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
  /** 从下到上 */
  layers: ExportLayer[];
}

/** 页面框 + 里面的素材引用 → 导出用的像素坐标；画布单位按页面宽度换算 */
export function planPageExport(page: PageCard, cards: readonly CanvasCard[]): PageExportPlan {
  const logical = pageLogicalSize(page);
  const width = Math.max(1, Math.round(logical.width * page.exportScale));
  const height = Math.max(1, Math.round(logical.height * page.exportScale));
  const scaleX = width / page.width;
  const scaleY = height / page.height;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const used = new Map<string, number>();

  const layers: ExportLayer[] = [];
  for (const card of cards) {
    if (!isRefCard(card) || card.pageId !== page.id) continue;
    const source = byId.get(card.imageCardId);
    if (!source || !isImageCard(source)) continue;
    const version = currentVersion(source);
    const count = (used.get(source.name) ?? 0) + 1;
    used.set(source.name, count);
    layers.push({
      name: count === 1 ? source.name : `${source.name} ${count}`,
      file: version.file,
      versionId: version.id,
      x: Math.round((card.x - page.x) * scaleX),
      y: Math.round((card.y - page.y) * scaleY),
      width: Math.max(1, Math.round(card.width * scaleX)),
      height: Math.max(1, Math.round(card.height * scaleY)),
    });
  }

  return {
    pageName: page.name,
    width,
    height,
    logicalWidth: logical.width,
    logicalHeight: logical.height,
    exportScale: page.exportScale,
    background: page.background,
    base: page.base ? { file: page.base.file } : null,
    layers,
  };
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
