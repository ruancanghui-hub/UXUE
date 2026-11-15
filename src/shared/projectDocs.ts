/** 项目文稿：磁盘 Markdown，不进画布 / project.json */

export type ProjectDocRole = 'prd' | 'brief' | 'designSpec' | 'agents';

export interface ProjectDocMeta {
  role: ProjectDocRole;
  /** 相对项目根 */
  relativePath: string;
  label: string;
  description: string;
}

export const PROJECT_DOCS: readonly ProjectDocMeta[] = [
  {
    role: 'prd',
    relativePath: 'docs/PRD.md',
    label: '产品需求',
    description: '产品做什么、给谁用、核心流程与约束',
  },
  {
    role: 'brief',
    relativePath: 'docs/界面简报.md',
    label: '界面简报',
    description: '感觉、要与不要、品牌色、线框结构（先于出图）',
  },
  {
    role: 'designSpec',
    relativePath: 'docs/设计规范.md',
    label: '设计规范',
    description: '色彩、字体、组件与禁忌；可生成设计规范图',
  },
  {
    role: 'agents',
    relativePath: 'AGENTS.md',
    label: '代理说明',
    description: '给 Cursor / Claude 等外部 Agent 的项目约定',
  },
] as const;

export function projectDocMeta(role: ProjectDocRole): ProjectDocMeta {
  return PROJECT_DOCS.find((doc) => doc.role === role)!;
}

export function projectDocTemplate(role: ProjectDocRole, projectName: string): string {
  const name = projectName.trim() || '未命名项目';
  switch (role) {
    case 'prd':
      return `# ${name} · 产品需求

## 一句话
（这个产品解决什么问题）

## 用户
（给谁用）

## 核心场景
1.
2.

## 约束与非目标
-
`;
    case 'brief':
      return `# ${name} · 界面简报

## 产品感觉
（整体应该是什么感觉）

## 想要 / 要避免
- 想要：
- 要避免：

## 品牌色
| 角色 | Hex |
|---|---|
| 主色 | |
| 背景 | |

## 主页面线框
（只写有什么、放在哪；视觉留给概念图）
`;
    case 'designSpec':
      return `# ${name} · 设计规范

## 色彩
-

## 字体与字号
-

## 圆角 / 间距 / 质感
-

## 组件与图标
-

## 禁忌
-
`;
    case 'agents':
      return `# ${name} · Agent 说明

后续在本项目里做页面或改 UI 时请遵守：

1. 先读 \`docs/PRD.md\` 与 \`docs/界面简报.md\` 了解产品与感觉；
2. 视觉与组件以 \`docs/设计规范.md\` 为准（若已有「设计规范图」图像卡，一并参考）；
3. 不要把长文需求写进画布卡片；项目文稿只维护本目录这些 Markdown。
`;
  }
}

/** 无助手时：把规范收成一段可用的文生图提示词 */
export function designSpecImagePromptFallback(markdown: string): string {
  const body = markdown
    .replace(/^#+\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  return [
    '一张完整的移动应用设计规范展示图（design system board），横版构图，清晰分区：',
    '色板色块与 hex、字体样例、圆角与间距示意、若干 UI 组件与图标示例、禁忌对照。',
    '风格现代、干净、适合放到 Figma 当参考。根据以下设计规范内容来画：',
    body || '（规范正文为空，请画出通用的现代移动端设计规范板。）',
  ].join('\n');
}

/** 请助手只产出生图提示词时用的用户消息 */
export function designSpecSummarizeMessage(markdown: string): string {
  return [
    '下面是一份产品的设计规范 Markdown。请写成**一段**可直接用于文生图的提示词（中文或中英均可），',
    '要求画出一张「设计规范展示图 / design system board」：色板、字体、圆角间距、组件示例、禁忌。',
    '不要解释、不要列表标题，只输出提示词正文。',
    '',
    '---',
    markdown.slice(0, 8000),
  ].join('\n');
}
