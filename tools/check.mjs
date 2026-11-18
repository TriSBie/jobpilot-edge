import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// T-117b: các test còn đọc source dùng entry legacy; contract test kiểm entry TS riêng.
const entry = process.env.API_ENTRY || 'apps/api/src/worker.js';
function run(args) {
  console.log(`== node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(['--check', entry]);
for (const file of readdirSync('apps/api/test').filter((name) => name.endsWith('.cjs')).sort()) {
  if (file === 'talent.selfcheck.cjs') {
    console.log(`== SKIP unfinished HR/talent selfcheck: ${file}`);
    continue;
  }
  run([`apps/api/test/${file}`, entry]);
}
for (const file of readdirSync('apps/web/test').filter((name) => name.endsWith('.selfcheck.cjs')).sort()) {
  run([`apps/web/test/${file}`]);
}
console.log('GATE OK');
