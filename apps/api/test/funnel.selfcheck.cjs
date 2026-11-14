// T-88: funnel closed beta: ref sanitize, 1 ghi hoạt động/ngày, /api/admin/funnel đúng số + chỉ owner + không lộ email + ≤ 40 query.
// Chạy: node apps/api/test/funnel.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let queries = 0; const writes = [];
const exec = (sql, args) => { queries++; const st = db.prepare(sql); if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) return st.all(...args); if (/^\s*UPDATE users SET last_active_day/i.test(sql)) writes.push(1); st.run(...args); return []; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map();
const env = {
  OWNER_EMAIL: 'tribui.it.work@gmail.com',
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => l.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  FILES: { delete: async () => {} }, Q_SCORE: { send: async () => {} },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const DAY = 86400, T = Math.floor(Date.now() / 1000), today = Math.floor(T / DAY);
const ins = (id, email, ref, created, active, extra = '') => db.prepare(`INSERT INTO users (id, email, name, created_at, ref_source, last_active_day${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, 'U', ?, ?, ?${extra ? ', ' + extra.split('=')[1] : ''})`).run(id, email, created, ref, active);
const old = T - 40 * DAY, oc = Math.floor(old / DAY);
ins('u1', 'one@secret.test', 'fb', old, oc + 31, 'telegram_chat_id=1');   // kích hoạt, giữ chân D7+D30, Telegram
ins('u2', 'two@secret.test', 'fb', old, oc + 1, 'consent_cv_at=1');        // đồng ý CV nhưng không có file, hồ sơ 0 kỹ năng
ins('u3', 'three@secret.test', null, T, today);                           // direct, mới
ins('own', 'tribui.it.work@gmail.com', 'own', T, today);
ins('usr', 'usr@secret.test', 'zz', T, today);
for (const [u, n] of [['u1', 3], ['u2', 0]]) {
  db.prepare("INSERT INTO profiles (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'P', ?, ?)").run('p' + u, u, T, T);
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO profile_skills (profile_id, skill, weight) VALUES (?, ?, 3)').run('p' + u, 's' + i);
}
db.prepare("INSERT INTO files (id, user_id, r2_key, kind, filename, size_bytes, created_at) VALUES ('f1', 'u1', 'cv/u1/x', 'cv', 'a', 1, ?)").run(T);
kv.set('session:tokO', 'own'); kv.set('session:tokU', 'usr');

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-funnel-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (tok, method, p, body) => {
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: { ...(tok && { Authorization: `Bearer ${tok}` }), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
    return { status: r.status, text: await r.text() };
  };
  const reg = (email, ref) => call(null, 'POST', '/api/auth/register', { name: 'Bob', email, password: 'password123', ref });
  assert.strictEqual((await reg('a@x.test', 'Bad Ref!<script>')).status, 201);
  assert.strictEqual((await reg('b@x.test', 'Zalo_01-A')).status, 201);
  const refOf = (e) => db.prepare('SELECT ref_source r, last_active_day d FROM users WHERE email = ?').get(e);
  assert.strictEqual(refOf('a@x.test').r, null, 'ref sai → null');
  assert.deepStrictEqual({ ...refOf('b@x.test') }, { r: 'zalo_01-a', d: today }, 'ref hợp lệ lowercase');

  // /api/me hai lần cùng ngày: lần đầu ghi (ngày khác), lần hai không ghi
  db.prepare("UPDATE users SET last_active_day = ? WHERE id = 'usr'").run(today - 1);
  writes.length = 0;
  await call('tokU', 'GET', '/api/me'); await call('tokU', 'GET', '/api/me');
  assert.strictEqual(writes.length, 1, '1 ghi/ngày');

  assert.strictEqual((await call('tokU', 'GET', '/api/admin/funnel')).status, 403);
  assert.strictEqual((await call(null, 'GET', '/api/admin/funnel')).status, 401);
  queries = 0;
  const f = await call('tokO', 'GET', '/api/admin/funnel');
  const used = queries;
  assert.strictEqual(f.status, 200);
  assert.ok(used <= 40, `query ${used}`);
  assert.ok(!/@/.test(f.text.replace(/\s/g, '')) && !f.text.includes('secret'), 'không lộ email');
  const rows = JSON.parse(f.text).rows, fb = rows.find((r) => r.ref === 'fb');
  assert.deepStrictEqual({ ...fb, week: 0 }, { ref: 'fb', week: 0, signups: 2, activated: 1, cv_dropout: 1, profile_no_skills: 1, telegram_linked: 1,
    d7_eligible: 2, d7_retained: 1, d30_eligible: 2, d30_retained: 1, quick_open: 0, quick_applied: 0 });
  assert.strictEqual(rows.find((r) => r.ref === 'direct').signups, 2 + 0 * 1, 'direct = u3 + a@x');
  assert.strictEqual(rows.find((r) => r.ref === 'direct').d7_eligible, 0, 'cohort mới chưa tính D7');
  console.log('funnel:', JSON.stringify({ queries: used, fb }));
  console.log('funnel selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
