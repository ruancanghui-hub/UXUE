import type { ImageCard, Region, RegionId, Version } from '../../../shared/project';
import type { Rect } from '../canvas/geometry';

/** 画布文档的一个不可变快照；撤销栈只需要保存快照引用 */
export interface DocState {
  readonly cards: readonly ImageCard[];
  readonly regions: readonly Region[];
}

const NEW_CARD_GAP = 40;
export const MIN_CARD_EDGE = 16;
export const DUPLICATE_OFFSET = 40;

/** 新导入的图长边最大显示尺寸（画布单位）：一次导入越多，单张越小，整批大致能放进一个区域 */
export function newCardMaxEdge(count: number): number {
  if (count <= 4) return 800;
  if (count <= 16) return 480;
  return 320;
}

export function cardSizeFor(version: Version, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(version.width, version.height));
  return { width: version.width * scale, height: version.height * scale };
}

/** 把新版本排成接近横向矩形的网格，整体中心对准 (centerX, centerY) */
export function layoutNewCards(
  versions: Version[],
  centerX: number,
  centerY: number,
  makeId: () => string,
): ImageCard[] {
  if (versions.length === 0) return [];
  const maxEdge = newCardMaxEdge(versions.length);
  const sizes = versions.map((version) => cardSizeFor(version, maxEdge));
  const perRow = Math.ceil(Math.sqrt(versions.length * 1.6));
  const rows: number[][] = [];
  for (let i = 0; i < versions.length; i += perRow) {
    rows.push(sizes.slice(i, i + perRow).map((_, j) => i + j));
  }
  const rowHeights = rows.map((row) => Math.max(...row.map((i) => sizes[i].height)));
  const rowWidths = rows.map((row) => row.reduce((sum, i) => sum + sizes[i].width, 0) + NEW_CARD_GAP * (row.length - 1));
  const totalWidth = Math.max(...rowWidths);
  const totalHeight = rowHeights.reduce((sum, h) => sum + h, 0) + NEW_CARD_GAP * (rows.length - 1);

  const cards: ImageCard[] = [];
  let y = centerY - totalHeight / 2;
  rows.forEach((row, rowIndex) => {
    let x = centerX - totalWidth / 2;
    for (const i of row) {
      const version = versions[i];
      cards.push({
        kind: 'image',
        id: makeId(),
        name: displayName(version),
        x,
        y: y + (rowHeights[rowIndex] - sizes[i].height) / 2,
        width: sizes[i].width,
        height: sizes[i].height,
        versions: [version],
        currentVersionId: version.id,
      });
      x += sizes[i].width + NEW_CARD_GAP;
    }
    y += rowHeights[rowIndex] + NEW_CARD_GAP;
  });
  return cards;
}

function displayName(version: Version): string {
  const name = version.sourceName?.replace(/\.[^.]+$/, '').trim();
  return name || '图片';
}

export function addCards(state: DocState, cards: ImageCard[]): DocState {
  return { ...state, cards: [...state.cards, ...cards] };
}

export function removeCards(state: DocState, ids: ReadonlySet<string>): DocState {
  return { ...state, cards: state.cards.filter((card) => !ids.has(card.id)) };
}

/** origins 是手势开始时的卡片，按绝对偏移计算，避免拖动过程中累积误差 */
export function moveCards(state: DocState, origins: ReadonlyMap<string, ImageCard>, dx: number, dy: number): DocState {
  return mapCards(state, (card) => {
    const origin = origins.get(card.id);
    return origin ? { ...card, x: origin.x + dx, y: origin.y + dy } : card;
  });
}

/** 以 anchor 为不动点等比缩放；scale 太小时按最小边长截住 */
export function scaleCards(
  state: DocState,
  origins: ReadonlyMap<string, ImageCard>,
  anchorX: number,
  anchorY: number,
  scale: number,
): DocState {
  let minEdge = Infinity;
  for (const origin of origins.values()) minEdge = Math.min(minEdge, origin.width, origin.height);
  const safeScale = Math.max(scale, MIN_CARD_EDGE / minEdge);
  return mapCards(state, (card) => {
    const origin = origins.get(card.id);
    if (!origin) return card;
    return {
      ...card,
      x: anchorX + (origin.x - anchorX) * safeScale,
      y: anchorY + (origin.y - anchorY) * safeScale,
      width: origin.width * safeScale,
      height: origin.height * safeScale,
    };
  });
}

export function duplicateCards(state: DocState, ids: ReadonlySet<string>, makeId: () => string): { state: DocState; newIds: string[] } {
  const copies = state.cards
    .filter((card) => ids.has(card.id))
    .map((card) => ({ ...card, id: makeId(), x: card.x + DUPLICATE_OFFSET, y: card.y + DUPLICATE_OFFSET }));
  return { state: { ...state, cards: [...state.cards, ...copies] }, newIds: copies.map((card) => card.id) };
}

export function reorderCards(state: DocState, ids: ReadonlySet<string>, to: 'front' | 'back'): DocState {
  const picked = state.cards.filter((card) => ids.has(card.id));
  const rest = state.cards.filter((card) => !ids.has(card.id));
  return { ...state, cards: to === 'front' ? [...rest, ...picked] : [...picked, ...rest] };
}

export function renameCard(state: DocState, id: string, name: string): DocState {
  return mapCards(state, (card) => (card.id === id ? { ...card, name } : card));
}

/** 切换当前版本：保持宽度和左上角不变，高度跟着新版本的比例走 */
export function setCurrentVersion(state: DocState, id: string, versionId: string): DocState {
  return mapCards(state, (card) => {
    if (card.id !== id || card.currentVersionId === versionId) return card;
    const version = card.versions.find((v) => v.id === versionId);
    if (!version) return card;
    return { ...card, currentVersionId: versionId, height: card.width * (version.height / version.width) };
  });
}

/** 给图像卡追加版本，并把最后一个设为当前版本 */
export function addVersions(state: DocState, id: string, versions: Version[]): DocState {
  if (versions.length === 0) return state;
  const withVersions = mapCards(state, (card) => (card.id === id ? { ...card, versions: [...card.versions, ...versions] } : card));
  return setCurrentVersion(withVersions, id, versions[versions.length - 1].id);
}

export function regionOf(state: DocState, card: Rect): RegionId | null {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  const region = state.regions.find((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height);
  return region?.id ?? null;
}

function mapCards(state: DocState, fn: (card: ImageCard) => ImageCard): DocState {
  let changed = false;
  const cards = state.cards.map((card) => {
    const next = fn(card);
    if (next !== card) changed = true;
    return next;
  });
  return changed ? { ...state, cards } : state;
}
