// /api/jobs: salary_vnd_min/max + work_mode suy ra lúc đọc; lọc mode/min_salary/has_salary trước khi phân trang (total đúng).
// Chạy: node apps/api/test/jobs-filters.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const src = fs.readFileSync(workerPath, 'utf8').replace(/\r\n/g, '\n');

// 1. hàm thuần: parse lương (cùng parser + tỉ giá benchmark) và nhận diện hình thức
const pure = new Function(['USD_VND', 'parseSalary', 'monthlyVND', 'salaryVND', 'normLoc', 'VN_CITY_RE', 'REMOTE_SOURCES', 'HYBRID_RE', 'workMode']
  .map((n) => src.match(new RegExp(`\\n(const ${n} =[^\\n]*\\n|function ${n}\\([\\s\\S]*?\\n\\}\\n)`))[1]).join('\n')
  + '\nreturn { salaryVND, workMode, USD_VND };')();
const { salaryVND, workMode, USD_VND } = pure;
assert.deepStrictEqual(salaryVND('15 - 25 triệu'), { min: 15e6, max: 25e6 });
assert.deepStrictEqual(salaryVND('$3k - $5k/năm'), { min: Math.round(3000 * USD_VND / 12), max: Math.round(5000 * USD_VND / 12) });
assert.deepStrictEqual(salaryVND('Up to 2000 USD'), { min: 2000 * USD_VND, max: 2000 * USD_VND });
assert.deepStrictEqual(salaryVND('Thương lượng'), { min: null, max: null });
assert.deepStrictEqual(salaryVND(null), { min: null, max: null });
assert.strictEqual(workMode('Ho Chi Minh', 'Java Developer', 'We work in a hybrid model, 3 days in office'), 'hybrid', 'ITviec HCM + JD hybrid');
assert.strictEqual(workMode('Hồ Chí Minh', 'Java Developer', 'Làm việc linh hoạt'), 'hybrid');
assert.strictEqual(workMode('Remote (Worldwide)', 'Backend', ''), 'remote');
assert.strictEqual(workMode('Hà Nội', 'Dev (làm từ xa)', ''), 'remote');
assert.strictEqual(workMode('Hà Nội', 'Java Dev', 'Office in Cau Giay'), 'onsite');
assert.strictEqual(workMode('Vietnam', 'Java Dev', ''), null);
assert.strictEqual(workMode('', 'Java Dev', ''), null);
// QA F2/F3: nguồn remote không ghi chữ remote; tin onsite VN có chữ remote trong JD/tiêu đề
assert.strictEqual(workMode('Worldwide', 'Backend', '', 'src-remoteok'), 'remote');
assert.strictEqual(workMode('Asia', 'Backend', '', 'src-remotive'), 'remote');
assert.strictEqual(workMode('Anywhere in the World', 'Backend', ''), 'remote');
assert.strictEqual(workMode('Ho Chi Minh', 'Java Dev', 'We do not offer remote work'), 'onsite');
assert.strictEqual(workMode('Ho Chi Minh', 'Java Dev', 'Thỉnh thoảng họp remote'), 'onsite');
assert.strictEqual(workMode('Ha Noi', 'Remote Sensing Data Engineer', ''), 'onsite');
assert.strictEqual(workMode('HCMC', 'Java Dev', ''), 'onsite');
assert.strictEqual(workMode('Ho Chi Minh', 'Java Dev (Work from home)', ''), 'remote');
assert.strictEqual(workMode('Remote', 'Dev', 'Hybrid: 2 days in office', 'src-hn'), 'hybrid');
console.log('jobs-filters parse/mode OK');

