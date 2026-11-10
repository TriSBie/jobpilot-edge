// T-28: POST /api/profiles/:id/cv-suggest — guard chống bịa, opt-out, cache, giới hạn ngày.
// Chạy: node apps/api/test/cv-suggest.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) return st.all(...args); st.run(...args); return []; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map(), r2 = new Map();
let aiCalls = 0, aiReply = null, aiPrompt = '';
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => l.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  FILES: { get: async (k) => (r2.has(k) ? { text: async () => r2.get(k) } : null) },
  AI: { run: async (_m, req) => { aiCalls++; aiPrompt = req.messages[1].content; return { response: typeof aiReply === 'string' ? aiReply : JSON.stringify(aiReply) }; } },
  Q_SCORE: { send: async () => {} },
};
const CV = `Backend Developer, 3 years of experience.
Built loyalty point services with Java and Spring Boot, processing events through Kafka.
Designed PostgreSQL schemas for reward ledgers serving 200k members.
Led a team of 4 engineers.
Backend developer with 4 years of experience in loyalty platforms.
- Built REST APIs for the points and voucher service using NestJS and PostgreSQL.
- Migrated two services from Spring Boot 2 to Spring Boot 3.`;
const T = Math.floor(Date.now() / 1000);
for (const u of ['u1', 'u2', 'u3']) db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'U', ?)").run(u, u + '@x.test', T);
db.prepare("UPDATE users SET ai_opt_out = 1 WHERE id = 'u3'").run();
for (const [p, u, f] of [['p1', 'u1', 'f1'], ['p2', 'u2', null], ['p3', 'u3', 'f3'], ['p1b', 'u1', null]]) {
  if (f) { db.prepare("INSERT INTO files (id, user_id, r2_key, kind, filename, size_bytes, created_at) VALUES (?, ?, ?, 'cv', 'cv.txt', 1, ?)").run(f, u, 'cv/' + f, T); r2.set('cv/' + f, CV); }
  db.prepare("INSERT INTO profiles (id, user_id, name, cv_file_id, created_at, updated_at) VALUES (?, ?, 'P', ?, ?, ?)").run(p, u, f, T, T);
}
db.prepare("INSERT INTO profile_skills (profile_id, skill, weight, source) VALUES ('p1', 'Java', 5, 'cv')").run();
const JD = 'We need a Java Spring Boot engineer with Kafka, PostgreSQL, Kubernetes and Redis experience.';
for (const j of ['j1', 'j2']) db.prepare("INSERT INTO jobs (id, source_url, title, company, content_hash, jd_text, first_seen_at, created_at) VALUES (?, 'https://x.test', 'T', 'C', ?, ?, ?, ?)").run(j, j, JD, T, T);
const JD3 = 'Senior Java engineer. You will take ownership of production reliability for our event-driven loyalty platform, building RESTful APIs with Java and Spring Boot.';
db.prepare("INSERT INTO jobs (id, source_url, title, company, content_hash, jd_text, first_seen_at, created_at) VALUES ('j3', 'https://x.test', 'T', 'C', 'j3', ?, ?, ?)").run(JD3, T, T);
db.prepare("INSERT INTO jobs (id, source_url, title, company, content_hash, jd_text, first_seen_at, created_at, submitted_by) VALUES ('jp', 'https://x.test', 'T', 'C', 'jp', ?, ?, ?, 'u2')").run(JD, T, T);
kv.set('session:t1', 'u1'); kv.set('session:t2', 'u2'); kv.set('session:t3', 'u3');
const rlKey = () => `cvsugrl:u1:${Math.floor(Date.now() / 86400000)}`;

