// T-22: đổi / đặt lại mật khẩu + huỷ session cũ (sessions_valid_after). Chạy worker.fetch thật trên SQLite trong RAM.
// Chạy: node apps/api/test/password.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
const stmt = (sql, args = []) => ({
  sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null,
  run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...args).changes } }),
});
const kv = new Map();
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => ({ results: exec(s.sql, s.args) })) },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
};
(async () => {
  const tmp = path.join(os.tmpdir(), `worker-pw-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (method, p, body, tok) => {
    const h = { 'content-type': 'application/json' }; if (tok) h.Authorization = `Bearer ${tok}`;
    const r = await worker.fetch(new Request(`https://api.test${p}`, { method, headers: h, body: body && JSON.stringify(body) }), env, {});
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = (email, password) => call('POST', '/api/auth/login', { email, password });
  const reg = await call('POST', '/api/auth/register', { email: 'a@x.com', name: 'Alice', password: 'oldpassword1' });
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
  const s1 = reg.body.token;
  const s2 = (await login('a@x.com', 'oldpassword1')).body.token;
  const uid = reg.body.user.id;
  // session kiểu cũ (chỉ userId) còn dùng được khi chưa đổi mật khẩu
  kv.set('session:legacy', uid);
  assert.strictEqual((await call('GET', '/api/me', null, 'legacy')).status, 200, 'legacy trước đổi');

  // đổi mật khẩu: sai mật khẩu cũ -> 401 và tính vào limiter
  const bad = await call('POST', '/api/auth/change-password', { current_password: 'nope', new_password: 'newpassword2' }, s1);
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(db.prepare('SELECT fail_count c FROM login_failures WHERE user_id=?').get(uid).c, 1, 'tính vào limiter');
  assert.strictEqual((await call('POST', '/api/auth/change-password', { current_password: 'oldpassword1', new_password: 'short' }, s1)).status, 400);
  const ok = await call('POST', '/api/auth/change-password', { current_password: 'oldpassword1', new_password: 'newpassword2' }, s1);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual((await login('a@x.com', 'oldpassword1')).status, 401, 'mật khẩu cũ');
  assert.strictEqual((await call('GET', '/api/me', null, s2)).status, 401, 'session khác bị huỷ');
  assert.strictEqual((await call('GET', '/api/me', null, 'legacy')).status, 401, 'session kiểu cũ bị huỷ sau đổi');
  assert.strictEqual((await call('GET', '/api/me', null, s1)).status, 401, 'token cũ của người gọi bị thay');
  assert.strictEqual((await call('GET', '/api/me', null, ok.body.token)).status, 200, 'người gọi vẫn đăng nhập');
  const s3 = (await login('a@x.com', 'newpassword2')).body.token;
  assert.strictEqual((await call('GET', '/api/me', null, s3)).status, 200);

  // reset: chỉ owner tạo link
  const o = await call('POST', '/api/admin/password-reset', { email: 'a@x.com' }, s3);
  assert.strictEqual(o.status, 403, 'không phải owner');
  const OWNER = (fs.readFileSync(workerPath, 'utf8').match(/OWNER_EMAIL\s*=\s*"([^"]+)"/) || [])[1];
  db.prepare("INSERT INTO users (id,email,name,created_at) VALUES ('own',?, 'O', 1)").run(OWNER);
  kv.set('session:own', 'own|' + Date.now());
  const lk = await call('POST', '/api/admin/password-reset', { email: 'a@x.com' }, 'own');
  assert.strictEqual(lk.status, 200, JSON.stringify(lk.body));
  const tok = lk.body.link.split('?reset=')[1];
  assert.ok(tok && kv.has(`pwreset:${tok}`));
  assert.strictEqual((await call('POST', '/api/auth/reset-password', { token: tok, new_password: 'x' })).status, 400, 'mật khẩu ngắn');
  assert.ok(kv.has(`pwreset:${tok}`), 'mật khẩu sai chưa tiêu token');
  assert.strictEqual((await call('POST', '/api/auth/reset-password', { token: tok, new_password: 'resetpass3' })).status, 200);
  assert.strictEqual((await call('POST', '/api/auth/reset-password', { token: tok, new_password: 'resetpass4' })).status, 400, 'dùng lần 2');
  assert.strictEqual((await call('POST', '/api/auth/reset-password', { token: 'unknown', new_password: 'resetpass4' })).status, 400, 'token lạ');
  assert.strictEqual((await call('GET', '/api/me', null, s3)).status, 401, 'reset huỷ session');
  assert.strictEqual((await login('a@x.com', 'newpassword2')).status, 401);
  assert.strictEqual((await login('a@x.com', 'resetpass3')).status, 200);
  // token hết hạn = KV không còn khoá
  kv.delete(`pwreset:${tok}`);
  assert.strictEqual((await call('POST', '/api/auth/reset-password', { token: tok, new_password: 'resetpass5' })).status, 400, 'hết hạn');
  console.log('password.selfcheck OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
