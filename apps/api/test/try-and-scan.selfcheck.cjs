// T-86 /api/public/try + T-87 quét ngay khi lưu hồ sơ. Worker thật trên SQLite trong RAM.
// Chạy: node apps/api/test/try-and-scan.selfcheck.cjs apps/api/src/worker.js
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
const kv = new Map(), ingest = [];
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  Q_SCORE: { send: async () => {} },
  Q_INGEST: { send: async (b) => { ingest.push(b); } },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const T = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('A', 'a@x', 'U', ?)").run(T);
kv.set('session:tokA', 'A');
db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES ('src-topdev', 'topdev', 'TopDev', ?)").run(T);
for (let i = 0; i < 14; i++) db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, skills, content_hash, first_seen_at, created_at, submitted_by) VALUES (?, 'src-topdev', ?, 'Java Developer', 'Co', ?, ?, ?, ?, ?)")
  .run('j' + i, `https://topdev.vn/detail-jobs/j-${i}`, i % 2 ? '["Java","Docker"]' : '["Java","Spring Boot","Redis"]', 'h' + i, T - i, T, i === 13 ? 'A' : null);

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-try-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const get = async (p) => { const r = await worker.fetch(new Request('https://api.test' + p), env, {}); return { status: r.status, body: await r.json() }; };
  const post = async (p, body) => { const r = await worker.fetch(new Request('https://api.test' + p, { method: 'POST', headers: { Authorization: 'Bearer tokA', 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, {}); return { status: r.status, body: await r.json() }; };

  for (const bad of ['', '?skills=Hack', '?skills=Java&level=god', '?skills=Java&location=Mars', '?skills=' + ['Java', 'Spring Boot', 'Redis', 'Docker', 'AWS', 'Go', 'PHP', 'Python', 'Kafka'].join(',')])
    assert.strictEqual((await get('/api/public/try' + bad)).status, 400, bad);
  const ok = await get('/api/public/try?skills=Java,spring%20boot,Docker&level=middle&location=Remote');
  assert.strictEqual(ok.status, 200);
  const jobs = ok.body.jobs;
  assert(jobs.length > 0 && jobs.length <= 10);
  assert(jobs.every((j, i) => i === 0 || jobs[i - 1].score >= j.score || jobs[i - 1].verdict !== j.verdict || jobs[i - 1].fit.level !== j.fit.level));
  assert(!JSON.stringify(jobs).includes('j-13'), 'job dán tay lọt ra');
  const allowed = new Set(['title', 'company', 'location', 'source', 'url', 'salary', 'age_days', 'score', 'tier', 'rule', 'fit', 'matched', 'missing', 'capped', 'flags', 'verdict', 'verdict_why']);
  assert(jobs.every((j) => Object.keys(j).every((k) => allowed.has(k))));

  // T-87: hồ sơ mới có target_roles + kỹ năng → ≤3 từ khoá × (itviec, topdev); lưu lại trong TTL → 0.
  const p = await post('/api/profiles', { name: 'P', target_roles: ['Backend Developer', 'Golang Engineer', 'Java', 'DevOps', 'SRE'], level: 'middle' });
  assert.strictEqual(p.status, 201);
  assert.deepStrictEqual(ingest.map((m) => m.keyword), ['Backend Developer', 'Backend Developer', 'Golang Engineer', 'Golang Engineer', 'DevOps', 'DevOps']);
  assert(ingest.every((m) => m.kind === 'ingest' && ['itviec', 'topdev'].includes(m.sourceType)));
  ingest.length = 0;
  await post(`/api/profiles/${p.body.id}/skills/confirm`, { skills: [{ skill: 'Kubernetes', weight: 5 }] });
  assert.deepStrictEqual([...new Set(ingest.map((m) => m.keyword))], ['SRE', 'Kubernetes']); // DevOps đã quét, còn lại ≤3
  ingest.length = 0;
  await post(`/api/profiles/${p.body.id}/skills/confirm`, { skills: [{ skill: 'Kubernetes', weight: 5 }] });
  assert.strictEqual(ingest.length, 0, 'lưu lại trong TTL phải 0');
  console.log('OK try-and-scan');
})().catch((e) => { console.error(e); process.exit(1); });
