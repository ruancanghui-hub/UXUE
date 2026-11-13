import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(tmpdir(), 'anye-m1-check');
let passed = true;
for (const phase of ['write', 'verify']) {
  let report;
  try {
    report = JSON.parse(readFileSync(join(root, `report-${phase}.json`), 'utf8'));
  } catch {
    console.log(`${phase}：没有找到报告，这一阶段可能中途崩溃了`);
    passed = false;
    continue;
  }
  console.log(`\n${phase === 'write' ? '第一次启动：导入、编辑、撤销重做、保存' : '第二次启动：重新打开并核对'}`);
  for (const item of report.checks) console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `（${item.detail}）` : ''}`);
  if (Object.keys(report.timings).length) console.log(`  耗时 ${JSON.stringify(report.timings)}`);
  passed &&= report.passed;
}
console.log(`\n结论：${passed ? '达标' : '未达标'}  截图在 ${root}`);
process.exit(passed ? 0 : 1);
