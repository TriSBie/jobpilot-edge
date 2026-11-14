// SPEC 12/11 §3A: logo/địa chỉ/phúc lợi/chế độ do nguồn ghi. TopDev bóc từ trang danh sách, ITviec từ trang chi tiết enrichJd đã tải
// (0 request thêm). Logo ngoài allowlist → null. /api/jobs trả 4 trường mới, field cũ giữ nguyên, nhãn nguồn thắng heuristic.
// Chạy: node apps/api/test/jobs-preview.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map([['session:tokO', 'own']]);
const env = {
  OWNER_EMAIL: 'tribui.it.work@gmail.com',
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => l.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); }, list: async () => ({ keys: [] }) },
  Q_SCORE: { send: async () => {}, sendBatch: async () => {} },
};
const T = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('own', 'tribui.it.work@gmail.com', 'O', ?)").run(T);
for (const [id, type] of [['src-topdev', 'topdev'], ['src-itviec', 'itviec']]) db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES (?, ?, ?, ?)").run(id, type, type, T);

// TopDev: JSON nhúng trong RSC (\" escaped); phúc lợi là tham chiếu "$3e" tới chunk "3e:T…" kế sau, entity chữ Việt.
const tdJob = (id, title, logo, extra) => `{"id":${id},"title":"${title}","company":{"id":1,"display_name":"Co ${id}","image_logo":"${logo}"},"skills_arr":["Java","Spring Boot","Kafka"],"address_short_region_list":"Hồ Chí Minh","full_addresses":["118 Đường B2, Phường An Lợi Đông, Thành phố Hồ Chí Minh","Số 5 Nguyễn Thị Duệ, Hà Nội"],"job_url":"x","slug":"java-${id}","published":{"date":"10-11-2026"},${extra}}`;
const tdJson = '[' + [
  tdJob(1000001, 'Java Developer', 'https://assets.saramin.vn/images/a.png', '"job_types_str":"Trực tiếp","benefits_original":[{"icon":null,"value":"$3e"}]'),
  tdJob(1000002, 'Backend Engineer', 'https://evil.test/a.png', '"job_types_str":"Linh hoạt"'),
  tdJob(1000003, 'Java Engineer', 'http://assets.saramin.vn/b.png', '"job_types_str":"Kiểu lạ"'),
].join(',') + ']';
const longLi = 'Thưởng cuối năm + thưởng Lễ/Tết + thưởng sinh nhật + thưởng đột xuất khi hoàn thành tốt';
const tdHtml = `<script>self.__next_f.push([1,"${tdJson.split('"').join('\\"')}"])</script><script>self.__next_f.push([1,"3e:T80,"])</script>`
  + `<script>self.__next_f.push([1,"\\u003cul\\u003e\\u003cli\\u003eL&agrave;m việc tại văn ph&ograve;ng\\u003c/li\\u003e\\u003cli\\u003e${longLi}\\u003c/li\\u003e`
  + Array.from({ length: 6 }, (_, i) => `\\u003cli\\u003eB${i}\\u003c/li\\u003e`).join('') + `\\u003c/ul\\u003e"])</script>`;

// ITviec trang chi tiết: JSON-LD + nhãn "Hybrid" đầu trang + "Top 3 reasons"; "Remote" ở thẻ liên quan sau job-content không được tính.
const ivHtml = (logo) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'JobPosting', title: 'Java',
  hiringOrganization: { '@type': 'Organization', logo, name: 'bbv' },
  jobLocation: [{ '@type': 'Place', address: { streetAddress: 'Anna Building, QTSC', addressLocality: 'Quận 12', addressRegion: 'Hồ Chí Minh' } }] })}</script></head>
