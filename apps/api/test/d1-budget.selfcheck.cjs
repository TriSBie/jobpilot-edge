// Tự kiểm ngân sách D1 của 2 queue consumer (gói Free: 50 truy vấn/lần chạy; 1 batch() = 1 truy vấn).
// Chạy handler queue thật của worker.js trên SQLite trong RAM (node:sqlite, đủ migration 0001-0008),
// lô đầy đúng max_batch_size trong toml.example. Đếm all/first/run/batch, assert ≤ 40 và kết quả ghi đúng.
// Chạy: node apps/api/test/d1-budget.selfcheck.cjs apps/api/src/worker.js [apps/api/wrangler.toml.example]
// Đưa worker.js bản cũ vào để lấy số "trước": các assert kết quả vẫn chạy, chỉ assert ngân sách fail.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning'); // node:sqlite còn ExperimentalWarning
const { DatabaseSync } = require('node:sqlite');
const BUDGET = 40;
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const tomlPath = path.resolve(process.argv[3] || 'apps/api/wrangler.toml.example');
const toml = fs.readFileSync(tomlPath, 'utf8').replace(/\r\n/g, '\n');
const batchSize = (q) => Number(toml.split('[[queues.consumers]]').slice(1).find((b) => b.includes(`queue = "${q}"`)).match(/max_batch_size\s*=\s*(\d+)/)[1]);
const migDir = path.join(path.dirname(tomlPath), '..', '..', 'db', 'migrations');

