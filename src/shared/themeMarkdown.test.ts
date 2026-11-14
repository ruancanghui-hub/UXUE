import { describe, expect, it } from 'vitest';
import type { ThemeCard } from './project';
import { themeMarkdown } from './themeMarkdown';

const theme: ThemeCard = {
  kind: 'theme',
  id: 't1',
  name: '节日祝福',
  x: 0,
  y: 0,
  width: 420,
  height: 500,
  topic: '节日祝福与礼物赠送',
  keywords: ['温暖', '喜庆'],
  cues: ['红色礼盒', '香槟金缎带'],
  palette: [
    { role: '主色', name: '节日红', hex: '#D43E3E', note: '礼盒主体 | 关键按钮' },
    { role: '背景色', name: '', hex: '#F5D7D0', note: '' },
  ],
  rules: { shape: '方正礼盒为主体', material: '', lighting: '柔和顶部侧光', color: '红金暖色调' },
  groupId: null,
  sourceImageCardId: 'img',
  sourceVersionId: 'v1',
};

describe('主题说明', () => {
  it('开头是使用说明，后面依次是产品主题、关键词、线索、配色表、统一规则、主题来源', () => {
    const md = themeMarkdown(theme, { projectName: '02_节日祝福', sourceName: 'Icon-App', sourceImagePath: '../assets/v1.png' });
    const order = ['# 视觉主题：节日祝福', '> 使用说明：这是「02_节日祝福」', '## 产品主题', '## 视觉关键词', '## 视觉线索', '## 配色', '## 统一规则', '## 主题来源'];
    const positions = order.map((part) => md.indexOf(part));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(md).toContain('| 主色 | 节日红 | `#D43E3E` | 礼盒主体 \\| 关键按钮 |');
    expect(md).toContain('| 背景色 | — | `#F5D7D0` | — |');
    expect(md).toContain('- **造型**：方正礼盒为主体');
    expect(md).not.toContain('**材质**');
    expect(md).toContain('![主题来源](../assets/v1.png)');
  });

  it('复制到剪贴板时只写来源图名字；没有来源和空字段时省掉对应小节', () => {
    const clip = themeMarkdown(theme, { projectName: 'p', sourceName: 'Icon-App', sourceImagePath: null });
    expect(clip).toContain('从参考图「Icon-App」提炼。');
    expect(clip).not.toContain('![');
    const bare = themeMarkdown({ ...theme, cues: [], palette: [], sourceImageCardId: null }, { projectName: 'p', sourceName: null, sourceImagePath: null });
    expect(bare).not.toContain('## 视觉线索');
    expect(bare).not.toContain('## 配色');
    expect(bare).not.toContain('## 主题来源');
  });
});
