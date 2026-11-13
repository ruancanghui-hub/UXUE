import type { RegionId } from '../../../shared/project';
import type { Tool } from '../canvas/CanvasEngine';
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
  zoom: number;
  focusRegion: RegionId | null;
  onRegion(id: RegionId): void;
  onToggleFocus(): void;
  onTool(tool: Tool): void;
  onFit(): void;
  onImport(): void;
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
      </div>

      <div className="top-bar-actions">
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
