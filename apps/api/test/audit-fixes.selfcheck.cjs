// Audit 14/11: hồ sơ locations sai kiểu không làm chết lô chấm điểm; POST application đổi stage có ghi event;
// không có OWNER_EMAIL thì không ai vào /api/admin/*; bản tin sáng 1 lô notify đầy ≤ 40 truy vấn D1.
// Chạy: node apps/api/test/audit-fixes.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const toml = fs.readFileSync(path.join(path.dirname(workerPath), '..', 'wrangler.toml.example'), 'utf8').replace(/\r\n/g, '\n');
const notifyBatch = Number(toml.split('[[queues.consumers]]').slice(1).find((b) => b.includes('queue = "jobpilot-notify"')).match(/max_batch_size\s*=\s*(\d+)/)[1]);

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let queries = 0;
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => (queries++, { results: exec(sql, args) }), first: async () => (queries++, exec(sql, args)[0] || null), run: async () => (queries++, exec(sql, args), { success: true }) });
const kv = new Map(), scoreMsgs = [];
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => { queries++; db.exec('BEGIN'); try { const r = l.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  Q_SCORE: { send: async (b) => { scoreMsgs.push(b); }, sendBatch: async (ms) => { for (const m of ms) scoreMsgs.push(m.body); } },
  Q_INGEST: { send: async () => {} },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const T = Math.floor(Date.now() / 1000);
const N = 10; // user, mỗi người 2 hồ sơ
for (let u = 0; u < N; u++) {
  db.prepare("INSERT INTO users (id, email, name, created_at, last_active_day) VALUES (?, ?, 'U', ?, ?)").run(`u${u}`, `u${u}@x.test`, T, Math.floor(T / 86400));
  for (let k = 0; k < 2; k++) {
    db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, is_active, created_at, updated_at) VALUES (?, ?, 'P', 'middle', '[\"Remote\"]', 1, ?, ?)").run(`p${u}${k}`, `u${u}`, T, T);
    db.prepare("INSERT INTO profile_skills (profile_id, skill, weight) VALUES (?, 'Java', 5)").run(`p${u}${k}`);
  }
  kv.set(`session:tok${u}`, `u${u}|${Date.now()}`);
}
db.prepare("INSERT INTO jobs (id, source_url, title, company, location, skills, content_hash, first_seen_at, created_at) VALUES ('j1', 'https://x.test/1', 'Java Dev', 'C', 'Remote', '[\"Java\"]', 'h1', ?, ?)").run(T, T);

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-audit-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (tok, method, p, body) => {
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const run = (queue, bodies) => worker.queue({ queue, messages: bodies.map((body) => ({ body, ack() {}, retry() {} })), ackAll() {}, retryAll() { throw new Error('retryAll'); } }, env, {});

  // 1. API chặn locations/target_roles sai kiểu.
  assert.strictEqual((await call('tok0', 'PATCH', '/api/profiles/p00', { locations: 'HCM' })).status, 400, 'PATCH locations chuỗi');
  assert.strictEqual((await call('tok0', 'POST', '/api/profiles', { target_roles: [{}] })).status, 400, 'POST target_roles không phải chuỗi');
  assert.strictEqual((await call('tok0', 'PATCH', '/api/profiles/p00', { locations: ['Remote'] })).status, 200, 'mảng chuỗi hợp lệ');
  // Dòng cũ đã hỏng trong DB: lô chấm vẫn chạy, chỉ bỏ hồ sơ đó.
  db.prepare("UPDATE profiles SET locations = '\"HCM\"' WHERE id = 'p01'").run();
  await run('jobpilot-score', [{ kind: 'score', jobId: 'j1' }]); // retryAll() ném lỗi nếu cả lô chết
  assert.ok(db.prepare("SELECT COUNT(*) c FROM job_matches WHERE job_id = 'j1'").get().c >= N, 'các hồ sơ khác vẫn được chấm');

  // 2. POST application lên đơn đã có: đổi stage thì có event, giữ nguyên id.
  const a = await call('tok0', 'POST', '/api/applications', { profile_id: 'p00', job_id: 'j1', stage: 'offer' });
  const b = await call('tok0', 'POST', '/api/applications', { profile_id: 'p00', job_id: 'j1', stage: 'saved' });
  assert.deepStrictEqual([a.status, b.status, b.body.id, b.body.stage], [201, 201, a.body.id, 'saved']);
  const ev = db.prepare('SELECT payload FROM application_events WHERE application_id = ?').all(a.body.id).map((r) => JSON.parse(r.payload));
  assert.deepStrictEqual(ev, [{ from: 'offer', to: 'saved' }], 'hạ stage phải để lại lịch sử');

  // 3. Không có OWNER_EMAIL → không ai là admin, kể cả email cứng cũ.
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('old', 'tribui.it.work@gmail.com', 'O', ?)").run(T);
  kv.set('session:tokOld', `old|${Date.now()}`);
  assert.strictEqual((await call('tokOld', 'GET', '/api/admin/overview')).status, 403, 'không có env.OWNER_EMAIL thì cấm');
  assert.strictEqual((await call('tokOld', 'GET', '/api/me')).body.user.is_owner, false);

  // 4. Bản tin sáng: một lô notify đầy (mỗi user 2 hồ sơ, u0 có hồ sơ hỏng p01) ≤ 40 truy vấn D1, không message nào retry.
  queries = 0;
  let retried = 0;
  await worker.queue({ queue: 'jobpilot-notify', messages: Array.from({ length: notifyBatch }, (_, i) => ({ body: { kind: 'digest', userId: `u${i % N}` }, ack() {}, retry() { retried++; } })), ackAll() {}, retryAll() { throw new Error('retryAll'); } }, env, {});
  assert.strictEqual(retried, 0, 'digest của user có hồ sơ hỏng không được retry');
  const digestQueries = queries;
  assert.ok(digestQueries <= 40, `digest: ${digestQueries} truy vấn D1/lần chạy > 40`);
  // /api/jobs và GET hồ sơ của chính user đó vẫn chạy với dòng hỏng.
  assert.strictEqual((await call('tok0', 'GET', '/api/jobs?profile_id=p01')).status, 200, '/api/jobs với hồ sơ hỏng');
  assert.strictEqual((await call('tok0', 'GET', '/api/me')).status, 200, '/api/me với hồ sơ hỏng');
  console.log(`audit-fixes selfcheck OK — digest ${digestQueries} truy vấn/lô ${notifyBatch}`);
})().catch((e) => { console.error(e); process.exit(1); });
