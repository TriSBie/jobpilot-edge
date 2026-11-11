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
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({
  sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }),
});
const kv = new Map(), scoreMsgs = [], files = new Map();
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  FILES: { delete: async () => {}, put: async (k, v) => { files.set(k, v); }, get: async (k) => (files.has(k) ? { text: async () => String(files.get(k)) } : null) },
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

  // 7. Kiểm thử người dùng: /api/jobs phân trang, gọn trường; không tham số → mảng như cũ.
  for (let i = 0; i < 7; i++) db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, skills, jd_text, content_hash, first_seen_at, created_at) VALUES (?, 'src-itviec', ?, ?, 'Co', '[\"Java\"]', ?, ?, ?, ?)").run(`pg${i}`, `https://itviec.com/it-jobs/pg-${i}`, `Java Dev ${i}`, 'x'.repeat(5000), `hpg${i}`, T - i, T);
  const legacy = await call('B', 'GET', '/api/jobs?profile_id=pB');
  assert.ok(Array.isArray(legacy.body), 'không tham số phân trang → mảng (tương thích)');
  const p1 = await call('B', 'GET', '/api/jobs?profile_id=pB&limit=3');
  assert.strictEqual(p1.status, 200);
  assert.deepStrictEqual([p1.body.items.length, p1.body.total, p1.body.offset, p1.body.limit, p1.body.next_offset], [3, legacy.body.length, 0, 3, 3]);
  assert.ok(!('jd_text' in p1.body.items[0]) && 'jd_len' in p1.body.items[0], 'không trả JD thô');
  const seen = []; let off = 0;
  while (off !== null) { const pg = await call('B', 'GET', `/api/jobs?profile_id=pB&limit=3&offset=${off}`); seen.push(...pg.body.items.map((j) => j.id)); off = pg.body.next_offset; }
  assert.deepStrictEqual(seen, legacy.body.map((j) => j.id), 'đi hết các trang = đúng thứ tự danh sách cũ, không trùng/thiếu');
  const pjd = (await call('B', 'GET', `/api/jobs?profile_id=pB&limit=100`)).body.items.find((j) => j.id === 'pg0');
  assert.strictEqual(pjd.jd_len, 5000, 'jd_len vẫn đúng khi phân trang');
  const sf = await call('B', 'GET', '/api/jobs?limit=2&source=itviec');
  assert.ok(sf.body.items.every((j) => j.source === 'src-itviec') && sf.body.total === 7, 'lọc chạy trước khi cắt trang');
  for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=1.5']) assert.strictEqual((await call('B', 'GET', `/api/jobs?${bad}`)).status, 400, bad);
  r.jobsPage = { total: p1.body.total, pages: Math.ceil(p1.body.total / 3) };

  // 8. Benchmark: số chính chỉ VNĐ; USD tách riêng, không kéo trung vị.
  const sal = [['20 - 30 triệu', 'b1'], ['30 - 40 triệu', 'b2'], ['40 - 50 triệu', 'b3'], ['25 - 35 triệu', 'b6'], ['35 - 45 triệu', 'b7'], ['$8,000 - $10,000/month', 'b4'], ['$120k - $150k', 'b5']];
  for (const [t, id] of sal) db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, salary_text, content_hash, first_seen_at, created_at) VALUES (?, 'src-topdev', ?, 'Backend Dev', 'Co', ?, ?, ?, ?)").run(id, `https://topdev.vn/detail-jobs/${id}`, t, `h${id}`, T, T);
  const bm = (await call('B', 'GET', '/api/benchmark')).body;
  assert.deepStrictEqual([bm.count, bm.samples_vnd, bm.samples_usd, bm.currency, bm.median_mid], [5, 5, 2, 'VND', 35e6], 'trung vị mặc định chỉ từ tin VNĐ');
  assert.deepStrictEqual([bm.usd.count, bm.usd.currency, bm.usd.median_min, bm.usd.median_max], [2, 'USD', null, null], 'USD tách riêng; A7: <5 mẫu không ra trung vị');
  r.benchmark = { vnd_median: bm.median_mid, usd_median: bm.usd.median_mid };

  // 9. CV: lưu CV (cv-text, cv-file) chỉ sau khi đồng ý; lưu xong thì cv-suggest không còn no_cv.
  db.prepare("UPDATE users SET ai_opt_out = 1 WHERE id = 'B'").run();
  const cvText = 'Backend developer. Java, Spring Boot, PostgreSQL. Built payment APIs for 3 years at Acme. '.repeat(3);
  assert.strictEqual((await call('B', 'POST', '/api/profiles/pB/cv-text', { text: cvText, filename: 'cv.pdf' })).status, 403, 'chưa đồng ý → không lưu CV');
  assert.strictEqual((await worker.fetch(new Request('https://api.test/api/profiles/pB/cv-file', { method: 'POST', headers: { Authorization: 'Bearer tokB' }, body: 'x' }), env, {})).status, 403);
  assert.strictEqual(files.size, 0, 'không có file nào được ghi khi chưa đồng ý');
  assert.strictEqual((await call('B', 'POST', '/api/profiles/pB/cv-suggest', { job_id: 'shared' })).body.error, 'no_cv');
  assert.ok((await call('B', 'POST', '/api/me/consent', { kind: 'cv' })).body.consent_cv_at);
  const up = await call('B', 'POST', '/api/profiles/pB/cv-text', { text: cvText, filename: 'cv.pdf' });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.strictEqual(q("SELECT cv_file_id FROM profiles WHERE id = 'pB'")[0].cv_file_id, up.body.file_id, 'hồ sơ gắn CV vừa lưu');
  const sug = await call('B', 'POST', '/api/profiles/pB/cv-suggest', { job_id: 'shared' });
  assert.notStrictEqual(sug.body && sug.body.error, 'no_cv', 'đã lưu CV → cv-suggest không còn báo chưa có CV');
  r.cv = { before_consent: 403, after: up.status, suggest: sug.status };

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
