import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { renderSimpleMarkdown } from './simpleMarkdown';

function html(source: string): string {
  return renderToStaticMarkup(createElement('div', null, renderSimpleMarkdown(source)));
}

describe('simpleMarkdown', () => {
  it('渲染加粗、列表和代码块', () => {
    const out = html('你好 **世界**\n\n- 一项\n- 二项\n\n```\ncode here\n```');
    expect(out).toContain('<strong>世界</strong>');
    expect(out).toContain('<ul');
    expect(out).toContain('一项');
    expect(out).toContain('md-code');
    expect(out).toContain('code here');
  });

  it('不把 HTML 标签当标记执行', () => {
    const out = html('看 <script>alert(1)</script> 和 `x`');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('md-inline-code');
  });
});
