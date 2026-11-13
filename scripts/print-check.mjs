import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const name = process.argv[2] ?? 'm1';
const root = join(tmpdir(), `anye-${name}-check`);
const titles = { write: '第一次启动', verify: '第二次启动：重新打开并核对' };
let passed = true;
for (const phase of ['write', 'verify']) {
  let report;
  try {
    report = JSON.parse(readFileSync(join(root, `report-${phase}.json`), 'utf8'));
  } catch {
    console.log(`${titles[phase]}：没有找到报告，这一阶段可能中途崩溃了`);
    passed = false;
    continue;
  }
  console.log(`\n${titles[phase]}`);
  for (const item of report.checks) console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `（${item.detail}）` : ''}`);
  if (Object.keys(report.timings).length) console.log(`  数据 ${JSON.stringify(report.timings)}`);
  passed &&= report.passed;
}
console.log(`\n结论：${passed ? '达标' : '未达标'}  截图在 ${root}`);
process.exit(passed ? 0 : 1);
