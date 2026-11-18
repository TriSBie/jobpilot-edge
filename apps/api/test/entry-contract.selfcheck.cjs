// T-117b/c: so bundle Hono với legacy và fixture ghi từ các base.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createHash, pbkdf2Sync } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const publicBaseline = require('./fixtures/public-contract-df3db94.json');
const healthRumBaseline = require('./fixtures/health-rum-contract-414ec0b.json');
const authBaseline = require('./fixtures/auth-contract-ae7eb19.json');
const logoutFixture = authBaseline['auth logout success'].requests[0];
const logoutBaseline = { response: logoutFixture.response, logs: [logoutFixture.log], points: [logoutFixture.metric], cacheKeys: [] };
const root = path.resolve(__dirname, '../../..');
const legacyPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const entrySource = path.resolve(process.argv[3] || path.join(root, 'apps/api/src/index.ts'));
const entryName = path.basename(entrySource, path.extname(entrySource));
const bundleDir = path.join(root, '.test-build/contract', entryName);
const bundled = path.join(bundleDir, entryName + '.js');
const build = spawnSync(process.execPath, ['tools/wrangler.mjs', 'deploy', entrySource, '--dry-run', '--outdir', bundleDir], { cwd: root, encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout, build.stderr); process.exit(build.status || 1); }