function fakeEnv() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  const stats = { queries: 0, scoreMsgs: [], tg: 0, broadcasts: 0 };
  const exec = (sql, args) => { const st = db.prepare(sql); return /^\s*SELECT/i.test(sql) ? st.all(...args) : (st.run(...args), []); };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => { stats.queries++; return { results: exec(sql, args) }; },
    first: async () => { stats.queries++; return exec(sql, args)[0] || null; },
    run: async () => { stats.queries++; exec(sql, args); return { success: true }; },
  });
  const kv = new Map();
  const env = {
    DB: {
      prepare: (sql) => stmt(sql),
      batch: async (list) => { // D1: 1 truy vấn, chạy tuần tự trong 1 transaction
        stats.queries++;
        db.exec('BEGIN');
        try { const r = list.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      },
    },
    KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
    Q_SCORE: { send: async (b) => { stats.scoreMsgs.push(b); }, sendBatch: async (ms) => { for (const m of ms) stats.scoreMsgs.push(m.body); } },
    USER_HUB: { idFromName: (n) => n, get: () => ({ fetch: async () => { stats.broadcasts++; return new Response('{}'); } }) },
    TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_API_BASE: 'https://tg.test', TELEGRAM_QUIET_OVERRIDE: '1',
  };
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  return { env, db, q, kv, stats };
}
const T = Math.floor(Date.now() / 1000);
function seedProfiles({ db, kv }) {
  for (let u = 1; u <= 5; u++) {
    db.prepare("INSERT INTO users (id, email, name, created_at, telegram_chat_id) VALUES (?, ?, 'U', ?, ?)").run(`u${u}`, `u${u}@x`, T, u <= 3 ? `chat${u}` : null);
    for (let k = 1; k <= 2; k++) { // 2 hồ sơ/người → 10 hồ sơ đủ skill
      const id = `p${u}${k}`;
      db.prepare("INSERT INTO profiles (id, user_id, name, level, locations, is_active, created_at, updated_at) VALUES (?, ?, 'P', 'middle', '[\"Remote\"]', 1, ?, ?)").run(id, `u${u}`, T, T);
      for (const [s, w] of [['Java', 5], ['Spring Boot', 5], ['PostgreSQL', 3]]) db.prepare('INSERT INTO profile_skills (profile_id, skill, weight) VALUES (?, ?, ?)').run(id, s, w);
    }
  }
  db.prepare("INSERT INTO profiles (id, user_id, name, locations, is_active, created_at, updated_at) VALUES ('p-noskill', 'u1', 'P', '[]', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO profiles (id, user_id, name, locations, is_active, created_at, updated_at) VALUES ('p-off', 'u1', 'P', '[]', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO profile_skills (profile_id, skill, weight) VALUES ('p-off', 'Java', 5)").run();
  kv.set('tgburst:u2', '1'); // u2 vừa nhận tin trong giờ này
}
const msgs = (bodies) => bodies.map((body) => ({ body, ack() {}, retry() {} }));
const run = (worker, queue, bodies, env) => worker.queue({ queue, messages: msgs(bodies), ackAll() {}, retryAll() { throw new Error('retryAll'); } }, env, {});

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const result = {};

  // --- score: lô đầy, 3 tin khớp mạnh + 7 tin yếu, 10 hồ sơ (+1 không skill, +1 tắt) ---
  const nScore = batchSize('jobpilot-score');
  {
    const S = fakeEnv(); seedProfiles(S);
    const ids = [];
    for (let i = 0; i < nScore; i++) {
      const strong = i < 3, id = `j${i}`; ids.push(id);
      S.db.prepare("INSERT INTO jobs (id, source_url, title, company, location, skills, content_hash, posted_at, first_seen_at, created_at) VALUES (?, ?, 'Backend Developer', 'Co', 'Remote (Worldwide)', ?, ?, ?, ?, ?)")
        .run(id, `https://x/${i}`, JSON.stringify(strong ? ['Java', 'Spring Boot', 'PostgreSQL'] : ['Rust', 'Elixir', 'Haskell']), `h${i}`, T, T, T);
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => { if (String(u).startsWith('https://tg.test')) S.stats.tg++; return new Response('{}'); };
    await run(worker, 'jobpilot-score', [...ids.map((jobId) => ({ kind: 'score', jobId })), { kind: 'score', jobId: 'missing' }].slice(0, nScore), S.env);
    globalThis.fetch = realFetch;
    const m = S.q('SELECT tier, COUNT(*) c FROM job_matches GROUP BY tier');
    result.score = { queries: S.stats.queries, matches: S.q('SELECT COUNT(*) c FROM job_matches')[0].c, strong: (m.find((r) => r.tier === 'strong') || {}).c,
      notifications: S.q("SELECT COUNT(*) c FROM notifications WHERE type = 'strong_match'")[0].c, broadcasts: S.stats.broadcasts, telegram: S.stats.tg };
    // chạy lại cùng lô: không nhân đôi notification (khử trùng theo người dùng + tin)
    await run(worker, 'jobpilot-score', ids.map((jobId) => ({ kind: 'score', jobId })), S.env);
    result.score.notificationsAfterRerun = S.q('SELECT COUNT(*) c FROM notifications')[0].c;

    // --- rescore_profile: lô đầy, mỗi tin 1 hồ sơ, chấm lại 500 tin mới nhất ---
    for (let i = nScore; i < 520; i++) S.db.prepare("INSERT INTO jobs (id, source_url, title, company, skills, content_hash, first_seen_at, created_at) VALUES (?, ?, 'Dev', 'Co', '[\"Java\"]', ?, ?, ?)").run(`j${i}`, `https://x/${i}`, `h${i}`, T - i, T);
    S.stats.queries = 0;
    const pids = S.q("SELECT id FROM profiles WHERE id GLOB 'p[0-9]*' ORDER BY id").map((r) => r.id).slice(0, batchSize('jobpilot-score'));
    await run(worker, 'jobpilot-score', pids.map((profileId) => ({ kind: 'rescore_profile', profileId })), S.env);
    result.rescore = { queries: S.stats.queries, matches: S.q('SELECT COUNT(*) c FROM job_matches')[0].c };
    // R1: một tin skills hỏng chỉ bỏ đúng tin đó, lô không bị retryAll (run() ném lỗi nếu retryAll).
    S.db.prepare("UPDATE jobs SET skills = '{hỏng' WHERE id = 'j0'").run(); S.db.prepare('DELETE FROM job_matches').run();
    await run(worker, 'jobpilot-score', ['j0', 'j1'].map((jobId) => ({ kind: 'score', jobId })), S.env);
    assert.deepStrictEqual(S.q('SELECT DISTINCT job_id FROM job_matches').map((r) => r.job_id), ['j1'], 'tin skills hỏng phải bị bỏ, tin còn lại vẫn chấm');
  }

  // --- ingest: lô đầy, mỗi tin nhắn 1 lần quét nguồn trả 50 tin, chồng lấn 25 tin với lần trước ---
  const nIngest = batchSize('jobpilot-ingest');
  {
    const S = fakeEnv();
    for (const t of ['remoteok', 'remotive']) S.db.prepare("INSERT INTO sources (id, type, name, created_at) VALUES (?, ?, ?, ?)").run(`src-${t}`, t, t, T);
    const calls = { remoteok: 0, remotive: 0 };
    const job = (t, i) => ({ title: 'Backend Developer', company: `C${i}`, url: `https://${t}.test/${i}`, desc: `Java Spring Boot PostgreSQL job ${i}` });
    // Có sẵn: 5 tin đã có JD, 5 tin JD rỗng (phải được bù JD rồi chấm lại), cùng hash với tin feed.
    for (let i = 0; i < 10; i++) {
      const j = job('remoteok', i), hash = require('crypto').createHash('sha256').update(`${j.title}|${j.company}|${j.url}`.toLowerCase()).digest('hex');
      S.db.prepare("INSERT INTO jobs (id, source_id, source_url, title, company, jd_text, skills, content_hash, posted_at, first_seen_at, created_at) VALUES (?, 'src-remoteok', ?, ?, ?, ?, '[]', ?, ?, ?, ?)")
        .run(`old${i}`, j.url, j.title, j.company, i < 5 ? 'jd cũ' : '', hash, T - 864000, T, T);
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const t = /remoteok/.test(u) ? 'remoteok' : 'remotive', k = calls[t]++;
      const list = Array.from({ length: 50 }, (_, n) => job(t, k * 25 + n));
      const body = t === 'remoteok'
        ? [{ legal: 1 }, ...list.map((j) => ({ position: j.title, company: j.company, url: j.url, date: new Date(T * 1000).toISOString(), tags: ['java'], description: j.desc }))]
        : { jobs: list.map((j) => ({ title: j.title, company_name: j.company, url: j.url, publication_date: new Date(T * 1000).toISOString(), tags: ['java'], description: j.desc })) };
      return new Response(JSON.stringify(body));
    };
    const logs = [], log = console.log; console.log = (...a) => logs.push(a.join(' '));
    try { await run(worker, 'jobpilot-ingest', Array.from({ length: nIngest }, (_, i) => ({ kind: 'ingest', sourceType: i % 2 ? 'remotive' : 'remoteok', keyword: '*' })), S.env); }
    finally { console.log = log; globalThis.fetch = realFetch; }
    const created = logs.filter((l) => l.startsWith('ingest ')).reduce((n, l) => n + JSON.parse(l.slice(l.indexOf('{'))).created, 0);
    result.ingest = { queries: S.stats.queries, jobs: S.q('SELECT COUNT(*) c FROM jobs')[0].c, created, scoreMsgs: S.stats.scoreMsgs.length,
      jdFilled: S.q("SELECT COUNT(*) c FROM jobs WHERE id LIKE 'old%' AND jd_text LIKE 'Java%'")[0].c, seenTwice: S.q('SELECT COUNT(*) c FROM jobs WHERE seen_count >= 2')[0].c,
      sourceRuns: S.q('SELECT COUNT(*) c FROM sources WHERE last_status = \'ok\'')[0].c };
  }

  console.log('d1-budget:', JSON.stringify(result));
  // Kết quả ghi (giống bản cũ — xem commit perf/d1-batch): 10 hồ sơ có skill × lô tin; 3 tin mạnh × 10 hồ sơ = 30 strong,
  // notification khử trùng theo người → 3 × 5 = 15; Telegram 1 tin/người: u1, u3 (u2 vướng tgburst, u4/u5 không có chat).
  assert.deepStrictEqual({ ...result.score, queries: 0 }, { queries: 0, matches: 10 * Math.min(nScore, 10), strong: 30, notifications: 15, broadcasts: 30, telegram: 2, notificationsAfterRerun: 15 });
  assert.strictEqual(result.rescore.matches, 10 * 300, 'rescore: 10 hồ sơ × 300 tin mới nhất (JOB_LIST_LIMIT, T-45)');
  // Ingest: 5 lần quét × 50 tin, mỗi lần chồng 25 → 150 URL mỗi nguồn; 10 tin có sẵn không tính created.
  const per = (Math.ceil(nIngest / 2) - 1) * 25 + 50;
  assert.deepStrictEqual({ ...result.ingest, queries: 0 }, { queries: 0, jobs: 2 * per, created: 2 * per - 10, scoreMsgs: 2 * per - 10 + 5, jdFilled: 5, seenTwice: 2 * (per - 50) + 10, sourceRuns: 2 });
  for (const k of ['score', 'rescore', 'ingest']) assert(result[k].queries <= BUDGET, `${k}: ${result[k].queries} truy vấn D1/lần chạy > ${BUDGET}`);
  console.log(`d1-budget selfcheck OK — truy vấn/lần chạy: score ${result.score.queries}, rescore ${result.rescore.queries}, ingest ${result.ingest.queries} (≤ ${BUDGET})`);
})().catch((e) => { console.error(e); process.exit(1); });
