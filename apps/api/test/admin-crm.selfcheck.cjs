// SPEC 12/11 §3D: endpoint admin CRM. Non-owner 403 ở mọi route, không lộ hash/salt/token/CV, phân trang cursor đúng (không trùng/sót),
// limit ≤ 50, admin_note ≤ 2000 và không đổi stage, admin_note không lộ ra route người dùng, ≤ 2 query D1 mỗi route.
// Chạy: node apps/api/test/admin-crm.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let queries = 0;
const exec = (sql, args) => { queries++; const st = db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map([['session:tokO', 'own'], ['session:tokU', 'u0'], ['quota:ai:2026-11-12', '7']]);
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => l.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); },
    list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) },
  FILES: { list: async () => ({ delimitedPrefixes: ['backups/2026-11-11/', 'backups/2026-11-12/'], objects: [] }),
    get: async (k) => (k === 'backups/2026-11-12/manifest.json' ? { json: async () => ({ tables: { users: 3 } }) } : null) },
  Q_SCORE: { send: async () => {} },
  USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
};
const T = Math.floor(Date.now() / 1000), today = Math.floor(T / 86400);
const SECRETS = ['HASH-SECRET', 'SALT-SECRET', 'TG-CHAT-SECRET', 'LINKCODE-SECRET', 'BOT-TOKEN-SECRET', 'cv/u0/secret.pdf'];
db.prepare("INSERT INTO users (id, email, name, created_at, last_active_day) VALUES ('own', 'tribui.it.work@gmail.com', 'Owner', ?, ?)").run(T - 999, today);
// 7 user cùng created_at với 1 user khác để thử tie-break theo id khi phân trang
for (let i = 0; i < 7; i++) db.prepare("INSERT INTO users (id, email, name, created_at, last_active_day, password_hash, password_salt, telegram_chat_id, telegram_link_code) VALUES (?, ?, ?, ?, ?, 'HASH-SECRET', 'SALT-SECRET', ?, 'LINKCODE-SECRET')")
  .run('u' + i, `user${i}@x.test`, 'User ' + i, i < 3 ? T - 100 : T - i, today, i === 0 ? 'TG-CHAT-SECRET' : null);
db.prepare("INSERT INTO user_bots (user_id, username, token_enc, status, created_at) VALUES ('u0', 'b', 'BOT-TOKEN-SECRET', 'ok', ?)").run(T);
db.prepare("INSERT INTO files (id, user_id, r2_key, kind, filename, size_bytes, created_at) VALUES ('f0', 'u0', 'cv/u0/secret.pdf', 'cv', 'cv.pdf', 1, ?)").run(T);
db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, cv_file_id, created_at, updated_at) VALUES ('p0', 'u0', 'Backend', 'middle', '[\"HCM\"]', 'f0', ?, ?)").run(T, T);
db.prepare("INSERT INTO profile_skills (profile_id, skill, weight) VALUES ('p0', 'Java', 5), ('p0', 'Kafka', 3)").run();
db.prepare("INSERT INTO sources (id, type, name, created_at, last_status, last_error) VALUES ('src-itviec', 'itviec', 'ITviec', ?, 'error', 'HTTP 503')").run(T);
for (let i = 0; i < 5; i++) db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, location, skills, content_hash, first_seen_at, last_seen_at, created_at, repost_count) VALUES (?, 'src-itviec', ?, ?, 'Acme_Co', 'Ho Chi Minh', ?, ?, ?, ?, ?, ?)")
  .run('j' + i, 'https://itviec.com/it-jobs/j' + i, 'Java Dev ' + i, i === 4 ? 'not json' : '["Java"]', 'h' + i, T - i * 3600, T, T, i === 1 ? 2 : 0);
