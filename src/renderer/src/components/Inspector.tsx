import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  calibrationKey,
  estimateCostUsd,
  formatUsd,
  MAX_COUNT,
  MIN_COUNT,
  QUALITIES,
  resolveSize,
  SIZE_OPTIONS,
  validatePrompt,
  type GenerationConfig,
  type PromptSettings,
} from '../../../shared/generation';
import type { ExportResult } from '../../../shared/export';
import {
  currentVersion,
  DEVICE_PRESETS,
  isImageCard,
  isPageCard,
  isPromptCard,
  isRefCard,
  isThemeCard,
  pageLogicalSize,
  normalizeHex,
  RULE_LABELS,
  themeSuffix,
  type ImageCard,
  type PageCard,
  type PromptCard,
  type RefCard,
  type ThemeCard,
  type ThemeColor,
  type ThemeRules,
} from '../../../shared/project';
import type { DocumentStore } from '../document/DocumentStore';
import { updatePrompt, type DocState } from '../document/operations';
import { activeTheme } from '../project/GenerationTracker';
import type { TrackedJob } from '../project/GenerationTracker';
import { thumbnailUrl } from '../project/thumbnails';

export interface InspectorHandle {
  focusPrompt(): void;
}

interface InspectorProps {
  /** 面板顶部的「属性 / 助手」切换 */
  tabs: React.ReactNode;
  state: DocState;
  doc: DocumentStore;
  selectedIds: ReadonlySet<string>;
  projectName: string;
  projectDir: string;
  missingVersionIds: ReadonlySet<string>;
  cacheBust: ReadonlyMap<string, number>;
  config: GenerationConfig | null;
  jobs: TrackedJob[];
  onRename(id: string, name: string): void;
  onSetCurrentVersion(id: string, versionId: string): void;
  onImportVersion(id: string): void;
  onDuplicate(): void;
  onDelete(): void;
  onBringToFront(): void;
  onReveal(path: string): void;
  onGenerate(promptId: string): void;
  onRemoveInput(promptId: string, index: number): void;
  onMoveInput(promptId: string, index: number, delta: -1 | 1): void;
  onSettings(promptId: string, settings: Partial<PromptSettings>): void;
  onSelectCard(id: string): void;
  onNewPrompt(): void;
  onUpdateTheme(id: string, patch: Partial<Omit<ThemeCard, 'kind' | 'id'>>): void;
  onSetActiveTheme(id: string | null): void;
  onUpdatePage(id: string, patch: Partial<Omit<PageCard, 'kind' | 'id'>>): void;
  onSetPagePreset(id: string, presetId: string | null): void;
  onReplaceLowFi(pageId: string): void;
  onExportPage(pageId: string): void;
  onPlaceInPage(imageCardId: string, pageId: string): void;
  exports: ReadonlyMap<string, ExportResult | 'running' | { error: string }>;
}

export const Inspector = forwardRef<InspectorHandle, InspectorProps>(function Inspector(props, ref) {
  const selected = props.state.cards.filter((card) => props.selectedIds.has(card.id));
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    focusPrompt: () => {
      const element = promptRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    },
  }));

  const only = selected.length === 1 ? selected[0] : null;
  return (
    <aside className="side-panel inspector">
      {props.tabs}
      {selected.length === 0 && <ProjectInfo {...props} />}
      {only && isImageCard(only) && <ImageInfo card={only} {...props} />}
      {only && isPromptCard(only) && <PromptInfo card={only} textareaRef={promptRef} {...props} />}
      {only && isThemeCard(only) && <ThemeInfo card={only} {...props} />}
      {only && isPageCard(only) && <PageInfo card={only} {...props} />}
      {only && isRefCard(only) && <RefInfo card={only} {...props} />}
      {selected.length > 1 && (
        <section className="inspector-section">
          <div className="panel-title">已选 {selected.length} 个对象</div>
          {selected.every(isImageCard) && <button onClick={props.onNewPrompt}>用这些图新建提示词卡（P）</button>}
          <CardActions {...props} />
        </section>
      )}
    </aside>
  );
});

