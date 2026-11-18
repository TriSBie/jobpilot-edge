import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Wrangler nhận .toml, không đọc template có đuôi .example như một file TOML.
const config = 'apps/api/wrangler.generated.toml';
const args = process.argv.slice(2);
if (!(args[0] === 'types' || (args[0] === 'deploy' && args.includes('--dry-run')) || (args[0] === 'dev' && args.includes('--local')))) {
  throw new Error('Helper này chỉ chạy types, deploy --dry-run hoặc dev --local.');
}
writeFileSync(config, readFileSync('apps/api/wrangler.toml.example'));
for (let i = 0; i < args.length; i++) {
  if (['--outdir', '--outfile'].includes(args[i]) && args[i + 1]) args[++i] = resolve(args[i]);
}
const result = spawnSync(process.execPath, [
  'node_modules/wrangler/bin/wrangler.js', ...args, '--config', config,
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
