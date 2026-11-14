import { RULE_LABELS, type ThemeCard, type ThemeRules } from './project';

export interface ThemeMarkdownOptions {
  projectName: string;
  /** 主题来源图像卡的名字；没有来源为 null */
  sourceName: string | null;
  /** 存成文件时，来源图相对 .md 的路径；复制到剪贴板时为 null（路径在别处没有意义） */
  sourceImagePath: string | null;
}

/** 主题说明：开头是给其它模型的使用说明，后面是完整的视觉主题 */
export function themeMarkdown(theme: ThemeCard, options: ThemeMarkdownOptions): string {
  const lines: string[] = [`# 视觉主题：${theme.name}`, ''];
  lines.push(
    `> 使用说明：这是「${options.projectName}」的视觉规范。生成任何界面素材（图标、插画、Banner、页面）时都要遵守下面的配色和统一规则。` +
      '统一不是让所有元素长得一样，而是让不同元素遵循同一套视觉规则。不要把这些规则写成画面里的文字。',
    '',
  );

  if (theme.topic.trim()) lines.push('## 产品主题', '', theme.topic.trim(), '');
  if (theme.keywords.length) lines.push('## 视觉关键词', '', theme.keywords.join('、'), '');
  if (theme.cues.length) lines.push('## 视觉线索', '', ...theme.cues.map((cue) => `- ${cue}`), '');

  if (theme.palette.length) {
    lines.push('## 配色', '', '| 角色 | 名字 | 色值 | 用途 |', '| --- | --- | --- | --- |');
    for (const color of theme.palette) {
      lines.push(`| ${cell(color.role)} | ${cell(color.name)} | \`${color.hex}\` | ${cell(color.note)} |`);
    }
    lines.push('');
  }

  const rules = (Object.keys(RULE_LABELS) as (keyof ThemeRules)[]).filter((key) => theme.rules[key].trim());
  if (rules.length) {
    lines.push('## 统一规则', '', ...rules.map((key) => `- **${RULE_LABELS[key]}**：${theme.rules[key].trim()}`), '');
  }

  if (options.sourceName) {
    lines.push('## 主题来源', '', `从参考图「${options.sourceName}」提炼。`, '');
    if (options.sourceImagePath) lines.push(`![主题来源](${encodeURI(options.sourceImagePath)})`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 表格单元格里不能有竖线和换行 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || '—';
}
