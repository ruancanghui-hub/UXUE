import type { Tool } from '../canvas/CanvasEngine';

interface TopBarProps {
  tool: Tool;
  zoom: number;
  busy: boolean;
  hasImages: boolean;
  onTool(tool: Tool): void;
  onFit(): void;
  onLoad(): void;
  onBenchmark(): void;
}

export function TopBar({ tool, zoom, busy, hasImages, onTool, onFit, onLoad, onBenchmark }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="brand">
        <span className="brand-name">暗夜精灵</span>
        <span className="brand-badge">M0 · 画布性能原型</span>
      </div>

      <div className="segmented" role="group" aria-label="工具">
        <button className={tool === 'select' ? 'active' : ''} onClick={() => onTool('select')} title="选择（V）">
          选择 <kbd>V</kbd>
        </button>
        <button className={tool === 'hand' ? 'active' : ''} onClick={() => onTool('hand')} title="抓手（H，或按住空格）">
          抓手 <kbd>H</kbd>
        </button>
      </div>

      <div className="top-bar-actions">
        <button className="ghost" onClick={onFit} title="缩放到全部（Shift+1）">
          {Math.round(zoom * 100)}%
        </button>
        <button className="ghost" onClick={onLoad} disabled={busy}>
          {hasImages ? '重新载入测试图' : '载入 200 张测试图'}
        </button>
        <button className="primary" onClick={onBenchmark} disabled={busy}>
          运行性能测试
        </button>
      </div>
    </header>
  );
}
