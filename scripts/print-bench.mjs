import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2] ?? join(homedir(), 'Library/Application Support/暗夜精灵/bench-project/bench-report.json');
const report = JSON.parse(readFileSync(file, 'utf8'));

console.log(
  `${report.uncapped ? '不限帧率' : `${report.refreshRateHz}Hz`} · DPR ${report.devicePixelRatio} · ` +
    `L0 上屏 ${report.firstPaintAllL0Ms}ms · 峰值显存 ${report.peakTextureMB}MB`,
);
for (const phase of report.phases) {
  const w = phase.worstFrame;
  const worst = w
    ? `最慢帧 ${w.cpuMs}ms（脚本 ${w.hooksMs} / 视口 ${w.viewMs} / 调度 ${w.scheduleMs} / 提交 ${w.commitMs} / 渲染 ${w.renderMs} / ${w.commits} 块）`
    : '';
  console.log(
    `${phase.name.padEnd(18, '　')} fps ${String(phase.avgFps).padStart(8)}  间隔 p95 ${phase.intervalP95}ms p99 ${phase.intervalP99}ms` +
      `  超20ms ${phase.over60Count}/${phase.frames}  CPU p95 ${phase.cpuP95}ms  ${worst}`,
  );
}
console.log(report.verdict.passed ? '结论：达标' : `结论：未达标\n- ${report.verdict.reasons.join('\n- ')}`);
