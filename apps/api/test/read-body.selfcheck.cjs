// T-121: exercise body handling through the real entry with isolated fake bindings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migrationDir = path.resolve(path.dirname(workerPath), '../../../db/migrations');
const schema = fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()
  .map(name => fs.readFileSync(path.join(migrationDir, name), 'utf8')).join('\n');

const routes = [
  ['POST', '/api/profiles', 201],
  ['PATCH', '/api/profiles/p', 200],
  ['POST', '/api/profiles/p/cv-text', 400],
  ['POST', '/api/profiles/p/cv-suggest', 404],
  ['POST', '/api/profiles/p/skills/confirm', 200],
  ['POST', '/api/profiles/p/skills', 400],
  ['POST', '/api/auth/register', 403],
  ['POST', '/api/auth/login', 403],
  ['POST', '/api/auth/restore', 403],
  ['POST', '/api/auth/reset-password', 400],
  ['POST', '/api/auth/change-password', 400],
  ['POST', '/api/me/consent', 400],
  ['PATCH', '/api/me', 400],
  ['DELETE', '/api/me', 401],
  ['POST', '/api/telegram/webhook', 200],
  ['POST', '/api/telegram/webhook/123456', 200],
  ['PUT', '/api/me/telegram/bot', 400],
  ['POST', '/api/jobs/submit', 400],
  ['POST', '/api/applications', 404],
  ['POST', '/api/applications/quick', 404],
  ['PATCH', '/api/applications/a', 200],
  ['POST', '/api/applications/a/interviews', 400],
  ['PATCH', '/api/interviews/i', 200],
  ['POST', '/api/notifications/read', 400],
  ['PATCH', '/api/admin/applications/a', 400],
  ['POST', '/api/admin/password-reset', 404],
  ['POST', '/api/admin/jd/enrich', 200],
  ['POST', '/api/admin/ingest/run', 200],
];
const bodies = ['{}', 'null', '[]', '5', '"x"', 'true', '{'];

async function call(worker, method, route, body) {
  const db = new DatabaseSync(':memory:');
  let ids = 0;
  crypto.randomUUID = () => 't121-fixture-' + (++ids);
  try {
    db.exec(schema);
    db.exec("INSERT INTO users (id,email,name,created_at,consent_cv_at) VALUES ('u','fixture@example.invalid','Fixture',1,1)");
    db.exec("INSERT INTO profiles (id,user_id,name,created_at,updated_at) VALUES ('p','u','Profile',1,1)");
    db.exec("INSERT INTO jobs (id,source_url,title,company,content_hash,first_seen_at,created_at) VALUES ('j','https://fixture.invalid/job','Job','Fixture','fixture',1,1)");
    db.exec("INSERT INTO applications (id,profile_id,job_id,stage,created_at,updated_at) VALUES ('a','p','j','saved',1,1)");
    db.exec("INSERT INTO interviews (id,application_id,kind,round_label,scheduled_at,created_at) VALUES ('i','a','technical','Fixture interview',0,1)");
    db.exec("INSERT INTO user_bots (user_id,bot_id,username,webhook_secret) VALUES ('u','123456','fixture_bot','fixture-bot-webhook')");
    const execute = ({ sql, args }) => {
      const statement = db.prepare(sql);
      if (/^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql)) return statement.all(...args);
      return statement.run(...args);
    };
    const prepare = (sql, args = []) => ({
      sql, args,
      bind: (...values) => prepare(sql, values),
      first: async () => execute({ sql, args })[0] ?? null,
      all: async () => ({ results: execute({ sql, args }) }),
      run: async () => ({ success: true, meta: execute({ sql, args }) }),
    });
    const kv = new Map([['session:fixture', 'u']]);
    const env = {
      DB: { prepare, batch: async statements => statements.map(s => ({ results: execute(s) })) },
      KV: { get: async key => kv.get(key) ?? null, put: async (key, value) => { kv.set(key, value); } },
      Q_SCORE: { send: async () => {} }, Q_INGEST: { send: async () => {} },
      FILES: { get: async () => null },
      OWNER_EMAIL: 'fixture@example.invalid',
      TURNSTILE_SECRET: 'fixture-turnstile-key',
      TELEGRAM_WEBHOOK_SECRET: 'fixture-common-webhook',
      TG_TOKEN_KEY: Buffer.alloc(32, 2).toString('base64'),
    };
    const res = await worker.fetch(new Request('https://api.test' + route, {
      method, body, headers: {
        authorization: 'Bearer fixture',
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': route.endsWith('/123456') ? 'fixture-bot-webhook' : 'fixture-common-webhook',
      },
    }), env, {});
    return { status: res.status, body: await res.json() };
  } finally {
    db.close();
  }
}

(async () => {
  const entry = path.join(path.dirname(workerPath), 'index.ts');
  const { default: worker } = await import(pathToFileURL(entry).href);
  const original = { now: Date.now, uuid: crypto.randomUUID, fetch: globalThis.fetch, log: console.log, error: console.error };
  let outbound = 0;
  const matrix = [];
  try {
    Date.now = () => 1793346000000;
    globalThis.fetch = async () => { outbound++; throw new Error('unexpected outbound request'); };
    console.log = console.error = () => {};
    for (const [method, route, expected] of routes) {
      const results = [];
      for (const body of bodies) results.push(await call(worker, method, route, body));
      matrix.push({ method, route, expected, results });
    }
    const valid = await call(worker, 'POST', '/api/profiles', '{"name":"Explicit name","locations":["Remote"]}');
    assert.equal(valid.status, 201);
    assert.equal(valid.body.name, 'Explicit name');
    assert.deepEqual(valid.body.locations, ['Remote']);
    assert.equal(outbound, 0, 'no external requests');
  } finally {
    Object.assign(console, { log: original.log, error: original.error });
    Date.now = original.now;
    crypto.randomUUID = original.uuid;
    globalThis.fetch = original.fetch;
  }
  console.log('read-body input order:', JSON.stringify(bodies));
  for (const { method, route, results } of matrix) {
    console.log(method + ' ' + route + ' ' + results.map(({ status, body }) => status + (body.error ? ':' + body.error : '')).join(' '));
  }
  for (const { method, route, expected, results } of matrix) {
    assert.equal(results[0].status, expected, method + ' ' + route + ' {} control');
    for (let i = 1; i < bodies.length; i++) {
      const expectedBody = route === '/api/interviews/i' && bodies[i] !== '{'
        ? { status: 400, body: { error: 'invalid_body' } }
        : results[0];
      assert.deepEqual(results[i], expectedBody, method + ' ' + route + ' body ' + bodies[i]);
    }
  }
  console.log('T-121 read-body selfcheck OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
