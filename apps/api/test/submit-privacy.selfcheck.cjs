// T-05: job dán tay thuộc riêng người nộp + Worker không tải URL tuỳ ý.
// Chạy handler fetch/queue thật của worker.js trên SQLite trong RAM (đủ migration), fetch ngoài bị mock và ghi lại.
// Chạy: node apps/api/test/submit-privacy.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({
  sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }),
});
const kv = new Map(), scoreMsgs = [];
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  FILES: { delete: async () => {} },
  Q_SCORE: { send: async (b) => { scoreMsgs.push(b); }, sendBatch: async (ms) => { for (const m of ms) scoreMsgs.push(m.body); } },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const q = (sql, ...a) => db.prepare(sql).all(...a);
const T = Math.floor(Date.now() / 1000);
for (const u of ['A', 'B']) {
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'U', ?)").run(u, `${u}@x`, T);
  db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, is_active, created_at, updated_at) VALUES (?, ?, 'P', 'middle', '[\"Remote\"]', 1, ?, ?)").run(`p${u}`, u, T, T);
  for (const [s, w] of [['Java', 5], ['Spring Boot', 5]]) db.prepare('INSERT INTO profile_skills (profile_id, skill, weight) VALUES (?, ?, ?)').run(`p${u}`, s, w);
  kv.set(`session:tok${u}`, u);
}
// Một job quét chung có sẵn.
db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES ('src-topdev', 'topdev', 'TopDev', ?), ('src-itviec', 'itviec', 'ITviec', ?)").run(T, T);
db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, skills, content_hash, first_seen_at, created_at) VALUES ('shared', 'src-topdev', 'https://topdev.vn/detail-jobs/x-1', 'Java Dev', 'Co', '[\"Java\"]', 'hshared', ?, ?)").run(T, T);

