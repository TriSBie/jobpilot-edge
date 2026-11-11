// Review live 11/11 (Nova): A1 tag lấn thẻ, A2 tin phi IT, A3 cấp bậc, A4 "Vietnam" + skip xếp đầu, A7 trung vị ít mẫu, A8 mojibake RemoteOK, A9 lang/Vary.
// Chạy: node apps/api/test/scoring-data.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map([['session:tokA', 'A']]);
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => l.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
};
const T = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('A', 'a@x', 'A', ?)").run(T);
db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES ('src-topdev', 'topdev', 'TopDev', ?)").run(T);
db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, created_at, updated_at) VALUES ('p', 'A', 'P', 'middle', '[\"Hồ Chí Minh\"]', ?, ?)").run(T, T);
const job = (id, title, location, salary, score) => {
  db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, location, salary_text, skills, content_hash, posted_at, first_seen_at, last_seen_at, created_at) VALUES (?, 'src-topdev', ?, ?, 'Co', ?, ?, '[\"Java\",\"Spring Boot\",\"PostgreSQL\"]', ?, ?, ?, ?, ?)")
    .run(id, `https://topdev.vn/detail-jobs/${id}`, title, location, salary, 'h' + id, T, T, T, T);
  if (score) db.prepare("INSERT INTO job_matches (job_id, profile_id, final_score, tier, matched_skills, scored_at) VALUES (?, 'p', ?, 'strong', '[\"Java\",\"Spring Boot\",\"PostgreSQL\"]', ?)").run(id, score, T);
};
job('skip', 'Java Developer', 'Ha Noi', null, 90);           // khác thành phố → skip, điểm cao nhất
job('ok', 'Java Developer', 'Ho Chi Minh', null, 70);
job('vn', 'Java Backend Developer', 'Vietnam', null, 60);   // A4: chỉ ghi Vietnam
for (const [i, s] of ['$3,000 - $4,000/month', '$5,000 - $6,000/month', '$7,000 - $8,000/month'].entries()) job('u' + i, 'Backend Engineer', 'Remote', s);

