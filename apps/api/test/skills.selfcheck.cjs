// Sửa từng kỹ năng: POST /api/profiles/:id/skills (upsert 1) + DELETE /api/profiles/:id/skills/:skill (xoá 1).
// Hồi quy: bản cũ gửi cả danh sách lên /skills/confirm (DELETE hết + INSERT) nên client cũ làm mất kỹ năng.
// Chạy: node apps/api/test/skills.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { pathToFileURL } = require('url');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migDir = path.join(path.dirname(workerPath), '..', '..', '..', 'db', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(migDir).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const exec = (sql, args) => { const st = db.prepare(sql); if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) return st.all(...args); st.run(...args); return []; };
const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a),
  all: async () => ({ results: exec(sql, args) }), first: async () => exec(sql, args)[0] || null, run: async () => (exec(sql, args), { success: true }) });
const kv = new Map(), rescored = [];
const env = {
  DB: { prepare: (sql) => stmt(sql), batch: async (l) => { db.exec('BEGIN'); try { const r = l.map((s) => ({ results: exec(s.sql, s.args) })); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  Q_SCORE: { send: async (m) => { rescored.push(m); } }, Q_INGEST: { send: async () => {} },
};
const T = 1000;
for (const u of ['u1', 'u2']) {
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'U', ?)").run(u, u + '@x.test', T);
  db.prepare("INSERT INTO profiles (id, user_id, name, is_active, created_at, updated_at) VALUES (?, ?, 'P', 1, ?, ?)").run('p' + u, u, T, T);
  kv.set('session:tok-' + u, u);
}
const skills = (p = 'pu1') => db.prepare('SELECT skill, weight, source FROM profile_skills WHERE profile_id = ? ORDER BY skill').all(p).map((r) => ({ ...r }));

(async () => {
  const tmp = path.join(os.tmpdir(), `worker-skills-${process.pid}.mjs`);
  fs.copyFileSync(workerPath, tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const call = async (method, p, body, tok = 'tok-u1') => {
    const r = await worker.fetch(new Request('https://api.test' + p, { method, headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  const add = (skill, weight, p = 'pu1', tok) => call('POST', `/api/profiles/${p}/skills`, { skill, weight }, tok);

  // 1. thêm 5 kỹ năng lần lượt → còn đủ 5, mỗi lần trả profileWithSkills + rescore_queued, chuẩn hoá tên, weight kẹp 1..5
  const names = ['Kafka', 'redis', 'Docker', 'nodejs', 'Go'];
  let r;
  for (const [i, n] of names.entries()) {
    r = await add(n, [3, 9, -2, 4.6, undefined][i]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.skills.length, i + 1, 'kỹ năng trước đó không mất');
  }
  assert.strictEqual(r.body.rescore_queued, true);
  assert.strictEqual(r.body.id, 'pu1');
  assert(Array.isArray(r.body.locations) && Array.isArray(r.body.target_roles), 'cùng dạng /confirm');
  assert.deepStrictEqual(skills(), [
    { skill: 'Docker', weight: 1, source: 'manual' }, { skill: 'Go', weight: 3, source: 'manual' }, { skill: 'Kafka', weight: 3, source: 'manual' },
    { skill: 'Node.js', weight: 5, source: 'manual' }, { skill: 'Redis', weight: 5, source: 'manual' },
  ]);
  assert.strictEqual(rescored.length, 5, 'mỗi lần đổi đều chấm lại');
  assert(db.prepare("SELECT updated_at FROM profiles WHERE id = 'pu1'").get().updated_at > T, 'bump updated_at');

  // 2. thêm lại kỹ năng đã có với trọng số mới → cập nhật, không nhân bản; khác hoa thường cũng thay chứ không thêm dòng
  db.prepare("UPDATE profile_skills SET source = 'cv' WHERE skill = 'Kafka'").run();
  r = await add('Kafka', 5);
  assert.strictEqual(r.body.skills.length, 5);
  assert.deepStrictEqual(skills().find((s) => s.skill === 'Kafka'), { skill: 'Kafka', weight: 5, source: 'cv' }, 'đổi trọng số, giữ nguồn');
  await add('acmelib', 3); r = await add('AcmeLib', 2);
  assert.strictEqual(r.body.skills.length, 6, 'acmelib/AcmeLib không thành 2 dòng');
  assert.deepStrictEqual(skills().filter((s) => s.skill.toLowerCase() === 'acmelib'), [{ skill: 'AcmeLib', weight: 2, source: 'manual' }]);
  await call('DELETE', '/api/profiles/pu1/skills/AcmeLib');

  // 3. xoá một → 4 còn lại
  r = await call('DELETE', '/api/profiles/pu1/skills/Node.js');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(skills().map((s) => s.skill), ['Docker', 'Go', 'Kafka', 'Redis']);
  assert.deepStrictEqual(r.body.skills.map((s) => s.skill).sort(), ['Docker', 'Go', 'Kafka', 'Redis']);
  // tên có ký tự đặc biệt (encodeURIComponent phía web)
  await add('C#', 3);
  r = await call('DELETE', '/api/profiles/pu1/skills/' + encodeURIComponent('C#'));
  assert.strictEqual(r.body.skills.length, 4);
  // xoá kỹ năng không có → 200, không đổi gì
  assert.strictEqual((await call('DELETE', '/api/profiles/pu1/skills/Rust')).body.skills.length, 4);

  // 4. hồ sơ người khác → 404, không ghi gì
  r = await add('Java', 3, 'pu2');
  assert.deepStrictEqual([r.status, r.body.error], [404, 'profile_not_found']);
  r = await call('DELETE', '/api/profiles/pu1/skills/Go', undefined, 'tok-u2');
  assert.deepStrictEqual([r.status, r.body.error], [404, 'profile_not_found']);
  assert.strictEqual(skills('pu2').length, 0);
  assert.strictEqual(skills().length, 4);

  // 5. kỹ năng rỗng/sai kiểu → 400
  for (const b of [{ skill: '' }, { skill: '   ' }, { weight: 3 }, { skill: 5 }, { skill: 'x'.repeat(101) }, null]) {
    r = await call('POST', '/api/profiles/pu1/skills', b);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'invalid_skill'], JSON.stringify(b));
  }
  assert.strictEqual((await call('DELETE', '/api/profiles/pu1/skills/%20')).status, 400);
  assert.strictEqual((await call('DELETE', '/api/profiles/pu1/skills/%E0%A4%A')).status, 400, '%xx hỏng');
  assert.strictEqual(skills().length, 4);

  // 6. /skills/confirm vẫn thay cả danh sách (luồng CV/onboarding)
  r = await call('POST', '/api/profiles/pu1/skills/confirm', { skills: [{ skill: 'Java', weight: 4 }] });
  assert.deepStrictEqual(skills().map((s) => s.skill), ['Java']);

  console.log('skills selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