// 2. route thật trên SQLite trong RAM
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map([['session:tokA', 'A']]);
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => l.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
};
const T = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('A', 'a@x.test', 'A', ?)").run(T);
db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES ('s1', 'itviec', 'ITviec', ?)").run(T);
const job = (id, location, salary, jd, i) => db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, location, salary_text, jd_text, skills, content_hash, first_seen_at, created_at) VALUES (?, 's1', ?, 'Java Dev', 'Co', ?, ?, ?, '[]', ?, ?, ?)")
  .run(id, 'https://x.test/' + id, location, salary, jd, 'h' + id, T - i, T);
job('j1', 'Ho Chi Minh', null, 'Hybrid, 2 days WFH', 1);           // hybrid, no salary
job('j2', 'Ha Noi', '30 - 40 triệu', 'Office', 2);                   // onsite 40tr
job('j3', 'Remote (Worldwide)', '$80k - $100k/năm', '', 3);         // remote ~212tr
job('j4', 'Ho Chi Minh', '10 - 15 triệu', 'Office', 4);              // onsite 15tr
job('j5', 'Remote (US)', 'Thương lượng', '', 5);                     // remote, no salary
job('j6', 'Vietnam', null, '', 6);                                   // null

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-filters-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const get = async (qs) => { const r = await worker.fetch(new Request('https://api.test/api/jobs' + qs, { headers: { Authorization: 'Bearer tokA' } }), env, {}); return { status: r.status, body: await r.json() }; };
  const idsOf = (b) => (Array.isArray(b) ? b : b.items).map((x) => x.id).sort();

  let r = await get('');
  assert(Array.isArray(r.body) && r.body.length === 6, 'mảng cũ giữ nguyên');
  const j2 = r.body.find((x) => x.id === 'j2');
  assert.deepStrictEqual([j2.salary_vnd_min, j2.salary_vnd_max, j2.work_mode], [30e6, 40e6, 'onsite']);
  assert.deepStrictEqual(Object.fromEntries(r.body.map((x) => [x.id, x.work_mode])), { j1: 'hybrid', j2: 'onsite', j3: 'remote', j4: 'onsite', j5: 'remote', j6: null });

  r = await get('?limit=1&offset=0');
  assert.strictEqual(r.body.items[0].work_mode !== undefined && 'salary_vnd_max' in r.body.items[0], true, 'trang có trường mới');
  assert.strictEqual(r.body.items[0].id, 'j1'); assert.strictEqual(r.body.items[0].work_mode, 'hybrid', 'jd_head trong bản phân trang');

  assert.deepStrictEqual(idsOf((await get('?mode=remote')).body), ['j3', 'j5']);
  assert.deepStrictEqual(idsOf((await get('?mode=onsite,hybrid')).body), ['j1', 'j2', 'j4']);
  assert.deepStrictEqual(idsOf((await get('?has_salary=1')).body), ['j2', 'j3', 'j4']);
  assert.deepStrictEqual(idsOf((await get('?min_salary=20')).body), ['j1', 'j2', 'j3', 'j5', 'j6'], 'giữ tin không có lương');
  assert.deepStrictEqual(idsOf((await get('?min_salary=20&has_salary=1')).body), ['j2', 'j3']);

  // lọc + phân trang: total tính sau lọc
  r = await get('?mode=onsite,remote&limit=2&offset=0');
  assert.deepStrictEqual([r.body.total, r.body.items.length, r.body.next_offset], [4, 2, 2]);
  r = await get('?mode=onsite,remote&limit=2&offset=2');
  assert.deepStrictEqual([r.body.total, r.body.items.length, r.body.next_offset], [4, 2, null]);
  r = await get('?has_salary=1&min_salary=20&limit=1');
  assert.deepStrictEqual([r.body.total, r.body.next_offset], [2, 1]);

  for (const bad of ['?mode=office', '?mode=', '?min_salary=-1', '?min_salary=abc', '?min_salary=1.5', '?has_salary=yes'])
    assert.deepStrictEqual([(await get(bad)).status, (await get(bad)).body.error], [400, 'invalid_query'], bad);
  console.log('jobs-filters route OK');
})().catch((e) => { console.error(e); process.exit(1); });