const fixed = 1793346000000;
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync(path.join(root, 'db/migrations')).sort()) db.exec(fs.readFileSync(path.join(root, 'db/migrations', file), 'utf8'));
  const t = fixed / 1000;
  db.prepare("INSERT INTO users (id,email,name,created_at,last_active_day) VALUES ('u','user@example.invalid','User',?,?),('owner','owner@example.invalid','Owner',?,?)").run(t, Math.floor(t/86400), t, Math.floor(t/86400));
  db.prepare("INSERT INTO profiles (id,user_id,name,level,locations,created_at,updated_at) VALUES ('p','u','Backend','middle','[\"Remote\"]',?,?)").run(t,t);
  db.prepare("INSERT INTO profile_skills(profile_id,skill,weight) VALUES ('p','Java',5),('p','Spring Boot',5),('p','PostgreSQL',3)").run();
  db.prepare("INSERT INTO sources(id,type,name,created_at) VALUES ('src-itviec','itviec','ITviec',?)").run(t);
  db.prepare("INSERT INTO jobs(id,source_id,source_url,title,company,skills,content_hash,first_seen_at,created_at) VALUES ('job','src-itviec','https://itviec.com/it-jobs/example','Java Backend','Example','[\"Java\",\"Spring Boot\",\"PostgreSQL\"]','hash',?,?)").run(t,t);
  db.prepare("INSERT INTO job_matches(job_id,profile_id,final_score,tier,scored_at) VALUES ('job','p',90,'strong',?)").run(t);
  db.prepare("INSERT INTO applications(id,profile_id,job_id,stage,created_at,updated_at) VALUES ('app','p','job','saved',?,?)").run(t,t);
  const execute = (sql,args) => { const s=db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? s.all(...args) : (s.run(...args),[]); };
  const stmt = (sql,args=[]) => ({sql,args,bind:(...a)=>stmt(sql,a), first:async()=>execute(sql,args)[0]||null, all:async()=>({results:execute(sql,args)}),run:async()=>({ success:true, meta: { changes:db.prepare(sql).run(...args).changes } })});
  const kv=new Map([['session:tok','u'],['session:owner','owner']]);
  const points=[], waits=[];
  const env={DB:{prepare:s=>stmt(s),batch:async a=>a.map(s=>({results:execute(s.sql,s.args)}))},KV:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,v),delete:async k=>kv.delete(k),list:async()=>({keys:[]})},FILES:{get:async()=>null},EVENTS:{writeDataPoint:p=>points.push(p)},OWNER_EMAIL:'owner@example.invalid'};
  env.TG_TOKEN_KEY = Buffer.alloc(32, 1).toString('base64');
  return {db,env,kv,points,waits,ctx:{waitUntil:p=>waits.push(p),passThroughOnException(){}}};
}
const scenarios=[
  {name:'health',url:'/api/health',status:200,token:null},
  {name:'health POST',url:'/api/health',method:'POST',status:200,token:null},
  {name:'health PUT',url:'/api/health',method:'PUT',status:200,token:null},
  {name:'health PROPFIND',url:'/api/health',method:'PROPFIND',status:200,token:null},
  {name:'health OPTIONS',url:'/api/health',method:'OPTIONS',status:200,token:null},
  {name:'public',url:'/api/public/sample',status:200,token:null},
  {name:'public try',url:'/api/public/try?skills=Java,Spring%20Boot,PostgreSQL',status:200,token:null},
  {name:'public try english',url:'/api/public/try?skills=Java&lang=en',status:200,token:null},
  {name:'public try senior remote',url:'/api/public/try?skills=Java&level=senior&location=Remote',status:200,token:null},
  {name:'public sample language header',url:'/api/public/sample',language:'en-US',status:200,token:null},
  {name:'public try duplicate query',url:'/api/public/try?skills=Java&skills=bogus&level=&level=bogus&location=&location=bogus',status:200,token:null},
  {name:'public try invalid skills first',url:'/api/public/try?skills=bogus&level=bogus&location=bogus',status:400,token:null,error:'invalid_skills'},
  {name:'public try missing skills',url:'/api/public/try',status:400,token:null,error:'invalid_skills'},
  {name:'public try malformed encoding',url:'/api/public/try?skills=%E0%A4%A',status:400,token:null,error:'invalid_skills'},
  {name:'public try over skill limit',url:'/api/public/try?skills=Java,TypeScript,JavaScript,Node.js,NestJS,Express,Next.js,React,PostgreSQL',status:400,token:null,error:'invalid_skills'},
  {name:'public try at skill limit',url:'/api/public/try?skills=Java,TypeScript,JavaScript,Node.js,NestJS,Express,Next.js,React',status:200,token:null},
  {name:'public try invalid level first',url:'/api/public/try?skills=Java&level=bogus&location=bogus',status:400,token:null,error:'invalid_level'},
  {name:'public try invalid location',url:'/api/public/try?skills=Java&location=bogus',status:400,token:null,error:'invalid_location'},
  {name:'public try HEAD',url:'/api/public/try?skills=Java',method:'HEAD',status:401,token:null},
  {name:'public try OPTIONS',url:'/api/public/try?skills=Java',method:'OPTIONS',status:200,token:null},
  {name:'public try POST',url:'/api/public/try?skills=Java',method:'POST',status:401,token:null},
  {name:'public try POST with token',url:'/api/public/try?skills=Java',method:'POST',status:404},
  {name:'public encoded path',url:'/api/public/%74ry?skills=Java',status:401,token:null},
  {name:'public trailing slash',url:'/api/public/try/?skills=Java',status:401,token:null},
  {name:'public try DB failure',url:'/api/public/try?skills=Java',dbError:true,status:500,token:null,error:'internal_error'},
  {name:'me',url:'/api/me',status:200},
  {name:'profiles',url:'/api/profiles',status:200},
  {name:'jobs',url:'/api/jobs?profile_id=p&limit=10',status:200},
  {name:'applications',url:'/api/applications?profile_id=p',status:200},
  {name:'interviews',url:'/api/applications/app/interviews',status:200},
  {name:'notifications',url:'/api/notifications',status:200},
  {name:'telegram',url:'/api/me/telegram/bot',status:200},
  {name:'admin',url:'/api/admin/quota',status:200,token:'owner'},
  {name:'auth logout',url:'/api/auth/logout',method:'POST',status:200},
  {name:'rum',url:'/api/rum',method:'POST',body:{metric:'LCP',page:'landing',value:100},status:204,token:null},
  {name:'rum missing IP',url:'/api/rum',method:'POST',body:{metric:'LCP',page:'landing',value:100},noIp:true,status:400,token:null,error:'invalid_request'},
  {name:'rum bad JSON',url:'/api/rum',method:'POST',rawBody:'not json',status:400,token:null,error:'invalid_request'},
  {name:'rum invalid metric',url:'/api/rum',method:'POST',body:{metric:'FCP',page:'landing',value:100},status:400,token:null,error:'invalid_request'},
  {name:'rum body 1025 bytes',url:'/api/rum',method:'POST',largeBody:true,status:413,token:null,error:'too_large'},
  {name:'rum 61st attempt',url:'/api/rum',method:'POST',body:{metric:'LCP',page:'landing',value:100},priorAttempts:60,status:429,token:null,error:'rate_limited'},
  {name:'rum GET',url:'/api/rum',status:401,token:null,error:'unauthorized'},
  {name:'rum OPTIONS',url:'/api/rum',method:'OPTIONS',status:200,token:null},
  {name:'preflight',url:'/api/jobs',method:'OPTIONS',status:200,token:null},
  {name:'wrong method',url:'/api/jobs',method:'PUT',status:404},
  {name:'unknown path',url:'/api/khong-co',status:404},
  {name:'missing token',url:'/api/me',status:401,token:null},
  {name:'invalid token',url:'/api/me',status:401,token:'bad'},
  {name:'nonowner',url:'/api/admin/quota',status:403},
  {name:'invalid body',url:'/api/profiles',method:'POST',body:{locations:'bad'},status:400},
  {name:'DB failure',url:'/api/me',status:500,dbError:true},
  {name:'HEAD',url:'/api/health',method:'HEAD',status:200,token:null},
  {name:'trailing slash',url:'/api/me/',status:404},
];