function CardActions({ onDuplicate, onBringToFront, onDelete }: InspectorProps) {
  return (
    <div className="button-row">
      <button onClick={onDuplicate}>创建副本</button>
      <button onClick={onBringToFront}>移到最前</button>
      <button className="danger" onClick={onDelete}>
        删除
      </button>
    </div>
  );
}

function ProjectInfo({ state, projectName, projectDir, onReveal }: InspectorProps) {
  const images = state.cards.filter(isImageCard);
  const versionCount = images.reduce((sum, card) => sum + card.versions.length, 0);
  const spent = images.reduce(
    (sum, card) => sum + card.versions.reduce((s, v) => s + (v.generation?.costUsd ?? 0), 0),
    0,
  );
  return (
    <section className="inspector-section">
      <div className="panel-title">项目</div>
      <Field label="名称" value={projectName} />
      <Field label="图像卡" value={`${images.length} 张`} />
      <Field label="提示词卡" value={`${state.cards.length - images.length} 张`} />
      <Field label="版本" value={`${versionCount} 个`} />
      <Field label="生成花费" value={formatUsd(spent)} />
      <button className="link" onClick={() => onReveal(projectDir)} title={projectDir}>
        在 Finder 中显示项目目录
      </button>
      <p className="hint">
        把图片拖进画布、粘贴或按 ⌘⇧K 导入。选中图片按 P 新建提示词卡，写好后按 ⌘↩ 生成。
      </p>
    </section>
  );
}

