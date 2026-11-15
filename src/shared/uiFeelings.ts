/** 界面感觉：生图时可多选附加的气质约束（非视觉主题） */

export type UiFeelingId = 'order' | 'restraint' | 'calm';

/** 拼接顺序：骨架 → 取舍 → 情绪 */
export const UI_FEELING_ORDER: readonly UiFeelingId[] = ['order', 'restraint', 'calm'];

export const UI_FEELINGS: readonly { id: UiFeelingId; label: string; title: string }[] = [
  { id: 'order', label: '秩序', title: '秩序感' },
  { id: 'restraint', label: '克制', title: '克制感' },
  { id: 'calm', label: '从容', title: '从容感' },
];

const SUFFIX: Record<UiFeelingId, string> = {
  order: [
    '【界面感觉：秩序感】',
    '画面要有清晰可预测的结构：统一网格与对齐、间距规范；层级分明（标题→正文→辅助）；同类组件样式一致；相关信息分组就近；阅读流向从上到下、从左到右；少特例。',
  ].join('\n'),
  restraint: [
    '【界面感觉：克制感】',
    '只放必要元素，去掉装饰噪音；强调手段稀缺（主色/粗体/阴影/动效一页少用）；色板收敛，高饱和仅用于主操作或警示；动效只服务状态；文案短、不打扰。',
  ].join('\n'),
  calm: [
    '【界面感觉：从容感】',
    '界面不抢注意力、不制造焦虑：留白有呼吸、一页一个主操作、配色低刺激；信息渐进披露，少弹窗与紧迫感；交互反馈温和可预期、可撤销；界面安静可靠，焦点在任务本身。',
  ].join('\n'),
};

export function isUiFeelingId(value: unknown): value is UiFeelingId {
  return value === 'order' || value === 'restraint' || value === 'calm';
}

/** 去重并按固定顺序排序 */
export function normalizeFeelings(raw: unknown): UiFeelingId[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<UiFeelingId>();
  for (const item of raw) {
    if (isUiFeelingId(item)) set.add(item);
  }
  return UI_FEELING_ORDER.filter((id) => set.has(id));
}

/** 附加到生图提示词末尾；空则返回空串 */
export function feelingSuffix(feelings: readonly UiFeelingId[]): string {
  const ordered = normalizeFeelings(feelings);
  if (ordered.length === 0) return '';
  return ordered.map((id) => SUFFIX[id]).join('\n\n');
}

export function toggleFeeling(feelings: readonly UiFeelingId[], id: UiFeelingId): UiFeelingId[] {
  const set = new Set(feelings);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return UI_FEELING_ORDER.filter((feeling) => set.has(feeling));
}
