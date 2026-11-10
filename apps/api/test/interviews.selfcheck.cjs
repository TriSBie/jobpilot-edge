// T-37: vòng phỏng vấn — route CRUD, nâng stage, sở hữu, validate, next_interview/rounds trên kanban, nhắc cron không lặp.
// Chạy: node apps/api/test/interviews.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let queries = 0;
const exec = (sql, args) => { queries++; const st = db.prepare(sql); if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) return st.all(...args); st.run(...args); return []; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map();
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => { db.exec('BEGIN'); try { const r = l.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  FILES: { delete: async () => {} }, Q_SCORE: { send: async () => {} }, Q_INGEST: { send: async () => {} },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const T = Math.floor(Date.now() / 1000), H = 3600;
for (const u of ['u1', 'u2']) {
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'U', ?)").run(u, u + '@x.test', T);
  db.prepare("INSERT INTO profiles (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'P', ?, ?)").run('p' + u, u, T, T);
}
for (const j of ['j1', 'j2', 'j3']) db.prepare("INSERT INTO jobs (id, source_url, title, company, content_hash, first_seen_at, created_at) VALUES (?, 'https://x.test', 'Dev', 'Acme', ?, ?, ?)").run(j, j, T, T);
const seed = (id, prof, job, stage, fu = null) => db.prepare("INSERT INTO applications (id, profile_id, job_id, stage, next_follow_up_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)").run(id, prof, job, stage, fu);
seed('aA', 'pu1', 'j1', 'applied', T - 60); seed('aO', 'pu1', 'j2', 'offer'); seed('aX', 'pu2', 'j1', 'applied');
kv.set('session:tok1', 'u1'); kv.set('session:tok2', 'u2');

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-iv-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (method, p, body, tok = 'tok1') => {
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  const stageOf = (id) => db.prepare('SELECT stage FROM applications WHERE id = ?').get(id).stage;
  const events = (id) => db.prepare("SELECT payload FROM application_events WHERE application_id = ? AND type = 'stage_changed'").all(id).map((r) => JSON.parse(r.payload));

  // tạo: nâng applied → interview, checklist mặc định, label mặc định
  let r = await call('POST', '/api/applications/aA/interviews', { kind: 'technical', scheduled_at: T + 2 * H });
  assert.strictEqual(r.status, 201);
  const ivTech = r.body;
  assert.deepStrictEqual([ivTech.kind, ivTech.result, ivTech.application_id, ivTech.scheduled_at], ['technical', 'pending', 'aA', T + 2 * H]);
  assert.ok(ivTech.round_label.length > 0 && Array.isArray(ivTech.checklist) && ivTech.checklist.length >= 3 && ivTech.checklist.length <= 5);
  assert.ok(ivTech.checklist.every((c) => typeof c.text === 'string' && c.done === false));
  assert.strictEqual(stageOf('aA'), 'interview');
  assert.deepStrictEqual(events('aA'), [{ from: 'applied', to: 'interview', via: 'interview_added' }]);
  // vòng thứ hai không thêm event stage; chưa hẹn giờ = 0
  r = await call('POST', '/api/applications/aA/interviews', { kind: 'hr', round_label: 'HR cuối', note: 'gặp chị Lan' });
  assert.deepStrictEqual([r.status, r.body.scheduled_at, r.body.round_label], [201, 0, 'HR cuối']);
  const ivHr = r.body;
  r = await call('POST', '/api/applications/aA/interviews', { kind: 'screen', scheduled_at: T - H });
  const ivPast = r.body;
  assert.strictEqual(events('aA').length, 1, 'không event lặp');
  // không hạ offer
  r = await call('POST', '/api/applications/aO/interviews', { kind: 'offer' });
  assert.strictEqual(r.status, 201); assert.strictEqual(stageOf('aO'), 'offer'); assert.strictEqual(events('aO').length, 0);

  // sở hữu
  r = await call('POST', '/api/applications/aX/interviews', { kind: 'hr' });
  assert.deepStrictEqual([r.status, r.body.error], [404, 'application_not_found']);
  r = await call('GET', '/api/applications/aA/interviews', null, 'tok2');
  assert.deepStrictEqual([r.status, r.body.error], [404, 'application_not_found']);
  for (const m of ['PATCH', 'DELETE']) {
    r = await call(m, `/api/interviews/${ivTech.id}`, { note: 'x' }, 'tok2');
    assert.deepStrictEqual([r.status, r.body.error], [404, 'interview_not_found'], m);
  }

  // validate
  const bad = async (method, p, body, error) => { const x = await call(method, p, body); assert.deepStrictEqual([x.status, x.body.error], [400, error], JSON.stringify(body)); };
  await bad('POST', '/api/applications/aA/interviews', { kind: 'lunch' }, 'invalid_kind');
  await bad('POST', '/api/applications/aA/interviews', {}, 'invalid_kind');
  await bad('POST', '/api/applications/aA/interviews', { kind: 'hr', round_label: 'x'.repeat(81) }, 'invalid_round_label');
  await bad('POST', '/api/applications/aA/interviews', { kind: 'hr', scheduled_at: -1 }, 'invalid_scheduled_at');
  await bad('POST', '/api/applications/aA/interviews', { kind: 'hr', scheduled_at: '123' }, 'invalid_scheduled_at');
  const P = `/api/interviews/${ivTech.id}`;
  await bad('PATCH', P, { checklist: Array.from({ length: 31 }, () => ({ text: 'a', done: false })) }, 'invalid_checklist');
  await bad('PATCH', P, { checklist: [{ text: 'x'.repeat(201), done: false }] }, 'invalid_checklist');
  await bad('PATCH', P, { checklist: [{ text: 'a', done: 'yes' }] }, 'invalid_checklist');
  await bad('PATCH', P, { result: 'maybe' }, 'invalid_result');
  await bad('PATCH', P, { note: 'x'.repeat(2001) }, 'invalid_note');
  await bad('PATCH', P, { kind: 'lunch' }, 'invalid_kind');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM interviews').get().n, 4, 'lỗi validate không ghi gì');

  // toggle checklist lưu được; PATCH result
  const cl = ivTech.checklist.map((c, i) => ({ ...c, done: i === 0 }));
  r = await call('PATCH', P, { checklist: cl });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.checklist[0].done, true);
  r = await call('GET', '/api/applications/aA/interviews');
  assert.deepStrictEqual(r.body.map((x) => x.id), [ivPast.id, ivTech.id, ivHr.id], 'thứ tự: scheduled_at tăng, 0 cuối');
  assert.deepStrictEqual(r.body[1].checklist, cl);
  r = await call('PATCH', `/api/interviews/${ivPast.id}`, { result: 'pass' });
  assert.strictEqual(r.body.result, 'pass');

  // kanban: next_interview = vòng sớm nhất > now, rounds done/total; một truy vấn chính
  queries = 0;
  r = await call('GET', '/api/applications?profile_id=pu1');
  assert.ok(queries <= 6, 'list D1 reads: ' + queries);
  const A = r.body.find((x) => x.id === 'aA'), O = r.body.find((x) => x.id === 'aO');
  assert.deepStrictEqual(A.next_interview, { id: ivTech.id, kind: 'technical', round_label: ivTech.round_label, scheduled_at: T + 2 * H });
  assert.deepStrictEqual(A.rounds, { done: 1, total: 3 });
  assert.deepStrictEqual([O.next_interview, O.rounds], [null, { done: 0, total: 1 }]);
  r = await call('GET', '/api/applications?profile_id=pu1&stats=1');
  assert.deepStrictEqual(r.body.items.find((x) => x.id === 'aA').rounds, { done: 1, total: 3 });

  // cron: 2 lượt → đúng 1 'interview' (vòng ≤24h) + 1 'follow_up' (aA đến hạn); vòng HR chưa hẹn / vòng quá khứ không nhắc
  const sch = () => worker.scheduled({ cron: '*/30 * * * *' }, env, {});
  await sch(); await sch();
  const notes = db.prepare('SELECT user_id, type, ref_id FROM notifications ORDER BY type').all().map((x) => ({ ...x }));
  assert.deepStrictEqual(notes, [{ user_id: 'u1', type: 'follow_up', ref_id: 'aA' }, { user_id: 'u1', type: 'interview', ref_id: ivTech.id }]);

  // xoá
  r = await call('DELETE', P);
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true }]);
  r = await call('DELETE', P);
  assert.strictEqual(r.status, 404);
  console.log('interviews selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
