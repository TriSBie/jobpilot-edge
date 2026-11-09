// T-45/T-49/T-50: dọn job cũ trong cron, last_status theo cả lượt quét, rescore cũ không đè điểm mới.
// Chạy worker.js thật trên SQLite RAM (đủ migration, foreign_keys=ON). Chạy: node apps/api/test/hygiene.selfcheck.cjs apps/api/src/worker.js
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
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({
  sql, args, bind: (...a) => stmt(sql, a),
  all: async () => (queries++, { results: exec(sql, args) }), first: async () => (queries++, exec(sql, args)[0] || null), run: async () => (queries++, exec(sql, args), { success: true }),
});
const kv = new Map(), sent = [];
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => { queries++; db.exec('BEGIN'); try { const r = list.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
  Q_INGEST: { send: async (b) => { sent.push(b); } }, Q_SCORE: { send: async () => {}, sendBatch: async () => {} },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
  TELEGRAM_QUIET_OVERRIDE: '1',
};
const q = (sql, ...a) => db.prepare(sql).all(...a);
const T = Math.floor(Date.now() / 1000), DAY = 86400;
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@x', 'U', ?)").run(T);
db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, is_active, created_at, updated_at) VALUES ('p', 'u', 'P', 'middle', '[\"Remote\"]', 1, ?, ?)").run(T, T + 10);
for (const s of ['Java', 'Spring Boot']) db.prepare('INSERT INTO profile_skills (profile_id, skill, weight) VALUES (?, ?, 5)').run('p', s);
const job = (id, ageDays) => db.prepare("INSERT INTO jobs (id, source_url, title, company, skills, content_hash, first_seen_at, last_seen_at, created_at) VALUES (?, ?, 'Backend Developer', 'Co', '[\"Java\"]', ?, ?, ?, ?)").run(id, 'https://x/' + id, 'h' + id, T - ageDays * DAY, T - ageDays * DAY, T);
job('old', 40); job('old-app', 40); job('fresh', 1);
for (const id of ['old', 'old-app', 'fresh']) db.prepare("INSERT INTO job_matches (job_id, profile_id, final_score, tier, scored_at) VALUES (?, 'p', 50, 'partial', ?)").run(id, T);
db.prepare("INSERT INTO applications (id, profile_id, job_id, created_at, updated_at) VALUES ('a', 'p', 'old-app', ?, ?)").run(T, T);
db.prepare("INSERT INTO sources (id, type, name, last_status, created_at) VALUES ('src-itviec', 'itviec', 'ITviec', 'ok', ?)").run(T);

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-hyg-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response('<html></html>'); };

  // T-45
  queries = 0;
  await worker.scheduled({ cron: '*/30 * * * *' }, env, {});
  assert(queries <= 40, 'cron queries ' + queries);
  assert.deepStrictEqual(q('SELECT id FROM jobs ORDER BY id').map((r) => r.id), ['fresh', 'old-app'], 'chỉ xoá tin cũ không có đơn');
  assert.deepStrictEqual(q('SELECT job_id FROM job_matches ORDER BY job_id').map((r) => r.job_id), ['fresh', 'old-app']);

  // T-49: slug + last_status
  const ingest = (kws, fail) => (urls.length = 0, kws.reduce((p, kw) => p.then(async () => {
    globalThis.fetch = async (u) => (urls.push(String(u)), fail.includes(kw) ? new Response('', { status: 500 }) : new Response('<html></html>'));
    await worker.queue({ queue: 'jobpilot-ingest', messages: [{ body: { kind: 'ingest', sourceType: 'itviec', keyword: kw }, ack() {}, retry() {} }] }, env, {});
  }), Promise.resolve()));
  const KW = ['Java', 'Node.js', 'Backend', 'Spring Boot'], st = () => q("SELECT last_status s FROM sources WHERE id = 'src-itviec'")[0].s;
  await ingest(KW, ['Spring Boot']); // 1/4 lỗi, lỗi xử lý sau cùng
  assert(urls.some((u) => u.includes('/nodejs/')) && !urls.some((u) => u.includes('/node-js/')), 'slug Node.js: ' + urls);
  assert.strictEqual(st(), 'ok');
  db.prepare("UPDATE sources SET last_status = 'ok', last_run_at = ? WHERE id = 'src-itviec'").run(T - 3600);
  await ingest(KW, KW);
  assert.strictEqual(st(), 'error');

  // T-50: message cũ hơn updated_at của hồ sơ → bỏ; mới/không phiên bản → chấm
  const rescore = (v) => worker.queue({ queue: 'jobpilot-score', messages: [{ body: { kind: 'rescore_profile', profileId: 'p', v }, ack() {}, retry() {} }], ackAll() {}, retryAll() { throw new Error('retryAll'); } }, env, {});
  db.prepare('DELETE FROM job_matches').run();
  await rescore(T);
  assert.strictEqual(q('SELECT COUNT(*) c FROM job_matches')[0].c, 0, 'rescore cũ phải bị bỏ');
  await rescore(T + 10);
  assert.strictEqual(q('SELECT COUNT(*) c FROM job_matches')[0].c, 2);
  console.log('hygiene selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
