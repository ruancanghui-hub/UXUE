import { useEffect, useState } from 'react';
import type { PromptTemplate } from '../../../shared/api';
import { ASSISTANT_MODELS } from '../../../shared/assistant';
import {
  NEWAPI_ASSISTANT_MODELS,
  NEWAPI_MODELS,
  OPENAI_MODELS,
  SILICONFLOW_EDIT_MODELS,
  SILICONFLOW_T2I_MODELS,
  type AssistantProviderId,
  type GenerationConfig,
  type ProviderId,
} from '../../../shared/generation';

interface SettingsDialogProps {
  config: GenerationConfig;
  onChange(config: GenerationConfig): void;
  onClose(): void;
}

type KeyProvider = 'openai' | 'siliconflow' | 'newapi';
type Message = { text: string; tone: 'good' | 'bad' } | null;

const cleanError = (error: unknown): string =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);

export function SettingsDialog({ config, onChange, onClose }: SettingsDialogProps) {
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [draftName, setDraftName] = useState('');
  const [draftText, setDraftText] = useState('');

  useEffect(() => {
    void window.anye.listPromptTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const run = async (task: () => Promise<GenerationConfig | string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await task();
      if (typeof result === 'string') setMessage({ text: result, tone: 'good' });
      else onChange(result);
    } catch (error) {
      setMessage({ text: cleanError(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  const [transferNote, setTransferNote] = useState<Message>(null);
  /** 导出 / 导入配置：结果就近显示在按钮下面；task 返回 null 表示用户取消 */
  const transfer = async (task: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setTransferNote(null);
    try {
      const text = await task();
      if (text) setTransferNote({ text, tone: 'good' });
    } catch (error) {
      setTransferNote({ text: cleanError(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  const exportConfig = async (): Promise<string | null> => {
    const path = await window.anye.exportConfig();
    return path ? `已导出到 ${path}` : null;
  };
  const importConfig = async (): Promise<string | null> => {
    const result = await window.anye.importConfig();
    if (!result) return null;
    onChange(result.config);
    setTemplates(await window.anye.listPromptTemplates());
    const provider = providers.find((p) => p.id === result.config.provider)?.label ?? result.config.provider;
    return `已导入：生图 ${provider}、${result.keyCount} 个 Key、${result.templateCount} 个模板`;
  };
  const update = (patch: Parameters<typeof window.anye.updateGenerationConfig>[0]): void =>
    void run(() => window.anye.updateGenerationConfig(patch));

  const providers: { id: ProviderId; label: string; note: string }[] = [
    { id: 'siliconflow', label: '硅基流动', note: '国内直连，Qwen 改图 ¥0.3/张，最多 3 张参考图' },
    { id: 'newapi', label: 'NewAPI 中转', note: 'OpenAI 兼容中转，填 Base URL + Key' },
    { id: 'openai', label: 'OpenAI', note: 'gpt-image-2.6，按用量美元计费' },
    { id: 'mock', label: '本地模拟', note: '不联网、不花钱，用来熟悉流程' },
  ];

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="设置">
        <div className="dialog-title">设置</div>

        <section className="dialog-section">
          <div className="section-title">生图供应商</div>
          {providers.map((provider) => (
            <label key={provider.id} className="radio-row">
              <input type="radio" checked={config.provider === provider.id} onChange={() => update({ provider: provider.id })} />
              <span>
                {provider.label}
                <span className="dim">　{provider.note}</span>
              </span>
            </label>
          ))}
        </section>

        {config.provider === 'siliconflow' && (
          <section className="dialog-section">
            <div className="section-title">硅基流动模型</div>
            <div className="field">
              <span className="field-label">有参考图时（改图）</span>
              <select value={config.siliconflowEditModel} onChange={(e) => update({ siliconflowEditModel: e.target.value })}>
                {SILICONFLOW_EDIT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · ¥{m.priceCny}/张
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label">没有参考图时（文生图）</span>
              <select value={config.siliconflowT2iModel} onChange={(e) => update({ siliconflowT2iModel: e.target.value })}>
                {SILICONFLOW_T2I_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · ¥{m.priceCny}/张
                  </option>
                ))}
              </select>
            </div>
            <p className="hint">
              已关闭接口自动加的可见水印；按平台规定，用在最终成品上时请自行加上"AI 生成"标识。改图模型的输出尺寸跟随输入图。
            </p>
          </section>
        )}

        {config.provider === 'newapi' && (
          <section className="dialog-section">
            <div className="section-title">NewAPI 中转</div>
            <div className="field">
              <span className="field-label">Base URL</span>
              <input
                type="url"
                defaultValue={config.newapiBaseUrl}
                placeholder="https://你的中转域名 或 …/v1"
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== config.newapiBaseUrl) update({ newapiBaseUrl: value });
                }}
              />
            </div>
            <div className="field">
              <span className="field-label">生图模型</span>
              <select
                value={NEWAPI_MODELS.some((m) => m.id === config.newapiModel) ? config.newapiModel : '__custom__'}
                onChange={(event) => {
                  if (event.target.value !== '__custom__') update({ newapiModel: event.target.value });
                }}
              >
                {NEWAPI_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
                <option value="__custom__">自定义模型 id…</option>
              </select>
            </div>
            {!NEWAPI_MODELS.some((m) => m.id === config.newapiModel) && (
              <div className="field">
                <span className="field-label">自定义模型 id</span>
                <input
                  defaultValue={config.newapiModel}
                  placeholder="站点后台里的模型名"
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value && value !== config.newapiModel) update({ newapiModel: value });
                  }}
                />
              </div>
            )}
            <p className="hint">
              走 OpenAI 兼容的 <code>/v1/images/generations</code>（有参考图则 <code>/edits</code>）。模型 id 必须和中转站后台一致；你这边可用的生图多为 <code>gemini-*-image</code>。DALL·E 仅文生图。费用按中转返回的 usage 估算（美元显示）。
            </p>
          </section>
        )}

        {config.provider === 'openai' && (
          <section className="dialog-section">
            <div className="section-title">OpenAI 生图模型</div>
            <select value={config.model} onChange={(event) => update({ model: event.target.value })}>
              {OPENAI_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <p className="hint">生成前的费用是粗估；每次真实生成后会按接口返回的实际用量自动校准。</p>
          </section>
        )}

        <section className="dialog-section">
          <div className="section-title">助手</div>
          <div className="field">
            <span className="field-label">供应商</span>
            <select
              value={config.assistantProvider}
              onChange={(e) => update({ assistantProvider: e.target.value as AssistantProviderId })}
            >
              <option value="newapi">NewAPI 中转</option>
              <option value="openai">OpenAI</option>
              <option value="mock">本地模拟</option>
            </select>
          </div>
          {config.assistantProvider === 'openai' && (
            <select value={config.assistantModel} onChange={(event) => update({ assistantModel: event.target.value })}>
              {ASSISTANT_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · 输入 ${model.input} / 输出 ${model.output} 每百万 token
                </option>
              ))}
            </select>
          )}
          {config.assistantProvider === 'newapi' && (
            <>
              <div className="field">
                <span className="field-label">看图对话模型</span>
                <select
                  value={
                    NEWAPI_ASSISTANT_MODELS.some((m) => m.id === config.newapiAssistantModel)
                      ? config.newapiAssistantModel
                      : '__custom__'
                  }
                  onChange={(event) => {
                    if (event.target.value !== '__custom__') update({ newapiAssistantModel: event.target.value });
                  }}
                >
                  {NEWAPI_ASSISTANT_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                  <option value="__custom__">自定义模型 id…</option>
                </select>
              </div>
              {!NEWAPI_ASSISTANT_MODELS.some((m) => m.id === config.newapiAssistantModel) && (
                <div className="field">
                  <span className="field-label">自定义模型 id</span>
                  <input
                    defaultValue={config.newapiAssistantModel}
                    placeholder="站点后台里能看图的对话模型名"
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value && value !== config.newapiAssistantModel) update({ newapiAssistantModel: value });
                    }}
                  />
                </div>
              )}
              <p className="hint">
                复用上面 NewAPI 的 Base URL 和 Key，走 <code>/v1/chat/completions</code>。要选能看图的对话模型（不要选 <code>*-image</code> 生图模型）。
              </p>
            </>
          )}
        </section>

        <KeySection
          provider="siliconflow"
          title="硅基流动 API Key"
          hasKey={config.hasSiliconflowKey}
          hint={config.siliconflowKeyHint}
          placeholder="sk-…（在 cloud.siliconflow.cn 的 API 密钥页创建）"
          busy={busy}
          run={run}
        />
        <KeySection
          provider="newapi"
          title="NewAPI Key"
          hasKey={config.hasNewapiKey}
          hint={config.newapiKeyHint}
          placeholder="中转站发放的 API Key"
          busy={busy}
          run={run}
        />
        <KeySection
          provider="openai"
          title="OpenAI API Key"
          hasKey={config.hasApiKey}
          hint={config.apiKeyHint}
          placeholder="sk-…"
          busy={busy}
          run={run}
        />
        <p className="hint">Key 用系统钥匙串加密保存在本机，只在主进程里使用，不会出现在界面或项目文件里。</p>

        <section className="dialog-section">
          <div className="section-title">配置迁移</div>
          <p className="hint">
            把供应商、模型、Base URL、API Key 和提示词模板导出成一个文件，换电脑后导入就能直接用。导入会覆盖这些设置；模板会合并进来，同一个模板覆盖、新的追加。
          </p>
          <p className="warning">导出文件里的 API Key 是明文，请妥善保管，不要发给别人或传到公开的地方。</p>
          <div className="button-row tight">
            <button disabled={busy} onClick={() => void transfer(exportConfig)}>
              导出配置…
            </button>
            <button disabled={busy} onClick={() => void transfer(importConfig)}>
              导入配置…
            </button>
          </div>
          {transferNote && <p className={transferNote.tone === 'good' ? 'good-text' : 'warning'}>{transferNote.text}</p>}
        </section>

        <section className="dialog-section">
          <div className="section-title">提示词模板</div>
          <p className="hint">跨项目复用。也可以在提示词卡属性里「存为模板」。</p>
          {templates.length === 0 && <p className="dim">还没有模板</p>}
          <ul className="template-list">
            {templates.map((template) => (
              <li key={template.id} className="template-row">
                <div className="template-meta">
                  <div className="template-name">{template.name}</div>
                  <div className="template-preview">{template.text.trim() || '（空提示词）'}</div>
                </div>
                <button
                  className="danger small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.anye.removePromptTemplate(template.id);
                      setTemplates(await window.anye.listPromptTemplates());
                      return '已删除模板';
                    })
                  }
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
          <div className="field">
            <span className="field-label">名称</span>
            <input className="name-input" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="例如：线稿转 3D" />
          </div>
          <textarea
            className="prompt-input template-draft"
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="模板提示词正文，可用 {{Image 1}} 指代输入图"
            aria-label="模板正文"
          />
          <button
            className="primary"
            disabled={busy || !draftName.trim() || !draftText.trim()}
            onClick={() =>
              void run(async () => {
                await window.anye.createPromptTemplate(draftName.trim(), draftText);
                setDraftName('');
                setDraftText('');
                setTemplates(await window.anye.listPromptTemplates());
                return '已添加模板';
              })
            }
          >
            添加模板
          </button>
        </section>

        {message && <p className={message.tone === 'good' ? 'good-text' : 'warning'}>{message.text}</p>}
        <div className="button-row end">
          <button onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

function KeySection(props: {
  provider: KeyProvider;
  title: string;
  hasKey: boolean;
  hint: string | null;
  placeholder: string;
  busy: boolean;
  run(task: () => Promise<GenerationConfig | string>): Promise<void>;
}) {
  const [key, setKey] = useState('');
  const { provider, busy, run } = props;
  return (
    <section className="dialog-section">
      <div className="section-title">{props.title}</div>
      {props.hasKey && <p className="field-value">已保存（末四位 {props.hint}）</p>}
      <div className="button-row tight">
        <input
          className="name-input grow"
          type="password"
          placeholder={props.hasKey ? '输入新的 Key 替换' : props.placeholder}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
        />
        <button
          className="primary"
          disabled={busy || !key.trim()}
          onClick={() =>
            void run(async () => {
              const next = await window.anye.setApiKey(provider, key);
              setKey('');
              return next;
            })
          }
        >
          保存
        </button>
      </div>
      <div className="button-row tight">
        <button disabled={busy || !props.hasKey} onClick={() => void run(() => window.anye.testConnection(provider))}>
          测试连接
        </button>
        <button className="danger" disabled={busy || !props.hasKey} onClick={() => void run(() => window.anye.setApiKey(provider, null))}>
          清除 Key
        </button>
      </div>
    </section>
  );
}