const fetched = [];
globalThis.fetch = async (u, init) => {
  fetched.push({ url: String(u), redirect: init && init.redirect });
  return new Response('<html><title>Java Backend | TopDev</title><body>Java Spring Boot PostgreSQL</body></html>');
};

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-submit-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (who, method, p, body) => {
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: { Authorization: `Bearer tok${who}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const scoreAll = () => worker.queue({ queue: 'jobpilot-score', messages: scoreMsgs.splice(0).map((body) => ({ body, ack() {}, retry() {} })), ackAll() {}, retryAll() { throw new Error('retryAll'); } }, env, {});
  const r = {};

  // 1. A dán link TopDev → chỉ A thấy, chỉ hồ sơ A được chấm.
  const a = await call('A', 'POST', '/api/jobs/submit', { url: 'https://topdev.vn/detail-jobs/java-backend-99' });
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  const aId = a.body.job.id;
  await scoreAll();
  r.fetchedTopdev = fetched.splice(0);
  assert.deepStrictEqual(r.fetchedTopdev.map((f) => f.redirect), ['manual'], 'tải đúng 1 lần, không theo redirect');
  assert.deepStrictEqual(q('SELECT profile_id FROM job_matches WHERE job_id = ?', aId).map((x) => x.profile_id), ['pA'], 'job dán tay chỉ chấm cho hồ sơ người nộp');
  const listA = await call('A', 'GET', '/api/jobs?profile_id=pA'), listB = await call('B', 'GET', '/api/jobs?profile_id=pB');
  assert.ok(listA.body.some((j) => j.id === aId), 'A thấy job của mình');
  assert.ok(!listB.body.some((j) => j.id === aId), 'B không thấy job của A');
  assert.ok(listB.body.some((j) => j.id === 'shared') && listA.body.some((j) => j.id === 'shared'), 'job chung vẫn ai cũng thấy');
  assert.strictEqual((await call('B', 'GET', `/api/jobs/${aId}`)).status, 404, 'B mở chi tiết job của A → 404');
  assert.strictEqual((await call('A', 'GET', `/api/jobs/${aId}`)).status, 200);
  assert.strictEqual((await call('B', 'POST', '/api/applications', { profile_id: 'pB', job_id: aId })).status, 404, 'B gắn job của A vào Kanban → 404');
  assert.strictEqual((await call('B', 'POST', '/api/applications', { profile_id: 'pB', job_id: 'shared' })).status, 201, 'job chung vẫn gắn được');

  // 2. B dán cùng link → dòng riêng; dán link của job quét chung → không đè job chung.
  const b = await call('B', 'POST', '/api/jobs/submit', { url: 'https://topdev.vn/detail-jobs/java-backend-99' });
  assert.notStrictEqual(b.body.job.id, aId, 'cùng link, 2 người → 2 dòng');
  const bShared = await call('B', 'POST', '/api/jobs/submit', { url: 'https://topdev.vn/detail-jobs/x-1' });
  assert.notStrictEqual(bShared.body.job.id, 'shared');
  assert.strictEqual(q("SELECT submitted_by FROM jobs WHERE id = 'shared'")[0].submitted_by, null, 'job chung không bị gắn người nộp');
  fetched.length = 0;
  // Review T-103 M1: dán lại 10 lần cùng link → không tải, không thêm dòng, không xếp hàng chấm.
  const queued = scoreMsgs.length, again = [];
  for (let i = 0; i < 10; i++) again.push((await call('A', 'POST', '/api/jobs/submit', { url: 'https://topdev.vn/detail-jobs/java-backend-99' })).body);
  assert.ok(again.every((x) => x.job.id === aId && x.created === false), 'dán lại trả dòng cũ, created:false');
  assert.strictEqual(fetched.length, 0, 'dán lại không tải trang');
  assert.strictEqual(scoreMsgs.length, queued, 'dán lại không xếp hàng chấm');
  r.repeat = { calls: 10, fetched: fetched.length, rows: q("SELECT COUNT(*) c FROM jobs WHERE submitted_by = 'A'")[0].c };

  // 3. URL nguy hiểm / host lạ: không tải; scheme lạ → 400.
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y']) assert.strictEqual((await call('A', 'POST', '/api/jobs/submit', { url: u })).status, 400, u);
  assert.strictEqual((await call('A', 'POST', '/api/jobs/submit', { title: 'T', source_url: 'javascript:x' })).status, 400);
  for (const u of ['http://127.0.0.1:8787/api/health', 'https://169.254.169.254/latest', 'http://topdev.vn/detail-jobs/plain-http', 'https://evil.example/topdev.vn', 'https://itviec.com:8443/it-jobs/x']) {
    assert.strictEqual((await call('A', 'POST', '/api/jobs/submit', { url: u })).status, 201, u);
  }
  r.fetchedOther = fetched.length;
  assert.strictEqual(fetched.length, 0, 'không tải host ngoài allowlist / http / IP nội bộ');

  // 4. Rate-limit 20 / giờ / người (A đã dán 1 + 4 = 5).
  const codes = [];
  for (let i = 0; i < 20; i++) codes.push((await call('A', 'POST', '/api/jobs/submit', { title: `Job ${i}`, company: 'C' })).status);
  r.rate = codes.reduce((m, c) => ({ ...m, [c]: (m[c] || 0) + 1 }), {});
  assert.deepStrictEqual(r.rate, { 201: 14, 429: 6 }); // A đã có 6 dòng: 1 link TopDev + 5 link không tải

  // 5. Landing sample + benchmark bỏ job dán tay; rescore B không kéo job của A vào.
  db.prepare("UPDATE jobs SET salary_text = '9999 USD' WHERE id = ?").run(aId);
  const sample = await (await worker.fetch(new Request('https://api.test/api/public/sample'), env, {})).json();
  assert.ok(!JSON.stringify(sample).includes('java-backend-99'), 'landing không lộ job dán tay');
  scoreMsgs.push({ kind: 'rescore_profile', profileId: 'pB' }); await scoreAll();
  assert.strictEqual(q('SELECT COUNT(*) c FROM job_matches WHERE profile_id = ? AND job_id = ?', 'pB', aId)[0].c, 0, 'rescore B không chấm job của A');

  // 6. Xoá hẳn tài khoản A: job dán tay của A đi theo, FK không chặn.
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'A'").run(T - 8 * 86400);
  globalThis.fetch = async () => new Response('[]'); // cron */30 còn enrichJd (job chung)
  await worker.scheduled({ cron: '*/30 * * * *', scheduledTime: Date.now() }, { ...env, Q_INGEST: { send: async () => {}, sendBatch: async () => {} }, Q_NOTIFY: { send: async () => {}, sendBatch: async () => {} } }, { waitUntil() {} });
  r.afterPurge = { userA: q("SELECT COUNT(*) c FROM users WHERE id = 'A'")[0].c, jobsA: q("SELECT COUNT(*) c FROM jobs WHERE submitted_by = 'A'")[0].c, shared: q("SELECT COUNT(*) c FROM jobs WHERE id = 'shared'")[0].c };
  assert.deepStrictEqual(r.afterPurge, { userA: 0, jobsA: 0, shared: 1 });

  console.log('submit-privacy:', JSON.stringify(r));
  console.log('submit-privacy selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