// Các giá trị đều là fixture local; snapshot không lưu token hay bản ghi mật khẩu.
const authPassword = 'Fixture-Current01';
const nextPassword = 'Fixture-New02';
const authSalt = Buffer.alloc(16, 2);
const authHash = pbkdf2Sync(authPassword, authSalt, 100000, 32, 'sha256').toString('base64');
const turnstilePass = 'fixture-turnstile-pass';
const resetFixture = 'fixture-reset';
const loginBody = { email: 'user@example.invalid', password: authPassword, turnstile_token: turnstilePass };
const registerBody = { ...loginBody, email: '  New@example.invalid ', name: '  New User  ', ref: 'Fixture_Ref' };
const resetBody = { token: resetFixture, new_password: nextPassword };
const changeBody = { current_password: authPassword, new_password: nextPassword };
const authCase = (route, label, status, options = {}) => ({
  name: `auth ${route} ${label}`, url: `/api/auth/${route}`, status, ...options,
});
const passwordErrors = [
  [undefined, 'missing_password'],
  [42, 'missing_password'],
  ['short', 'password_too_short'],
  ['x'.repeat(129), 'password_too_long'],
];
const authScenarios = [
  authCase('register', 'success', 201, { body: registerBody, issue: 'new', hashes: 1 }),
  authCase('register', 'Turnstile first', 403, { body: { email: 'bad' }, error: 'turnstile_failed', hashes: 0 }),
  authCase('register', 'empty body', 403, { error: 'turnstile_failed' }),
  authCase('register', 'malformed JSON', 403, { rawBody: 'not json', error: 'turnstile_failed' }),
  authCase('register', 'JSON under alternate content type', 201, { body: registerBody, contentType: 'text/plain', issue: 'new', hashes: 1 }),
  authCase('register', 'email precedes name and password', 400, { body: { ...registerBody, email: 'bad', name: '', password: 'short' }, error: 'invalid_email' }),
  authCase('register', 'name precedes password', 400, { body: { ...registerBody, name: 'x', password: 'short' }, error: 'invalid_name' }),
  authCase('register', 'name too long', 400, { body: { ...registerBody, name: 'x'.repeat(81) }, error: 'invalid_name' }),
  authCase('register', 'non-string email', 500, { body: { ...registerBody, email: true }, error: 'internal_error' }),
  authCase('register', 'limit precedes duplicate lookup and hash', 429, { body: { ...registerBody, email: loginBody.email }, registrationCount: 5, error: 'too_many_registrations', hashes: 0 }),
  authCase('register', 'duplicate', 409, { body: { ...registerBody, email: loginBody.email }, error: 'email_taken', hashes: 0 }),
  ...passwordErrors.map(([password, error], i) => authCase('register', `password error ${i + 1}`, 400, { body: { ...registerBody, password }, error })),
  ...['login', 'restore'].flatMap(route => [
    authCase(route, 'Turnstile first', 403, { body: { email: 'bad' }, error: 'turnstile_failed', hashes: 0 }),
    authCase(route, 'invalid email first', 400, { body: { ...loginBody, email: 'bad', password: null }, error: 'invalid_email', hashes: 0 }),
    authCase(route, 'missing password', 400, { body: { ...loginBody, password: null }, error: 'missing_password', hashes: 0 }),
    authCase(route, 'unknown email causes no write', 401, { body: { ...loginBody, email: 'unknown@example.invalid' }, error: 'invalid_credentials', hashes: 0, count: 0 }),
    authCase(route, 'requires password setup', 403, { body: loginBody, noPassword: true, error: 'password_setup_required', hashes: 0, count: 0 }),
    authCase(route, 'limit precedes wrong password hash', 429, { body: { ...loginBody, password: nextPassword }, attempts: 5, error: 'too_many_attempts', hashes: 0, count: 6 }),
    authCase(route, 'wrong password', 401, { body: { ...loginBody, password: nextPassword }, error: 'invalid_credentials', hashes: 1, count: 1 }),
  ]),
  authCase('login', 'success', 200, { body: loginBody, issue: 'existing', attempts: 2, hashes: 1, count: 0 }),
  authCase('login', 'deleted account', 403, { body: loginBody, deletedDays: 1, error: 'account_deleted', hashes: 1, count: 0 }),
  authCase('login', 'malformed JSON', 403, { rawBody: 'not json', error: 'turnstile_failed' }),
  authCase('login', 'explicit JSON null', 500, { body: null, error: 'internal_error' }),
  authCase('restore', 'account not deleted', 400, { body: loginBody, error: 'not_deleted', hashes: 1, count: 0 }),
  authCase('restore', 'expired by one second', 410, { body: loginBody, deletedDays: 7, expiredBy: 1, error: 'restore_expired', hashes: 1, count: 0 }),
  authCase('restore', 'success at exact seven days', 200, { body: loginBody, deletedDays: 7, issue: 'existing', hashes: 1, count: 0 }),
  authCase('logout', 'needs authorization', 401, { error: 'unauthorized' }),
  authCase('logout', 'success', 200, { bearer: 'tok', logout: true }),
  authCase('logout', 'opaque authorization header', 200, { authorization: 'fixture-opaque-session', logout: true }),
  authCase('set-password', 'disabled', 410, { error: 'password_setup_disabled' }),
  ...passwordErrors.map(([new_password, error], i) => authCase('reset-password', `new password error ${i + 1}`, 400, {
    body: { ...resetBody, new_password }, error, seedReset: true, hashes: 0,
  })),
  authCase('reset-password', 'non-string token', 400, { body: { ...resetBody, token: true }, error: 'invalid_reset_token', hashes: 0 }),
  authCase('reset-password', 'unknown token', 400, { body: resetBody, error: 'invalid_reset_token', hashes: 0 }),
  authCase('reset-password', 'deleted target consumes token but changes no password', 400, {
    body: resetBody, seedReset: true, deletedDays: 1, attempts: 2, error: 'invalid_reset_token', hashes: 1, count: 2,
  }),
  authCase('reset-password', 'success and replay fails', 200, { body: resetBody, seedReset: true, replay: true, attempts: 2, hashes: 1, count: 0 }),
  authCase('change-password', 'auth precedes password fields', 401, { body: {}, error: 'unauthorized' }),
  ...passwordErrors.map(([new_password, error], i) => authCase('change-password', `new password error ${i + 1}`, 400, {
    body: { ...changeBody, new_password, current_password: 1 }, bearer: 'tok', error, hashes: 0,
  })),
  authCase('change-password', 'requires current string', 401, { body: { ...changeBody, current_password: 1 }, bearer: 'tok', error: 'invalid_credentials', hashes: 0 }),
  authCase('change-password', 'requires stored hash', 401, { body: changeBody, bearer: 'tok', noPassword: true, error: 'invalid_credentials', hashes: 0 }),
  authCase('change-password', 'limit precedes wrong password hash', 429, { body: { ...changeBody, current_password: nextPassword }, bearer: 'tok', attempts: 5, error: 'too_many_attempts', hashes: 0, count: 6 }),
  authCase('change-password', 'wrong password', 401, { body: { ...changeBody, current_password: nextPassword }, bearer: 'tok', error: 'invalid_credentials', hashes: 1, count: 1 }),
  authCase('change-password', 'success revokes existing sessions', 200, { body: changeBody, bearer: 'tok', issue: 'existing', attempts: 2, change: true, hashes: 2, count: 0 }),
  ...['register', 'login', 'restore', 'logout', 'set-password', 'reset-password', 'change-password'].flatMap(route => [
    authCase(route, 'GET fallback', 401, { method: 'GET', error: 'unauthorized' }),
    authCase(route, 'PUT fallback', 401, { method: 'PUT', error: 'unauthorized' }),
    authCase(route, 'OPTIONS preflight', 200, { method: 'OPTIONS' }),
  ]),
  authCase('change-password', 'authenticated PUT fallback', 404, { method: 'PUT', bearer: 'tok', error: 'not_found' }),
];

