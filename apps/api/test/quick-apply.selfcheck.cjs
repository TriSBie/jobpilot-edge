// Nộp nhanh: POST /api/applications/quick (open/applied) + 2 cột funnel quick_open/quick_applied.
// Chạy: node apps/api/test/quick-apply.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let batches = 0;
const exec = (sql, args) => { const st = db.prepare(sql); if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) return st.all(...args); st.run(...args); return []; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map();
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => { batches++; db.exec('BEGIN'); try { const r = l.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  FILES: { delete: async () => {} }, Q_SCORE: { send: async () => {} },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const T = Math.floor(Date.now() / 1000), D7 = 7 * 86400;
for (const [u, e] of [['u1', 'u1@x.test'], ['u2', 'u2@x.test'], ['own', 'tribui.it.work@gmail.com']]) {
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'U', ?)").run(u, e, T);
  db.prepare("INSERT INTO profiles (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'P', ?, ?)").run('p' + u, u, T, T);
}
for (const j of ['j1', 'j2', 'j3', 'j4']) db.prepare("INSERT INTO jobs (id, source_url, title, company, content_hash, first_seen_at, created_at) VALUES (?, 'https://x.test', 'T', 'C', ?, ?, ?)").run(j, j, T, T);
db.prepare("INSERT INTO jobs (id, source_url, title, company, content_hash, first_seen_at, created_at, submitted_by) VALUES ('jp', 'https://x.test', 'T', 'C', 'jp', ?, ?, 'u2')").run(T, T);
const seed = (id, job, stage) => db.prepare("INSERT INTO applications (id, profile_id, job_id, stage, created_at, updated_at) VALUES (?, 'pu1', ?, ?, 1, 1)").run(id, job, stage);
seed('aI', 'j2', 'interview'); seed('aO', 'j4', 'offer');
kv.set('session:tok1', 'u1'); kv.set('session:tokO', 'own');

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-quick-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (tok, p, body, method = 'POST') => {
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: { ...(tok && { Authorization: `Bearer ${tok}` }), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  const q = (b, tok = 'tok1') => call(tok, '/api/applications/quick', b);
  const ev = (appId) => db.prepare('SELECT type, payload FROM application_events WHERE application_id = ? ORDER BY rowid').all(appId).map((r) => ({ ...r }));

  assert.strictEqual((await call(null, '/api/applications/quick', { profile_id: 'pu1', job_id: 'j1', action: 'open' })).status, 401, 'auth');
  let r = await q({ profile_id: 'pu2', job_id: 'j1', action: 'open' });
  assert.deepStrictEqual([r.status, r.body.error], [404, 'profile_not_found'], 'hồ sơ người khác');
  r = await q({ profile_id: 'pu1', job_id: 'jp', action: 'open' });
  assert.deepStrictEqual([r.status, r.body.error], [404, 'job_not_found'], 'tin riêng của người khác');
  r = await q({ profile_id: 'pu1', job_id: 'j1', action: 'submit' });
  assert.deepStrictEqual([r.status, r.body.error], [400, 'invalid_action']);

  // open: tạo 'saved' + event; gọi lại không nhân bản hàng
  batches = 0;
  r = await q({ profile_id: 'pu1', job_id: 'j1', action: 'open' });
  assert.strictEqual(r.status, 200); assert.strictEqual(batches, 1, '1 batch');
  assert.strictEqual(r.body.stage, 'saved'); assert.strictEqual(r.body.job_id, 'j1');
  assert.deepStrictEqual(ev(r.body.id), [{ type: 'quick_apply_open', payload: '{}' }]);
  const a1 = r.body.id;
  // open trên 'interview' giữ nguyên
  r = await q({ profile_id: 'pu1', job_id: 'j2', action: 'open' });
  assert.strictEqual(r.body.stage, 'interview'); assert.strictEqual(r.body.id, 'aI');

  // applied trên 'saved': applied_at + follow-up +7d + event via quick_apply
  r = await q({ profile_id: 'pu1', job_id: 'j1', action: 'applied' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.id, a1); assert.strictEqual(r.body.stage, 'applied');
  assert.ok(Math.abs(r.body.applied_at - T) < 5, 'applied_at');
  assert.ok(Math.abs(r.body.next_follow_up_at - (r.body.applied_at + D7)) < 5, 'follow-up +7d');
  assert.deepStrictEqual(ev(a1).map((e) => [e.type, JSON.parse(e.payload)]),
    [['quick_apply_open', {}], ['stage_changed', { from: 'saved', to: 'applied', via: 'quick_apply' }]]);
  // applied lần 2: không thêm event, giữ applied_at
  const at = r.body.applied_at;
  r = await q({ profile_id: 'pu1', job_id: 'j1', action: 'applied' });
  assert.strictEqual(r.body.applied_at, at); assert.strictEqual(ev(a1).length, 2, 'không event lặp');
  // applied khi chưa có hàng: tạo + nâng lên applied, from = null
  r = await q({ profile_id: 'pu1', job_id: 'j3', action: 'applied' });
  assert.strictEqual(r.body.stage, 'applied'); assert.ok(r.body.next_follow_up_at > T);
  assert.deepStrictEqual(JSON.parse(ev(r.body.id)[0].payload), { from: null, to: 'applied', via: 'quick_apply' });
  // applied không hạ 'offer'
  r = await q({ profile_id: 'pu1', job_id: 'j4', action: 'applied' });
  assert.deepStrictEqual([r.body.stage, r.body.applied_at, r.body.next_follow_up_at], ['offer', null, null]);
  assert.strictEqual(ev('aO').length, 0, 'không event stage');

  // funnel: u1 có cả hai, u2/own không
  const f = await call('tokO', '/api/admin/funnel', null, 'GET');
  assert.strictEqual(f.status, 200);
  const row = f.body.rows[0];
  assert.deepStrictEqual([row.signups, row.quick_open, row.quick_applied], [3, 1, 1]);
  assert.ok('d30_retained' in row && 'activated' in row, 'cột cũ còn nguyên');
  console.log('quick-apply selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
