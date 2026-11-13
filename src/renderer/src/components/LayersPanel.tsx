import { memo, useMemo } from 'react';
import { currentVersion, isImageCard, type CanvasCard, type RegionId } from '../../../shared/project';
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

/** 按区域分组列出画布对象，最上层的排在最前面 */
export function LayersPanel({ state, selectedIds, missingVersionIds, cacheBust, onSelect, onFocusCard }: LayersPanelProps) {
  const groups = useMemo(() => {
    const byRegion = new Map<RegionId | null, CanvasCard[]>();
    for (const card of [...state.cards].reverse()) {
      const region = regionOf(state, card);
      const list = byRegion.get(region) ?? [];
      list.push(card);
      byRegion.set(region, list);
    }
    const ordered: { id: string; name: string; cards: CanvasCard[] }[] = state.regions.map((region) => ({
      id: region.id,
      name: region.name,
      cards: byRegion.get(region.id) ?? [],
    }));
    const outside = byRegion.get(null);
    if (outside?.length) ordered.push({ id: 'outside', name: '区域外', cards: outside });
    return ordered;
  }, [state]);

  return (
    <aside className="side-panel layers-panel">
      <div className="panel-title">图层</div>
      <div className="layers-scroll">
        {groups.map((group) => (
          <section key={group.id} className="layer-group">
            <div className="layer-group-title">
              <span>{group.name}</span>
              <span className="dim">{group.cards.length}</span>
            </div>
            {group.cards.length === 0 && <div className="layer-empty">还没有内容</div>}
            {group.cards.map((card) => {
              if (!isImageCard(card)) {
                return (
                  <LayerRow key={card.id} card={card} selected={selectedIds.has(card.id)} kind="prompt" onSelect={onSelect} onFocusCard={onFocusCard} />
                );
              }
              const version = currentVersion(card);
              return (
                <LayerRow
                  key={card.id}
                  card={card}
                  selected={selectedIds.has(card.id)}
                  kind={missingVersionIds.has(version.id) ? 'missing' : 'image'}
                  thumbnail={thumbnailUrl(version, cacheBust.get(version.id))}
                  badge={card.versions.length > 1 ? card.versions.length : undefined}
                  onSelect={onSelect}
                  onFocusCard={onFocusCard}
                />
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

interface LayerRowProps {
  card: CanvasCard;
  selected: boolean;
  kind: 'image' | 'missing' | 'prompt';
  thumbnail?: string;
  badge?: number;
  onSelect(id: string, additive: boolean): void;
  onFocusCard(id: string): void;
}

const LayerRow = memo(function LayerRow({ card, selected, kind, thumbnail, badge, onSelect, onFocusCard }: LayerRowProps) {
  return (
    <button
      className={`layer-row ${selected ? 'selected' : ''}`}
      onClick={(event) => onSelect(card.id, event.shiftKey || event.metaKey)}
      onDoubleClick={() => onFocusCard(card.id)}
      title="单击选中，双击定位到画布"
    >
      {kind === 'prompt' && <span className="layer-thumb prompt">✎</span>}
      {kind === 'missing' && <span className="layer-thumb missing">缺失</span>}
      {kind === 'image' && <img className="layer-thumb" src={thumbnail} alt="" loading="lazy" />}
      <span className="layer-name">{card.name}</span>
      {badge !== undefined && <span className="layer-badge">{badge}</span>}
    </button>
  );
});