function setupAuth(scenario) {
  const state = setup();
  const { db, env, kv } = state;
  db.exec('PRAGMA foreign_keys = ON');
  const t = fixed / 1000;
  const deletedAt = scenario.deletedDays ? t - scenario.deletedDays * 86400 - (scenario.expiredBy || 0) : null;
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, deleted_at = ?, last_active_day = ? WHERE id = ?')
    .run(scenario.noPassword ? null : authHash, scenario.noPassword ? null : authSalt.toString('base64'), deletedAt, Math.floor(t / 86400) - 1, 'u');
  if (scenario.attempts) db.prepare('INSERT INTO login_failures (user_id,fail_count,last_fail_at) VALUES (?,?,?)').run('u', scenario.attempts, t);
  if (scenario.registrationCount) db.prepare('INSERT INTO register_attempts (ip,hour,count) VALUES (?,?,?)').run('203.0.113.2', Math.floor(t / 3600), scenario.registrationCount);
  if (scenario.seedReset) kv.set('pwreset:' + resetFixture, 'u');
  kv.set('session:fixture-opaque-session', 'u');
  kv.set('session:fixture-older-session', `u|${fixed - 1}`);
  env.TURNSTILE_SECRET = 'fake-only-turnstile-binding';
  const puts = [], effects = [];
  const put = env.KV.put, deleteKey = env.KV.delete;
  env.KV.put = async (key, value, options) => {
    if (key.startsWith('session:')) puts.push({ key, value, options });
    return put(key, value);
  };
  env.KV.delete = async (key) => {
    effects.push(key.startsWith('pwreset:') ? 'consume-reset' : 'delete-session');
    return deleteKey(key);
  };
  return { ...state, puts, effects, deletedAt };
}

