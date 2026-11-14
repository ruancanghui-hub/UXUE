import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PromptTemplate } from '../../../shared/api';
import {
  formatCost,
  formatUsd,
  planGeneration,
  MAX_COUNT,
  MIN_COUNT,
  QUALITIES,
  SIZE_OPTIONS,
  validatePrompt,
  type GenerationConfig,
  type PromptSettings,
} from '../../../shared/generation';
import type { ExportResult } from '../../../shared/export';
import {
  BLOCK_TYPES,
  blockTypeLabel,
  currentVersion,
  DEVICE_PRESETS,
  isBlockCard,
  isBlockCropStale,
  isGroupCard,
  isSketchTextCard,
  isStrokeCard,
  isImageCard,
  isPageCard,
  isPromptCard,
  isRefCard,
  isThemeCard,
  pageLogicalSize,
  normalizeHex,
  refDisplayVersion,
  RULE_LABELS,
  themeSuffix,
  type BlockCard,
  type BlockType,
  type SketchTextCard,
  type GroupCard,
  type ImageCard,
  type PageCard,
  type PromptCard,
  type RefCard,
  type ThemeCard,
  type ThemeColor,
  type ThemeRules,
} from '../../../shared/project';
import { isImageCardStale, regenPromptIdsForSelection } from '../../../shared/stale';
import type { DocumentStore } from '../document/DocumentStore';
import {
  blockHasOutput,
  currentStyleBenchmark,
  elementPrompts,
  isWireframeOutput,
  pageBlocks,
  sketchMarks,
  updatePrompt,
  type DocState,
} from '../document/operations';
import { activeTheme, effectiveConfig } from '../project/GenerationTracker';
import type { TrackedJob } from '../project/GenerationTracker';
import { thumbnailUrl } from '../project/thumbnails';

export interface InspectorHandle {
  focusPrompt(): void;
  /** 选中卡片的名字输入框获得焦点并全选，比如刚画出的区块 */
  focusName(): void;
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
  onCreatePromptFromTemplate(template: PromptTemplate): void;
  onUpdateTheme(id: string, patch: Partial<Omit<ThemeCard, 'kind' | 'id'>>): void;
  onSetActiveTheme(id: string | null): void;
  onUpdatePage(id: string, patch: Partial<Omit<PageCard, 'kind' | 'id'>>): void;
  onSetPagePreset(id: string, presetId: string | null): void;
  onReplaceLowFi(pageId: string): void;
  onExportPage(pageId: string): void;
  onPlaceInPage(imageCardId: string, pageId: string): void;
  onLockRef(refId: string, lockedVersionId: string | null): void;
  onRegenDownstream(promptIds: string[]): void;
  exports: ReadonlyMap<string, ExportResult | 'running' | { error: string }>;
  blockActions: BlockActions;
  wireframeActions: WireframeActions;
  themeMarkdownActions: ThemeMarkdownActions;
  elementActions: ElementActions;
}

/** 素材清单：list 走助手；setBenchmark 传 null 是取消风格基准 */
export interface ElementActions {
  busy: boolean;
  list(themeId: string): void;
  setBenchmark(imageCardId: string | null): void;
}

/** 主题说明：copy 写剪贴板；save 写进项目 themes/，返回完整路径 */
export interface ThemeMarkdownActions {
  copy(themeId: string): Promise<void>;
  save(themeId: string): Promise<string>;
}

/** 转线框与"拿图像卡做页面" */
export interface WireframeActions {
  /** 在图像卡右侧建转线框提示词卡并发起生成 */
  fromImage(imageCardId: string): void;
  /** 从页面框的低保真原型发起，出图后自动换底稿 */
  fromPage(pageId: string): void;
  newPage(imageCardId: string): void;
  /** 用 baseCardId 那张图像卡的当前版本做底稿 */
  useBaseCard(pageId: string): void;
}

