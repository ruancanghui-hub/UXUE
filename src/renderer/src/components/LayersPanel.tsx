import { memo, useMemo } from 'react';
import { currentVersion, isImageCard, isPageCard, isRefCard, type CanvasCard, type RefCard, type RegionId } from '../../../shared/project';
import { regionOf, type DocState } from '../document/operations';
import { thumbnailUrl } from '../project/thumbnails';

interface LayersPanelProps {
  state: DocState;
  selectedIds: ReadonlySet<string>;
  missingVersionIds: ReadonlySet<string>;
  cacheBust: ReadonlyMap<string, number>;
  onSelect(id: string, additive: boolean): void;
  onFocusCard(id: string): void;
}

type RowKind = 'image' | 'missing' | 'prompt' | 'theme' | 'page';

interface Row {
  id: string;
  label: string;
  kind: RowKind;
  thumbnail?: string;
  badge?: number | string;
  indent: boolean;
}

/** 按区域分组列出画布对象，最上层的排在最前面；页面框里的引用缩进列在页面下面 */
export function LayersPanel({ state, selectedIds, missingVersionIds, cacheBust, onSelect, onFocusCard }: LayersPanelProps) {
  const groups = useMemo(() => {
    const byId = new Map(state.cards.map((card) => [card.id, card]));
    const children = new Map<string, RefCard[]>();
    for (const card of state.cards) {
      if (isRefCard(card) && card.pageId && byId.has(card.pageId)) {
        const list = children.get(card.pageId) ?? [];
        list.unshift(card);
        children.set(card.pageId, list);
      }
    }

    const rowFor = (card: CanvasCard, indent: boolean): Row => {
      if (isImageCard(card) || isRefCard(card)) {
        const source = isRefCard(card) ? byId.get(card.imageCardId) : card;
        if (!source || !isImageCard(source)) return { id: card.id, label: '引用丢失', kind: 'missing', indent };
        const version = currentVersion(source);
        return {
          id: card.id,
          label: isRefCard(card) ? `↳ ${source.name}` : source.name,
          kind: missingVersionIds.has(version.id) ? 'missing' : 'image',
          thumbnail: thumbnailUrl(version, cacheBust.get(version.id)),
          badge: !isRefCard(card) && source.versions.length > 1 ? source.versions.length : undefined,
          indent,
        };
      }
      return {
        id: card.id,
        label: card.name,
        kind: card.kind,
        badge: card.id === state.activeThemeCardId ? '生效' : isPageCard(card) ? (children.get(card.id)?.length ?? 0) || undefined : undefined,
        indent,
      };
    };

    const byRegion = new Map<RegionId | null, Row[]>();
    for (const card of [...state.cards].reverse()) {
      if (isRefCard(card) && card.pageId && byId.has(card.pageId)) continue;
      const region = regionOf(state, card);
      const rows = byRegion.get(region) ?? [];
      rows.push(rowFor(card, false));
      if (isPageCard(card)) for (const child of children.get(card.id) ?? []) rows.push(rowFor(child, true));
      byRegion.set(region, rows);
    }
    const ordered = state.regions.map((region) => ({ id: region.id as string, name: region.name, rows: byRegion.get(region.id) ?? [] }));
    const outside = byRegion.get(null);
    if (outside?.length) ordered.push({ id: 'outside', name: '区域外', rows: outside });
    return ordered;
  }, [state, missingVersionIds, cacheBust]);

  return (
    <aside className="side-panel layers-panel">
      <div className="panel-title">图层</div>
      <div className="layers-scroll">
        {groups.map((group) => (
          <section key={group.id} className="layer-group">
            <div className="layer-group-title">
              <span>{group.name}</span>
              <span className="dim">{group.rows.filter((row) => !row.indent).length}</span>
            </div>
            {group.rows.length === 0 && <div className="layer-empty">还没有内容</div>}
            {group.rows.map((row) => (
              <LayerRow key={row.id} row={row} selected={selectedIds.has(row.id)} onSelect={onSelect} onFocusCard={onFocusCard} />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

const ICONS: Partial<Record<RowKind, string>> = { prompt: '✎', theme: '◆', page: '▢' };

const LayerRow = memo(function LayerRow({
  row,
  selected,
  onSelect,
  onFocusCard,
}: {
  row: Row;
  selected: boolean;
  onSelect(id: string, additive: boolean): void;
  onFocusCard(id: string): void;
}) {
  return (
    <button
      className={`layer-row ${selected ? 'selected' : ''} ${row.indent ? 'indent' : ''}`}
      onClick={(event) => onSelect(row.id, event.shiftKey || event.metaKey)}
      onDoubleClick={() => onFocusCard(row.id)}
      title="单击选中，双击定位到画布"
    >
      {row.kind === 'image' && <img className="layer-thumb" src={row.thumbnail} alt="" loading="lazy" />}
      {row.kind === 'missing' && <span className="layer-thumb missing">缺失</span>}
      {ICONS[row.kind] && <span className={`layer-thumb ${row.kind}`}>{ICONS[row.kind]}</span>}
      <span className="layer-name">{row.label}</span>
      {row.badge !== undefined && <span className="layer-badge">{row.badge}</span>}
    </button>
  );
});