const good = { section: 'Experience', original: 'Built loyalty point services with Java and Spring Boot, processing events through Kafka.', suggested: 'Built Kafka event-driven loyalty point services in Java / Spring Boot.', reason: 'JD nhấn mạnh Kafka' };
(async () => {
  const tmp = path.join(os.tmpdir(), `worker-cvsug-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (tok, pid, body) => {
    const r = await worker.fetch(new Request(`https://api.test/api/profiles/${pid}/cv-suggest`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, {});
    return { status: r.status, body: JSON.parse(await r.text()) };
  };

  assert.strictEqual((await call('t1', 'p2', { job_id: 'j1' })).status, 404, 'hồ sơ người khác');
  assert.strictEqual((await call('t1', 'p1', { job_id: 'jp' })).status, 404, 'tin riêng người khác');
  assert.strictEqual((await call('t1', 'p1', {})).status, 404, 'thiếu job_id');
  let r = await call('t1', 'p1b', { job_id: 'j1' });
  assert.deepStrictEqual([r.status, r.body.error], [409, 'no_cv']);

  // JSON hỏng → 200, không gợi ý AI
  aiReply = 'Sure! here you go: {"suggestions": [ {broken';
  r = await call('t1', 'p1', { job_id: 'j1' });
  assert.strictEqual(r.status, 200, 'JSON hỏng → 200');
  assert.deepStrictEqual([r.body.suggestions, r.body.ai_used], [[], false]);
  assert.deepStrictEqual(r.body.matched.sort(), ['Java', 'Kafka', 'PostgreSQL', 'Spring Boot']);
  assert.deepStrictEqual(r.body.missing.sort(), ['Kubernetes', 'Redis']);
  assert.deepStrictEqual(r.body.skills_text.split(', ').slice(0, 4).sort(), ['Java', 'Kafka', 'PostgreSQL', 'Spring Boot'], 'skill JD cần lên đầu');
  assert.ok(/NEVER mention these\): (Kubernetes, Redis|Redis, Kubernetes)/.test(aiPrompt), 'prompt nêu missing');

  aiReply = { suggestions: [
    good,
    { ...good, suggested: 'Built Kafka loyalty services in Java / Spring Boot on Kubernetes.' }, // skill bịa (missing)
    { ...good, suggested: 'Built Kafka loyalty services in Java / Spring Boot with Docker.' },   // skill bịa (không có trong CV)
    { section: 'Summary', original: 'Backend Developer, 3 years of experience.', suggested: 'Backend Developer with 5 years of experience.' }, // số bịa
    { section: 'Experience', original: 'Led a team of 4 engineers.', suggested: 'Led a team of 4 engineers, cutting latency by 40%.' }, // % bịa
    { section: 'Summary', original: 'Senior Backend Developer with 8 years at Google.', suggested: 'Senior Backend Developer.' }, // original không có trong CV
    { section: 'Experience', original: 'Designed  PostgreSQL schemas\n for reward ledgers serving 200k members.', suggested: 'Designed PostgreSQL reward-ledger schemas serving 200k members.' }, // khoảng trắng lệch vẫn giữ
  ] };
  aiCalls = 0;
  r = await call('t1', 'p1', { job_id: 'j2' });
  assert.strictEqual(r.status, 200); assert.strictEqual(aiCalls, 1); assert.strictEqual(r.body.ai_used, true);
  assert.deepStrictEqual(r.body.suggestions.map((s) => s.suggested), [good.suggested, 'Designed PostgreSQL reward-ledger schemas serving 200k members.'], 'chỉ giữ gợi ý hợp lệ');
  assert.strictEqual(r.body.dropped, 5, 'đếm số bị loại');
  assert.deepStrictEqual(Object.keys(r.body.suggestions[0]).sort(), ['id', 'original', 'reason', 'section', 'suggested']);
  for (const s of r.body.suggestions) for (const m of r.body.missing) assert.ok(!s.suggested.includes(m), 'missing không bao giờ vào gợi ý');
  assert.strictEqual(r.body.suggestions[1].reason, 'Diễn đạt lại theo cách JD dùng', 'reason mặc định VI');

  // 3 ca bịa thật từ llama-4-scout (Ada chạy AI thật): phải bị loại; 1 diễn đạt lại hợp lệ được giữ.
  aiReply = { suggestions: [
    { section: 'Experience', original: '- Built REST APIs for the points and voucher service using NestJS and PostgreSQL.', suggested: '- Designed and built RESTful APIs for points and voucher services using Java, Spring Boot and PostgreSQL.' }, // đổi công nghệ của dòng
    { section: 'Summary', original: 'Backend developer with 4 years of experience in loyalty platforms.', suggested: 'Senior Backend Developer with 4 years of experience in loyalty platforms.' }, // cấp bậc bịa
    { section: 'Experience', original: '- Migrated two services from Spring Boot 2 to Spring Boot 3.', suggested: '- Migrated two services from Spring Boot 2 to Spring Boot 3, demonstrating ownership of production reliability.' }, // chép claim từ JD
    { section: 'Experience', original: '- Built REST APIs for the points and voucher service using NestJS and PostgreSQL.', suggested: '- Built RESTful APIs in NestJS and PostgreSQL for the event-driven loyalty points and voucher service.' }, // hợp lệ: cụm JD ngắn, cùng skill
    { section: 'Experience', original: '- Migrated two services from Spring Boot 2 to Spring Boot 3.', suggested: '- Upgraded two production services from Spring Boot 2 to Spring Boot 3.' }, // hợp lệ
  ] };
  aiCalls = 0;
  r = await call('t1', 'p1', { job_id: 'j3' });
  assert.strictEqual(aiCalls, 1);
  assert.ok(aiPrompt.includes('same tools'), 'prompt siết');
  assert.strictEqual(r.body.dropped, 3, 'loại 3 ca bịa thật');
  assert.deepStrictEqual(r.body.suggestions.map((s) => s.suggested), ['- Built RESTful APIs in NestJS and PostgreSQL for the event-driven loyalty points and voucher service.', '- Upgraded two production services from Spring Boot 2 to Spring Boot 3.']);

  // cache: không gọi AI, không tính lượt
  const used = kv.get(rlKey());
  r = await call('t1', 'p1', { job_id: 'j2' });
  assert.deepStrictEqual([aiCalls, r.body.cached, r.body.suggestions.length, r.body.dropped], [1, true, 2, 5], 'cache hit');
  assert.strictEqual(kv.get(rlKey()), used, 'cache hit không đếm');
  // lang=en: reason mặc định tiếng Anh, khoá cache riêng
  aiReply = { suggestions: [{ ...good, reason: '' }] };
  r = await call('t1', 'p1', { job_id: 'j2', lang: 'en' });
  assert.strictEqual(r.body.suggestions[0].reason, "Rephrased using the JD's wording");

  // opt-out: không gọi AI
  aiCalls = 0;
  r = await call('t3', 'p3', { job_id: 'j1' });
  assert.deepStrictEqual([r.status, r.body.ai_used, r.body.suggestions, aiCalls], [200, false, [], 0], 'opt-out');
  assert.ok(r.body.matched.length && r.body.skills_text);

  // giới hạn 15 lượt AI/ngày (đã dùng 4), lượt 16 → 429
  for (let i = 5; i <= 15; i++) { kv.delete('cvsug:p1:j1:f1:vi'); assert.strictEqual((await call('t1', 'p1', { job_id: 'j1' })).status, 200, 'lượt ' + i); }
  assert.strictEqual(kv.get(rlKey()), '15');
  kv.delete('cvsug:p1:j1:f1:vi'); aiCalls = 0;
  r = await call('t1', 'p1', { job_id: 'j1' });
  assert.deepStrictEqual([r.status, r.body.error, aiCalls], [429, 'rate_limited', 0]);
  assert.ok(r.body.retry_after > 0 && r.body.retry_after <= 86400);
  r = await call('t1', 'p1', { job_id: 'j2' });
  assert.deepStrictEqual([r.status, aiCalls], [200, 0], 'cache hit vẫn chạy sau khi chạm trần');

  console.log('cv-suggest selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
