import { describe, expect, it } from 'vitest';
import { buildConfigExport, parseConfigExport } from './configTransfer';

const settings = {
  provider: 'newapi',
  model: 'gpt-image-2.6-flare',
  assistantProvider: 'newapi',
  assistantModel: 'gpt-6.1-terra',
  siliconflowEditModel: 'Qwen/Qwen-Image-Edit-2509',
  siliconflowT2iModel: 'Qwen/Qwen-Image',
  newapiBaseUrl: 'https://relay.example.com/v1',
  newapiModel: 'gpt-image-2',
  newapiAssistantModel: 'claude-sonnet-5-5',
};
const keys = { openai: null, siliconflow: 'sk-sf', newapi: 'sk-na' };
const templates = [{ id: 't1', name: '3D 图标', text: '把 {{Image 1}} 做成 3D 图标', defaultSettings: { count: 1, size: 'match' as const, quality: 'medium' as const, useTheme: true, feelings: [] } }];

describe('配置迁移文件', () => {
  it('导出再读回完全一致，只带白名单里的设置（不带校准系数）', () => {
    const exported = buildConfigExport({ ...settings, calibration: 'x' } as never, keys, templates, new Date('2026-11-14T00:00:00Z'));
    expect(exported.settings).toEqual(settings);
    const parsed = parseConfigExport(JSON.parse(JSON.stringify(exported)));
    expect(parsed).toEqual(exported);
    expect(parsed.exportedAt).toBe('2026-11-14T00:00:00.000Z');
  });

  it('不是这个格式或版本不对就报错', () => {
    expect(() => parseConfigExport({ hello: 1 })).toThrow('不是暗夜精灵的配置文件');
    expect(() => parseConfigExport(null)).toThrow('不是暗夜精灵的配置文件');
    expect(() => parseConfigExport({ format: 'anye-config', version: 9 })).toThrow('版本是 9');
  });

  it('字段缺失或类型不对时跳过：空 Key 记为 null，坏模板丢掉', () => {
    const parsed = parseConfigExport({
      format: 'anye-config',
      version: 1,
      settings: { provider: 'newapi', model: 3 },
      keys: { openai: '  ', newapi: ' sk-na ' },
      templates: [{ id: 'ok', name: 'a', text: 'b' }, { id: 1, name: 'bad', text: 'c' }, 'nope'],
    });
    expect(parsed.settings).toEqual({ provider: 'newapi' });
    expect(parsed.keys).toEqual({ openai: null, siliconflow: null, newapi: 'sk-na' });
    expect(parsed.templates).toEqual([{ id: 'ok', name: 'a', text: 'b' }]);
  });
});