function assertPasswordRecord(row, password, label) {
  assert.ok(row?.password_salt && row.password_hash, label + ' stores a password record');
  const salt = Buffer.from(row.password_salt, 'base64');
  assert.equal(salt.length, 16, label + ' salt length');
  const expected = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64');
  assert.ok(row.password_hash === expected, label + ' correct password hash');
  assert.equal(row.password_set_at, fixed / 1000, label + ' password time');
}

async function runAuthContract(worker) {
  const original = {
    fetch: globalThis.fetch,
    log: console.log,
    error: console.error,
    deriveBits: Object.getOwnPropertyDescriptor(crypto.subtle, 'deriveBits'),
  };
  const deriveBits = crypto.subtle.deriveBits;
  const snapshot = {};
  try {
    for (const scenario of authScenarios) {
      const state = setupAuth(scenario), records = [], logs = [];
      const { db, env, kv, points, puts, effects } = state;
      console.log = (...args) => logs.push(args.map(String).join(' '));
      console.error = console.log;
      globalThis.fetch = async (url, init) => {
        assert.ok(url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'only mocked Turnstile may fetch');
        assert.equal(init.method, 'POST');
        return Response.json({ success: init.body.get('response') === turnstilePass });
      };
      Object.defineProperty(crypto.subtle, 'deriveBits', {
        configurable: true,
        value: function (...args) {
          effects.push('derive-password');
          return deriveBits.apply(this, args);
        },
      });
      let issued;
      const request = async ({
        name, url, method = 'POST', body, rawBody, bearer, authorization, contentType, status, error, issue,
      }) => {
        const headers = { 'cf-connecting-ip': '203.0.113.2', 'content-type': contentType || 'application/json' };
        if (authorization || bearer) headers.authorization = authorization || `Bearer ${bearer}`;
        const logStart = logs.length, pointStart = points.length;
        const req = new Request('https://api.test' + url, { method, headers, body: rawBody ?? JSON.stringify(body) });
        const res = await worker.fetch(req, env, state.ctx);
        assert.equal(res.status, status, name + ' status');
        let wire = await res.text();
        if (error) assert.equal(JSON.parse(wire).error, error, name + ' error');
        if (issue) {
          const data = JSON.parse(wire);
          issued = data.token;
          assert.ok(typeof issued === 'string' && /^[0-9a-f]{64}$/.test(issued), name + ' fresh session token format');
          assert.deepEqual(Object.keys(data).sort(), ['token', 'user'], name + ' response keys');
          assert.deepEqual(Object.keys(data.user).sort(), ['email', 'id', 'name'], name + ' public user fields');
          if (issue === 'new') {
            const row = db.prepare('SELECT * FROM users WHERE email = ?').get('new@example.invalid');
            assert.ok(row && row.id === data.user.id, name + ' returns inserted user');
            assert.equal(row.name, 'New User', name + ' trims name');
            assert.equal(row.ref_source, 'fixture_ref', name + ' keeps normalized ref');
            assert.equal(row.last_active_day, Math.floor(fixed / 86400000), name + ' sets active day');
            assertPasswordRecord(row, authPassword, name);
            wire = wire.replace(JSON.stringify(data.user.id), '"<registered-user>"');
          } else {
            assert.equal(data.user.id, 'u', name + ' issues session for known user');
          }
          assert.ok(puts.length === 1 && puts[0].key === 'session:' + issued, name + ' writes issued token');
          assert.ok(kv.get('session:' + issued) === `${data.user.id}|${fixed}`, name + ' stores session user and issue time');
          assert.equal(puts[0].options?.expirationTtl, 2592000, name + ' session TTL');
          wire = wire.replace(JSON.stringify(issued), '"<issued-session>"');
        }
        const emitted = logs.slice(logStart);
        const privateValues = [authPassword, nextPassword, turnstilePass, resetFixture, authHash, authSalt.toString('base64'), env.TURNSTILE_SECRET, bearer, authorization, issued].filter(Boolean);
        assert.ok(!emitted.some(line => privateValues.some(value => line.includes(value))), name + ' telemetry scrubbed');
        assert.ok(!privateValues.some(value => wire.includes(JSON.stringify(value))), name + ' response scrubbed apart from the expected issued session');
        const requestLogs = emitted.map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter(value => value && Object.hasOwn(value, 'd1_queries'));
        const requestPoints = points.slice(pointStart).filter(point => point.blobs[0] === 'request');
        assert.equal(requestLogs.length, 1, name + ' logs one request');
        assert.equal(requestPoints.length, 1, name + ' emits one request metric');
        assert.deepEqual(Object.keys(requestLogs[0]).sort(), ['cache', 'd1_queries', 'method', 'ms', 'route', 'status', 'user_hash'], name + ' telemetry keys');
        records.push({ response: { status: res.status, headers: [...res.headers].sort(), body: wire }, log: requestLogs[0], metric: requestPoints[0] });
      };
      try {
        await request(scenario);
        if (scenario.logout) assert.equal(kv.has('session:' + (scenario.bearer || scenario.authorization)), false, scenario.name + ' deletes the session');
        if (scenario.replay) await request({ ...scenario, name: scenario.name + ' replay', status: 400, error: 'invalid_reset_token' });
        if (scenario.change) {
          assert.equal(kv.has('session:tok'), false, scenario.name + ' deletes current session');
          for (const bearer of ['tok', 'fixture-older-session']) {
            await request({ name: scenario.name + ' rejects old session', url: scenario.url, bearer, status: 401, error: 'unauthorized' });
          }
          await request({ name: scenario.name + ' accepts new session', url: scenario.url, bearer: issued, status: 400, error: 'missing_password' });
        }
        const user = db.prepare("SELECT * FROM users WHERE id = 'u'").get();
        if (scenario.replay || scenario.change) {
          assertPasswordRecord(user, nextPassword, scenario.name);
          assert.equal(user.sessions_valid_after, fixed, scenario.name + ' invalidates old session issue times');
        }
        if (scenario.change) assert.equal(user.last_active_day, Math.floor(fixed / 86400000), scenario.name + ' sets active day');
        if (scenario.url.endsWith('/restore') && scenario.issue) assert.equal(user.deleted_at, null, scenario.name + ' restores user');
        if (scenario.seedReset) {
          assert.equal(kv.has('pwreset:' + resetFixture), scenario.hashes === 0, scenario.name + ' reset token consumed only after password validation');
          if (scenario.hashes) assert.deepEqual(effects.slice(0, 2), ['consume-reset', 'derive-password'], scenario.name + ' consumes reset token before hashing');
        }
        if (scenario.deletedDays && !scenario.issue) {
          assert.equal(user.deleted_at, state.deletedAt, scenario.name + ' does not restore user');
          assert.ok(user.password_hash === authHash, scenario.name + ' leaves deleted user password unchanged');
        }
        if (scenario.hashes !== undefined) assert.equal(effects.filter(effect => effect === 'derive-password').length, scenario.hashes, scenario.name + ' PBKDF2 calls');
        if (scenario.count !== undefined) {
          const failures = db.prepare('SELECT fail_count FROM login_failures').all();
          assert.deepEqual(failures.map(row => row.fail_count), scenario.count ? [scenario.count] : [], scenario.name + ' failure counter');
        }
        snapshot[scenario.name] = { requests: records, effects };
      } finally {
        db.close();
      }
    }
    return snapshot;
  } finally {
    globalThis.fetch = original.fetch;
    console.log = original.log;
    console.error = original.error;
    if (original.deriveBits) Object.defineProperty(crypto.subtle, 'deriveBits', original.deriveBits);
    else delete crypto.subtle.deriveBits;
  }
}

