// Bot Telegram riêng từng khách: mã hoá token, API /api/me/telegram/bot, webhook riêng, chọn token khi gửi, 401 → broken.
// Chạy worker.js thật trên SQLite RAM (đủ migration), Telegram giả qua TELEGRAM_API_BASE. Chạy: node apps/api/test/tg-own-bot.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const src = fs.readFileSync(workerPath, 'utf8').replace(/\r\n/g, '\n');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');

// --- hàm thuần: regex + mã hoá vòng tròn, sai AAD phải lỗi ---
const code = src.slice(src.indexOf('const TG_TOKEN_RE'), src.indexOf('// Gửi bằng bot riêng'));
const { TG_TOKEN_RE, tgEncrypt, tgDecrypt, ownBotEnabled } = new Function(code + '\nreturn { TG_TOKEN_RE, tgEncrypt, tgDecrypt, ownBotEnabled };')();
const KEY = Buffer.alloc(32, 7).toString('base64');
const TOK_A = '123456789:' + 'A'.repeat(35), TOK_B = '987654321:' + 'b_-'.repeat(12), TOK_C = '555555555:' + 'C'.repeat(35);
assert(TG_TOKEN_RE.test(TOK_A) && TG_TOKEN_RE.test(TOK_B));
for (const bad of ['12345:' + 'A'.repeat(35), '123456789:short', '123456789:' + 'A'.repeat(34) + '!', 'abc:' + 'A'.repeat(40), ' ' + TOK_A]) assert(!TG_TOKEN_RE.test(bad), bad);
assert(ownBotEnabled({ TG_TOKEN_KEY: KEY }) && !ownBotEnabled({}) && !ownBotEnabled({ TG_TOKEN_KEY: Buffer.alloc(16).toString('base64') }));

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({
  sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true, meta: {} }),
});
const kv = new Map();
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => { db.exec('BEGIN'); try { const r = list.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  TELEGRAM_API_BASE: 'https://tg.test', TELEGRAM_BOT_TOKEN: 'SHARED', TELEGRAM_BOT_USERNAME: 'shared_bot', TELEGRAM_WEBHOOK_SECRET: 'shared-secret',
  TELEGRAM_QUIET_OVERRIDE: '1', TG_TOKEN_KEY: KEY,
};
const T = Math.floor(Date.now() / 1000);
for (const u of ['u1', 'u2']) {
  db.prepare("INSERT INTO users (id, email, name, created_at, telegram_chat_id) VALUES (?, ?, 'U', ?, ?)").run(u, u + '@x.test', T, 'old-' + u);
  kv.set('session:s-' + u, u + '|' + Date.now());
}

// Telegram giả: token hợp lệ = A/B/C; REVOKED = token bị thu hồi (401); C không giữ được webhook.
const calls = [], revoked = new Set(), hooks = {};
globalThis.fetch = async (u, init = {}) => {
  const m = String(u).match(/^https:\/\/tg\.test\/bot([^/]+)\/(\w+)$/);
  assert(m, 'gọi ngoài Telegram giả: ' + u);
  const [, token, method] = m, body = init.body ? JSON.parse(init.body) : {};
  calls.push({ token, method, body });
  const known = { [TOK_A]: 'alice_bot', [TOK_B]: 'bob_bot', [TOK_C]: 'carol_bot', SHARED: 'shared_bot' };
  if (!known[token] || revoked.has(token)) return new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 });
  if (method === 'getMe') return Response.json({ ok: true, result: { username: known[token] } });
  if (method === 'setWebhook') { if (token !== TOK_C) hooks[token] = body.url; return Response.json({ ok: true }); }
  if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: hooks[token] || '', last_error_message: null } });
  if (method === 'deleteWebhook') { delete hooks[token]; return Response.json({ ok: true }); }
  return Response.json({ ok: true });
};

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-tgbot-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const ORIGIN = 'https://api.jp.test';
  const call = async (method, p, { user, body, headers = {}, e = env } = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (user) h.authorization = 'Bearer s-' + user;
    const r = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: body && method !== 'GET' ? JSON.stringify(body) : undefined }), e, {});
    return { status: r.status, body: await r.json() };
  };
  const row = (u) => db.prepare('SELECT * FROM user_bots WHERE user_id = ?').get(u);
  const chatOf = (u) => db.prepare('SELECT telegram_chat_id c FROM users WHERE id = ?').get(u).c;

  // mã hoá vòng tròn, sai AAD lỗi
  const enc = await tgEncrypt(env, TOK_A, 'u1');
  assert.strictEqual(await tgDecrypt(env, enc, 'u1'), TOK_A);
  assert(!enc.includes(TOK_A.split(':')[1]));
  await assert.rejects(() => tgDecrypt(env, enc, 'u2'), 'sai AAD phải lỗi');

  // thiếu khoá → 503
  const noKey = { ...env, TG_TOKEN_KEY: undefined };
  for (const [m, p] of [['GET', '/api/me/telegram/bot'], ['PUT', '/api/me/telegram/bot'], ['POST', '/api/me/telegram/bot/check'], ['DELETE', '/api/me/telegram/bot']])
    assert.deepStrictEqual(await call(m, p, { user: 'u1', e: noKey, body: {} }), { status: 503, body: { error: 'own_bot_disabled' } }, m + p);
  assert.strictEqual((await call('GET', '/api/me/telegram/bot')).status, 401, 'phải đăng nhập');

  // PUT: lỗi định dạng / bị từ chối / webhook không giữ
  assert.deepStrictEqual((await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: 'nope' } })).body, { error: 'invalid_token_format' });
  assert.deepStrictEqual((await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: '111111111:' + 'Z'.repeat(35) } })).body, { error: 'token_rejected' });
  assert.deepStrictEqual(await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: TOK_C } }), { status: 400, body: { error: 'webhook_failed' } });
  assert(!row('u1') && chatOf('u1') === 'old-u1', 'webhook_failed không lưu gì');

  // PUT thành công
  assert.deepStrictEqual(await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: '  ' + TOK_A + ' ' } }), { status: 200, body: { ok: true, bot_username: 'alice_bot' } });
  const r1 = row('u1');
  assert(r1.bot_id === '123456789' && r1.status === 'ok' && /^[0-9a-f]{32}$/.test(r1.webhook_secret) && r1.token_enc !== TOK_A);
  assert.strictEqual(await tgDecrypt(env, r1.token_enc, 'u1'), TOK_A);
  const sw = calls.filter((c) => c.method === 'setWebhook').pop();
  assert.deepStrictEqual(sw.body, { url: ORIGIN + '/api/telegram/webhook/123456789', secret_token: r1.webhook_secret, allowed_updates: ['message'] });
  assert.strictEqual(chatOf('u1'), null, 'chuyển sang bot riêng → phải /start lại');

  // bot của người khác → 409
  assert.deepStrictEqual(await call('PUT', '/api/me/telegram/bot', { user: 'u2', body: { token: TOK_A } }), { status: 409, body: { error: 'bot_in_use' } });

  // GET + /api/me không bao giờ lộ token
  const g = await call('GET', '/api/me/telegram/bot', { user: 'u1' });
  assert.deepStrictEqual({ ...g.body, checked_at: 0 }, { configured: true, bot_username: 'alice_bot', status: 'ok', last_error: null, checked_at: 0 });
  assert.deepStrictEqual((await call('GET', '/api/me/telegram/bot', { user: 'u2' })).body, { configured: false, bot_username: null, status: null, last_error: null, checked_at: null });
  const me = await call('GET', '/api/me', { user: 'u1' });
  assert.deepStrictEqual(me.body.user.telegram_bot, { username: 'alice_bot', status: 'ok' });
  assert.strictEqual((await call('GET', '/api/me', { user: 'u2' })).body.user.telegram_bot, null);
  for (const x of [g, me]) assert(!JSON.stringify(x).includes(TOK_A.split(':')[1]) && !JSON.stringify(x).includes('token_enc'));

  // link: bot riêng ok → deeplink bot riêng (kể cả khi bot chung chưa cấu hình); u2 giữ hành vi cũ
  const noShared = { ...env, TELEGRAM_BOT_USERNAME: '', TELEGRAM_WEBHOOK_SECRET: '' };
  const l1 = await call('POST', '/api/me/telegram/link', { user: 'u1', e: noShared });
  assert(l1.status === 200 && l1.body.bot === 'alice_bot' && l1.body.deeplink === `https://t.me/alice_bot?start=${l1.body.code}`);
  assert.deepStrictEqual(await call('POST', '/api/me/telegram/link', { user: 'u2', e: noShared }), { status: 503, body: { error: 'telegram_not_configured' } });
  const l2 = await call('POST', '/api/me/telegram/link', { user: 'u2' });
  assert.strictEqual(l2.body.bot, 'shared_bot');

  // webhook riêng: sai khoá / bot lạ → 403; mã /start của người khác bị từ chối; mã của chủ bot → gắn, trả lời bằng bot riêng
  const hook = (secret, text, id = '123456789') => call('POST', '/api/telegram/webhook/' + id, { headers: { 'x-telegram-bot-api-secret-token': secret }, body: { message: { chat: { id: 4242 }, text } } });
  assert.strictEqual((await hook('wrong', '/start ' + l1.body.code)).status, 403);
  assert.strictEqual((await hook(r1.webhook_secret, '/start ' + l1.body.code, '999999999')).status, 403);
  assert.strictEqual((await hook(undefined, '/start ' + l1.body.code)).status, 403);
  calls.length = 0;
  assert.strictEqual((await hook(r1.webhook_secret, '/start ' + l2.body.code)).status, 200);
  assert(chatOf('u2') !== '4242' && kv.has('tglink:' + l2.body.code), 'mã của u2 không gắn qua bot của u1');
  assert(calls.length === 1 && calls[0].token === TOK_A && /Mã không đúng/.test(calls[0].body.text));
  calls.length = 0;
  assert.strictEqual((await hook(r1.webhook_secret, '/start ' + l1.body.code)).status, 200);
  assert(chatOf('u1') === '4242' && calls[0].token === TOK_A && /Đã gắn/.test(calls[0].body.text));
  // webhook chung vẫn chạy như cũ, trả lời bằng bot chung
  calls.length = 0;
  assert.strictEqual((await call('POST', '/api/telegram/webhook', { headers: { 'x-telegram-bot-api-secret-token': 'shared-secret' }, body: { message: { chat: { id: 77 }, text: '/start ' + l2.body.code } } })).status, 200);
  assert(chatOf('u2') === '77' && calls[0].token === 'SHARED');
  assert.strictEqual((await call('POST', '/api/telegram/webhook', { headers: { 'x-telegram-bot-api-secret-token': 'x' }, body: {} })).status, 403);

  // chọn token khi gửi digest: u1 bot riêng, u2 bot chung
  db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, is_active, created_at, updated_at) VALUES ('p1', 'u1', 'P', 'middle', '[]', 1, ?, ?), ('p2', 'u2', 'P', 'middle', '[]', 1, ?, ?)").run(T, T, T, T);
  db.prepare("INSERT INTO jobs (id, source_url, title, company, skills, content_hash, first_seen_at, created_at) VALUES ('j', 'https://x/j', 'Dev', 'Co', '[]', 'h', ?, ?)").run(T, T);
  db.prepare("INSERT INTO job_matches (job_id, profile_id, final_score, tier, scored_at) VALUES ('j', 'p1', 90, 'strong', ?), ('j', 'p2', 90, 'strong', ?)").run(T, T);
  const digest = (u) => worker.queue({ queue: 'jobpilot-notify', messages: [{ body: { kind: 'digest', userId: u }, ack() {}, retry() { throw new Error('retry'); } }] }, env, {});
  calls.length = 0;
  await digest('u1'); await digest('u2');
  assert.deepStrictEqual(calls.filter((c) => c.method === 'sendMessage').map((c) => [c.token, c.body.chat_id]), [[TOK_A, '4242'], ['SHARED', '77']]);

  // 401 từ bot riêng → broken/token_revoked; sau đó gửi bằng bot chung
  revoked.add(TOK_A);
  calls.length = 0;
  await digest('u1');
  assert(row('u1').status === 'broken' && row('u1').last_error === 'token_revoked');
  calls.length = 0;
  await digest('u1');
  assert.strictEqual(calls[0].token, 'SHARED', 'broken → dùng bot chung');

  // check: token sống lại → ok; webhook lệch → broken/webhook_mismatch
  revoked.delete(TOK_A);
  const c1 = await call('POST', '/api/me/telegram/bot/check', { user: 'u1' });
  assert(c1.status === 200 && c1.body.status === 'ok' && c1.body.last_error === null && c1.body.checked_at > 0);
  hooks[TOK_A] = 'https://evil.test/x';
  assert.strictEqual((await call('POST', '/api/me/telegram/bot/check', { user: 'u1' })).body.last_error, 'webhook_mismatch');
  assert.deepStrictEqual(await call('POST', '/api/me/telegram/bot/check', { user: 'u2' }), { status: 404, body: { error: 'own_bot_not_configured' } });

  // đổi sang bot khác cùng người → chat_id xoá, bot cũ nhả bot_id
  await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: TOK_B } });
  assert(row('u1').bot_id === '987654321' && row('u1').username === 'bob_bot' && chatOf('u1') === null);

  // DELETE: deleteWebhook bằng token bot riêng, xoá dòng, chat_id = NULL
  db.prepare("UPDATE users SET telegram_chat_id = '4242' WHERE id = 'u1'").run();
  calls.length = 0;
  assert.deepStrictEqual(await call('DELETE', '/api/me/telegram/bot', { user: 'u1' }), { status: 200, body: { ok: true } });
  assert(!row('u1') && chatOf('u1') === null && calls.some((c) => c.method === 'deleteWebhook' && c.token === TOK_B));

  // giới hạn 10 lần/giờ chung PUT + check (đã dùng: u1 7 lần ở trên)
  const used = Number(kv.get(`tgbotrl:u1:${Math.floor(Date.now() / 1000 / 3600)}`));
  for (let i = used; i < 10; i++) assert.notStrictEqual((await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: 'x' } })).status, 429);
  assert.deepStrictEqual(await call('PUT', '/api/me/telegram/bot', { user: 'u1', body: { token: TOK_A } }), { status: 429, body: { error: 'too_many_attempts' } });
  assert.strictEqual((await call('POST', '/api/me/telegram/bot/check', { user: 'u1' })).status, 429);

  // xoá tài khoản xoá user_bots; export + backup không chứa token_enc
  await call('PUT', '/api/me/telegram/bot', { user: 'u2', body: { token: TOK_A } });
  assert(row('u2'));
  assert(!/user_bots/.test(src.slice(src.indexOf('const BACKUP_TABLES'), src.indexOf('const BACKUP_KEEP'))), 'backup không gồm user_bots');
  const exp = await worker.fetch(new Request(ORIGIN + '/api/me/export', { headers: { authorization: 'Bearer s-u2' } }), env, {});
  const expText = await exp.text();
  assert(exp.status === 200 && !expText.includes('token_enc') && !expText.includes(row('u2').token_enc));
  assert(/"DELETE FROM user_bots WHERE user_id = \?1"/.test(src.slice(src.indexOf('async function purgeUser'), src.indexOf('// ---------------- fetchers'))), 'purgeUser xoá user_bots');

  // không log token
  assert(!/console\.(log|error)\([^)]*token\b(?!_)/.test(src.replace(/thiếu TELEGRAM_BOT_TOKEN/g, '').replace(/token bot riêng/g, '')), 'có log token');
  console.log('tg-own-bot selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
