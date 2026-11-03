// Tự kiểm rate-limit đăng ký theo IP (T-16b). Chạy: node apps/api/test/limits.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8');
const m = src.match(/const REGISTER_MAX[\s\S]*?async function registerAttemptAllowed[\s\S]*?\n\}/);
assert(m, 'không thấy registerAttemptAllowed');
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('db/migrations/0005_register_attempts.sql', 'utf8'));
// mock D1: prepare().bind().first() chạy trên sqlite thật để kiểm đúng câu SQL
const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({ first: async () => db.prepare(sql).get(...a) }) }) } };
const fn = new Function(m[0] + '\nreturn registerAttemptAllowed;')();
(async () => {
  for (let i = 1; i <= 5; i++) assert.equal(await fn(env, '1.1.1.1', 100), true, 'lần ' + i);
  assert.equal(await fn(env, '1.1.1.1', 100), false, 'lần 6 bị chặn');
  assert.equal(await fn(env, '1.1.1.1', 100), false);
  assert.equal(db.prepare('SELECT count FROM register_attempts WHERE ip=? AND hour=?').get('1.1.1.1', 100).count, 6, 'count dừng ở MAX+1');
  assert.equal(await fn(env, '1.1.1.1', 101), true, 'giờ mới đếm lại');
  assert.equal(await fn(env, '2.2.2.2', 100), true, 'IP khác không ảnh hưởng');
  console.log('limits selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
