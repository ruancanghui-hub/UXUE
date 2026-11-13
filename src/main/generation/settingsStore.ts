import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS, type GenerationConfig, type ProviderId } from '../../shared/generation';

interface StoredSettings {
  provider: ProviderId;
  model: string;
  calibration: Record<string, number>;
}

const DEFAULTS: StoredSettings = { provider: 'openai', model: DEFAULT_OPENAI_MODEL, calibration: {} };
/** 校准系数取指数滑动平均，单次异常不会让估算大幅跳动 */
const CALIBRATION_WEIGHT = 0.3;

/**
 * 生成设置存在 userData/generation.json；API Key 用 safeStorage 加密后单独存放，
 * 解密密钥由 macOS 钥匙串保管，Key 本身不会以明文落盘，也不会发给渲染进程。
 */
export class GenerationSettingsStore {
  private settings: StoredSettings = DEFAULTS;
  private apiKey: string | null = null;
  private loaded = false;

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.settingsFile(), 'utf8')) as Partial<StoredSettings>;
      this.settings = {
        provider: raw.provider === 'mock' ? 'mock' : 'openai',
        model: OPENAI_MODELS.some((m) => m.id === raw.model) ? (raw.model as string) : DEFAULT_OPENAI_MODEL,
        calibration: raw.calibration && typeof raw.calibration === 'object' ? raw.calibration : {},
      };
    } catch {
      this.settings = { ...DEFAULTS };
    }
    try {
      const encrypted = await readFile(this.keyFile());
      this.apiKey = safeStorage.decryptString(encrypted);
    } catch {
      this.apiKey = null;
    }
  }

  config(): GenerationConfig {
    return {
      provider: this.settings.provider,
      model: this.settings.model,
      hasApiKey: !!this.apiKey,
      apiKeyHint: this.apiKey ? this.apiKey.slice(-4) : null,
      calibration: { ...this.settings.calibration },
    };
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  async update(patch: Partial<Pick<StoredSettings, 'provider' | 'model'>>): Promise<GenerationConfig> {
    if (patch.provider === 'openai' || patch.provider === 'mock') this.settings.provider = patch.provider;
    if (patch.model && OPENAI_MODELS.some((m) => m.id === patch.model)) this.settings.model = patch.model;
    await this.persist();
    return this.config();
  }

  async setApiKey(key: string | null): Promise<GenerationConfig> {
    const trimmed = key?.trim() || null;
    if (trimmed) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存 API Key');
      await writeFile(this.keyFile(), safeStorage.encryptString(trimmed));
    } else {
      await writeFile(this.keyFile(), Buffer.alloc(0)).catch(() => {});
    }
    this.apiKey = trimmed;
    return this.config();
  }

  async recordCalibration(key: string, ratio: number): Promise<void> {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const previous = this.settings.calibration[key];
    this.settings.calibration[key] = previous ? previous * (1 - CALIBRATION_WEIGHT) + ratio * CALIBRATION_WEIGHT : ratio;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeFile(this.settingsFile(), JSON.stringify(this.settings, null, 2));
  }

  private settingsFile(): string {
    return join(this.dir, 'generation.json');
  }

  private keyFile(): string {
    return join(this.dir, 'openai-key.bin');
  }
}
