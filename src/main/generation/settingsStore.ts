import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL } from '../../shared/assistant';
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SILICONFLOW_EDIT_MODEL,
  DEFAULT_SILICONFLOW_T2I_MODEL,
  OPENAI_MODELS,
  SILICONFLOW_EDIT_MODELS,
  SILICONFLOW_T2I_MODELS,
  type GenerationConfig,
  type ProviderId,
} from '../../shared/generation';

export type KeyProvider = 'openai' | 'siliconflow';

interface StoredSettings {
  provider: ProviderId;
  model: string;
  assistantModel: string;
  assistantProvider: 'openai' | 'mock';
  siliconflowEditModel: string;
  siliconflowT2iModel: string;
  calibration: Record<string, number>;
}

export type SettingsPatch = Partial<
  Pick<StoredSettings, 'provider' | 'model' | 'assistantModel' | 'assistantProvider' | 'siliconflowEditModel' | 'siliconflowT2iModel'>
>;

const DEFAULTS: StoredSettings = {
  provider: 'openai',
  model: DEFAULT_OPENAI_MODEL,
  assistantModel: DEFAULT_ASSISTANT_MODEL,
  assistantProvider: 'openai',
  siliconflowEditModel: DEFAULT_SILICONFLOW_EDIT_MODEL,
  siliconflowT2iModel: DEFAULT_SILICONFLOW_T2I_MODEL,
  calibration: {},
};
/** 校准系数取指数滑动平均，单次异常不会让估算大幅跳动 */
const CALIBRATION_WEIGHT = 0.3;
const PROVIDERS: ProviderId[] = ['openai', 'siliconflow', 'mock'];
const KEY_FILES: Record<KeyProvider, string> = { openai: 'openai-key.bin', siliconflow: 'siliconflow-key.bin' };

const oneOf = <T extends string>(value: unknown, allowed: readonly { id: T }[] | readonly T[], fallback: T): T => {
  const ids = (allowed as readonly (T | { id: T })[]).map((item) => (typeof item === 'string' ? item : item.id));
  return ids.includes(value as T) ? (value as T) : fallback;
};

/**
 * 生成设置存在 userData/generation.json；各家 API Key 用 safeStorage 加密后分开存放，
 * 解密密钥由 macOS 钥匙串保管，Key 本身不会以明文落盘，也不会发给渲染进程。
 */
export class GenerationSettingsStore {
  private settings: StoredSettings = DEFAULTS;
  private readonly keys: Record<KeyProvider, string | null> = { openai: null, siliconflow: null };
  private loaded = false;

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'generation.json'), 'utf8')) as Partial<StoredSettings>;
      this.settings = {
        provider: oneOf(raw.provider, PROVIDERS, DEFAULTS.provider),
        model: oneOf(raw.model, OPENAI_MODELS, DEFAULTS.model),
        assistantModel: oneOf(raw.assistantModel, ASSISTANT_MODELS, DEFAULTS.assistantModel),
        // 旧设置里没有这一项：以前生图选本地模拟时助手也是本地模拟
        assistantProvider: raw.assistantProvider === 'mock' || (!raw.assistantProvider && raw.provider === 'mock') ? 'mock' : 'openai',
        siliconflowEditModel: oneOf(raw.siliconflowEditModel, SILICONFLOW_EDIT_MODELS, DEFAULTS.siliconflowEditModel),
        siliconflowT2iModel: oneOf(raw.siliconflowT2iModel, SILICONFLOW_T2I_MODELS, DEFAULTS.siliconflowT2iModel),
        calibration: raw.calibration && typeof raw.calibration === 'object' ? raw.calibration : {},
      };
    } catch {
      this.settings = { ...DEFAULTS };
    }
    for (const provider of Object.keys(KEY_FILES) as KeyProvider[]) {
      try {
        const encrypted = await readFile(join(this.dir, KEY_FILES[provider]));
        this.keys[provider] = encrypted.length ? safeStorage.decryptString(encrypted) : null;
      } catch {
        this.keys[provider] = null;
      }
    }
  }

  config(): GenerationConfig {
    const { openai, siliconflow } = this.keys;
    return {
      provider: this.settings.provider,
      model: this.settings.model,
      assistantModel: this.settings.assistantModel,
      assistantProvider: this.settings.assistantProvider,
      hasApiKey: !!openai,
      apiKeyHint: openai ? openai.slice(-4) : null,
      hasSiliconflowKey: !!siliconflow,
      siliconflowKeyHint: siliconflow ? siliconflow.slice(-4) : null,
      siliconflowEditModel: this.settings.siliconflowEditModel,
      siliconflowT2iModel: this.settings.siliconflowT2iModel,
      calibration: { ...this.settings.calibration },
    };
  }

  getApiKey(provider: KeyProvider = 'openai'): string | null {
    return this.keys[provider];
  }

  async update(patch: SettingsPatch): Promise<GenerationConfig> {
    const s = this.settings;
    if (patch.provider) s.provider = oneOf(patch.provider, PROVIDERS, s.provider);
    if (patch.model) s.model = oneOf(patch.model, OPENAI_MODELS, s.model);
    if (patch.assistantModel) s.assistantModel = oneOf(patch.assistantModel, ASSISTANT_MODELS, s.assistantModel);
    if (patch.assistantProvider) s.assistantProvider = patch.assistantProvider === 'mock' ? 'mock' : 'openai';
    if (patch.siliconflowEditModel) s.siliconflowEditModel = oneOf(patch.siliconflowEditModel, SILICONFLOW_EDIT_MODELS, s.siliconflowEditModel);
    if (patch.siliconflowT2iModel) s.siliconflowT2iModel = oneOf(patch.siliconflowT2iModel, SILICONFLOW_T2I_MODELS, s.siliconflowT2iModel);
    await this.persist();
    return this.config();
  }

  async setApiKey(provider: KeyProvider, key: string | null): Promise<GenerationConfig> {
    const trimmed = key?.trim() || null;
    const file = join(this.dir, KEY_FILES[provider]);
    if (trimmed) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存 API Key');
      await writeFile(file, safeStorage.encryptString(trimmed));
    } else {
      await writeFile(file, Buffer.alloc(0)).catch(() => {});
    }
    this.keys[provider] = trimmed;
    return this.config();
  }

  async recordCalibration(key: string, ratio: number): Promise<void> {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const previous = this.settings.calibration[key];
    this.settings.calibration[key] = previous ? previous * (1 - CALIBRATION_WEIGHT) + ratio * CALIBRATION_WEIGHT : ratio;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeFile(join(this.dir, 'generation.json'), JSON.stringify(this.settings, null, 2));
  }
}
