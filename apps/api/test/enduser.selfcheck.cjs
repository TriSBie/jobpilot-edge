// Ada 12/11 end-user gaps #1-#10: forgot password, verify email, telegram_shared_ok, filters over all jobs, sort,
// VN salary from JD, enrichment order, geocoding, public job, source_id NULL guard. worker.fetch/scheduled thật trên SQLite RAM.
// Chạy: node apps/api/test/enduser.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const src = fs.readFileSync(workerPath, 'utf8').replace(/\r\n/g, '\n');

// #6 hàm thuần: bóc lương từ JD, bảo thủ
const grab = (n) => src.match(new RegExp(`\\n(const ${n} =[^\\n]*\\n|function ${n}\\([\\s\\S]*?\\n\\}\\n)`))[1];
const { salaryFromJd } = new Function(['JD_MAX', 'SAL_KW', 'TR', 'salaryFromJd'].map(grab).join('\n') + '\nreturn { salaryFromJd };')();
const ok = {
  'Mức lương: 15 - 25 triệu, thưởng tháng 13': '15 - 25 triệu',
  'Lương: 20-30tr gross': '20 - 30 triệu',
  'Thu nhập lên đến 40 triệu/tháng': '40 triệu',
  'Salary: up to 2000 USD': '2000 - 2000 USD/month',
  'Offer salary $1,500 - $2,500 USD': '1500 - 2500 USD/month',
  'Benefits: Up to $3000 depending on experience': '3000 - 3000 USD/month',
  // JD thật prod 12/11
  'cạnh tranh trên thị trường (From $700, Up to $10,000).': '700 - 10000 USD/month',
  'Thu nhập: 16-23 triệu đồng. (Theo năng lực)': '16 - 23 triệu',
};
for (const [t, want] of Object.entries(ok)) assert.strictEqual(salaryFromJd(t), want, t);
const no = ['Công ty có 500 nhân viên, 20 năm kinh nghiệm', 'Vốn 100 triệu USD', 'Bảo hiểm 30 triệu cho người thân', 'Lương thương lượng',
  'Salary: $120k - $150k per year', 'Raised 2000 USD seed', 'Hỗ trợ ăn trưa 1 triệu', 'Salary: 5000 USD/year', 'Mức lương cạnh tranh; thu nhập từ 170tr/năm.', 'Lương 15-20 triệu/năm', 'Salary 300 triệu / năm', 'version 2000 USD API', '', null];
for (const t of no) assert.strictEqual(salaryFromJd(t), null, String(t));
console.log('enduser salaryFromJd OK');

