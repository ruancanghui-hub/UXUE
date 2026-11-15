import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  currentVersion,
  isBlockCard,
  isBlockCropStale,
  isDecorCard,
  isGroupCard,
  isPageStackable,
  isSketchMark,
  isSketchTextCard,
  isStrokeCard,
  isImageCard,
  isPageCard,
  isPromptCard,
  isRefCard,
  isThemeCard,
  refDisplayVersion,
  type BlockCard,
  type CanvasCard,
  type DecorCard,
  type SketchTextCard,
  type RefCard,
  type RegionId,
} from '../../../shared/project';
import { isImageCardStale } from '../../../shared/stale';
import { regionOf, type DocState } from '../document/operations';
import { thumbnailUrl } from '../project/thumbnails';
import { LayerIcons } from './LayerIcons';

interface LayersPanelProps {
  state: DocState;
  projectDir: string;
  selectedIds: ReadonlySet<string>;
  missingVersionIds: ReadonlySet<string>;
  cacheBust: ReadonlyMap<string, number>;
  onSelect(id: string, additive: boolean): void;
  onFocusCard(id: string): void;
  /** orderedIds：从下到上；仅同页可叠层（装饰 / 引用） */
  onReorderPageStack?(pageId: string, orderedIds: string[]): void;
  /** 嵌在左侧壳里时不再包一层 aside */
  embedded?: boolean;
}

type RowKind = 'image' | 'missing' | 'prompt' | 'theme' | 'page' | 'group' | 'ref' | 'block' | 'sketchText' | 'stroke' | 'decor';

interface Row {
  id: string;
  label: string;
  kind: RowKind;
  thumbnail?: string;
  badge?: number | string;
  indent: boolean;
  /** 可拖重排时所属页面 */
  stackPageId?: string;
  /** 折叠子行所属的页面/分组 */
  parentId?: string;
  childCount?: number;
  fill?: string;
  isRef?: boolean;
}

function collapseStorageKey(projectDir: string): string {
  return `anye.layers.collapsed:${projectDir}`;
}

