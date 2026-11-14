import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_SETTINGS, nearestSize, planGeneration, renderPrompt, validatePrompt, type GenerationConfig } from './generation';

const config: Pick<GenerationConfig, 'provider' | 'model' | 'calibration' | 'siliconflowEditModel' | 'siliconflowT2iModel'> = {
  provider: 'siliconflow',
  model: 'gpt-image-2.6-flare',
  calibration: {},
  siliconflowEditModel: 'Qwen/Qwen-Image-Edit-2509',
  siliconflowT2iModel: 'Qwen/Qwen-Image',
};

describe('硅基流动', () => {
  it('有参考图走改图模型：不传尺寸、按张人民币计价、提示词用"图N"', () => {
    const plan = planGeneration(config, { ...DEFAULT_PROMPT_SETTINGS, count: 2 }, { width: 2048, height: 1024 }, 1);
    expect(plan).toMatchObject({ model: 'Qwen/Qwen-Image-Edit-2509', size: null, currency: 'CNY', promptStyle: 'tu', maxInputs: 3 });
    expect(plan.estimate).toBeCloseTo(0.6);
  });

  it('没有参考图走文生图模型，尺寸吸附到模型推荐尺寸', () => {
    const wide = planGeneration(config, { ...DEFAULT_PROMPT_SETTINGS, size: '1536x1024' }, null, 0);
    expect(wide).toMatchObject({ model: 'Qwen/Qwen-Image', size: { width: 1584, height: 1056 }, promptStyle: 'image' });
    const turbo = planGeneration({ ...config, siliconflowT2iModel: 'Tongyi-MAI/Z-Image-Turbo' }, { ...DEFAULT_PROMPT_SETTINGS, count: 1, size: '1024x1024' }, null, 0);
    expect(turbo.size).toEqual({ width: 512, height: 512 });
    expect(turbo.estimate).toBeCloseTo(0.1);
  });

  it('超过 3 张参考图时提交前就拦下', () => {
    expect(validatePrompt('把 {{Image 1}} 和 {{Image 4}} 合成', 4, 3)).toMatch(/最多接受 3 张/);
  });

  it('{{Image N}} 可以渲染成"图N"', () => {
    expect(renderPrompt('把 {{Image 1}} 的风格用到 {{Image 2}} 上', 'tu').text).toBe('把 图1 的风格用到 图2 上');
  });

  it('按比例挑最接近的推荐尺寸', () => {
    expect(nearestSize(['1328x1328', '1664x928', '928x1664'], 16 / 9)).toEqual({ width: 1664, height: 928 });
  });
});

describe('OpenAI', () => {
  it('按美元粗估，尺寸按"跟随输入图"计算', () => {
    const plan = planGeneration({ ...config, provider: 'openai' }, DEFAULT_PROMPT_SETTINGS, { width: 2048, height: 1024 }, 1);
    expect(plan).toMatchObject({ model: 'gpt-image-2.6-flare', currency: 'USD', promptStyle: 'image', maxInputs: 16 });
    expect(plan.size).toEqual({ width: 1776, height: 880 });
  });
});