(async()=>{
  const original={Date:globalThis.Date,fetch:globalThis.fetch,caches:globalThis.caches,log:console.log,error:console.error};
  class FixedDate extends original.Date { constructor(...args){super(...(args.length?args:[fixed]));} static now(){return fixed;} }
  try {
    globalThis.Date=FixedDate;
    globalThis.fetch=async()=>{throw new Error('unexpected external fetch');};
    const legacy=(await import(pathToFileURL(legacyPath).href)).default;
    const current=(await import(pathToFileURL(bundled).href)).default;
    const rows=[];
    for(const scenario of scenarios){
      const responses=[],logs=[],telemetry=[];
      const baseline=publicBaseline[scenario.name] || healthRumBaseline[scenario.name] || (scenario.name === 'auth logout' ? logoutBaseline : undefined);
      for(const worker of baseline?[current]:[legacy,current]){
        const state=setup(),cache=new Map(),workerLogs=[];
        globalThis.caches={default:{match:async r=>cache.get(r.url)?.clone(),put:async(r,res)=>cache.set(r.url,res.clone())}};
        console.log=(...a)=>workerLogs.push(a.join(' ')); console.error=()=>{};
        try {
          if(scenario.dbError)state.env.DB.prepare=()=>{throw new Error('fixture DB unavailable');};
          const headers={'content-type':'application/json','cf-connecting-ip':'203.0.113.2'};
          if(scenario.noIp)delete headers['cf-connecting-ip'];
          if(scenario.priorAttempts){
            const ipKey='rum:'+createHash('sha256').update('rum:'+headers['cf-connecting-ip']).digest('hex');
            state.db.prepare('INSERT INTO register_attempts (ip,hour,count) VALUES (?,?,?)').run(ipKey,Math.floor(fixed/3600000),scenario.priorAttempts);
          }
          if(scenario.language)headers['accept-language']=scenario.language;
          const token=scenario.token===undefined?'tok':scenario.token;if(token)headers.authorization=`Bearer ${token}`;
          const init={method:scenario.method||'GET',headers,body:scenario.rawBody??(scenario.body&&JSON.stringify(scenario.body))};
          if(scenario.largeBody){
            init.body=new ReadableStream({start(controller){
              controller.enqueue(new Uint8Array(1024).fill(120));
              controller.enqueue(Uint8Array.of(120));
              controller.close();
            }});
            init.duplex='half';
          }
          const request=new Request('https://api.test'+scenario.url,init);
          if(scenario.largeBody)assert.equal(request.headers.get('content-length'),null);
          const res=await worker.fetch(request,state.env,state.ctx);
          assert.equal(res.status,scenario.status,scenario.name);
          const body=await res.text();
          if(scenario.method==='HEAD'&&worker===current)assert.equal(body,'',scenario.name+' body');
          if(scenario.error)assert.equal(JSON.parse(body).error,scenario.error,scenario.name+' error');
          responses.push({status:res.status,headers:[...res.headers].sort(),body:scenario.method==='HEAD'?'':body});
          await Promise.all(state.waits);
          const log=workerLogs.map(x=>{try{return JSON.parse(x);}catch{return null;}}).find(x=>x&&Object.hasOwn(x,'d1_queries'));
          assert(log,`${scenario.name}: structured log`);
          for(const key of ['route','method','status','ms','d1_queries','cache','user_hash'])assert(Object.hasOwn(log,key),`${scenario.name}: ${key}`);
          logs.push(log);
          if(scenario.name==='public try'){
            const repeat='/api/public/try?skills=PostgreSQL,spring+boot,java,Java&level=middle&location=H%E1%BB%93+Ch%C3%AD+Minh';
            const r=await worker.fetch(new Request('https://api.test'+repeat,{headers}),state.env,state.ctx);
            assert.equal(r.status,res.status,'cache hit status');
            assert.deepEqual([...r.headers].sort(),[...res.headers].sort(),'cache hit headers');
            assert.equal(await r.text(),body,'cache hit body');
            assert(workerLogs.some(x=>x.includes('"cache":"hit"')),'waitUntil cache write must be visible');
          }
          const requestLogs=workerLogs.map(x=>{try{return JSON.parse(x);}catch{return null;}}).filter(x=>x&&Object.hasOwn(x,'d1_queries'));
          const count=scenario.name==='public try'?2:1;
          assert.equal(requestLogs.length,count,scenario.name+' log mỗi request');
          assert.equal(state.points.filter(p=>p.blobs[0]==='request').length,count,scenario.name+' metric mỗi request');
          if(scenario.priorAttempts)assert.equal(state.db.prepare('SELECT count FROM register_attempts').get().count,61);
          telemetry.push({logs:requestLogs,points:state.points,cacheKeys:[...cache.keys()]});
        }finally{state.db.close();}
      }
      if(baseline){
        const {response,...expectedTelemetry}=baseline;
        assert.deepEqual(responses[0],response,scenario.name+' status/header/body');
        assert.deepEqual(telemetry[0],expectedTelemetry,scenario.name+' telemetry');
      }else{
        assert.deepEqual(responses[1],responses[0],scenario.name+' status/header/body');
        assert.deepEqual(logs[1],logs[0],scenario.name+' logs');
        assert.deepEqual(telemetry[1],telemetry[0],scenario.name+' telemetry');
      }
      rows.push({scenario:scenario.name,status:responses.at(-1).status,identical:true});
    }
    const auth = await runAuthContract(current);
    assert.deepEqual(Object.keys(auth), Object.keys(authBaseline), 'auth baseline scenario list');
    for (const [name, seen] of Object.entries(auth)) {
      assert.deepEqual(seen, authBaseline[name], name + ' status/header/body, telemetry and credential effects');
      rows.push({ scenario: name, status: seen.requests[0].response.status, identical: true });
    }
    console.log=original.log; console.error=original.error;
    console.log('T-117b/c entry contract selfcheck OK:',JSON.stringify(rows));
  }finally{globalThis.Date=original.Date;globalThis.fetch=original.fetch;globalThis.caches=original.caches;console.log=original.log;console.error=original.error;}
})().catch(e=>{console.error(e);process.exitCode=1});