function ImageInfo(props: InspectorProps & { card: ImageCard }) {
  const { card, missingVersionIds, cacheBust } = props;
  const version = currentVersion(card);
  const record = version.generation;
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">图像卡</div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="图像卡名称" />
        <Field label="画布尺寸" value={`${Math.round(card.width)} × ${Math.round(card.height)}`} />
        <Field label="原图" value={`${version.width} × ${version.height} px`} />
        {missingVersionIds.has(version.id) && <p className="warning">原图文件不见了：{version.file}</p>}
        {record && (
          <div className="generation-record">
            <div className="field-label">由提示词生成</div>
            <p className="record-prompt">{record.prompt}</p>
            <Field label="模型" value={record.model} />
            <Field label="尺寸 / 质量" value={`${record.size} · ${record.quality}`} />
            <Field label="花费" value={formatUsd(record.costUsd)} />
            {props.state.cards.some((c) => c.id === record.promptCardId) && (
              <button className="link" onClick={() => props.onSelectCard(record.promptCardId)}>
                选中来源提示词卡
              </button>
            )}
          </div>
        )}
        <button className="link" onClick={() => props.onReveal(`${props.projectDir}/${version.file}`)}>
          在 Finder 中显示原图
        </button>
      </section>

      <section className="inspector-section">
        <div className="panel-title">
          版本栈 <span className="dim">{card.versions.length}</span>
        </div>
        <div className="version-grid">
          {[...card.versions].reverse().map((item) => {
            const index = card.versions.indexOf(item) + 1;
            const isCurrent = item.id === card.currentVersionId;
            const origin = item.origin === 'generate' ? '生成' : (item.sourceName ?? '导入');
            return (
              <button
                key={item.id}
                className={`version-tile ${isCurrent ? 'current' : ''}`}
                onClick={() => props.onSetCurrentVersion(card.id, item.id)}
                title={`版本 ${index} · ${origin} · ${formatTime(item.createdAt)}${isCurrent ? ' · 当前版本' : ''}`}
              >
                {missingVersionIds.has(item.id) ? (
                  <span className="version-missing">缺失</span>
                ) : (
                  <img src={thumbnailUrl(item, cacheBust.get(item.id))} alt="" />
                )}
                <span className="version-index">{index}</span>
              </button>
            );
          })}
        </div>
        <button onClick={() => props.onImportVersion(card.id)}>导入为新版本…</button>
        <button onClick={props.onNewPrompt}>用这张图新建提示词卡（P）</button>
      </section>

      <PlaceInPage {...props} />

      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

function PromptInfo(props: InspectorProps & { card: PromptCard; textareaRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const { card, state, doc, config, jobs, cacheBust } = props;
  const [text, setText] = useState(card.text);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(card.text);
  }, [card.id, card.text]);

  const inputs = card.inputs
    .map((id) => state.cards.find((c) => c.id === id))
    .filter((c): c is ImageCard => !!c && isImageCard(c));
  const output = card.outputCardId ? state.cards.find((c) => c.id === card.outputCardId) : undefined;
  const problem = validatePrompt(text, inputs.length);
  const size = resolveSize(card.settings.size, inputs[0] ? currentVersion(inputs[0]) : null);
  const isMock = config?.provider === 'mock';
  const model = isMock ? 'local-mock' : (config?.model ?? '');
  const calibration = config?.calibration[calibrationKey(model, card.settings.quality)];
  const estimate = isMock ? 0 : estimateCostUsd(card.settings, size, calibration ?? 1);
  const latest = jobs.find((job) => job.promptCardId === card.id);
  const busy = latest?.update.status === 'queued' || latest?.update.status === 'running';

  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">提示词卡</div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="提示词卡名称" />
        <textarea
          ref={props.textareaRef}
          className="prompt-input"
          value={text}
          placeholder={'写下要模型做什么，用 {{Image 1}} 指代第 1 张输入图。\n例如：把 {{Image 1}} 转为圆润的 3D 图标风格，柔和棚拍光，不保留黑色描边。'}
          onFocus={() => {
            editing.current = true;
            doc.beginGesture('编辑提示词');
          }}
          onChange={(event) => {
            setText(event.target.value);
            // 编辑途中如果有别的改动提交了（会结束当前手势），重新开一个
            if (!doc.isGestureActive()) doc.beginGesture('编辑提示词');
            doc.updateGesture(updatePrompt(doc.get(), card.id, { text: event.target.value }));
          }}
          onBlur={() => {
            editing.current = false;
            doc.commitGesture();
          }}
          aria-label="提示词"
        />
        {problem && text.trim() && <p className="warning">{problem}</p>}
      </section>

      <section className="inspector-section">
        <div className="panel-title">
          输入图 <span className="dim">{inputs.length}</span>
        </div>
        {inputs.length === 0 && <p className="hint">从卡片左侧的 ⊕ 拖一条线到图像卡上，就能把它绑定为 Image 1、Image 2…</p>}
        {inputs.map((input, index) => (
          <div key={input.id} className="input-row">
            <span className="input-slot">{index + 1}</span>
            <img className="layer-thumb" src={thumbnailUrl(currentVersion(input), cacheBust.get(input.currentVersionId))} alt="" />
            <button className="input-name link" onClick={() => props.onSelectCard(input.id)} title="选中这张图">
              {input.name}
            </button>
            <button className="icon" disabled={index === 0} onClick={() => props.onMoveInput(card.id, index, -1)} title="上移">
              ↑
            </button>
            <button
              className="icon"
              disabled={index === inputs.length - 1}
              onClick={() => props.onMoveInput(card.id, index, 1)}
              title="下移"
            >
              ↓
            </button>
            <button className="icon" onClick={() => props.onRemoveInput(card.id, index)} title="解除绑定">
              ✕
            </button>
          </div>
        ))}
      </section>

      <section className="inspector-section">
        <div className="panel-title">生成参数</div>
        <div className="field">
          <span className="field-label">数量</span>
          <div className="segmented small">
            {Array.from({ length: MAX_COUNT - MIN_COUNT + 1 }, (_, i) => i + MIN_COUNT).map((count) => (
              <button
                key={count}
                className={card.settings.count === count ? 'active' : ''}
                onClick={() => props.onSettings(card.id, { count })}
              >
                {count}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">质量</span>
          <select value={card.settings.quality} onChange={(e) => props.onSettings(card.id, { quality: e.target.value as PromptSettings['quality'] })}>
            {QUALITIES.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field-label">尺寸</span>
          <select value={card.settings.size} onChange={(e) => props.onSettings(card.id, { size: e.target.value as PromptSettings['size'] })}>
            {SIZE_OPTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <Field label="实际尺寸" value={`${size.width} × ${size.height}`} />
        <ThemeToggle card={card} state={state} onSettings={props.onSettings} />
        <Field
          label="费用估算"
          value={isMock ? '本地模拟 · 免费' : `≈ ${formatUsd(estimate)}${calibration ? '（已按实际校准）' : '（粗估）'}`}
        />
        <button className="primary" disabled={!!problem || busy} onClick={() => props.onGenerate(card.id)}>
          {busy ? '生成中…' : `生成 ×${card.settings.count}  ⌘↩`}
        </button>
        {latest?.update.status === 'failed' && <p className="warning">上次失败：{latest.update.error}</p>}
        {output && isImageCard(output) && (
          <button className="link" onClick={() => props.onSelectCard(output.id)}>
            结果：{output.name}（{output.versions.length} 个版本）
          </button>
        )}
      </section>

      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

function PlaceInPage(props: InspectorProps & { card: ImageCard }) {
  const pages = props.state.cards.filter(isPageCard);
  const [pageId, setPageId] = useState(pages[0]?.id ?? '');
  const refs = props.state.cards.filter((c) => isRefCard(c) && c.imageCardId === props.card.id).length;
  if (pages.length === 0) return null;
  const target = pages.some((p) => p.id === pageId) ? pageId : pages[0].id;
  return (
    <section className="inspector-section">
      <div className="panel-title">
        放进页面 {refs > 0 && <span className="dim">已被引用 {refs} 次</span>}
      </div>
      <p className="hint">也可以直接把它拖到页面框上松手（按住 ⌥ 拖则只是移动）。</p>
      <div className="button-row tight">
        <select className="grow" value={target} onChange={(e) => setPageId(e.target.value)}>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </select>
        <button onClick={() => props.onPlaceInPage(props.card.id, target)}>放进去</button>
      </div>
    </section>
  );
}

function PageInfo(props: InspectorProps & { card: PageCard }) {
  const { card, state, cacheBust } = props;
  const logical = pageLogicalSize(card);
  const refs = state.cards.filter((c): c is RefCard => isRefCard(c) && c.pageId === card.id);
  const exported = props.exports.get(card.id);
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">页面框</div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="页面名称" />
        <div className="field">
          <span className="field-label">设备</span>
          <select value={card.devicePreset ?? ''} onChange={(e) => props.onSetPagePreset(card.id, e.target.value || null)}>
            <option value="">{card.base ? '跟随低保真原型' : '画布尺寸'}</option>
            {DEVICE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
        <Field label="逻辑尺寸" value={`${logical.width} × ${logical.height}`} />
        <div className="field">
          <span className="field-label">导出倍数</span>
          <div className="segmented small">
            {[1, 2, 3].map((scale) => (
              <button key={scale} className={card.exportScale === scale ? 'active' : ''} onClick={() => props.onUpdatePage(card.id, { exportScale: scale })}>
                {scale}x
              </button>
            ))}
          </div>
        </div>
        <Field label="导出尺寸" value={`${logical.width * card.exportScale} × ${logical.height * card.exportScale} px`} />
        <div className="field">
          <span className="field-label">背景色</span>
          <ColorInput value={card.background} onCommit={(background) => props.onUpdatePage(card.id, { background })} />
        </div>
      </section>

      <section className="inspector-section">
        <div className="panel-title">低保真原型</div>
        {card.base ? (
          <img className="lowfi-thumb" src={thumbnailUrl(card.base, cacheBust.get(card.base.id))} alt="" />
        ) : (
          <p className="hint">还没有低保真原型，现在只有背景色。</p>
        )}
        <div className="button-row tight">
          <button onClick={() => props.onReplaceLowFi(card.id)}>{card.base ? '替换…' : '选择图片…'}</button>
          {card.base && <button onClick={() => props.onUpdatePage(card.id, { base: null })}>移除</button>}
        </div>
      </section>

      <section className="inspector-section">
        <div className="panel-title">
          页面里的素材 <span className="dim">{refs.length}</span>
        </div>
        {refs.length === 0 && <p className="hint">把核心素材拖到这个页面框上松手，就会放进来一个引用。</p>}
        {[...refs].reverse().map((ref) => {
          const source = state.cards.find((c) => c.id === ref.imageCardId);
          if (!source || !isImageCard(source)) return null;
          return (
            <button key={ref.id} className="layer-row" onClick={() => props.onSelectCard(ref.id)}>
              <img className="layer-thumb" src={thumbnailUrl(currentVersion(source), cacheBust.get(source.currentVersionId))} alt="" />
              <span className="layer-name">{source.name}</span>
            </button>
          );
        })}
      </section>

      <section className="inspector-section">
        <div className="panel-title">导出</div>
        <p className="hint">导出到项目的 exports/{card.name}/：整页 PNG、分层 SVG（可直接拖进 Figma）、素材包（每个素材 @1x/@2x/@3x）和坐标清单。</p>
        <button className="primary" disabled={exported === 'running'} onClick={() => props.onExportPage(card.id)}>
          {exported === 'running' ? '导出中…' : '导出页面  ⌘⇧E'}
        </button>
        {exported && exported !== 'running' && 'error' in exported && <p className="warning">导出失败：{exported.error}</p>}
        {exported && exported !== 'running' && 'folder' in exported && (
          <>
            <p className="good-text">
              已导出 {exported.png.width} × {exported.png.height} PNG、{exported.svg.layers.length} 层 SVG、{exported.files.length - 3} 个素材文件
            </p>
            <button className="link" onClick={() => props.onReveal(`${props.projectDir}/${exported.folder}/page.png`)}>
              在 Finder 中显示
            </button>
          </>
        )}
      </section>

      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

function RefInfo(props: InspectorProps & { card: RefCard }) {
  const { card, state, cacheBust } = props;
  const source = state.cards.find((c) => c.id === card.imageCardId);
  const page = card.pageId ? state.cards.find((c) => c.id === card.pageId) : undefined;
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">素材引用</div>
        {source && isImageCard(source) ? (
          <>
            <div className="ref-source">
              <img className="lowfi-thumb" src={thumbnailUrl(currentVersion(source), cacheBust.get(source.currentVersionId))} alt="" />
              <div>
                <div className="field-value">{source.name}</div>
                <div className="hint">版本 {source.versions.indexOf(currentVersion(source)) + 1} / {source.versions.length}</div>
              </div>
            </div>
            <p className="hint">显示的是原图像卡的当前版本；在原图像卡的版本栈里换版本，这里会跟着变。</p>
            <button onClick={() => props.onSelectCard(source.id)}>选中原图像卡</button>
          </>
        ) : (
          <p className="warning">引用的图像卡已经不在了</p>
        )}
        <Field label="所在页面" value={page && isPageCard(page) ? page.name : '不在任何页面里'} />
        <Field label="画布尺寸" value={`${Math.round(card.width)} × ${Math.round(card.height)}`} />
      </section>
      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

function ThemeToggle({ card, state, onSettings }: { card: PromptCard; state: DocState; onSettings: InspectorProps['onSettings'] }) {
  const theme = activeTheme(state);
  if (!theme) return <p className="hint">还没有生效主题卡；在视觉主题区设一张生效后，它的规则会自动附加到生成里。</p>;
  return (
    <div className="theme-toggle">
      <label className="radio-row">
        <input type="checkbox" checked={card.settings.useTheme} onChange={(e) => onSettings(card.id, { useTheme: e.target.checked })} />
        <span>附加生效主题卡「{theme.name}」的规则</span>
      </label>
      {card.settings.useTheme && (
        <details className="theme-preview">
          <summary>查看会附加的内容</summary>
          <pre>{themeSuffix(theme)}</pre>
        </details>
      )}
    </div>
  );
}

function ThemeInfo(props: InspectorProps & { card: ThemeCard }) {
  const { card, state, onUpdateTheme } = props;
  const active = state.activeThemeCardId === card.id;
  const update = (patch: Partial<Omit<ThemeCard, 'kind' | 'id'>>): void => onUpdateTheme(card.id, patch);
  const splitList = (value: string): string[] => value.split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean);
  const setColor = (index: number, patch: Partial<ThemeColor>): void =>
    update({ palette: card.palette.map((color, i) => (i === index ? { ...color, ...patch } : color)) });

  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">主题卡 {active && <span className="active-badge">生效中</span>}</div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="主题卡名称" />
        <button className={active ? '' : 'primary'} onClick={() => props.onSetActiveTheme(active ? null : card.id)}>
          {active ? '取消生效' : '设为生效主题卡'}
        </button>
        <p className="hint">生效主题卡的规则会附加到每次生成的提示词后面；每张提示词卡可以单独关掉。</p>
      </section>

      <section className="inspector-section">
        <div className="panel-title">视觉主题</div>
        <BlurField label="产品主题" value={card.topic} onCommit={(topic) => update({ topic })} />
        <BlurField label="视觉关键词（用、分隔）" value={card.keywords.join('、')} onCommit={(v) => update({ keywords: splitList(v) })} />
        <BlurField label="视觉线索（用、分隔）" value={card.cues.join('、')} onCommit={(v) => update({ cues: splitList(v) })} />
      </section>

      <section className="inspector-section">
        <div className="panel-title">
          配色 <span className="dim">{card.palette.length}</span>
        </div>
        {card.palette.map((color, index) => (
          <div key={index} className="palette-row">
            <ColorInput value={color.hex} onCommit={(hex) => setColor(index, { hex })} />
            <div className="palette-fields">
              <div className="palette-line">
                <BlurInput className="grow" value={color.role} placeholder="角色" onCommit={(role) => setColor(index, { role })} />
                <BlurInput className="grow" value={color.name} placeholder="名字" onCommit={(name) => setColor(index, { name })} />
                <button className="icon" onClick={() => update({ palette: card.palette.filter((_, i) => i !== index) })} title="删除">
                  ✕
                </button>
              </div>
              <BlurInput value={color.note} placeholder="用在哪里" onCommit={(note) => setColor(index, { note })} />
            </div>
          </div>
        ))}
        <button onClick={() => update({ palette: [...card.palette, { role: '', name: '', hex: '#888888', note: '' }] })}>添加颜色</button>
      </section>

      <section className="inspector-section">
        <div className="panel-title">统一规则</div>
        {(Object.keys(RULE_LABELS) as (keyof ThemeRules)[]).map((key) => (
          <BlurField key={key} label={RULE_LABELS[key]} multiline value={card.rules[key]} onCommit={(value) => update({ rules: { ...card.rules, [key]: value } })} />
        ))}
      </section>

      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

/** 失焦时才提交，打字过程不产生撤销记录 */
function BlurField({ label, value, onCommit, multiline }: { label: string; value: string; onCommit(value: string): void; multiline?: boolean }) {
  return (
    <label className="blur-field">
      <span className="field-label">{label}</span>
      <BlurInput value={value} onCommit={onCommit} multiline={multiline} />
    </label>
  );
}

function BlurInput({ value, onCommit, multiline, placeholder, className }: { value: string; onCommit(value: string): void; multiline?: boolean; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft !== value) onCommit(draft.trim());
  };
  const common = {
    className: `name-input ${className ?? ''}`,
    value: draft,
    placeholder,
    onBlur: commit,
  };
  return multiline ? (
    <textarea {...common} rows={2} onChange={(event) => setDraft(event.target.value)} />
  ) : (
    <input {...common} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
  );
}

/** 拖动取色时只预览；原生 change 事件（选定颜色）才提交，避免一次取色产生几十条撤销记录 */
function ColorInput({ value, onCommit }: { value: string; onCommit(hex: string): void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onChange = (): void => {
      const hex = normalizeHex(element.value);
      if (hex && hex !== latest.current.value) latest.current.onCommit(hex);
    };
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, []);
  return (
    <input
      ref={ref}
      type="color"
      className="color-input"
      value={draft.toLowerCase()}
      onChange={(event) => setDraft(event.target.value)}
      title={value}
    />
  );
}

function NameInput({ id, name, onRename, label }: { id: string; name: string; onRename(id: string, name: string): void; label: string }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [id, name]);
  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) onRename(id, trimmed);
    else setValue(name);
  };
  return (
    <input
      className="name-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setValue(name);
          event.currentTarget.blur();
        }
      }}
      aria-label={label}
    />
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{value}</span>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}
