// Thông báo trong app (0014): ghi lỗi không chặn/không nhân đôi Telegram, read chỉ đổi dòng của mình, digest rỗng không chèn,
// bot_broken không trùng khi chưa đọc, hợp đồng /api/me + /api/notifications, CORS đủ phương thức.
// Chạy worker.js thật trên SQLite RAM (đủ migration), Telegram giả. Chạy: node apps/api/test/notifications.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const src = fs.readFileSync(workerPath, 'utf8').replace(/\r\n/g, '\n');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
let failOn = null; // regex: câu SQL khớp sẽ ném lỗi (giả lập ghi thông báo hỏng)
const exec = (sql, args) => {
  if (failOn && failOn.test(sql)) throw new Error('D1 giả: ghi lỗi');
  const st = db.prepare(sql);
  return /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...args) : (st.run(...args), []);
};
const stmt = (sql, args = []) => ({
  sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true, meta: {} }),
});
const kv = new Map();
const KEY = Buffer.alloc(32, 7).toString('base64');
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => { db.exec('BEGIN'); try { const r = list.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  TELEGRAM_API_BASE: 'https://tg.test', TELEGRAM_BOT_TOKEN: 'SHARED', TELEGRAM_QUIET_OVERRIDE: '1', TG_TOKEN_KEY: KEY,
};
const T = Math.floor(Date.now() / 1000);
for (const u of ['u1', 'u2', 'u3']) {
  db.prepare("INSERT INTO users (id, email, name, created_at, telegram_chat_id) VALUES (?, ?, 'U', ?, ?)").run(u, u + '@x.test', T, 'chat-' + u);
  kv.set('session:s-' + u, u + '|' + Date.now());
  db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, is_active, created_at, updated_at) VALUES (?, ?, 'P', 'middle', '[\"Remote\"]', 1, ?, ?)").run('p-' + u, u, T, T);
  for (const [s, w] of [['Java', 5], ['Spring Boot', 5], ['PostgreSQL', 3]]) db.prepare('INSERT INTO profile_skills (profile_id, skill, weight) VALUES (?, ?, ?)').run('p-' + u, s, w);
}
const addJob = (id) => db.prepare("INSERT INTO jobs (id, source_url, title, company, location, skills, content_hash, posted_at, first_seen_at, created_at) VALUES (?, ?, 'Backend Developer', 'Co', 'Remote (Worldwide)', '[\"Java\",\"Spring Boot\",\"PostgreSQL\"]', ?, ?, ?, ?)").run(id, 'https://x/' + id, 'h' + id, T, T, T);

