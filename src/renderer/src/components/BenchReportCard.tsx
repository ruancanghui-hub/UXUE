import type { BenchReport } from '../../../shared/bench';

interface BenchReportCardProps {
  report: BenchReport;
  savedPath: string | null;
  onClose(): void;
}

export function BenchReportCard({ report, savedPath, onClose }: BenchReportCardProps) {
  return (
    <div className="report-card">
      <div className="report-header">
        <span className={`verdict ${report.verdict.passed ? 'pass' : 'fail'}`}>
          {report.verdict.passed ? '达标' : '未达标'}
        </span>
        <span className="report-meta">
          {report.imageCount} 张图 · {report.uncapped ? '不限帧率' : `${report.refreshRateHz}Hz`} · DPR {report.devicePixelRatio}
          · 峰值显存 {report.peakTextureMB}MB · L0 上屏 {report.firstPaintAllL0Ms}ms
        </span>
        <button className="ghost small" onClick={onClose}>
          关闭
        </button>
      </div>

      <table className="report-table">
        <thead>
          <tr>
            <th>场景</th>
            <th>平均 fps</th>
            <th>间隔 p95</th>
            <th>间隔 p99</th>
            <th>CPU p95</th>
            <th>CPU 最大</th>
            <th>超 20ms 帧</th>
          </tr>
        </thead>
        <tbody>
          {report.phases.map((phase) => (
            <tr key={phase.name}>
              <td>{phase.name}</td>
              <td>{phase.avgFps}</td>
              <td>{phase.intervalP95} ms</td>
              <td>{phase.intervalP99} ms</td>
              <td>{phase.cpuP95} ms</td>
              <td>{phase.cpuMax} ms</td>
              <td>
                {phase.over60Count} / {phase.frames}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {report.verdict.reasons.length > 0 && (
        <ul className="report-reasons">
          {report.verdict.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {savedPath && <div className="report-path">报告已保存：{savedPath}</div>}
    </div>
  );
}