const src = fs.readFileSync(workerPath, 'utf8');
(async () => {
  const tmp = path.join(os.tmpdir(), `worker-scoring-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src + '\nexport { extractJd, extractSkillsFromText, titleGate, fitBreakdown, fixMojibake };');
  const m = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);
  const worker = m.default;
  const get = async (p, h = {}) => { const r = await worker.fetch(new Request('https://api.test' + p, { headers: h }), env, {}); return { r, body: await r.json() }; };

  // A1: JD ITviec chỉ lấy trong <section class='job-content'>; khối "việc làm liên quan" sau đó không thành skill (live: Lộc Trời C# dính Java/Spring Boot).
  const page = `<html><section class='job-content imt-5'><h2>Job description</h2><p>Phát triển Backend C#/.NET, RESTful API, SQL Server. ${'Mô tả chi tiết. '.repeat(20)}</p></section>`
    + `<div class='company'>Lộc Trời</div><div class='related-jobs'><h3>Java Developer</h3><a class='itag'>Java</a> Spring Boot, Kafka</div></html>`;
  const jd = m.extractJd(page, 'src-itviec');
  assert(jd.includes('C#/.NET') && !/Java|Spring Boot|Kafka|Lộc Trời/.test(jd), 'A1: JD lấn sang cuối trang: ' + jd.slice(-120));
  assert.deepStrictEqual(m.extractSkillsFromText(jd).filter((x) => /Java|Spring/.test(x)), [], 'A1 skill');
  // A1 (Rigel): <section> lồng trong job-content không được cắt sớm rồi rơi về cả trang.
  const nested = m.extractJd(`<section class='job-content'><section><p>short</p></section><p>C# ${'.NET Core API. '.repeat(20)}</p></section><div>Java Spring Boot</div>`, 'src-itviec');
  assert(nested.includes('C#') && nested.includes('short') && !/Java/.test(nested), 'A1 lồng: ' + nested.slice(-80));

  // A2: tin "kỹ sư" ngành khác bị chặn; tin IT viết tiếng Việt vẫn qua.
  for (const t of ['KỸ SƯ THẦU CẤP THOÁT NƯỚC', 'Kỹ Sư Thiết Bị SMT', 'Kỹ Sư Quản Lý Năng Lượng', 'Kỹ sư Shop Điện nhẹ', 'Kỹ Sư Giám Sát Xây Dựng', 'Kỹ Sư Cơ Điện Tổng Trạm', 'Kỹ Sư QS (Xây Dựng)', 'Cán Bộ/Kỹ Sư QS (Xây Dựng)', 'Kỹ Sư Sản Xuất (PE, EE)'])
    assert.strictEqual(m.titleGate(t), false, 'A2 chặn: ' + t);
  for (const t of ['Kỹ sư lập trình Backend (Java)', 'Kỹ Sư Dữ Liệu (Data Engineer)', 'Kỹ sư Quản lý Chất lượng Phần mềm', 'Java Developer', 'Senior DevOps Engineer',
    'Kỹ sư Kiểm thử', 'Kỹ sư cầu nối (BrSE)', 'Kỹ sư Cloud', 'Kỹ sư Bảo mật', 'Kỹ sư An toàn thông tin', 'Kỹ sư triển khai ERP',
    'Embedded Software Engineer - Năng lượng tái tạo', 'Lập trình viên xây dựng hệ thống ERP', 'Kỹ sư phần mềm MES nhà máy sản xuất'])
    assert.strictEqual(m.titleGate(t), true, 'A2 giữ: ' + t);

  // A3: "Middle"/"mid" vs tiêu đề Senior không còn 5; thiếu cấp bậc = chưa biết.
  const lv = (level) => m.fitBreakdown({ level, locations: ['Remote'] }, { title: 'Senior ML Engineer', location: 'Remote', jd_text: '', posted_at: T }).level;
  for (const l of ['middle', 'Middle', 'mid', ' MID ']) assert.strictEqual(lv(l), 2, 'A3 level ' + l);
  assert.strictEqual(lv(''), 4, 'A3: thiếu cấp bậc ≠ 5'); assert.strictEqual(lv(undefined), 4);
  assert.strictEqual(lv('senior'), 5);

  // A4a: "Vietnam" với hồ sơ thành phố VN = khớp một phần, không còn 0.
  const vn = m.fitBreakdown({ level: 'middle', locations: ['Hồ Chí Minh'] }, { title: 'Java Dev', location: 'Vietnam', jd_text: '', posted_at: T });
  assert.deepStrictEqual([vn.location, vn.locationWhy], [5, 'Tin ghi chung Việt Nam'], 'A4 fit');
  assert.strictEqual(m.fitBreakdown({ level: 'middle', locations: ['Remote'] }, { title: 'Java Dev', location: 'Vietnam', jd_text: '', posted_at: T }).location, 6, 'hồ sơ chỉ Remote: giữ như cũ');
  // A4b: /api/jobs xếp skip sau apply/apply_if, cả mảng cũ lẫn bản phân trang.
  const auth = { Authorization: 'Bearer tokA' };
  const list = (await get('/api/jobs?profile_id=p', auth)).body;
  assert.deepStrictEqual(list.map((j) => [j.id, j.verdict]).slice(0, 3), [['ok', 'apply'], ['vn', 'apply'], ['skip', 'skip']], 'A4: skip không đứng đầu');
  const pg = (await get('/api/jobs?profile_id=p&limit=1', auth)).body;
  assert.strictEqual(pg.items[0].id, 'ok', 'A4: trang 1 không là tin skip');

  // A7: <5 mẫu → trung vị null, vẫn báo count.
  const bm = (await get('/api/benchmark?role=backend', auth)).body;
  assert.deepStrictEqual([bm.usd.count, bm.usd.median_mid, bm.usd.median_min, bm.count, bm.median_mid], [3, null, null, 0, null], 'A7');

  // A8: sửa mojibake RemoteOK; chuỗi đúng (kể cả tiếng Việt) giữ nguyên.
  assert.strictEqual(m.fixMojibake('Engineer â\u0080\u0094 Kubernetes'), 'Engineer — Kubernetes');
  assert.strictEqual(m.fixMojibake('Kỹ sư lập trình — Hồ Chí Minh'), 'Kỹ sư lập trình — Hồ Chí Minh');
  assert.strictEqual(m.fixMojibake('Café Ângela'), 'Café Ângela', 'latin1 thật không khớp mẫu → giữ');

  // A9: ?lang=en ghi đè Accept-Language; có Vary; không còn dấu tiếng Việt.
  const VI = /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/i;
  for (const p of ['/api/public/sample?lang=en', '/api/public/try?skills=Java,Spring%20Boot&level=middle&location=H%E1%BB%93%20Ch%C3%AD%20Minh&lang=en']) {
    const { r, body } = await get(p, { 'accept-language': 'vi-VN' });
    assert.strictEqual(r.headers.get('vary'), 'Accept-Language', 'A9 vary ' + p);
    assert(body.jobs.length > 0, 'A9 có job ' + p);
    const visible = JSON.stringify({ label: body.profile.label, jobs: body.jobs.map((j) => [j.verdict_why, j.flags.map((f) => f.label), j.fit.location_why, j.fit.level_why]) });
    assert(!VI.test(visible), 'A9 còn tiếng Việt: ' + visible);
  }
  assert(VI.test(JSON.stringify((await get('/api/public/sample?lang=vi', { 'accept-language': 'en-US' })).body.jobs.map((j) => j.flags))), 'A9: lang=vi thắng Accept-Language');
  console.log('scoring-data selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
