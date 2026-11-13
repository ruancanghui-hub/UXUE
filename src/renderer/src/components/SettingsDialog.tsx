import { useState } from 'react';
import { OPENAI_MODELS, type GenerationConfig, type ProviderId } from '../../../shared/generation';

interface SettingsDialogProps {
  config: GenerationConfig;
  onChange(config: GenerationConfig): void;
  onClose(): void;
}

export function SettingsDialog({ config, onChange, onClose }: SettingsDialogProps) {
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<GenerationConfig | string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await task();
      if (typeof result === 'string') setMessage({ text: result, tone: 'good' });
      else onChange(result);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  const setProvider = (provider: ProviderId): void => void run(() => window.anye.updateGenerationConfig({ provider }));

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="设置">
        <div className="dialog-title">设置</div>

        <section className="dialog-section">
          <div className="section-title">生成用的模型供应商</div>
          <label className="radio-row">
            <input type="radio" checked={config.provider === 'openai'} onChange={() => setProvider('openai')} />
            <span>
              OpenAI
              <span className="dim">　真实生成，按用量计费</span>
            </span>
          </label>
          <label className="radio-row">
            <input type="radio" checked={config.provider === 'mock'} onChange={() => setProvider('mock')} />
            <span>
              本地模拟
              <span className="dim">　不联网、不花钱，用来熟悉流程</span>
            </span>
          </label>
        </section>

        <section className="dialog-section">
          <div className="section-title">OpenAI API Key</div>
          <p className="hint">Key 用系统钥匙串加密保存在本机，只在主进程里使用，不会出现在界面或项目文件里。</p>
          {config.hasApiKey && <p className="field-value">已保存（末四位 {config.apiKeyHint}）</p>}
          <div className="button-row tight">
            <input
              className="name-input grow"
              type="password"
              placeholder={config.hasApiKey ? '输入新的 Key 替换' : 'sk-…'}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="off"
            />
            <button
              className="primary"
              disabled={busy || !key.trim()}
              onClick={() =>
                void run(async () => {
                  const next = await window.anye.setApiKey(key);
                  setKey('');
                  return next;
                })
              }
            >
              保存
            </button>
          </div>
          <div className="button-row tight">
            <button disabled={busy || !config.hasApiKey} onClick={() => void run(() => window.anye.testConnection())}>
              测试连接
            </button>
            <button className="danger" disabled={busy || !config.hasApiKey} onClick={() => void run(() => window.anye.setApiKey(null))}>
              清除 Key
            </button>
          </div>
        </section>

        <section className="dialog-section">
          <div className="section-title">模型</div>
          <select
            value={config.model}
            onChange={(event) => void run(() => window.anye.updateGenerationConfig({ model: event.target.value }))}
          >
            {OPENAI_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <p className="hint">
            生成前的费用是粗估（官方没有公开这一代模型每张图的 token 数）；每次真实生成后会按接口返回的实际用量自动校准。
          </p>
        </section>

        {message && <p className={message.tone === 'good' ? 'good-text' : 'warning'}>{message.text}</p>}
        <div className="button-row end">
          <button onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
