import { currentVersion, isImageCard, isThemeCard } from '../../../shared/project';
import { themeMarkdown } from '../../../shared/themeMarkdown';
import type { DocState } from '../document/operations';

/** 存成文件时 .md 在 themes/ 下，来源图在 assets/ 下 */
const THEMES_TO_PROJECT = '..';

/** 按主题卡 id 生成主题说明；forFile 时插入来源图的相对链接 */
export function themeMarkdownFor(state: DocState, themeId: string, projectName: string, forFile: boolean): { name: string; markdown: string } | null {
  const theme = state.cards.find((card) => card.id === themeId);
  if (!theme || !isThemeCard(theme)) return null;
  const source = theme.sourceImageCardId ? state.cards.find((card) => card.id === theme.sourceImageCardId) : undefined;
  const sourceVersion =
    source && isImageCard(source) ? source.versions.find((v) => v.id === theme.sourceVersionId) ?? currentVersion(source) : null;
  return {
    name: theme.name,
    markdown: themeMarkdown(theme, {
      projectName,
      sourceName: source && isImageCard(source) ? source.name : null,
      sourceImagePath: forFile && sourceVersion ? `${THEMES_TO_PROJECT}/${sourceVersion.file}` : null,
    }),
  };
}

/** ⌘K 的目标主题卡：选中了恰好一张主题卡就用它，否则用生效主题卡 */
export function targetThemeId(state: DocState, selectedIds: ReadonlySet<string>): string | null {
  const selected = state.cards.filter((card) => isThemeCard(card) && selectedIds.has(card.id));
  if (selected.length === 1) return selected[0].id;
  return state.activeThemeCardId;
}