function readCollapsed(projectDir: string): Set<string> {
  try {
    const raw = localStorage.getItem(collapseStorageKey(projectDir));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsed(projectDir: string, ids: Set<string>): void {
  localStorage.setItem(collapseStorageKey(projectDir), JSON.stringify([...ids]));
}

/** 按区域分组列出画布对象；图标 + 树线 + 折叠；页面子行可叠层可拖 */
export function LayersPanel({
  state,
  projectDir,
  selectedIds,
  missingVersionIds,
  cacheBust,
  onSelect,
  onFocusCard,
  onReorderPageStack,
  embedded = false,
}: LayersPanelProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(projectDir));

  useEffect(() => {
    setCollapsed(readCollapsed(projectDir));
  }, [projectDir]);

  const toggleCollapsed = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        writeCollapsed(projectDir, next);
        return next;
      });
    },
    [projectDir],
  );

  const groups = useMemo(() => {
    const byId = new Map(state.cards.map((card) => [card.id, card]));
    const strokeCounts = new Map<string, number>();
    const groupChildren = new Map<string, CanvasCard[]>();
    const pageBlocks = new Map<string, BlockCard[]>();
    const pageSketches = new Map<string, (SketchTextCard | CanvasCard)[]>();
    const pageStack = new Map<string, (RefCard | DecorCard)[]>();

    for (const card of state.cards) {
      if (isStrokeCard(card)) strokeCounts.set(card.pageId, (strokeCounts.get(card.pageId) ?? 0) + 1);
      if (isBlockCard(card) && byId.has(card.pageId)) {
        const list = pageBlocks.get(card.pageId) ?? [];
        list.push(card);
        pageBlocks.set(card.pageId, list);
      } else if (isSketchMark(card) && byId.has(card.pageId)) {
        const list = pageSketches.get(card.pageId) ?? [];
        list.push(card);
        pageSketches.set(card.pageId, list);
      } else if (isPageStackable(card) && card.pageId && byId.has(card.pageId)) {
        const list = pageStack.get(card.pageId) ?? [];
        list.push(card);
        pageStack.set(card.pageId, list);
      }
      if ((isImageCard(card) || isPromptCard(card) || isThemeCard(card)) && card.groupId && byId.has(card.groupId)) {
        const list = groupChildren.get(card.groupId) ?? [];
        list.unshift(card);
        groupChildren.set(card.groupId, list);
      }
    }

    const rowFor = (card: CanvasCard, indent: boolean, parentId?: string, stackPageId?: string): Row => {
      if (isImageCard(card) || isRefCard(card)) {
        const source = isRefCard(card) ? byId.get(card.imageCardId) : card;
        if (!source || !isImageCard(source)) {
          return { id: card.id, label: '引用丢失', kind: 'missing', indent, parentId, stackPageId, isRef: isRefCard(card) };
        }
        const version = isRefCard(card) ? refDisplayVersion(card, source) : currentVersion(source);
        if (!version) {
          return { id: card.id, label: '引用丢失', kind: 'missing', indent, parentId, stackPageId, isRef: isRefCard(card) };
        }
        const stale = !isRefCard(card) && isImageCardStale(source, state);
        const locked = isRefCard(card) && !!card.lockedVersionId;
        return {
          id: card.id,
          label: source.name,
          kind: missingVersionIds.has(version.id) ? 'missing' : 'image',
          thumbnail: thumbnailUrl(version, cacheBust.get(version.id)),
          badge: stale ? '过期' : locked ? '锁' : !isRefCard(card) && source.versions.length > 1 ? source.versions.length : undefined,
          indent,
          parentId,
          stackPageId,
          isRef: isRefCard(card),
        };
      }
      if (isGroupCard(card)) {
        const childCount = groupChildren.get(card.id)?.length ?? 0;
        return {
          id: card.id,
          label: card.name,
          kind: 'group',
          badge: childCount || undefined,
          indent,
          childCount,
        };
      }
      if (isBlockCard(card)) {
        const page = byId.get(card.pageId);
        const stale = !!page && isPageCard(page) && isBlockCropStale(card, page);
        return { id: card.id, label: card.name, kind: 'block', badge: stale ? '过期' : undefined, indent, parentId };
      }
      if (isSketchTextCard(card)) {
        return { id: card.id, label: card.text.split('\n')[0] || '（空文字）', kind: 'sketchText', indent, parentId };
      }
      if (isDecorCard(card)) {
        return { id: card.id, label: '页面装饰', kind: 'decor', indent, parentId, stackPageId, fill: card.fill };
      }
      if (isStrokeCard(card)) return { id: card.id, label: '草图笔迹', kind: 'stroke', indent, parentId };
      if (isPageCard(card)) {
        const stackLen = pageStack.get(card.id)?.length ?? 0;
        const sketchLen = pageSketches.get(card.id)?.length ?? 0;
        const blockLen = pageBlocks.get(card.id)?.length ?? 0;
        const childCount = stackLen + sketchLen + blockLen;
        const refs = pageStack.get(card.id)?.filter(isRefCard).length ?? 0;
        const strokes = strokeCounts.get(card.id) ?? 0;
        return {
          id: card.id,
          label: card.name,
          kind: 'page',
          badge: strokes ? `${refs ? `${refs} · ` : ''}笔迹 ${strokes}` : refs || undefined,
          indent,
          childCount,
        };
      }
      return {
        id: card.id,
        label: card.name,
        kind: card.kind,
        badge: card.id === state.activeThemeCardId ? '生效' : undefined,
        indent,
      };
    };

    const byRegion = new Map<RegionId | null, Row[]>();
    for (const card of [...state.cards].reverse()) {
      if ((isRefCard(card) || isBlockCard(card) || isSketchMark(card) || isDecorCard(card)) && card.pageId && byId.has(card.pageId)) continue;
      if ((isImageCard(card) || isPromptCard(card) || isThemeCard(card)) && card.groupId && byId.has(card.groupId)) continue;
      const region = regionOf(state, card);
      const rows = byRegion.get(region) ?? [];
      rows.push(rowFor(card, false));
      if (isPageCard(card)) {
        const stack = [...(pageStack.get(card.id) ?? [])].reverse();
        const sketches = [...(pageSketches.get(card.id) ?? [])].reverse();
        const blocks = [...(pageBlocks.get(card.id) ?? [])].reverse();
        for (const child of stack) rows.push(rowFor(child, true, card.id, card.id));
        for (const child of sketches) rows.push(rowFor(child, true, card.id));
        for (const child of blocks) rows.push(rowFor(child, true, card.id));
      }
      if (isGroupCard(card)) {
        for (const child of groupChildren.get(card.id) ?? []) rows.push(rowFor(child, true, card.id));
      }
      byRegion.set(region, rows);
    }
    const ordered = state.regions.map((region) => ({
      id: region.id as string,
      name: region.name,
      rows: byRegion.get(region.id) ?? [],
    }));
    const outside = byRegion.get(null);
    if (outside?.length) ordered.push({ id: 'outside', name: '区域外', rows: outside });
    return ordered;
  }, [state, missingVersionIds, cacheBust]);

  const finishDrop = (targetId: string, place: 'before' | 'after') => {
    if (!dragId || !onReorderPageStack || dragId === targetId) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    const dragRow = groups.flatMap((g) => g.rows).find((row) => row.id === dragId);
    const targetRow = groups.flatMap((g) => g.rows).find((row) => row.id === targetId);
    if (!dragRow?.stackPageId || !targetRow?.stackPageId || dragRow.stackPageId !== targetRow.stackPageId) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    const pageId = dragRow.stackPageId;
    const topToBottom = groups
      .flatMap((g) => g.rows)
      .filter((row) => row.stackPageId === pageId)
      .map((row) => row.id);
    const without = topToBottom.filter((id) => id !== dragId);
    let index = without.indexOf(targetId);
    if (index < 0) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    if (place === 'after') index += 1;
    without.splice(index, 0, dragId);
    onReorderPageStack(pageId, [...without].reverse());
    setDragId(null);
    setDropTarget(null);
  };

  const body = (
    <>
      {!embedded && <div className="panel-title">图层</div>}
      <div className="layers-scroll">
        {groups.map((group) => {
          const regionKey = `region:${group.id}`;
          const regionOpen = !collapsed.has(regionKey);
          const topCount = group.rows.filter((row) => !row.indent).length;
          const visibleRows = regionOpen
            ? group.rows.filter((row) => {
                if (!row.parentId) return true;
                return !collapsed.has(row.parentId);
              })
            : [];
          return (
            <section key={group.id} className="layer-group">
              <div className="layer-group-title">
                <button
                  type="button"
                  className="layer-chevron"
                  aria-label={regionOpen ? '折叠区域' : '展开区域'}
                  aria-expanded={regionOpen}
                  onClick={() => toggleCollapsed(regionKey)}
                >
                  <LayerIcons.chevron className="layer-chevron-icon" expanded={regionOpen} />
                </button>
                <span className="layer-group-name">{group.name}</span>
                <span className="dim">{topCount}</span>
              </div>
              {regionOpen && group.rows.length === 0 && <div className="layer-empty">还没有内容</div>}
              {visibleRows.map((row) => (
                <LayerRow
                  key={row.id}
                  row={row}
                  selected={selectedIds.has(row.id)}
                  dragging={dragId === row.id}
                  dropPlace={dropTarget?.id === row.id ? dropTarget.place : null}
                  canDrag={!!row.stackPageId && !!onReorderPageStack}
                  expanded={!collapsed.has(row.id)}
                  onToggle={() => toggleCollapsed(row.id)}
                  onSelect={onSelect}
                  onFocusCard={onFocusCard}
                  onDragStart={() => setDragId(row.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(place) => {
                    if (!dragId || dragId === row.id || !row.stackPageId) return;
                    const dragRow = groups.flatMap((g) => g.rows).find((r) => r.id === dragId);
                    if (!dragRow?.stackPageId || dragRow.stackPageId !== row.stackPageId) return;
                    setDropTarget({ id: row.id, place });
                  }}
                  onDrop={(place) => finishDrop(row.id, place)}
                />
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
  if (embedded) return <div className="layers-panel layers-panel-embedded">{body}</div>;
  return <aside className="side-panel layers-panel">{body}</aside>;
}

const LayerRow = memo(function LayerRow({
  row,
  selected,
  dragging,
  dropPlace,
  canDrag,
  expanded,
  onToggle,
  onSelect,
  onFocusCard,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  row: Row;
  selected: boolean;
  dragging: boolean;
  dropPlace: 'before' | 'after' | null;
  canDrag: boolean;
  expanded: boolean;
  onToggle(): void;
  onSelect(id: string, additive: boolean): void;
  onFocusCard(id: string): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(place: 'before' | 'after'): void;
  onDrop(place: 'before' | 'after'): void;
}) {
  const canCollapse = (row.kind === 'page' || row.kind === 'group') && (row.childCount ?? 0) > 0;
  return (
    <div
      className={`layer-row ${selected ? 'selected' : ''} ${row.indent ? 'indent' : ''} ${dragging ? 'dragging' : ''} ${dropPlace === 'before' ? 'drop-before' : ''} ${dropPlace === 'after' ? 'drop-after' : ''} ${canDrag ? 'draggable' : ''}`}
      draggable={canDrag}
      onClick={(event) => onSelect(row.id, event.shiftKey || event.metaKey)}
      onDoubleClick={() => onFocusCard(row.id)}
      onDragStart={(event) => {
        if (!canDrag) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!canDrag || !row.stackPageId) return;
        event.preventDefault();
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        onDragOver(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
      }}
      onDrop={(event) => {
        if (!canDrag || !row.stackPageId) return;
        event.preventDefault();
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        onDrop(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
      }}
      title={canDrag ? '拖拽调整上下层；单击选中，双击定位' : '单击选中，双击定位到画布'}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row.id, event.shiftKey || event.metaKey);
        }
      }}
    >
      {row.indent && <span className="layer-tree" aria-hidden />}
      {!row.indent && (
        <span className="layer-chevron-slot">
          {canCollapse ? (
            <button
              type="button"
              className="layer-chevron"
              aria-label={expanded ? '折叠' : '展开'}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
            >
              <LayerIcons.chevron className="layer-chevron-icon" expanded={expanded} />
            </button>
          ) : (
            <span className="layer-chevron-spacer" />
          )}
        </span>
      )}
      <LayerLeading row={row} />
      <span className="layer-name">{row.label}</span>
      {row.badge !== undefined && <span className={`layer-badge ${row.badge === '过期' ? 'stale' : ''}`}>{row.badge}</span>}
    </div>
  );
});

function LayerLeading({ row }: { row: Row }) {
  if (row.kind === 'image' && row.thumbnail) {
    return (
      <span className={`layer-thumb-wrap ${row.isRef ? 'is-ref' : ''}`}>
        <img className="layer-thumb" src={row.thumbnail} alt="" loading="lazy" />
        {row.isRef && (
          <span className="layer-ref-badge" title="素材引用">
            <LayerIcons.ref className="layer-ref-badge-icon" />
          </span>
        )}
      </span>
    );
  }
  if (row.kind === 'missing') {
    return (
      <span className="layer-icon-slot kind-missing">
        <LayerIcons.missing />
      </span>
    );
  }
  if (row.kind === 'decor') {
    return <span className="layer-swatch" style={{ background: row.fill ?? '#E8E8ED' }} title={row.fill} />;
  }
  const Icon =
    row.kind === 'page'
      ? LayerIcons.page
      : row.kind === 'group'
        ? LayerIcons.group
        : row.kind === 'block'
          ? LayerIcons.block
          : row.kind === 'stroke'
            ? LayerIcons.stroke
            : row.kind === 'sketchText'
              ? LayerIcons.sketchText
              : row.kind === 'prompt'
                ? LayerIcons.prompt
                : row.kind === 'theme'
                  ? LayerIcons.theme
                  : LayerIcons.image;
  return (
    <span className={`layer-icon-slot kind-${row.kind}`}>
      <Icon />
    </span>
  );
}
