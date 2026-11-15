import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasCard, Region } from '../../../shared/project';
import type { CanvasEngine } from '../canvas/CanvasEngine';
import type { Rect } from '../canvas/geometry';
import { createMinimapTransform, mapToWorld, worldRectToMap, type MinimapTransform } from '../canvas/minimapLayout';
import type { DocumentStore } from '../document/DocumentStore';
import type { Selection } from '../document/Selection';
import { useCommittedDoc, useSelectionIds } from '../project/hooks';

const MAP_W = 200;
const MAP_H = 140;
const COLLAPSE_KEY = 'anye.minimap.collapsed';

const REGION_FILL: Record<string, string> = {
  theme: 'rgba(224, 197, 110, 0.18)',
  assets: 'rgba(158, 196, 232, 0.16)',
  pages: 'rgba(143, 160, 255, 0.16)',
};

const KIND_FILL: Record<string, string> = {
  image: 'rgba(180, 190, 220, 0.75)',
  prompt: 'rgba(158, 196, 232, 0.85)',
  theme: 'rgba(224, 197, 110, 0.85)',
  page: 'rgba(143, 160, 255, 0.7)',
  group: 'rgba(160, 160, 180, 0.45)',
  block: 'rgba(184, 168, 212, 0.7)',
  decor: 'rgba(196, 184, 168, 0.75)',
  ref: 'rgba(150, 200, 170, 0.75)',
  sketchText: 'rgba(200, 200, 210, 0.65)',
  stroke: 'rgba(140, 140, 160, 0.45)',
};

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

interface MinimapProps {
  engine: CanvasEngine;
  doc: DocumentStore;
  selection: Selection;
}

export function Minimap({ engine, doc, selection }: MinimapProps) {
  const state = useCommittedDoc(doc);
  const selectedIds = useSelectionIds(selection);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [view, setView] = useState<Rect>(() => engine.visibleWorldRect());
  const dragRef = useRef<{ mode: 'view' | 'jump'; lastMapX: number; lastMapY: number } | null>(null);
  const transformRef = useRef<MinimapTransform | null>(null);

  useEffect(() => {
    setView(engine.visibleWorldRect());
    return engine.onViewportChange(() => setView(engine.visibleWorldRect()));
  }, [engine]);

  const transform = useMemo(
    () => createMinimapTransform([...state.regions, ...state.cards], MAP_W, MAP_H),
    [state.regions, state.cards],
  );
  transformRef.current = transform;

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const t = transformRef.current;
      if (!t) return;
      const svg = event.currentTarget;
      const rect = svg.getBoundingClientRect();
      const mapX = ((event.clientX - rect.left) / rect.width) * MAP_W;
      const mapY = ((event.clientY - rect.top) / rect.height) * MAP_H;
      const viewMap = worldRectToMap(t, engine.visibleWorldRect());
      const inView =
        mapX >= viewMap.x && mapX <= viewMap.x + viewMap.width && mapY >= viewMap.y && mapY <= viewMap.y + viewMap.height;
      dragRef.current = { mode: inView ? 'view' : 'jump', lastMapX: mapX, lastMapY: mapY };
      svg.setPointerCapture(event.pointerId);
      if (!inView) {
        const world = mapToWorld(t, mapX, mapY);
        engine.centerViewOn(world.x, world.y, true);
      }
      event.preventDefault();
    },
    [engine],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      const t = transformRef.current;
      if (!drag || !t || drag.mode !== 'view') return;
      const svg = event.currentTarget;
      const rect = svg.getBoundingClientRect();
      const mapX = ((event.clientX - rect.left) / rect.width) * MAP_W;
      const mapY = ((event.clientY - rect.top) / rect.height) * MAP_H;
      const dx = (mapX - drag.lastMapX) / t.scale;
      const dy = (mapY - drag.lastMapY) / t.scale;
      drag.lastMapX = mapX;
      drag.lastMapY = mapY;
      const center = engine.viewCenterWorld();
      engine.centerViewOn(center.x + dx, center.y + dy, false);
    },
    [engine],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (collapsed) {
    return (
      <div className="minimap collapsed">
        <button type="button" className="minimap-toggle" onClick={toggle} title="展开画布鸟瞰">
          鸟瞰
        </button>
      </div>
    );
  }

  const viewMap = worldRectToMap(transform, view);

  return (
    <div className="minimap">
      <div className="minimap-header">
        <span>鸟瞰</span>
        <button type="button" className="minimap-toggle ghost" onClick={toggle} title="收起" aria-label="收起鸟瞰">
          −
        </button>
      </div>
      <svg
        className="minimap-svg"
        width={MAP_W}
        height={MAP_H}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect x={0} y={0} width={MAP_W} height={MAP_H} className="minimap-bg" />
        {state.regions.map((region) => (
          <RegionShape key={region.id} region={region} transform={transform} />
        ))}
        {state.cards.map((card) => (
          <CardShape key={card.id} card={card} transform={transform} selected={selectedIds.has(card.id)} />
        ))}
        <rect
          x={viewMap.x}
          y={viewMap.y}
          width={Math.max(4, viewMap.width)}
          height={Math.max(4, viewMap.height)}
          className="minimap-view"
        />
      </svg>
    </div>
  );
}

function RegionShape({ region, transform }: { region: Region; transform: MinimapTransform }) {
  const r = worldRectToMap(transform, region);
  return (
    <g>
      <rect x={r.x} y={r.y} width={r.width} height={r.height} fill={REGION_FILL[region.id] ?? 'rgba(255,255,255,0.06)'} />
      <text x={r.x + 4} y={r.y + 12} className="minimap-label">
        {region.name}
      </text>
    </g>
  );
}

function CardShape({ card, transform, selected }: { card: CanvasCard; transform: MinimapTransform; selected: boolean }) {
  const r = worldRectToMap(transform, card);
  const w = Math.max(2, r.width);
  const h = Math.max(2, r.height);
  return (
    <rect
      x={r.x}
      y={r.y}
      width={w}
      height={h}
      fill={KIND_FILL[card.kind] ?? 'rgba(200,200,210,0.6)'}
      className={selected ? 'minimap-card selected' : 'minimap-card'}
    />
  );
}
