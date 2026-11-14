import { describe, expect, it } from 'vitest';
import { defaultRegions, isPageCard, isSketchMark, isStrokeCard, parseProject, PROJECT_SCHEMA_VERSION, type PageCard, type Version } from '../../../shared/project';
import { sketchBoxes } from '../project/sketch';
import {
  addCards,
  applyGenerationResult,
  createSketchText,
  createStroke,
  duplicateCards,
  moveCards,
  newPageCard,
  removeCards,
  renderOrder,
  scaleCards,
  sketchMarks,
  sketchToWireframe,
  strokeWorldPoints,
  updateSketchText,
  withPageChildren,
  type DocState,
} from './operations';

let counter = 0;
const makeId = (): string => `d-${++counter}`;
const empty: DocState = { cards: [], regions: defaultRegions(), activeThemeCardId: null };

function version(id: string, width: number, height: number): Version {
  return { id, file: `assets/${id}.png`, width, height, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' };
}

function drawn(): { state: DocState; page: PageCard; strokeId: string; textId: string } {
  const page = newPageCard(empty, { id: 'p', name: '首页', base: null });
  let state = addCards(empty, [page]);
  const stroke = createStroke(state, page.id, [page.x + 10, page.y + 10, page.x + 110, page.y + 60, page.x + 60, page.y + 110], 2, makeId)!;
  state = stroke.state;
  const text = createSketchText(state, page.id, { x: page.x + 20, y: page.y + 200 }, 'md', makeId)!;
  state = updateSketchText(text.state, text.textId, { text: '这里放优惠券' });
  return { state, page, strokeId: stroke.strokeId, textId: text.textId };
}

describe('草图笔迹', () => {
  it('点归一化到外接框，世界坐标往返一致；缩放后点保持相对位置', () => {
    const { state, page, strokeId } = drawn();
    const stroke = state.cards.find((c) => c.id === strokeId)!;
    expect(isStrokeCard(stroke) && stroke).toMatchObject({ x: page.x + 10, y: page.y + 10, width: 100, height: 100, lineWidth: 2 });
    expect(isStrokeCard(stroke) && strokeWorldPoints(stroke)).toEqual([page.x + 10, page.y + 10, page.x + 110, page.y + 60, page.x + 60, page.y + 110]);
    const scaled = scaleCards(state, new Map([[strokeId, stroke]]), stroke.x, stroke.y, 2).cards.find((c) => c.id === strokeId)!;
    expect(isStrokeCard(scaled) && strokeWorldPoints(scaled)).toEqual([page.x + 10, page.y + 10, page.x + 210, page.y + 110, page.x + 110, page.y + 210]);
  });

  it('横线不会除零；点数不对的不建', () => {
    const page = newPageCard(empty, { id: 'p2', name: '页', base: null });
    const state = addCards(empty, [page]);
    const flat = createStroke(state, page.id, [0, 50, 100, 50], 3, makeId)!;
    const card = flat.state.cards.find((c) => c.id === flat.strokeId)!;
    expect(isStrokeCard(card) && strokeWorldPoints(card).every(Number.isFinite)).toBe(true);
    expect(createStroke(state, page.id, [1, 2, 3], 2, makeId)).toBeNull();
  });

  it('草图文字的外接框跟着内容走', () => {
    const { state, textId } = drawn();
    const text = state.cards.find((c) => c.id === textId)!;
    expect(text.width).toBeCloseTo(6 * 18 * 1.05);
    const bigger = updateSketchText(state, textId, { fontSize: 'lg', text: '第一行\n第二行很长很长' }).cards.find((c) => c.id === textId)!;
    expect(bigger.height).toBeCloseTo(2 * 28 * 1.4);
  });
});

describe('草图跟着页面框', () => {
  it('移动、复制、删除页面框时笔迹和文字一起；绘制顺序在页面框之后', () => {
    const { state, page } = drawn();
    const ids = withPageChildren(state, [page.id]);
    expect(sketchMarks(state, page.id).every((m) => ids.has(m.id))).toBe(true);
    const moved = moveCards(state, new Map(state.cards.filter((c) => ids.has(c.id)).map((c) => [c.id, c])), 30, 40);
    const before = sketchMarks(state, page.id)[0];
    expect(sketchMarks(moved, page.id)[0].x).toBe(before.x + 30);

    const { state: copied, newIds } = duplicateCards(state, new Set([page.id]), makeId);
    expect(sketchMarks(copied, newIds[0])).toHaveLength(2);
    expect(removeCards(state, new Set([page.id])).cards.some(isSketchMark)).toBe(false);

    const order = renderOrder(state.cards).map((c) => c.kind);
    expect(order).toEqual(['page', 'stroke', 'sketchText']);
  });

  it('读回时清掉页面框已不存在的、点数不合法的笔迹', () => {
    const { state } = drawn();
    const raw = JSON.parse(JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, regions: state.regions, cards: state.cards, activeThemeCardId: null, viewport: null }));
    raw.cards.push({ kind: 'stroke', id: 'bad', x: 0, y: 0, width: 1, height: 1, pageId: 'p', points: [0, 0, 1], lineWidth: 2 });
    raw.cards.push({ kind: 'sketchText', id: 'orphan', x: 0, y: 0, width: 10, height: 10, pageId: 'gone', text: 'x', fontSize: 'md' });
    const { project } = parseProject(raw);
    expect(project.cards.filter(isSketchMark).map((c) => c.id).sort()).toEqual(sketchMarks(state, 'p').map((c) => c.id).sort());
  });
});

describe('示意图与转线框', () => {
  it('笔迹和文字换算成示意图像素（逻辑尺寸 3 倍）；空文字不画', () => {
    const { state, page } = drawn();
    const withEmpty = createSketchText(state, page.id, { x: page.x, y: page.y }, 'sm', makeId)!.state;
    const sketch = sketchBoxes(page, [], sketchMarks(withEmpty, page.id));
    const scale = 1179 / page.width;
    expect(sketch.strokes).toHaveLength(1);
    expect(sketch.strokes[0].points.slice(0, 2)).toEqual([Math.round(10 * scale), Math.round(10 * scale)]);
    expect(sketch.strokes[0].width).toBe(Math.round(2 * scale));
    expect(sketch.texts).toEqual([{ text: '这里放优惠券', x: Math.round(20 * scale), y: Math.round(200 * (2556 / page.height)), fontSize: Math.round(18 * scale) }]);
  });

  it('草图转线框出图后页面框自动隐藏草图', () => {
    const { state, page } = drawn();
    const started = sketchToWireframe(state, page.id, version('sk', 1179, 2556), makeId)!;
    const done = applyGenerationResult(started.state, { promptCardId: started.promptId, outputCardId: 'w', versions: [version('w1', 1179, 2556)], placement: { x: 0, y: 0, width: 300, height: 650 } });
    const after = done.cards.find((c): c is PageCard => c.id === page.id && isPageCard(c))!;
    expect(after).toMatchObject({ sketchHidden: true, baseSource: 'own' });
    expect(sketchMarks(done, page.id)).toHaveLength(2);
  });
});