// JSON-LD baseSalary: mẫu chép từ trang thật 12/11 (ITviec USD số / "You'll love it"; TopDev VND chuỗi số, USD chỉ max, Negotiable)
const { ldSalary } = new Function(grab('ldSalary') + '\nreturn { ldSalary };')();
const ld = (bs) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'X', baseSalary: bs })}</script>`;
const LD = {
  itvNum: ld({ '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 800, maxValue: 2000, unitText: 'MONTH', value: '800 - 2,000 USD' } }),
  itvText: ld({ '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', unitText: 'MONTH', value: "You'll love it" } }),
  tdVnd: ld({ '@type': 'MonetaryAmount', currency: 'VND', value: { '@type': 'QuantitativeValue', unitText: 'MONTH', minValue: '17000000', maxValue: '23000000', value: '17.000.000 VND to 23.000.000 VND' } }),
  tdUpTo: ld({ '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', unitText: 'MONTH', maxValue: '1200', value: 'Up to 1.200 USD' } }),
  tdNeg: ld({ '@type': 'MonetaryAmount', currency: 'VND', value: { '@type': 'QuantitativeValue', unitText: 'MONTH', value: 'Negotiable' } }),
  year: ld({ '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', unitText: 'YEAR', minValue: 40000, maxValue: 60000 } }),
};
assert.strictEqual(ldSalary(LD.itvNum), '800 - 2000 USD/month');
assert.strictEqual(ldSalary(LD.tdVnd), '17 - 23 triệu');
assert.strictEqual(ldSalary(LD.tdUpTo), '1200 USD/month');
for (const k of ['itvText', 'tdNeg', 'year']) assert.strictEqual(ldSalary(LD[k]), null, k);
assert.strictEqual(ldSalary('<script type="application/ld+json">{bad json baseSalary</script>'), null);
console.log('enduser ldSalary OK');

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let queries = 0;
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => (queries++, { results: exec(sql, args) }), first: async () => (queries++, exec(sql, args)[0] || null),
  run: async () => (queries++, { success: true, meta: { changes: db.prepare(sql).run(...args).changes } }) });
const kv = new Map(), q = (sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => (queries++, l.map((s) => ({ results: exec(s.sql, s.args) }))) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  Q_SCORE: { send: async () => {}, sendBatch: async () => {} }, Q_INGEST: { send: async () => {} },
  TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_API_BASE: 'https://tg.test',
};
const calls = [];
globalThis.fetch = async (u, init = {}) => {
  u = String(u); calls.push({ u, body: init.body ? String(init.body) : '', headers: init.headers || {} });
  if (u.startsWith('https://tg.test')) return new Response('{"ok":true}', { status: 200 });
  if (u.startsWith('https://api.resend.com')) return new Response('{"id":"m"}', { status: 200 });
  if (u.startsWith('https://nominatim.openstreetmap.org')) return new Response(u.includes('Nowhere') ? '[]' : '[{"lat":"10.776","lon":"106.700"}]');
  if (u.startsWith('https://api.mailjet.com')) return new Response('{"Messages":[{"Status":"success"}]}', { status: 200 });
  if (u.includes('topdev.vn')) return new Response(`<html>${LD.tdVnd}<div class="job-description">${'Golang backend. Mức lương: 25 - 35 triệu. '.repeat(10)}</div></html>`);
  if (u.includes('itviec.com')) return new Response(`<script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"logo":"https://itviec.com/l.png"},"jobLocation":{"address":{"streetAddress":"1 Le Loi","addressLocality":"HCM"}}}</script><section class='job-content'>${'Java Spring Boot. Mức lương: 25 - 35 triệu. '.repeat(10)}</section>`);
  return new Response('[]');
};
const T = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, name, created_at, telegram_chat_id) VALUES ('A', 'a@x.test', 'A', ?, 'chatA')").run(T);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('B', 'b@x.test', 'B', ?)").run(T);
kv.set('session:tokA', 'A'); kv.set('session:tokB', 'B');
db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES ('src-itviec', 'itviec', 'ITviec', ?)").run(T);

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-enduser-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (method, p, body, tok, e = env, h = {}) => {
    const hd = { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...h }; if (tok) hd.Authorization = `Bearer ${tok}`;
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: hd, body: body && JSON.stringify(body) }), e, {});
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  const resets = () => [...kv.keys()].filter((k) => k.startsWith('pwreset:'));

  // #1 forgot: Telegram nếu đã liên kết; email lạ / chưa có kênh → vẫn {ok:true}, không tạo token, không gửi
  let r = await call('POST', '/api/auth/forgot', { email: 'A@x.test ' });
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true }]);
  assert.strictEqual(resets().length, 1, 'token cho A');
  const tg = calls.find((c) => c.u.includes('/sendMessage'));
  assert.ok(tg && tg.body.includes('chatA') && tg.body.includes('?reset=' + resets()[0].slice(8)), 'link qua Telegram');
  calls.length = 0;
  for (const e of ['b@x.test', 'nobody@x.test']) assert.deepStrictEqual((await call('POST', '/api/auth/forgot', { email: e })).body, { ok: true }, e);
  assert.strictEqual(resets().length, 1, 'B không kênh + email lạ: không token');
  assert.strictEqual(calls.length, 0, 'không gửi gì');
  assert.strictEqual((await call('POST', '/api/auth/forgot', { email: 'xx' })).status, 400);
  // email qua Resend khi có khoá; token reset dùng được
  const envMail = { ...env, RESEND_API_KEY: 'k', MAIL_FROM: 'JobPilot <n@x.test>' };
  await call('POST', '/api/auth/forgot', { email: 'b@x.test' }, null, envMail, { 'cf-connecting-ip': '5.6.7.8' });
  const mail = calls.find((c) => c.u.startsWith('https://api.resend.com'));
  assert.ok(mail && JSON.parse(mail.body).to[0] === 'b@x.test' && mail.headers.authorization === 'Bearer k', 'email Resend');
  const tokB = JSON.parse(mail.body).text.match(/\?reset=([\w-]+)/)[1];
  assert.strictEqual((await call('POST', '/api/auth/reset-password', { token: tokB, new_password: 'newpassword1' })).status, 200);
  assert.strictEqual(q("SELECT password_hash IS NOT NULL p FROM users WHERE id='B'")[0].p, 1);
  // Turnstile bắt buộc khi có secret
  assert.strictEqual((await call('POST', '/api/auth/forgot', { email: 'a@x.test' }, null, { ...env, TURNSTILE_SECRET: 's' })).status, 403);
  // rate-limit theo email: lần thứ 4 trong giờ không tạo token, vẫn ok
  for (let i = 0; i < 3; i++) await call('POST', '/api/auth/forgot', { email: 'a@x.test' }, null, env, { 'cf-connecting-ip': `9.9.9.${i}` });
  const before = resets().length;
  assert.deepStrictEqual((await call('POST', '/api/auth/forgot', { email: 'a@x.test' }, null, env, { 'cf-connecting-ip': '9.9.9.9' })).body, { ok: true });
  assert.strictEqual(resets().length, before, 'quá 3/giờ/email: không token mới');
  console.log('enduser #1 forgot OK');

  // #2 + #3: /api/me cờ mới; verify-email ngủ khi không có khoá mail, chạy khi có; không chặn đăng nhập
  r = await call('GET', '/api/me', null, 'tokA');
  assert.deepStrictEqual([r.body.user.email_verified, r.body.user.mail_enabled, r.body.user.telegram_shared_ok], [false, false, false]);
  r = await call('GET', '/api/me', null, 'tokA', { ...envMail, TELEGRAM_BOT_USERNAME: 'bot' });
  assert.deepStrictEqual([r.body.user.mail_enabled, r.body.user.telegram_shared_ok], [true, true]);
  assert.deepStrictEqual((await call('POST', '/api/me/verify-email/send', {}, 'tokA')).body, { ok: true, sent: false, reason: 'mail_disabled' });
  calls.length = 0;
  assert.deepStrictEqual((await call('POST', '/api/me/verify-email/send', {}, 'tokA', envMail)).body, { ok: true, sent: true });
  const vtok = JSON.parse(calls.find((c) => c.u.startsWith('https://api.resend.com')).body).text.match(/\?verify=([\w-]+)/)[1];
  assert.strictEqual((await call('POST', '/api/auth/verify-email', { token: 'bad' })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/verify-email', { token: vtok })).status, 200);
  assert.strictEqual((await call('POST', '/api/auth/verify-email', { token: vtok })).status, 400, 'dùng 1 lần');
  assert.strictEqual((await call('GET', '/api/me', null, 'tokA')).body.user.email_verified, true);
  assert.strictEqual((await call('POST', '/api/me/verify-email/send', {}, 'tokA', envMail)).body.reason, 'already_verified');
  console.log('enduser #2/#3 verify + flags OK');

  // #10: ingest không lưu tin chung thiếu source_id; tin dán tay (source_id NULL + submitted_by) vẫn được
  const ins = (id, o) => db.prepare(`INSERT INTO jobs (id, source_id, source_url, title, company, location, salary_text, jd_text, skills, content_hash, first_seen_at, created_at, submitted_by)
    VALUES (?, ?, ?, ?, 'Co', ?, ?, ?, '[]', ?, ?, ?, ?)`).run(id, o.src === undefined ? 'src-itviec' : o.src, o.url || `https://itviec.com/it-jobs/${id}`, o.title || 'Java Dev',
    o.loc || 'Ho Chi Minh', o.sal ?? null, o.jd ?? 'Office', 'h' + id, o.seen, T, o.by ?? null);
  // 310 tin cũ hơn: chỉ đứng trong top 300 mới nhất khi lọc SQL chạy trước LIMIT
  for (let i = 0; i < 310; i++) ins('n' + i, { seen: T - i });
  ins('old-remote', { seen: T - 10000, loc: 'Remote (Worldwide)', sal: '$3000 - $4000/month' });
  ins('old-jd-sal', { seen: T - 10001, jd: 'Mức lương: 40 - 50 triệu. Office in D1' });
  ins('mine', { seen: T - 20000, src: null, url: 'manual://x', by: 'A' });
  // Prod: dòng source_id NULL duy nhất là tin DÁN TAY (submitted_by có, link host lạ → nguồn 'manual' = NULL), đúng thiết kế.
  // Guard chặn tin quét chung thiếu nguồn; nhánh dán tay vẫn chạy.
  r = await call('POST', '/api/jobs/submit', { title: 'Manual T', company: 'C' }, 'tokA');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(q("SELECT COUNT(*) c FROM jobs WHERE source_id IS NULL AND submitted_by IS NULL")[0].c, 0, 'không có tin chung source_id NULL');
  assert.match(src, /if \(!sourceId && !submittedBy\) \{ console\.log\("upsert: bỏ tin chung thiếu source_id"\); continue; \}/, 'guard trong planUpsertJobs');
  console.log('enduser #10 source_id guard OK');

  // #4: lọc phủ cả tin ngoài 300 mới nhất, trước và sau backfill
  const ids = (b) => (Array.isArray(b) ? b : b.items).map((x) => x.id);
  // Trước backfill: hành vi như cũ (300 tin mới nhất), không lỗi. Đây là trần đã ghi trong PR: phải chạy backfill.
  assert.deepStrictEqual(ids((await call('GET', '/api/jobs?mode=remote', null, 'tokA')).body), [], 'chưa backfill = như cũ');
  // backfill: dry_run không ghi; chạy thật ghi hết
  const OWNER = src.match(/OWNER_EMAIL = "([^"]+)"/)[1];
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('own', ?, 'O', ?)").run(OWNER, T); kv.set('session:own', 'own');
  assert.strictEqual((await call('POST', '/api/admin/backfill/derived', {}, 'tokA')).status, 403, 'chỉ owner');
  r = await call('POST', '/api/admin/backfill/derived', { limit: 500, dry_run: true }, 'own');
  assert.ok(r.body.dry_run && r.body.rows > 300 && /UPDATE jobs SET salary_vnd_min = 40000000, salary_vnd_max = 50000000/.test(r.body.sql));
  assert.strictEqual(q("SELECT COUNT(*) c FROM jobs WHERE derived_at IS NOT NULL")[0].c, 1, 'dry_run không ghi (chỉ tin dán tay mới có)');
  queries = 0;
  r = await call('POST', '/api/admin/backfill/derived', { limit: 500 }, 'own');
  assert.strictEqual(r.body.remaining, 0); assert.ok(queries <= 6, 'backfill ' + queries + ' truy vấn');
  assert.deepStrictEqual(q("SELECT salary_vnd_max m, work_mode w FROM jobs WHERE id = 'old-jd-sal'")[0], { m: 50e6, w: 'onsite' });
  assert.deepStrictEqual(ids((await call('GET', '/api/jobs?mode=remote', null, 'tokA')).body), ['old-remote'], 'sau backfill: SQL lọc');
  assert.deepStrictEqual(ids((await call('GET', '/api/jobs?min_salary=45&has_salary=1', null, 'tokA')).body).sort(), ['old-jd-sal', 'old-remote']);
  assert.deepStrictEqual(ids((await call('GET', '/api/jobs?q=manual', null, 'tokA')).body).length, 1, 'q lọc SQL');
  console.log('enduser #4 filters over all jobs + #6 backfill OK');

  // #5 sort
  r = await call('GET', '/api/jobs?sort=salary&limit=2', null, 'tokA');
  assert.deepStrictEqual(r.body.items.map((x) => x.id), ['old-remote', 'old-jd-sal'], 'sort=salary');
  kv.set('session:tokB2', 'B|' + Date.now());
  r = await call('GET', '/api/jobs?sort=new&limit=2', null, 'tokB2');
  assert.deepStrictEqual(r.body.items.map((x) => x.id), ['n0', 'n1']);
  assert.strictEqual((await call('GET', '/api/jobs?sort=bad', null, 'tokA')).status, 400);
  assert.deepStrictEqual(ids((await call('GET', '/api/jobs?limit=3', null, 'tokA')).body), ids((await call('GET', '/api/jobs?sort=score&limit=3', null, 'tokA')).body), 'mặc định = score');
  console.log('enduser #5 sort OK');

  // #7 enrich: tin ITviec chưa thử bao giờ (enriched_at NULL) đi trước, kể cả khi đã có JD; ghi logo/địa chỉ + lương từ JD
  calls.length = 0;
  r = await call('POST', '/api/admin/jd/enrich', { limit: 3 }, 'own');
  assert.strictEqual(r.body.done, 3);
  assert.strictEqual(q("SELECT COUNT(*) c FROM jobs WHERE enriched_at IS NOT NULL AND address = '1 Le Loi, HCM' AND salary_vnd_max = 35000000")[0].c, 3);
  r = await call('POST', '/api/admin/jd/enrich', { limit: 3 }, 'own');
  assert.strictEqual(q("SELECT COUNT(*) c FROM jobs WHERE enriched_at IS NOT NULL")[0].c, 6, 'lượt 2 lấy tin khác, không lặp');
  console.log('enduser #7 enrich order OK');

  // #8 geocode trong cron: ≤ GEOCODE_PER_RUN, UA JobPilot/1.0, chỉ gửi địa chỉ; trượt → geocoded_at=0; lat/lng trên list
  db.prepare("UPDATE jobs SET address = 'Nowhere 1' WHERE id = 'n5'").run();
  db.prepare("UPDATE jobs SET first_seen_at = ? WHERE id = 'n5'").run(T + 5);
  calls.length = 0;
  await worker.scheduled({ cron: '*/30 * * * *' }, env, {});
  const geo = calls.filter((c) => c.u.startsWith('https://nominatim'));
  assert.strictEqual(geo.length, 2); assert.ok(geo.every((c) => c.headers['user-agent'] === 'JobPilot/1.0'));
  assert.deepStrictEqual(q("SELECT geocoded_at g, lat FROM jobs WHERE id = 'n5'")[0], { g: 0, lat: null }, 'trượt → 0');
  const hit = q("SELECT id, lat, lng FROM jobs WHERE geocoded_at > 0");
  assert.strictEqual(hit.length, 1);
  r = await call('GET', '/api/jobs?sort=new&limit=100', null, 'tokA');
  const it = r.body.items.find((x) => x.id === hit[0].id);
  assert.deepStrictEqual([it.lat, it.lng], [10.776, 106.7]); assert.ok('lat' in r.body.items[0]);
  console.log('enduser #8 geocode OK');

  // #9 public job: không cần đăng nhập, chỉ trường công khai, tin dán tay → 404, có cache
  r = await call('GET', '/api/public/job/old-remote');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['company', 'location', 'logo', 'salary_text', 'skills', 'source_url', 'title', 'work_mode']);
  assert.strictEqual(r.body.work_mode, 'remote'); assert.match(r.headers.get('cache-control'), /public, max-age=\d+/);
  assert.strictEqual((await call('GET', '/api/public/job/mine')).status, 404, 'tin dán tay riêng tư');
  assert.strictEqual((await call('GET', '/api/public/job/nope')).status, 404);
  console.log('enduser #9 public job OK');

  // JSON-LD trong enrich: TopDev chưa có lương, đã có JD → vẫn tải trang chi tiết 1 lần; JSON-LD (17-23tr) thắng JD (25-35tr)
  db.prepare("INSERT OR IGNORE INTO sources (id, type, name, created_at) VALUES ('src-topdev', 'topdev', 'TopDev', ?)").run(T);
  ins('td-ld', { src: 'src-topdev', url: 'https://topdev.vn/detail-jobs/x-2145696', seen: T + 1000, jd: 'Mức lương: 25 - 35 triệu. Golang.' });
  calls.length = 0;
  await call('POST', '/api/admin/jd/enrich', { limit: 1 }, 'own');
  assert.strictEqual(calls.filter((c) => c.u.includes('topdev.vn')).length, 1, '1 fetch trang chi tiết');
  assert.deepStrictEqual(q("SELECT salary_text s, salary_vnd_min a, salary_vnd_max b FROM jobs WHERE id = 'td-ld'")[0], { s: '17 - 23 triệu', a: 17e6, b: 23e6 });
  // lương sẵn có từ trang danh sách không bị ghi đè
  db.prepare("UPDATE jobs SET salary_text = '$3000 - $4000/month', enriched_at = NULL, first_seen_at = ? WHERE id = 'n7'").run(T + 2000);
  await call('POST', '/api/admin/jd/enrich', { limit: 1 }, 'own');
  assert.strictEqual(q("SELECT salary_text s FROM jobs WHERE id = 'n7'")[0].s, '$3000 - $4000/month');
  console.log('enduser JSON-LD salary in enrich OK');

  // Mailjet: ưu tiên khi đủ khoá, basic auth, mail_enabled khi chỉ có Mailjet; Mailjet lỗi → Resend
  const envMJ = { ...env, MAILJET_API_KEY: 'pub', MAILJET_SECRET_KEY: 'sec', MAIL_FROM: 'JobPilot <me@gmail.test>' };
  assert.strictEqual((await call('GET', '/api/me', null, 'tokA', envMJ)).body.user.mail_enabled, true);
  calls.length = 0;
  await call('POST', '/api/auth/forgot', { email: 'b@x.test' }, null, { ...envMJ, RESEND_API_KEY: 'k' }, { 'cf-connecting-ip': '7.7.7.7' });
  const mj = calls.filter((c) => c.u === 'https://api.mailjet.com/v3.1/send');
  assert.strictEqual(mj.length, 1); assert.ok(!calls.some((c) => c.u.startsWith('https://api.resend.com')), 'không gửi trùng qua Resend');
  assert.strictEqual(mj[0].headers.authorization, 'Basic ' + Buffer.from('pub:sec').toString('base64'));
  const msg = JSON.parse(mj[0].body).Messages[0];
  assert.deepStrictEqual([msg.From, msg.To, /\?reset=[\w-]+/.test(msg.TextPart)], [{ Email: 'me@gmail.test', Name: 'JobPilot' }, [{ Email: 'b@x.test' }], true]);
  const f0 = globalThis.fetch; calls.length = 0;
  globalThis.fetch = async (u, init) => (String(u).startsWith('https://api.mailjet.com') ? (calls.push({ u: String(u) }), new Response('{}', { status: 401 })) : f0(u, init));
  kv.set('session:tokC', 'C'); db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('C', 'c@x.test', 'C', ?)").run(T);
  assert.deepStrictEqual((await call('POST', '/api/me/verify-email/send', {}, 'tokC', { ...envMJ, RESEND_API_KEY: 'k' })).body, { ok: true, sent: true }, 'Mailjet 401 → Resend');
  assert.deepStrictEqual(calls.map((c) => c.u.slice(0, 22)), ['https://api.mailjet.co', 'https://api.resend.com']);
  globalThis.fetch = f0;
  console.log('enduser Mailjet OK');

  // "Thử ngay": nhận đủ khu vực của web
  for (const l of ['Cần Thơ', 'Hải Phòng', 'Bình Dương', 'Đồng Nai', 'Khác', 'Hồ Chí Minh', 'Remote'])
    assert.strictEqual((await call('GET', '/api/public/try?skills=Java,Spring%20Boot,Docker&location=' + encodeURIComponent(l))).status, 200, l);
  assert.strictEqual((await call('GET', '/api/public/try?skills=Java&location=Mars')).status, 400);
  let web = null;
  try { web = require('child_process').execSync('git show origin/feat/enduser-web:apps/web/public/index.html', { cwd: path.dirname(workerPath), stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (_) {}
  if (web) {
    const pre = JSON.parse(web.match(/AREA_PRESETS = (\[[^\]]*\])/)[1]), TL = JSON.parse(src.match(/TRY_LOCATIONS = (\[[^\]]*\])/)[1]);
    assert.deepStrictEqual(pre.filter((x) => !TL.includes(x)), [], 'AREA_PRESETS của web có khu vực API chưa nhận');
  }
  console.log('enduser try locations OK' + (web ? ' (khớp AREA_PRESETS PR #15)' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