/** 区块相关的操作：拆解和写提示词要走助手，忙的时候按钮置灰 */
export interface BlockActions {
  busy: boolean;
  decompose(pageId: string): void;
  writePrompts(pageId: string): void;
  addBlock(pageId: string): void;
  update(id: string, patch: Partial<Pick<BlockCard, 'name' | 'blockType' | 'group'>>): void;
  refreshCrop(blockId: string): void;
  /** 空白页面框：把区块、笔迹和文字画成示意图，再由 AI 转成线框 */
  sketchToWireframe(pageId: string): void;
  updateSketchText(id: string, patch: Partial<Pick<SketchTextCard, 'text' | 'fontSize'>>): void;
}

export const Inspector = forwardRef<InspectorHandle, InspectorProps>(function Inspector(props, ref) {
  const selected = props.state.cards.filter((card) => props.selectedIds.has(card.id));
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => ({
    focusPrompt: () => {
      const element = promptRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    },
    focusName: () => {
      const element = asideRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('.sketch-text-input, .name-input');
      element?.focus();
      element?.select();
    },
  }));

  const only = selected.length === 1 ? selected[0] : null;
  return (
    <aside className="side-panel inspector" ref={asideRef}>
      {props.tabs}
      {selected.length === 0 && <ProjectInfo {...props} />}
      {only && isImageCard(only) && <ImageInfo card={only} {...props} />}
      {only && isPromptCard(only) && <PromptInfo card={only} textareaRef={promptRef} {...props} />}
      {only && isThemeCard(only) && <ThemeInfo card={only} {...props} />}
      {only && isPageCard(only) && <PageInfo card={only} {...props} />}
      {only && isRefCard(only) && <RefInfo card={only} {...props} />}
      {only && isGroupCard(only) && <GroupInfo card={only} {...props} />}
      {only && isBlockCard(only) && <BlockInfo card={only} {...props} />}
      {only && isSketchTextCard(only) && <SketchTextInfo card={only} {...props} />}
      {only && isStrokeCard(only) && (
        <section className="inspector-section">
          <div className="panel-title">草图笔迹</div>
          <p className="hint">布局草图里手绘的一笔，只在「草图转线框」时给 AI 看，不会进入导出。橡皮（E）点一下也能删掉。</p>
          <CardActions {...props} />
        </section>
      )}
      {selected.length > 1 && (
        <section className="inspector-section">
          <div className="panel-title">已选 {selected.length} 个对象</div>
          {selected.every(isImageCard) && <button onClick={props.onNewPrompt}>用这些图新建提示词卡（P）</button>}
          {regenPromptIdsForSelection(props.state, props.selectedIds).length > 0 && (
            <button onClick={() => props.onRegenDownstream(regenPromptIdsForSelection(props.state, props.selectedIds))}>
              重新生成全部下游
            </button>
          )}
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

function ProjectInfo({ state, projectName, projectDir, onReveal, onCreatePromptFromTemplate }: InspectorProps) {
  const images = state.cards.filter(isImageCard);
  const versionCount = images.reduce((sum, card) => sum + card.versions.length, 0);
  const versions = images.flatMap((card) => card.versions);
  const spentUsd = versions.reduce((sum, v) => sum + (v.generation?.costUsd ?? 0), 0);
  const spentCny = versions.reduce((sum, v) => sum + (v.generation?.costCny ?? 0), 0);
  const spent = [spentUsd > 0 ? formatUsd(spentUsd) : '', spentCny > 0 ? formatCost(spentCny, 'CNY') : ''].filter(Boolean).join(' + ') || '0';
  return (
    <section className="inspector-section">
      <div className="panel-title">项目</div>
      <Field label="名称" value={projectName} />
      <Field label="图像卡" value={`${images.length} 张`} />
      <Field label="提示词卡" value={`${state.cards.length - images.length} 张`} />
      <Field label="版本" value={`${versionCount} 个`} />
      <Field label="生成花费" value={spent} />
      <TemplateCreateSelect onPick={onCreatePromptFromTemplate} />
      <button className="link" onClick={() => onReveal(projectDir)} title={projectDir}>
        在 Finder 中显示项目目录
      </button>
      <p className="hint">
        把图片拖进画布、粘贴或按 ⌘⇧K 导入。选中图片按 P 新建提示词卡，写好后按 ⌘↩ 生成。⌘K 打开命令面板。
      </p>
    </section>
  );
}

function ImageInfo(props: InspectorProps & { card: ImageCard }) {
  const { card, missingVersionIds, cacheBust } = props;
  const version = currentVersion(card);
  const record = version.generation;
  const stale = isImageCardStale(card, props.state);
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">
          图像卡 {stale && <span className="stale-badge">已过期</span>}
        </div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="图像卡名称" />
        <Field label="画布尺寸" value={`${Math.round(card.width)} × ${Math.round(card.height)}`} />
        <Field label="原图" value={`${version.width} × ${version.height} px`} />
        {stale && (
          <p className="warning">
            上游（输入图、提示词或生效主题）在生成之后变了。不会自动重跑；可点下面重新生成。
          </p>
        )}
        {missingVersionIds.has(version.id) && <p className="warning">原图文件不见了：{version.file}</p>}
        {record && (
          <div className="generation-record">
            <div className="field-label">由提示词生成</div>
            <p className="record-prompt">{record.prompt}</p>
            <Field label="模型" value={record.model} />
            <Field label="尺寸 / 质量" value={`${record.size} · ${record.quality}`} />
            <Field label="花费" value={record.costCny !== undefined ? formatCost(record.costCny, 'CNY') : formatUsd(record.costUsd)} />
            {props.state.cards.some((c) => c.id === record.promptCardId) && (
              <button className="link" onClick={() => props.onSelectCard(record.promptCardId)}>
                选中来源提示词卡
              </button>
            )}
            {stale && (
              <button className="primary" onClick={() => props.onRegenDownstream([record.promptCardId])}>
                重新生成
              </button>
            )}
            {stale && (
              <button onClick={() => props.onRegenDownstream(regenPromptIdsForSelection(props.state, new Set([card.id])))}>
                重新生成全部下游
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

      <WireframeSection {...props} />

      <StyleBenchmarkSection {...props} />

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
  const plan = config
    ? planGeneration(effectiveConfig(config), card.settings, inputs[0] ? currentVersion(inputs[0]) : null, inputs.length)
    : null;
  const problem = validatePrompt(text, inputs.length, plan?.maxInputs);
  const isMock = plan?.provider === 'mock';
  const costLabel = !plan
    ? '—'
    : isMock
      ? '本地模拟 · 免费'
      : plan.currency === 'CNY'
        ? `${formatCost(plan.estimate, 'CNY')}（硅基流动 ${plan.model.split('/')[1]}，按张计价）`
        : `≈ ${formatUsd(plan.estimate)}（粗估，生成后按实际用量校准）`;
  const latest = jobs.find((job) => job.promptCardId === card.id);
  const busy = latest?.update.status === 'queued' || latest?.update.status === 'running';

  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">
          提示词卡 {card.purpose === 'element' && <span className="lock-badge">素材清单</span>}
          {card.purpose === 'wireframe' && <span className="lock-badge">转线框</span>}
        </div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="提示词卡名称" />
        {card.purpose === 'element' && <StyleRefLine {...props} />}
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
        <TemplateActions card={card} onCreateFromTemplate={props.onCreatePromptFromTemplate} />
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
        <Field label="实际尺寸" value={plan?.sizeLabel ?? '—'} />
        {plan?.provider === 'siliconflow' && <p className="hint">硅基流动按模型固定质量出图，"质量"选项对它不起作用。</p>}
        {plan?.provider === 'newapi' && (
          <p className="hint">NewAPI 中转：改图请用 gpt-image 系模型；DALL·E 只支持文生图。费用以中转站为准。</p>
        )}
        <ThemeToggle card={card} state={state} onSettings={props.onSettings} />
        <Field label="费用估算" value={costLabel} />
        <button className="primary" disabled={!!problem || busy} onClick={() => props.onGenerate(card.id)}>
          {busy ? '生成中…' : `生成 ×${card.settings.count}  ⌘↩`}
        </button>
        {output && isImageCard(output) && isImageCardStale(output, state) && (
          <button disabled={busy} onClick={() => props.onRegenDownstream(regenPromptIdsForSelection(state, new Set([card.id])))}>
            重新生成全部下游
          </button>
        )}
        {latest?.update.status === 'failed' && <p className="warning">上次失败：{latest.update.error}</p>}
        {output && isImageCard(output) && (
          <button className="link" onClick={() => props.onSelectCard(output.id)}>
            结果：{output.name}（{output.versions.length} 个版本）
            {isImageCardStale(output, state) ? ' · 已过期' : ''}
          </button>
        )}
      </section>

      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

/** 素材清单提示词卡上显示当前风格基准 */
function StyleRefLine(props: InspectorProps & { card: PromptCard }) {
  const ref = props.card.styleRefCardId ? props.state.cards.find((c) => c.id === props.card.styleRefCardId) : undefined;
  if (!ref || !isImageCard(ref)) {
    return <p className="hint">还没有风格基准。挑一张满意的图，在它的属性里点「以此为风格基准」，整套素材会统一画风。</p>;
  }
  return (
    <p className="hint">
      风格基准：{ref.name}（{'{{Image 1}}'}）{'　'}
      <button className="link" onClick={() => props.onSelectCard(ref.id)}>
        选中
      </button>
    </p>
  );
}

function StyleBenchmarkSection(props: InspectorProps & { card: ImageCard }) {
  const { card, state, elementActions } = props;
  const prompts = elementPrompts(state);
  if (prompts.length === 0) return null;
  const current = currentStyleBenchmark(state);
  const isCurrent = current === card.id;
  const targets = prompts.filter((prompt) => prompt.outputCardId !== card.id).length;
  return (
    <section className="inspector-section">
      <div className="panel-title">风格基准 {isCurrent && <span className="active-badge">当前基准</span>}</div>
      <p className="hint">
        {isCurrent
          ? `${targets} 张素材清单提示词卡正以这张图为参考统一画风。`
          : `设为风格基准后，${targets} 张素材清单提示词卡都会绑定这张图做参考（画风一致、不复制内容）；已生成的会标成已过期。`}
      </p>
      {isCurrent ? (
        <button onClick={() => elementActions.setBenchmark(null)}>取消风格基准</button>
      ) : (
        <button className="primary" disabled={props.missingVersionIds.has(card.currentVersionId)} onClick={() => elementActions.setBenchmark(card.id)}>
          以此为风格基准
        </button>
      )}
    </section>
  );
}

function WireframeSection(props: InspectorProps & { card: ImageCard }) {
  const { card, state, wireframeActions } = props;
  const wireframe = isWireframeOutput(state, card.id);
  const missing = props.missingVersionIds.has(card.currentVersionId);
  return (
    <section className="inspector-section">
      <div className="panel-title">线框与页面</div>
      {wireframe ? (
        <p className="hint">这是转线框的结果。用它新建页面框时，底稿来源会设成「借鉴的截图」。</p>
      ) : (
        <p className="hint">「转线框」用当前生图供应商把这张截图改画成黑白线描的低保真原型：保留布局和原文字，不附加主题规则。</p>
      )}
      <div className="button-row tight">
        {!wireframe && (
          <button disabled={missing} onClick={() => wireframeActions.fromImage(card.id)}>
            转线框
          </button>
        )}
        <button disabled={missing} onClick={() => wireframeActions.newPage(card.id)}>
          用这张图新建页面框
        </button>
      </div>
    </section>
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
  const baseCard = card.baseCardId ? state.cards.find((c): c is ImageCard => c.id === card.baseCardId && isImageCard(c)) : undefined;
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
          {card.base && <button onClick={() => props.onUpdatePage(card.id, { base: null, baseCardId: null })}>移除</button>}
          {card.base && (
            <button disabled={!!card.wireframePromptId} onClick={() => props.wireframeActions.fromPage(card.id)}>
              {card.wireframePromptId ? '转线框中…' : '转线框'}
            </button>
          )}
        </div>
        {card.wireframePromptId && <p className="hint">线框出图后会自动换成这里的低保真原型。</p>}
        {baseCard && baseCard.currentVersionId !== card.base?.id && (
          <button onClick={() => props.wireframeActions.useBaseCard(card.id)}>用「{baseCard.name}」的当前版本做底稿</button>
        )}
      </section>

      <PageBlocks {...props} />

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

function PageBlocks(props: InspectorProps & { card: PageCard }) {
  const { card, state, blockActions } = props;
  const blocks = pageBlocks(state, card.id);
  const marks = sketchMarks(state, card.id);
  const withPrompt = blocks.filter((block) => block.promptCardId).length;
  return (
    <section className="inspector-section">
      <div className="panel-title">
        区块 <span className="dim">{blocks.length}</span>
      </div>
      <div className="field">
        <span className="field-label">底稿来源</span>
        <div className="segmented small">
          {(['own', 'borrowed'] as const).map((source) => (
            <button
              key={source}
              className={card.baseSource === source ? 'active' : ''}
              onClick={() => props.onUpdatePage(card.id, { baseSource: source })}
            >
              {source === 'own' ? '自己的线框' : '借鉴的截图'}
            </button>
          ))}
        </div>
      </div>
      {!card.base ? (
        <>
          <p className="hint">
            布局草图：B 在页面框里拖出框并起名字（比如「Banner」「搜索框」「金刚位 ×4」）；D 画笔随手画，T 点一下写说明文字，E 橡皮整笔擦掉；V 或 Esc 退出。画好后点「草图转线框」，AI 会按名字和笔迹画成线框图，并换成这个页面框的低保真原型。
          </p>
          <button
            className="primary"
            disabled={(blocks.length === 0 && marks.length === 0) || !!card.wireframePromptId}
            onClick={() => blockActions.sketchToWireframe(card.id)}
          >
            {card.wireframePromptId ? '草图转线框中…' : '草图转线框'}
          </button>
        </>
      ) : (
        <>
          <p className="hint">
            「拆解」让助手看低保真原型，把要单独生成的块框出来（已经出图的区块会保留）；调整好之后点「为区块写提示词」，会裁出每块的截图并写好绑定截图的提示词卡，放在核心素材区。生成后结果自动放回区块位置。
          </p>
          {marks.length > 0 && (
            <label className="radio-row">
              <input type="checkbox" checked={!card.sketchHidden} onChange={(e) => props.onUpdatePage(card.id, { sketchHidden: !e.target.checked })} />
              <span>
                显示草图<span className="dim">　{marks.length} 个笔迹和文字</span>
              </span>
            </label>
          )}
        </>
      )}
      <div className="button-row tight">
        <button disabled={blockActions.busy || !card.base} onClick={() => blockActions.decompose(card.id)}>
          {blockActions.busy ? '助手忙…' : '拆解'}
        </button>
        <button
          className="primary"
          disabled={blockActions.busy || blocks.length === 0 || withPrompt === blocks.length}
          onClick={() => blockActions.writePrompts(card.id)}
        >
          为区块写提示词
        </button>
        <button onClick={() => blockActions.addBlock(card.id)}>新增区块</button>
      </div>
      {blocks.map((block) => {
        const stale = isBlockCropStale(block, card);
        const done = blockHasOutput(state, block);
        return (
          <button key={block.id} className="layer-row" onClick={() => props.onSelectCard(block.id)}>
            <span className="layer-thumb block">⬒</span>
            <span className="layer-name">
              {block.name}
              <span className="dim">　{blockTypeLabel(block.blockType)}</span>
            </span>
            {(stale || done || block.promptCardId) && (
              <span className={`layer-badge ${stale ? 'stale' : ''}`}>{stale ? '过期' : done ? '已出图' : '有提示词'}</span>
            )}
          </button>
        );
      })}
    </section>
  );
}

function SketchTextInfo(props: InspectorProps & { card: SketchTextCard }) {
  const { card, blockActions } = props;
  const [text, setText] = useState(card.text);
  useEffect(() => setText(card.text), [card.id, card.text]);
  const commit = (): void => {
    if (text !== card.text) blockActions.updateSketchText(card.id, { text });
  };
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">草图文字</div>
        <textarea
          className="prompt-input sketch-text-input"
          value={text}
          rows={3}
          placeholder="写一句说明，比如「这里放优惠券」「顶部要有城市切换」"
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // 回车完成；Shift + 回车换行
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <div className="field">
          <span className="field-label">字号</span>
          <div className="segmented small">
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <button key={size} className={card.fontSize === size ? 'active' : ''} onClick={() => blockActions.updateSketchText(card.id, { fontSize: size })}>
                {{ sm: '小', md: '中', lg: '大' }[size]}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">只在「草图转线框」时给 AI 看，不会进入导出。</p>
      </section>
      <section className="inspector-section">
        <CardActions {...props} />
      </section>
    </>
  );
}

function BlockInfo(props: InspectorProps & { card: BlockCard }) {
  const { card, state, cacheBust, blockActions } = props;
  const page = state.cards.find((c): c is PageCard => c.id === card.pageId && isPageCard(c));
  const crop = card.cropCardId ? state.cards.find((c): c is ImageCard => c.id === card.cropCardId && isImageCard(c)) : undefined;
  const prompt = card.promptCardId ? state.cards.find((c): c is PromptCard => c.id === card.promptCardId && isPromptCard(c)) : undefined;
  const stale = !!page && isBlockCropStale(card, page);
  const groups = [...new Set(pageBlocks(state, card.pageId).map((b) => b.group).filter((g): g is string => !!g))];
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">区块</div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="名字" />
        <div className="field">
          <span className="field-label">类型</span>
          <select value={card.blockType} onChange={(e) => blockActions.update(card.id, { blockType: e.target.value as BlockType })}>
            {BLOCK_TYPES.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field-label">区块组</span>
          <input
            key={`${card.id}-${card.group ?? ''}`}
            list={`block-groups-${card.pageId}`}
            defaultValue={card.group ?? ''}
            placeholder="同一排的图标填同一个组名，比如「金刚位」"
            onBlur={(e) => {
              const value = e.target.value.trim() || null;
              if (value !== card.group) blockActions.update(card.id, { group: value });
            }}
          />
          <datalist id={`block-groups-${card.pageId}`}>
            {groups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>
        </div>
        {page && <Field label="所在页面" value={page.name} />}
      </section>

      <section className="inspector-section">
        <div className="panel-title">区块截图 {stale && <span className="stale-badge">截图过时</span>}</div>
        {crop ? (
          <>
            <button className="ref-source link-like" onClick={() => props.onSelectCard(crop.id)}>
              <img className="lowfi-thumb" src={thumbnailUrl(currentVersion(crop), cacheBust.get(crop.currentVersionId))} alt="" />
              <div>
                <div className="field-value">{crop.name}</div>
                <div className="hint">版本 {crop.versions.findIndex((v) => v.id === crop.currentVersionId) + 1} / {crop.versions.length}</div>
              </div>
            </button>
            {stale && <p className="hint">区块相对低保真原型挪过位置或改过大小，截图还是旧的。更新后下游会标成已过期，不会自动重新生成。</p>}
            <button disabled={!stale} onClick={() => blockActions.refreshCrop(card.id)}>
              更新截图
            </button>
          </>
        ) : (
          <p className="hint">还没有截图。在页面框里点「为区块写提示词」时会自动裁出来。</p>
        )}
      </section>

      <section className="inspector-section">
        <div className="panel-title">提示词卡</div>
        {prompt ? (
          <button className="layer-row" onClick={() => props.onSelectCard(prompt.id)}>
            <span className="layer-thumb prompt">✎</span>
            <span className="layer-name">{prompt.name}</span>
            {prompt.outputCardId && <span className="layer-badge">已出图</span>}
          </button>
        ) : (
          <p className="hint">还没有提示词卡。</p>
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
  const shown = source && isImageCard(source) ? refDisplayVersion(card, source) : null;
  const locked = !!card.lockedVersionId;
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">素材引用 {locked && <span className="lock-badge">已锁定</span>}</div>
        {source && isImageCard(source) && shown ? (
          <>
            <div className="ref-source">
              <img className="lowfi-thumb" src={thumbnailUrl(shown, cacheBust.get(shown.id))} alt="" />
              <div>
                <div className="field-value">{source.name}</div>
                <div className="hint">
                  版本 {source.versions.indexOf(shown) + 1} / {source.versions.length}
                  {locked ? ' · 锁定' : ' · 跟随当前'}
                </div>
              </div>
            </div>
            <p className="hint">
              {locked
                ? '已锁定到指定版本，原图像卡换当前版本时这里不会跟着变。'
                : '显示的是原图像卡的当前版本；在原图像卡的版本栈里换版本，这里会跟着变。'}
            </p>
            {locked ? (
              <button onClick={() => props.onLockRef(card.id, null)}>解锁，跟随当前版本</button>
            ) : (
              <button onClick={() => props.onLockRef(card.id, source.currentVersionId)}>锁定为当前显示版本</button>
            )}
            <button onClick={() => props.onSelectCard(source.id)}>选中原图像卡</button>
          </>
        ) : (
          <p className="warning">引用的图像卡已经不在了{card.lockedVersionId ? '，或锁定的版本已丢失' : ''}</p>
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

function GroupInfo(props: InspectorProps & { card: GroupCard }) {
  const members = props.state.cards.filter((c) => isImageCard(c) || isPromptCard(c) || isThemeCard(c)).filter((c) => c.groupId === props.card.id);
  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">分组框</div>
        <NameInput id={props.card.id} name={props.card.name} onRename={props.onRename} label="分组名称" />
        <Field label="成员" value={`${members.length} 个`} />
        <Field label="画布尺寸" value={`${Math.round(props.card.width)} × ${Math.round(props.card.height)}`} />
        <p className="hint">拖动分组框会带着成员一起走；缩放只改框的大小。⌘⇧G 解组。</p>
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

function TemplateActions({
  card,
  onCreateFromTemplate,
}: {
  card: PromptCard;
  onCreateFromTemplate(template: PromptTemplate): void;
}) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!picking) return;
    void window.anye.listPromptTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [picking]);

  return (
    <div className="template-actions">
      <div className="button-row tight">
        <button
          className="small"
          onClick={() =>
            void window.anye
              .createPromptTemplate(card.name, card.text, card.settings)
              .then(() => setMessage('已存为模板'))
              .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
          }
        >
          存为模板
        </button>
        <button className="small" onClick={() => setPicking((value) => !value)}>
          从模板新建
        </button>
      </div>
      {picking && (
        <select
          defaultValue=""
          onChange={(event) => {
            const id = event.target.value;
            const template = templates.find((item) => item.id === id);
            if (template) {
              onCreateFromTemplate(template);
              setPicking(false);
            }
            event.target.value = '';
          }}
        >
          <option value="" disabled>
            {templates.length === 0 ? '还没有模板' : '选择模板…'}
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      )}
      {message && <p className="hint">{message}</p>}
    </div>
  );
}

function TemplateCreateSelect({ onPick }: { onPick(template: PromptTemplate): void }) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  useEffect(() => {
    void window.anye.listPromptTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);
  if (templates.length === 0) return null;
  return (
    <div className="field">
      <span className="field-label">从模板新建提示词卡</span>
      <select
        defaultValue=""
        onChange={(event) => {
          const template = templates.find((item) => item.id === event.target.value);
          if (template) onPick(template);
          event.target.value = '';
        }}
      >
        <option value="" disabled>
          选择模板…
        </option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 复制 / 存为主题说明（Markdown），给别的模型或别人用 */
function ThemeMarkdownActions(props: InspectorProps & { card: ThemeCard }) {
  const { card, themeMarkdownActions } = props;
  const [status, setStatus] = useState<{ text: string; path?: string; error?: boolean } | null>(null);
  useEffect(() => setStatus(null), [card.id]);
  const run = async (task: () => Promise<{ text: string; path?: string }>): Promise<void> => {
    try {
      setStatus(await task());
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error), error: true });
    }
  };
  return (
    <div className="theme-markdown">
      <div className="button-row tight">
        <button onClick={() => void run(async () => (await themeMarkdownActions.copy(card.id), { text: '已复制主题说明（Markdown），可以直接粘贴给别的模型' }))}>
          复制为 Markdown
        </button>
        <button
          onClick={() =>
            void run(async () => {
              const path = await themeMarkdownActions.save(card.id);
              return { text: `已存到 themes/${path.split('/').pop()}`, path };
            })
          }
        >
          存为 Markdown
        </button>
      </div>
      {status && (
        <p className={status.error ? 'warning' : 'good-text'}>
          {status.text}
          {status.path && (
            <>
              {'　'}
              <button className="link" onClick={() => props.onReveal(status.path!)}>
                在 Finder 中显示
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function ThemeInfo(props: InspectorProps & { card: ThemeCard }) {
  const { card, state, onUpdateTheme, cacheBust } = props;
  const active = state.activeThemeCardId === card.id;
  const update = (patch: Partial<Omit<ThemeCard, 'kind' | 'id'>>): void => onUpdateTheme(card.id, patch);
  const splitList = (value: string): string[] => value.split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean);
  const setColor = (index: number, patch: Partial<ThemeColor>): void =>
    update({ palette: card.palette.map((color, i) => (i === index ? { ...color, ...patch } : color)) });
  const source = card.sourceImageCardId ? state.cards.find((c) => c.id === card.sourceImageCardId) : undefined;
  const sourceVersion =
    source && isImageCard(source)
      ? source.versions.find((v) => v.id === card.sourceVersionId) ?? currentVersion(source)
      : null;

  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">主题卡 {active && <span className="active-badge">生效中</span>}</div>
        <NameInput id={card.id} name={card.name} onRename={props.onRename} label="主题卡名称" />
        <button className={active ? '' : 'primary'} onClick={() => props.onSetActiveTheme(active ? null : card.id)}>
          {active ? '取消生效' : '设为生效主题卡'}
        </button>
        <p className="hint">生效主题卡的规则会附加到每次生成的提示词后面；每张提示词卡可以单独关掉。</p>
        <ThemeMarkdownActions {...props} />
        <button disabled={props.elementActions.busy} onClick={() => props.elementActions.list(card.id)}>
          {props.elementActions.busy ? '助手忙…' : '列出素材清单'}
        </button>
        {card.sourceImageCardId && source && isImageCard(source) && sourceVersion && (
          <div className="ref-source">
            <img className="lowfi-thumb" src={thumbnailUrl(sourceVersion, cacheBust.get(sourceVersion.id))} alt="" />
            <div>
              <div className="field-label">主题来源</div>
              <div className="field-value">{source.name}</div>
              <button className="link" onClick={() => props.onSelectCard(source.id)}>
                选中来源参考图
              </button>
            </div>
          </div>
        )}
        {card.sourceImageCardId && !(source && isImageCard(source)) && (
          <p className="hint">来源参考图已不在项目中。</p>
        )}
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