const sends = [], revoked = new Set();
globalThis.fetch = async (u, init = {}) => {
  const m = String(u).match(/^https:\/\/tg\.test\/bot([^/]+)\/(\w+)$/);
  assert(m, 'gọi ngoài Telegram giả: ' + u);
  const body = init.body ? JSON.parse(init.body) : {};
  if (m[2] === 'sendMessage') sends.push({ token: m[1], chat: body.chat_id });
  if (revoked.has(m[1])) return new Response('{"ok":false}', { status: 401 });
  return Response.json({ ok: true });
};
const q = (sql, ...a) => db.prepare(sql).all(...a);

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-notif-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (method, p, user, body) => {
    const h = { 'content-type': 'application/json', authorization: 'Bearer s-' + user };
    const r = await worker.fetch(new Request('https://api.jp.test' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
    return { status: r.status, body: await r.json() };
  };
  const score = (jobId) => worker.queue({ queue: 'jobpilot-score', messages: [{ body: { kind: 'score', jobId } }], ackAll() {}, retryAll() { throw new Error('retryAll: Telegram sẽ gửi trùng'); } }, env, {});
  const digest = (u) => worker.queue({ queue: 'jobpilot-notify', messages: [{ body: { kind: 'digest', userId: u }, ack() {}, retry() { throw new Error('retry: Telegram sẽ gửi trùng'); } }] }, env, {});

  // 1. burst: ghi tg_status hỏng → Telegram vẫn gửi đúng 1 lần mỗi người, không retry; dòng strong_match vẫn có.
  addJob('j1');
  failOn = /tg_status/;
  await score('j1');
  failOn = null;
  assert.strictEqual(sends.length, 3, 'mỗi người đúng 1 tin');
  assert.strictEqual(q("SELECT COUNT(*) c FROM notifications WHERE type = 'strong_match' AND tg_status IS NULL")[0].c, 3);
  // burst bình thường → tg_status = sent (u1 dùng bot chung; xoá tgburst để gửi lại cho tin mới)
  kv.clear(); for (const u of ['u1', 'u2', 'u3']) kv.set('session:s-' + u, u + '|' + Date.now());
  addJob('j2');
  await score('j2');
  assert.strictEqual(sends.length, 6);
  assert.deepStrictEqual(q("SELECT DISTINCT tg_status s FROM notifications WHERE ref_id = 'j2'").map((r) => r.s), ['sent']);
  assert(q("SELECT tg_at FROM notifications WHERE ref_id = 'j2'").every((r) => r.tg_at >= T));

  // 2. digest: ghi hỏng → vẫn gửi 1 lần, không retry; ghi được → 1 dòng digest chưa đọc, digest cũ thành đã đọc.
  failOn = /'digest'/;
  await digest('u1');
  failOn = null;
  assert.strictEqual(sends.length, 7);
  assert.strictEqual(q("SELECT COUNT(*) c FROM notifications WHERE type = 'digest'")[0].c, 0);
  await digest('u1'); await digest('u1');
  const dg = q("SELECT * FROM notifications WHERE user_id = 'u1' AND type = 'digest' ORDER BY is_read");
  assert.strictEqual(dg.length, 2);
  assert.deepStrictEqual(dg.map((r) => r.is_read), [0, 1], 'chỉ bản mới nhất chưa đọc');
  assert(/^Bản tin sáng: \d+ tin khớp$/.test(dg[0].title) && dg[0].ref_id === null && dg[0].tg_status === 'sent', dg[0].title);
  // digest rỗng (không hồ sơ đang bật) → không chèn
  db.prepare("UPDATE profiles SET is_active = 0 WHERE user_id = 'u3'").run();
  await digest('u3');
  assert.strictEqual(q("SELECT COUNT(*) c FROM notifications WHERE user_id = 'u3' AND type = 'digest'")[0].c, 0, 'digest rỗng không chèn');

  // 3. bot_broken: token bị thu hồi 2 lần → 1 dòng; đọc rồi hỏng lại → dòng mới.
  const enc = await (new Function(src.slice(src.indexOf('const TG_TOKEN_RE'), src.indexOf('// Thông báo trong app')) + '\nreturn tgEncrypt;')())(env, 'BOT2', 'u2');
  db.prepare("INSERT INTO user_bots (user_id, bot_id, username, token_enc, webhook_secret, status, created_at) VALUES ('u2', '2', 'u2_bot', ?, 's', 'ok', ?)").run(enc, T);
  revoked.add('BOT2');
  const brk = () => q("SELECT * FROM notifications WHERE user_id = 'u2' AND type = 'bot_broken' ORDER BY created_at");
  await digest('u2');
  db.prepare("UPDATE user_bots SET status = 'ok' WHERE user_id = 'u2'").run();
  await digest('u2');
  assert.strictEqual(brk().length, 1, 'bot_broken không trùng khi chưa đọc');
  assert.deepStrictEqual([brk()[0].title, brk()[0].body], ['Bot @u2_bot ngừng hoạt động', 'token_revoked']);
  let me = (await call('GET', '/api/me', 'u2')).body.user;
  assert.strictEqual(me.has_attention, true);
  assert((await call('POST', '/api/notifications/read', 'u2', { ids: [brk()[0].id] })).body.ok);
  assert.strictEqual((await call('GET', '/api/me', 'u2')).body.user.has_attention, false);
  db.prepare("UPDATE user_bots SET status = 'ok' WHERE user_id = 'u2'").run();
  await digest('u2');
  assert.strictEqual(brk().length, 2, 'đã đọc thì lần hỏng sau chèn mới');
  // giải mã lỗi (key_changed) cũng chèn, vẫn không gửi gì
  db.prepare("DELETE FROM notifications WHERE type = 'bot_broken'").run();
  db.prepare("UPDATE user_bots SET status = 'ok', token_enc = 'AAAAAAAAAAAAAAAAAAAAAAAA' WHERE user_id = 'u2'").run();
  const before = sends.length;
  await digest('u2');
  assert.strictEqual(sends.length, before);
  assert.deepStrictEqual(brk().map((r) => r.body), ['key_changed']);

  // 4. /api/me: unread_count chặn ở 10, jobs_seen_at
  db.prepare("DELETE FROM notifications WHERE user_id = 'u3'").run();
  for (let i = 0; i < 12; i++) db.prepare("INSERT INTO notifications (id, user_id, type, title, created_at) VALUES (?, 'u3', 'strong_match', 't', ?)").run('n3-' + i, T - 100 + i);
  me = (await call('GET', '/api/me', 'u3')).body.user;
  assert.deepStrictEqual([me.unread_count, me.has_attention, me.jobs_seen_at], [10, false, null]);

  // 5. read: chỉ đổi dòng của chính user
  const u1ids = q("SELECT id FROM notifications WHERE user_id = 'u1'").map((r) => r.id);
  const r1 = await call('POST', '/api/notifications/read', 'u3', { ids: [...u1ids, 'n3-0'] });
  assert.deepStrictEqual(r1, { status: 200, body: { ok: true, unread_count: 10 } });
  assert.strictEqual(q("SELECT is_read FROM notifications WHERE id = 'n3-0'")[0].is_read, 1);
  assert(q(`SELECT is_read FROM notifications WHERE user_id = 'u1' AND type = 'strong_match'`).every((r) => r.is_read === 0), 'không đụng dòng của người khác');
  assert.deepStrictEqual((await call('POST', '/api/notifications/read', 'u3', { all: true })).body, { ok: true, unread_count: 0 });
  assert(q("SELECT is_read FROM notifications WHERE user_id = 'u1' AND type = 'strong_match'").every((r) => r.is_read === 0));
  for (const bad of [{}, { ids: [] }, { ids: [1] }, { ids: Array(51).fill('x') }, { all: 1 }, { ids: 'x' }, null])
    assert.deepStrictEqual(await call('POST', '/api/notifications/read', 'u3', bad), { status: 400, body: { error: 'invalid_body' } }, JSON.stringify(bad));

  // 6. GET /api/notifications: mặc định như cũ, before/limit/unread, có tg_status/tg_at
  const all3 = (await call('GET', '/api/notifications', 'u3')).body;
  assert.strictEqual(all3.length, 12);
  assert('tg_status' in all3[0] && 'tg_at' in all3[0]);
  const page = (await call('GET', `/api/notifications?before=${T - 95}&limit=3`, 'u3')).body;
  assert.deepStrictEqual(page.map((r) => r.id), ['n3-4', 'n3-3', 'n3-2']);
  db.prepare("UPDATE notifications SET is_read = 0 WHERE id = 'n3-7'").run();
  assert.deepStrictEqual((await call('GET', '/api/notifications?unread=1', 'u3')).body.map((r) => r.id), ['n3-7']);
  for (const p of ['?limit=0', '?limit=51', '?limit=x', '?before=-1', '?before=1.5'])
    assert.strictEqual((await call('GET', '/api/notifications' + p, 'u3')).status, 400, p);

  // 7. PATCH /api/me: jobs_seen do server đặt; ai_opt_out như cũ; không trường nào → 400
  const p1 = await call('PATCH', '/api/me', 'u3', { jobs_seen: true, jobs_seen_at: 1 });
  assert(p1.status === 200 && p1.body.jobs_seen_at >= T && !('ai_opt_out' in p1.body));
  assert.strictEqual((await call('GET', '/api/me', 'u3')).body.user.jobs_seen_at, p1.body.jobs_seen_at);
  assert.deepStrictEqual((await call('PATCH', '/api/me', 'u3', { ai_opt_out: 1 })).body, { ai_opt_out: 1 });
  const p2 = (await call('PATCH', '/api/me', 'u3', { ai_opt_out: 0, jobs_seen: true })).body;
  assert(p2.ai_opt_out === 0 && p2.jobs_seen_at >= T);
  for (const bad of [{}, { jobs_seen: false }, { jobs_seen: 'yes' }, { ai_opt_out: 'x', jobs_seen: true }])
    assert.strictEqual((await call('PATCH', '/api/me', 'u3', bad)).status, 400, JSON.stringify(bad));

  // 8. cron 18h xoá thông báo > 90 ngày (backup lỗi không chặn: R2 thiếu → backupToR2 ném, bỏ qua bước này nên chỉ kiểm câu SQL có mặt)
  assert(/DELETE FROM notifications WHERE created_at < \?"\)\.bind\(now\(\) - 90 \* 86400\)/.test(src));

  // 9. CORS: mọi phương thức route dùng có trong allow-methods
  const allow = src.match(/"access-control-allow-methods": "([^"]+)"/)[1].split(/,\s*/);
  // so sánh trực tiếp + mảng allowed của route bot riêng (PUT chỉ xuất hiện ở đó)
  const used = new Set([...src.matchAll(/request\.method === "([A-Z]+)"/g)].map((m) => m[1])
    .concat([...src.matchAll(/const allowed = [^;]+/g)].flatMap((m) => m[0].match(/"[A-Z]+"/g).map((x) => x.slice(1, -1)))));
  for (const m of used) assert(allow.includes(m), 'CORS thiếu ' + m);
  assert(used.has('PATCH') && used.has('PUT') && used.has('POST') && used.has('DELETE'));

  console.log('notifications selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