<body><div><span class='normal-text text-rich-grey ms-1'>Hybrid</span></div>
<img alt='x' class='border employer-logo' data-src='https://itviec.com/fallback.png'>
<section class='job-content'><div class='paragraph'><h2>Top 3 reasons to join us</h2> <ul> <li>Full insurance on NET salary.</li> <li>13th-month salary</li> <li>MacBook</li> </ul></div>
<h2>Job description</h2><p>${'Java Spring Boot Kafka backend work. '.repeat(10)}</p></section>
<div class='related'><div class='text-rich-grey'> Remote </div></div></body></html>`;

const fetched = [];
global.fetch = async (url) => {
  fetched.push(String(url));
  const u = String(url);
  const body = u.includes('topdev.vn/jobs/search') ? tdHtml : u.endsWith('iv-1') ? ivHtml('https://itviec.com/rails/logo.png') : u.endsWith('iv-2') ? ivHtml('javascript:alert(1)') : '';
  return { ok: true, status: 200, text: async () => body };
};

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-preview-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (method, p, body) => { const r = await worker.fetch(new Request('https://api.test' + p, { method, headers: { Authorization: 'Bearer tokO', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {}); return { status: r.status, body: await r.json() }; };

  // 1. TopDev ingest: 1 request, bóc trường mới, allowlist logo
  await worker.queue({ queue: 'jobpilot-ingest', messages: [{ body: { kind: 'ingest', sourceType: 'topdev', keyword: 'java' }, ack() {}, retry() {} }], ackAll() {}, retryAll() {} }, env, {});
  assert.strictEqual(fetched.length, 1, 'TopDev: đúng 1 request như cũ');
  const td = Object.fromEntries(db.prepare("SELECT source_url, company_logo_url, address, benefits, work_mode_src FROM jobs WHERE source_id = 'src-topdev'").all().map((r) => [r.source_url.slice(-7), { ...r }]));
  assert.strictEqual(Object.keys(td).length, 3);
  assert.strictEqual(td['1000001'].company_logo_url, 'https://assets.saramin.vn/images/a.png');
  assert.strictEqual(td['1000002'].company_logo_url, null, 'host ngoài allowlist → null');
  assert.strictEqual(td['1000003'].company_logo_url, null, 'http → null');
  assert.strictEqual(td['1000001'].address, '118 Đường B2, Phường An Lợi Đông, Thành phố Hồ Chí Minh');
  assert.deepStrictEqual([td['1000001'].work_mode_src, td['1000002'].work_mode_src, td['1000003'].work_mode_src], ['onsite', 'hybrid', null]);
  const b = JSON.parse(td['1000001'].benefits);
  assert.strictEqual(b.length, 5, 'tối đa 5 mục');
  assert.strictEqual(b[0], 'Làm việc tại văn phòng', 'entity chữ Việt giải mã');
  assert.ok(b[1].length <= 60 && b[1].endsWith('…'), 'mục dài bị cắt 60');
  assert.strictEqual(td['1000002'].benefits, null);

  // quét lại với nguồn rỗng trường mới: COALESCE giữ giá trị cũ
  const saved = tdHtml;
  global.fetch = async (url) => { fetched.push(String(url)); return { ok: true, status: 200, text: async () => saved.replace(/\\"image_logo\\":\\"[^\\]*\\"/g, '\\"x\\":1').replace(/full_addresses/g, 'fa') }; };
  await worker.queue({ queue: 'jobpilot-ingest', messages: [{ body: { kind: 'ingest', sourceType: 'topdev', keyword: 'java' }, ack() {}, retry() {} }], ackAll() {}, retryAll() {} }, env, {});
  const again = db.prepare("SELECT company_logo_url, address, seen_count FROM jobs WHERE source_url LIKE '%1000001'").get();
  assert.deepStrictEqual([again.company_logo_url, again.address, again.seen_count], ['https://assets.saramin.vn/images/a.png', '118 Đường B2, Phường An Lợi Đông, Thành phố Hồ Chí Minh', 2], 'giữ cũ khi nguồn rỗng');

  // 2. ITviec enrichJd: không thêm request (1 trang/tin), JSON-LD thắng fallback img, nhãn trước job-content
  db.prepare("UPDATE jobs SET jd_text = 'td' WHERE source_id = 'src-topdev'").run(); // chỉ soi enrich ITviec
  for (const id of ['iv-1', 'iv-2']) db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, location, jd_text, skills, content_hash, first_seen_at, created_at) VALUES (?, 'src-itviec', ?, 'Java Dev', 'bbv', 'Ho Chi Minh', '', '[]', ?, ?, ?)").run(id, 'https://itviec.com/it-jobs/' + id, 'h' + id, T, T);
  global.fetch = async (url) => { fetched.push(String(url)); return { ok: true, status: 200, text: async () => (String(url).endsWith('iv-1') ? ivHtml('https://itviec.com/rails/logo.png') : ivHtml('javascript:alert(1)')) }; };
  fetched.length = 0;
  const en = await call('POST', '/api/admin/jd/enrich', { limit: 5 });
  assert.strictEqual(en.body.done, 2);
  assert.strictEqual(fetched.length, 2, 'ITviec: 1 request/tin, không thêm');
  const iv = Object.fromEntries(db.prepare("SELECT id, company_logo_url, address, benefits, work_mode_src FROM jobs WHERE source_id = 'src-itviec'").all().map((r) => [r.id, { ...r }]));
  assert.deepStrictEqual({ ...iv['iv-1'] }, { id: 'iv-1', company_logo_url: 'https://itviec.com/rails/logo.png', address: 'Anna Building, QTSC, Quận 12, Hồ Chí Minh',
    benefits: JSON.stringify(['Full insurance on NET salary.', '13th-month salary', 'MacBook']), work_mode_src: 'hybrid' });
  assert.strictEqual(iv['iv-2'].company_logo_url, 'https://itviec.com/fallback.png', 'logo JSON-LD sai scheme → fallback img (cũng qua allowlist)');

  // 3. /api/jobs: trường mới, nguồn thắng heuristic, field cũ giữ nguyên
  db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, location, jd_text, skills, content_hash, first_seen_at, created_at, company_logo_url, benefits) VALUES ('old', 'src-itviec', 'https://itviec.com/it-jobs/old', 'Java Dev', 'C', 'Ha Noi', 'x', '[]', 'hold', ?, ?, 'https://evil.test/x.png', 'not json')").run(T - 99, T);
  for (const qs of ['', '?limit=50&offset=0']) {
    const r = await call('GET', '/api/jobs' + qs);
    const list = Array.isArray(r.body) ? r.body : r.body.items;
    const by = Object.fromEntries(list.map((x) => [x.id, x]));
    assert.strictEqual(by['iv-1'].work_mode, 'hybrid'); assert.strictEqual(by['iv-1'].work_mode_source, 'source', qs);
    assert.strictEqual(by['iv-1'].address, 'Anna Building, QTSC, Quận 12, Hồ Chí Minh');
    assert.deepStrictEqual(by['iv-1'].benefits, ['Full insurance on NET salary.', '13th-month salary', 'MacBook']);
    assert.deepStrictEqual([by.old.work_mode, by.old.work_mode_source, by.old.company_logo_url, by.old.benefits, by.old.address], ['onsite', 'inferred', null, [], null], 'dữ liệu cũ hỏng → an toàn');
    for (const k of ['id', 'title', 'company', 'location', 'source_url', 'source', 'salary_text', 'salary_vnd_min', 'salary_vnd_max', 'work_mode', 'skills', 'jd_len', 'posted_at', 'first_seen_at', 'flags', 'risk', 'match', 'application', 'verdict', 'verdict_why'])
      assert.ok(k in by.old, 'field cũ: ' + k);
  }
  // 4. CSP img-src đúng host allowlist, không wildcard
  const headers = fs.readFileSync(path.join(path.dirname(workerPath), '..', '..', 'web', 'public', '_headers'), 'utf8');
  const img = headers.match(/img-src([^;]*)/)[1].trim().split(/\s+/);
  const hosts = fs.readFileSync(workerPath, 'utf8').match(/const LOGO_HOSTS = new Set\(\[([^\]]*)\]\)/)[1].match(/"([^"]+)"/g).map((x) => 'https://' + x.slice(1, -1));
  for (const h of hosts) assert.ok(img.includes(h), 'img-src thiếu ' + h);
  assert.ok(!img.some((x) => x.includes('*')), 'không wildcard');
  console.log('jobs-preview selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
