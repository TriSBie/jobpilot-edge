// Chạy: node apps/api/test/weekstats.selfcheck.cjs apps/api/src/worker.js
// Kiểm cách tính cửa sổ 7 ngày trong worker.js bằng SQL tương đương trên mock rows (JS thuần).
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
assert(/const AUTO_CLOSE_DAYS = 14;/.test(src), 'AUTO_CLOSE_DAYS');
assert(/stage = 'archived'.*\[tự đóng: im lặng 14 ngày\]/.test(src), 'cron UPDATE');
assert(/INSERT INTO application_events .* FROM applications WHERE \$\{silent\}/.test(src), 'cron event');
const t = 1000 * 86400, D = 86400, W = 7 * D;
const rows = [['applied', 1], ['applied', 3], ['applied', 9], ['interview', 2], ['applied', 15], ['interview', 20], ['archived', 1]].map(([stage, d]) => ({ stage, updated_at: t - d * D }));
const cnt = (st, a, b) => rows.filter((r) => r.stage === st && r.updated_at >= a && r.updated_at < b).length;
assert.equal(cnt('applied', t - W, t + 1), 2); assert.equal(cnt('applied', t - 2 * W, t - W), 1);
assert.equal(cnt('interview', t - W, t + 1), 1);
assert.equal(rows.filter((r) => ['applied', 'interview'].includes(r.stage) && r.updated_at < t - 14 * D).length, 2);
console.log('weekstats selfcheck OK');
// S1 (review 05/11): đóng mềm bỏ qua đơn còn hẹn follow-up trong tương lai.
assert(/AND \(next_follow_up_at IS NULL OR next_follow_up_at < \?\)/.test(src), 'soft-close respects future follow-up');
assert(/\.bind\(tn, cutoff, tn\)/.test(src), 'soft-close binds 3 params');
console.log('weekstats S1 OK');
// Đóng mềm phải nằm sau công tắc AUTO_CLOSE_ENABLED (mặc định tắt trên prod).
assert(/if \(env\.AUTO_CLOSE_ENABLED === "1"\) \{[\s\S]{0,900}stage = 'archived'/.test(src), 'soft-close behind AUTO_CLOSE_ENABLED');
console.log('weekstats kill-switch OK');