db.prepare("INSERT INTO job_matches (job_id, profile_id, tier, final_score, scored_at) VALUES ('j0', 'p0', 'strong', 90, ?)").run(T);
const stages = ['applied', 'saved', 'interview', 'applied', 'new'];
for (let i = 0; i < 5; i++) db.prepare("INSERT INTO applications (id, profile_id, job_id, stage, note, applied_at, created_at, updated_at) VALUES (?, 'p0', ?, ?, 'user note', ?, ?, ?)")
  .run('a' + i, 'j' + i, stages[i], stages[i] === 'applied' ? T - 3600 : null, T, i < 2 ? T - 50 : T - i * 10);
db.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) VALUES ('e1', 'a0', 'created', '{}', ?), ('e2', 'a0', 'stage_changed', '{\"to\":\"applied\"}', ?), ('e3', 'a0', 'note', 'bad json', ?)").run(T - 30, T - 20, T - 10);
db.prepare("INSERT INTO interviews (id, application_id, kind, round_label, scheduled_at, result, created_at) VALUES ('i1', 'a2', 'technical', 'Tech 1', ?, 'pass', ?), ('i2', 'a2', 'hr', 'HR', ?, 'pending', ?)").run(T - 86400, T, T + 86400, T);

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-admin-crm-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const logs = []; const log0 = console.log; console.log = (...a) => logs.push(a.join(' '));
  const call = async (tok, method, p, body) => {
    const q0 = queries;
    const r = await worker.fetch(new Request('https://api.test' + p, { method, headers: { ...(tok && { Authorization: `Bearer ${tok}` }), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text), q: queries - q0 };
  };
  // auth/me ăn 1 query (session → user); route admin được thêm tối đa 2.
  const base = (await call('tokO', 'GET', '/api/admin/quota')).q; // quota chỉ đọc KV
  const ROUTES = [['GET', '/api/admin/overview'], ['GET', '/api/admin/applications'], ['GET', '/api/admin/applications/a0'], ['GET', '/api/admin/users'],
    ['GET', '/api/admin/users/u0'], ['GET', '/api/admin/jobs'], ['PATCH', '/api/admin/applications/a0', { admin_note: 'x' }]];

  // 1. non-owner 403, chưa đăng nhập 401, DB không đổi
  for (const [m, p, b] of ROUTES) {
    assert.strictEqual((await call('tokU', m, p, b)).status, 403, 'non-owner ' + m + ' ' + p);
    assert.strictEqual((await call(null, m, p, b)).status, 401, 'anon ' + p);
  }
  assert.strictEqual(db.prepare("SELECT admin_note FROM applications WHERE id = 'a0'").get().admin_note, null, '403 không ghi');

  // 2. owner: 200, ≤ 2 query D1 ngoài auth, không lộ bí mật, có log soát
  const res = {};
  for (const [m, p, b] of ROUTES.slice(0, 6)) {
    logs.length = 0;
    const r = await call('tokO', m, p, b);
    assert.strictEqual(r.status, 200, p + ' ' + r.text);
    assert.ok(r.q - base <= 2, `${p}: ${r.q - base} query admin (> 2)`);
    for (const s of SECRETS) assert.ok(!r.text.includes(s), `${p} lộ ${s}`);
    for (const k of ['password_hash', 'password_salt', 'telegram_chat_id', 'telegram_link_code', 'token_enc', 'r2_key', 'cv_file_id', 'jd_head'])
      assert.ok(!r.text.includes(`"${k}"`), `${p} có field ${k}`);
    assert.ok(logs.includes('admin ' + p), 'log admin ' + p);
    res[p] = r.body;
  }
  const ov = res['/api/admin/overview'];
  assert.deepStrictEqual([ov.users_total, ov.users_7d, ov.active_7d, ov.applied_7d, ov.interviews_upcoming, ov.jobs_total, ov.jobs_24h], [8, 8, 8, 2, 1, 5, 5]);
  assert.deepStrictEqual(ov.applications_by_stage, { new: 1, saved: 1, applied: 2, interview: 1, offer: 0, rejected: 0, archived: 0 });
  assert.deepStrictEqual(ov.quota, { 'quota:ai:2026-11-12': '7' });
  assert.deepStrictEqual(ov.backups_last, { date: '2026-11-12', tables: { users: 3 } });
  assert.strictEqual(ov.sources[0].last_error, 'HTTP 503');
  assert.strictEqual(ov.recent_events.length, 3); assert.strictEqual(ov.recent_events[0].id, 'e3'); assert.strictEqual(ov.recent_events[0].user_email, 'user0@x.test');

  const app = res['/api/admin/applications'].items.find((x) => x.id === 'a2');
  assert.deepStrictEqual(app.rounds, { done: 1, total: 2 });
  assert.deepStrictEqual(Object.keys(app.job).sort(), ['company', 'company_logo_url', 'id', 'location', 'source', 'source_url', 'title', 'work_mode']);
  assert.deepStrictEqual(app.user, { id: 'u0', email: 'user0@x.test', name: 'User 0' });
  const a0 = res['/api/admin/applications'].items.find((x) => x.id === 'a0');
  assert.deepStrictEqual([a0.events_count, a0.last_event], [3, { type: 'note', created_at: T - 10 }]);
  const det = res['/api/admin/applications/a0'];
  assert.deepStrictEqual(det.events.map((e) => [e.id, e.payload]), [['e1', {}], ['e2', { to: 'applied' }], ['e3', null]], 'payload hỏng → null, không 500');
  assert.deepStrictEqual((await call('tokO', 'GET', '/api/admin/applications/a2')).body.interviews.map((i) => i.id), ['i1', 'i2']);
  const ud = res['/api/admin/users/u0'];
  assert.deepStrictEqual([ud.telegram_linked, ud.profiles[0].has_cv, ud.profiles[0].locations, ud.profiles[0].skills.length, ud.applications.length, ud.events.length], [true, true, ['HCM'], 2, 5, 3]);
  const u0 = res['/api/admin/users'].items.find((x) => x.id === 'u0');
  assert.deepStrictEqual([u0.profiles_count, u0.skills_count, u0.applications_count, u0.applied_count, u0.telegram_linked], [1, 2, 5, 2, true]);
  const j0 = res['/api/admin/jobs'].items.find((x) => x.id === 'j0');
  assert.deepStrictEqual([j0.applications_count, j0.strong_count, j0.work_mode], [1, 1, 'onsite']);
  assert.ok(res['/api/admin/jobs'].items.find((x) => x.id === 'j1').flags.includes('reposted'));

  // 3. phân trang cursor: duyệt hết = đúng tập, không trùng, thứ tự giảm dần; limit kẹp 50; cursor bậy → 400
  const walk = async (p, key, limit) => {
    const seen = []; let cur = null, n = 0;
    do {
      const r = await call('tokO', 'GET', `${p}${p.includes('?') ? '&' : '?'}limit=${limit}${cur ? '&cursor=' + encodeURIComponent(cur) : ''}`);
      assert.strictEqual(r.status, 200, r.text); assert.ok(r.body.items.length <= limit);
      seen.push(...r.body.items); cur = r.body.next_cursor; n++;
      assert.ok(n < 20, 'cursor lặp vô hạn');
    } while (cur);
    const ids = seen.map((x) => x.id);
    assert.strictEqual(new Set(ids).size, ids.length, p + ' trùng hàng giữa các trang');
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1][key] > seen[i][key] || (seen[i - 1][key] === seen[i][key] && seen[i - 1].id > seen[i].id), p + ' sai thứ tự');
    return ids;
  };
  assert.deepStrictEqual((await walk('/api/admin/users', 'created_at', 2)).sort(), ['own', 'u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.deepStrictEqual((await walk('/api/admin/applications', 'updated_at', 2)).sort(), ['a0', 'a1', 'a2', 'a3', 'a4']);
  assert.deepStrictEqual((await walk('/api/admin/jobs', 'first_seen_at', 3)).sort(), ['j0', 'j1', 'j2', 'j3', 'j4']);
  const r1 = await call('tokO', 'GET', '/api/admin/users?limit=1');
  assert.deepStrictEqual([r1.body.items.length, r1.body.total, typeof r1.body.next_cursor], [1, 8, 'string']);
  for (let i = 0; i < 60; i++) db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'B', ?)").run('bulk' + i, `bulk${i}@x.test`, T - 5000);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/users?limit=999')).body.items.length, 50, 'limit kẹp 50');
  for (const c of ['abc', "1:a' OR 1=1", '1:' + 'x'.repeat(65)]) assert.strictEqual((await call('tokO', 'GET', '/api/admin/users?cursor=' + encodeURIComponent(c))).status, 400, 'cursor bậy ' + c);

  // 4. lọc stage/status/q (LIKE escape: "_" là chữ thường, không phải wildcard)
  assert.deepStrictEqual((await call('tokO', 'GET', '/api/admin/applications?stage=applied')).body.items.map((x) => x.id).sort(), ['a0', 'a3']);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/applications?status=interview')).body.total, 1);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/applications?stage=bogus')).status, 400);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/applications?q=Dev%203')).body.total, 1);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/jobs?q=Acme_Co')).body.total, 5);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/jobs?q=Acme%25')).body.total, 0, '% là chữ, không wildcard');
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/users?q=user3')).body.items[0].id, 'u3');
  assert.deepStrictEqual((await call('tokO', 'GET', '/api/admin/jobs?flag=reposted')).body.items.map((x) => x.id), ['j1']);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/jobs?flag=nope')).status, 400);

  // 5. PATCH admin_note: ≤ 2000, kiểu sai 400, không đổi stage/updated_at, null xoá, 404
  const before = { ...db.prepare("SELECT stage, updated_at FROM applications WHERE id = 'a0'").get() };
  assert.strictEqual((await call('tokO', 'PATCH', '/api/admin/applications/a0', { admin_note: 'x'.repeat(2001) })).status, 400);
  assert.strictEqual((await call('tokO', 'PATCH', '/api/admin/applications/a0', { admin_note: 5 })).status, 400);
  assert.strictEqual((await call('tokO', 'PATCH', '/api/admin/applications/a0', {})).status, 400);
  const ok = await call('tokO', 'PATCH', '/api/admin/applications/a0', { admin_note: 'n'.repeat(2000), stage: 'rejected' });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.admin_note.length, 2000);
  assert.ok(ok.q - base <= 2);
  assert.deepStrictEqual({ ...db.prepare("SELECT stage, updated_at FROM applications WHERE id = 'a0'").get() }, before, 'không đổi stage/updated_at');
  assert.strictEqual((await call('tokO', 'PATCH', '/api/admin/applications/nope', { admin_note: 'x' })).status, 404);
  assert.strictEqual((await call('tokO', 'GET', '/api/admin/users/nope')).status, 404);

  // 6. admin_note không lộ ra route người dùng
  kv.set('session:tokP', 'u0');
  const leak = [await call('tokP', 'GET', '/api/applications?profile_id=p0'), await call('tokP', 'PATCH', '/api/applications/a0', { note: 'u' }),
    await call('tokP', 'POST', '/api/applications/quick', { profile_id: 'p0', job_id: 'j0', action: 'open' })];
  for (const r of leak) { assert.strictEqual(r.status, 200, r.text); assert.ok(!r.text.includes('admin_note') && !r.text.includes('nnnn'), 'lộ admin_note: ' + r.text.slice(0, 200)); }
  const exp = await worker.fetch(new Request('https://api.test/api/me/export', { headers: { Authorization: 'Bearer tokP' } }), env, {});
  assert.ok(!(await exp.text()).includes('admin_note'), 'export lộ admin_note');
  assert.strictEqual((await call('tokO', 'PATCH', '/api/admin/applications/a0', { admin_note: null })).body.admin_note, null);

  console.log = log0;
  console.log('admin-crm selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
