import type { RegionId } from '../../../shared/project';
import type { PenWidth, Tool } from '../canvas/CanvasEngine';
import type { SaveState } from '../project/ProjectSession';

const REGION_TABS: { id: RegionId; label: string; key: string }[] = [
  { id: 'theme', label: '视觉主题', key: '⌘1' },
  { id: 'assets', label: '核心素材', key: '⌘2' },
  { id: 'pages', label: '高保真页面', key: '⌘3' },
];

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已保存',
  pending: '有改动',
  saving: '保存中…',
  error: '保存失败',
};

interface ProjectTopBarProps {
  projectName: string;
  saveState: SaveState;
  saveError: string | null;
  tool: Tool;
  penWidth: PenWidth;
  zoom: number;
  focusRegion: RegionId | null;
  onRegion(id: RegionId): void;
  onToggleFocus(): void;
  onTool(tool: Tool): void;
  onPenWidth(width: PenWidth): void;
  onFit(): void;
  onImport(): void;
  providerLabel: string;
  onSettings(): void;
}

export function ProjectTopBar(props: ProjectTopBarProps) {
  const { projectName, saveState, saveError, tool, zoom, focusRegion } = props;
  return (
    <header className="top-bar">
      <div className="brand">
        <span className="brand-name">{projectName}</span>
        <span className={`save-state ${saveState}`} title={saveError ?? undefined}>
          {SAVE_LABEL[saveState]}
        </span>
      </div>

      <nav className="segmented" aria-label="区域">
        {REGION_TABS.map((tab) => (
          <button
            key={tab.id}
            className={focusRegion === tab.id ? 'active' : ''}
            onClick={() => props.onRegion(tab.id)}
            title={`跳到${tab.label}区（${tab.key}）`}
          >
            {tab.label}
          </button>
        ))}
        <button
          className={focusRegion ? 'active' : ''}
          onClick={props.onToggleFocus}
          title="只看当前区域（⌘⇧F）"
        >
          {focusRegion ? '退出聚焦' : '聚焦'}
        </button>
      </nav>

      <div className="segmented" role="group" aria-label="工具">
        <button className={tool === 'select' ? 'active' : ''} onClick={() => props.onTool('select')} title="选择（V）">
          选择 <kbd>V</kbd>
        </button>
        <button className={tool === 'hand' ? 'active' : ''} onClick={() => props.onTool('hand')} title="抓手（H，或按住空格）">
          抓手 <kbd>H</kbd>
        </button>
        <button
          className={tool === 'block' ? 'active' : ''}
          onClick={() => props.onTool('block')}
          title="区块（B）：在页面框里拖出框来画布局草图，可以连续画，按 V 或 Esc 退出"
        >
          区块 <kbd>B</kbd>
        </button>
        <button
          className={tool === 'decor' ? 'active' : ''}
          onClick={() => props.onTool('decor')}
          title="装饰（R）：在页面框里拖出圆角有填充的底板"
        >
          装饰 <kbd>R</kbd>
        </button>
        <button className={tool === 'pen' ? 'active' : ''} onClick={() => props.onTool('pen')} title="画笔（D）：在页面框里手绘布局草图">
          画笔 <kbd>D</kbd>
        </button>
        <button className={tool === 'text' ? 'active' : ''} onClick={() => props.onTool('text')} title="文字（T）：在页面框里点一下写说明文字">
          文字 <kbd>T</kbd>
        </button>
        <button className={tool === 'eraser' ? 'active' : ''} onClick={() => props.onTool('eraser')} title="橡皮（E）：点到或拖过的笔迹整笔删掉">
          橡皮 <kbd>E</kbd>
        </button>
      </div>
      {tool === 'pen' && (
        <div className="segmented small" role="group" aria-label="画笔粗细">
          <button className={props.penWidth === 'thin' ? 'active' : ''} onClick={() => props.onPenWidth('thin')}>
            细
          </button>
          <button className={props.penWidth === 'thick' ? 'active' : ''} onClick={() => props.onPenWidth('thick')}>
            粗
          </button>
        </div>
      )}

      <div className="top-bar-actions">
        <button className="ghost" onClick={props.onSettings} title="设置（⌘,）">
          {props.providerLabel}
        </button>
        <button className="ghost" onClick={props.onFit} title="缩放到全部（⇧1）">
          {Math.round(zoom * 100)}%
        </button>
        <button className="primary" onClick={props.onImport} title="导入图片（⌘⇧K），也可以直接拖进画布或粘贴">
          导入图片
        </button>
      </div>
    </header>
  );
}
