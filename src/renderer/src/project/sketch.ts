import type { SketchBox, SketchLabel, SketchStroke } from '../../../shared/api';
import {
  blockRelativeRect,
  isPageCard,
  isSketchTextCard,
  pageLogicalSize,
  SKETCH_FONT_SIZES,
  type PageCard,
  type SketchTextCard,
  type StrokeCard,
} from '../../../shared/project';
import { pageBlocks, sketchMarks, sketchToWireframe, strokeWorldPoints } from '../document/operations';
import type { ProjectSession } from './ProjectSession';

/** 示意图按页面逻辑尺寸的 3 倍画，和 iPhone 3 倍图一样清楚 */
const SKETCH_SCALE = 3;

/** 页面框里的区块、草图笔迹和草图文字换算成示意图上的像素坐标 */
export function sketchBoxes(
  page: PageCard,
  blocks: ReturnType<typeof pageBlocks>,
  marks: (StrokeCard | SketchTextCard)[] = [],
): { width: number; height: number; boxes: SketchBox[]; strokes: SketchStroke[]; texts: SketchLabel[] } {
  const logical = pageLogicalSize(page);
  const width = Math.round(logical.width * SKETCH_SCALE);
  const height = Math.round(logical.height * SKETCH_SCALE);
  const sx = width / page.width;
  const sy = height / page.height;
  const strokes: SketchStroke[] = [];
  const texts: SketchLabel[] = [];
  for (const mark of marks) {
    if (isSketchTextCard(mark)) {
      if (!mark.text.trim()) continue;
      texts.push({ text: mark.text, x: Math.round((mark.x - page.x) * sx), y: Math.round((mark.y - page.y) * sy), fontSize: Math.round(SKETCH_FONT_SIZES[mark.fontSize] * sx) });
    } else {
      const points = strokeWorldPoints(mark).map((v, i) => Math.round(i % 2 === 0 ? (v - page.x) * sx : (v - page.y) * sy));
      strokes.push({ points, width: Math.max(1, Math.round(mark.lineWidth * sx)) });
    }
  }
  const boxes = blocks.map((block) => {
    const rel = blockRelativeRect(block, page);
    return {
      name: block.name,
      x: Math.round(rel.x * width),
      y: Math.round(rel.y * height),
      width: Math.round(rel.width * width),
      height: Math.round(rel.height * height),
    };
  });
  return { width, height, boxes, strokes, texts };
}

/**
 * 草图转线框：画示意图（存成项目里的图片）→ 建「草图转线框」链 → 返回要生成的提示词卡。
 * 页面框必须还没有低保真原型，且至少有区块、草图笔迹或草图文字之一。
 */
export async function startSketchWireframe(session: ProjectSession, pageId: string): Promise<string> {
  const state = session.doc.get();
  const page = state.cards.find((card): card is PageCard => card.id === pageId && isPageCard(card));
  if (!page) throw new Error('找不到这个页面框');
  if (page.base) throw new Error('这个页面框已经有低保真原型了，用「转线框」');
  const blocks = pageBlocks(state, pageId);
  const marks = sketchMarks(state, pageId);
  if (blocks.length === 0 && marks.length === 0) throw new Error('先在页面框里画几笔：B 画区块、D 画笔、T 写文字');

  const sketch = sketchBoxes(page, blocks, marks);
  const result = await window.anye.importImages([{ kind: 'sketch', name: `${page.name}-布局草图.png`, ...sketch }]);
  if (result.errors.length || !result.versions[0]) throw new Error(`画布局草图失败：${result.errors[0]?.message ?? '未知原因'}`);

  const created = sketchToWireframe(session.doc.get(), pageId, result.versions[0], () => crypto.randomUUID());
  if (!created) throw new Error('找不到这个页面框');
  session.doc.apply('草图转线框', created.state);
  return created.promptId;
}
