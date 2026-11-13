import type { RecentProject } from '../../../shared/api';

interface WelcomeProps {
  recent: RecentProject[];
  busy: boolean;
  onNew(): void;
  onOpen(): void;
  onOpenRecent(dir: string): void;
}

export function Welcome({ recent, busy, onNew, onOpen, onOpenRecent }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome-drag" />
      <div className="welcome-card">
        <div className="welcome-title">暗夜精灵</div>
        <div className="welcome-subtitle">一个目录就是一个项目。选一个文件夹开始吧。</div>
        <div className="welcome-actions">
          <button className="primary" onClick={onNew} disabled={busy}>
            新建项目
          </button>
          <button onClick={onOpen} disabled={busy}>
            打开项目
          </button>
        </div>
        {recent.length > 0 && (
          <div className="welcome-recent">
            <div className="section-title">最近项目</div>
            {recent.map((project) => (
              <button key={project.dir} className="recent-row" onClick={() => onOpenRecent(project.dir)} disabled={busy}>
                <span className="recent-name">{project.name}</span>
                <span className="recent-dir">{project.dir}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
