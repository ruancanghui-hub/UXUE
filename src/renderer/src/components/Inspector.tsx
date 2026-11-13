import { useEffect, useState } from 'react';
import { currentVersion, type ImageCard } from '../../../shared/project';
import type { DocState } from '../document/operations';
import { thumbnailUrl } from '../project/thumbnails';

interface InspectorProps {
  state: DocState;
  selectedIds: ReadonlySet<string>;
  projectName: string;
  projectDir: string;
  missingVersionIds: ReadonlySet<string>;
  cacheBust: ReadonlyMap<string, number>;
  onRename(id: string, name: string): void;
  onSetCurrentVersion(id: string, versionId: string): void;
  onImportVersion(id: string): void;
  onDuplicate(): void;
  onDelete(): void;
  onBringToFront(): void;
  onReveal(path: string): void;
}

export function Inspector(props: InspectorProps) {
  const selected = props.state.cards.filter((card) => props.selectedIds.has(card.id));

  return (
    <aside className="side-panel inspector">
      {selected.length === 0 && <ProjectInfo {...props} />}
      {selected.length === 1 && <CardInfo card={selected[0]} {...props} />}
      {selected.length > 1 && (
        <section className="inspector-section">
          <div className="panel-title">已选 {selected.length} 张图像卡</div>
          <div className="button-row">
            <button onClick={props.onDuplicate}>创建副本</button>
            <button onClick={props.onBringToFront}>移到最前</button>
            <button className="danger" onClick={props.onDelete}>
              删除
            </button>
          </div>
        </section>
      )}
    </aside>
  );
}

function ProjectInfo({ state, projectName, projectDir, onReveal }: InspectorProps) {
  const versionCount = state.cards.reduce((sum, card) => sum + card.versions.length, 0);
  return (
    <section className="inspector-section">
      <div className="panel-title">项目</div>
      <Field label="名称" value={projectName} />
      <Field label="图像卡" value={`${state.cards.length} 张`} />
      <Field label="版本" value={`${versionCount} 个`} />
      <button className="link" onClick={() => onReveal(projectDir)} title={projectDir}>
        在 Finder 中显示项目目录
      </button>
      <p className="hint">把图片拖进画布、直接粘贴，或者按 ⌘⇧K 导入。</p>
    </section>
  );
}

function CardInfo(props: InspectorProps & { card: ImageCard }) {
  const { card, missingVersionIds, cacheBust } = props;
  const version = currentVersion(card);
  const [name, setName] = useState(card.name);
  useEffect(() => setName(card.name), [card.id, card.name]);

  const commitName = (): void => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== card.name) props.onRename(card.id, trimmed);
    else setName(card.name);
  };

  return (
    <>
      <section className="inspector-section">
        <div className="panel-title">图像卡</div>
        <input
          className="name-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setName(card.name);
              event.currentTarget.blur();
            }
          }}
          aria-label="图像卡名称"
        />
        <Field label="画布尺寸" value={`${Math.round(card.width)} × ${Math.round(card.height)}`} />
        <Field label="原图" value={`${version.width} × ${version.height} px`} />
        <Field label="位置" value={`${Math.round(card.x)}, ${Math.round(card.y)}`} />
        {missingVersionIds.has(version.id) && (
          <p className="warning">原图文件不见了：{version.file}</p>
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
            return (
              <button
                key={item.id}
                className={`version-tile ${isCurrent ? 'current' : ''}`}
                onClick={() => props.onSetCurrentVersion(card.id, item.id)}
                title={`版本 ${index} · ${item.sourceName ?? '导入'} · ${formatTime(item.createdAt)}${isCurrent ? ' · 当前版本' : ''}`}
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
      </section>

      <section className="inspector-section">
        <div className="button-row">
          <button onClick={props.onDuplicate}>创建副本</button>
          <button onClick={props.onBringToFront}>移到最前</button>
          <button className="danger" onClick={props.onDelete}>
            删除
          </button>
        </div>
      </section>
    </>
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
