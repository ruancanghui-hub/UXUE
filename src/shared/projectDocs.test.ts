import { describe, expect, it } from 'vitest';
import {
  PROJECT_DOCS,
  designSpecImagePromptFallback,
  projectDocTemplate,
} from './projectDocs';

describe('项目文稿', () => {
  it('四类路径固定', () => {
    expect(PROJECT_DOCS.map((d) => d.relativePath)).toEqual([
      'docs/PRD.md',
      'docs/界面简报.md',
      'docs/设计规范.md',
      'AGENTS.md',
    ]);
  });

  it('模板含项目名与基本小节', () => {
    const prd = projectDocTemplate('prd', '寿司郎');
    expect(prd).toContain('寿司郎');
    expect(prd).toContain('产品需求');
    expect(projectDocTemplate('agents', '寿司郎')).toContain('Agent');
  });

  it('规范图回退提示词截断过长正文', () => {
    const long = `# 规范\n${'色板 '.repeat(500)}`;
    const prompt = designSpecImagePromptFallback(long);
    expect(prompt).toContain('设计规范展示图');
    expect(prompt.length).toBeLessThan(2000);
  });
});
