import type { EngineStatus } from '../canvas/CanvasEngine';

interface PerfPanelProps {
  status: EngineStatus;
  uncapped: boolean;
  firstPaintMs: number | null;
}

const BUDGET_120 = 1000 / 120;

export function PerfPanel({ status, uncapped, firstPaintMs }: PerfPanelProps) {
  const { perf, textures } = status;
  const fps = status.idle || !perf ? '空闲' : `${Math.round(perf.avgFps)}`;
  const cpuClass = perf && perf.cpuP95 > BUDGET_120 ? 'bad' : 'good';

  return (
    <aside className="perf-panel">
      <Row label="刷新率" value={uncapped ? '不限帧率' : `${status.refreshRateHz || '—'} Hz`} />
      <Row label="帧率" value={fps} strong />
      <Row label="帧间隔 p95" value={perf && !status.idle ? `${perf.intervalP95} ms` : '—'} />
      <Row
        label="每帧 CPU p95"
        value={perf && !status.idle ? `${perf.cpuP95} ms` : '—'}
        className={status.idle ? '' : cpuClass}
      />
      <div className="perf-divider" />
      <Row label="纹理 L0 / L1 / L2" value={textures.resident.join(' / ')} />
      <Row label="纹理显存" value={`${textures.residentMB} MB`} />
      <Row label="加载中" value={`${textures.loading + textures.pendingCommit}`} />
      <Row label="对象 / 选中" value={`${status.itemCount} / ${status.selectionCount}`} />
      {firstPaintMs !== null && <Row label="全部 L0 上屏" value={`${firstPaintMs} ms`} />}
    </aside>
  );
}

function Row({ label, value, strong, className }: { label: string; value: string; strong?: boolean; className?: string }) {
  return (
    <div className={`perf-row ${className ?? ''}`}>
      <span>{label}</span>
      <span className={strong ? 'perf-strong' : ''}>{value}</span>
    </div>
  );
}
