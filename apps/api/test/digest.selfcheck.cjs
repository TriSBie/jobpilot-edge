// Chạy: node apps/api/test/digest.selfcheck.cjs apps/api/src/worker.js
// Nạp worker.js, giả DB tối thiểu: kiểm tin phù hợp trong digest, GET không ghi, stage sai → 400.
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8').replace(/\r\n/g, '\n');
const W = new Function(src.replace(/^export default /m, 'const __w = ').replace(/^export /gm, '') + '\nreturn { __w, buildDigest, formatDigestTg };')();
(async () => {
  const t = Math.floor(Date.now() / 1000);
  const job = (title, location, score, extra = {}) => ({ title, company: 'C', location, source_url: 'https://x/' + title, first_seen_at: t - 3600, last_seen_at: t, posted_at: t - 3600, jd_text: '', final_score: score, tier: 'partial', missing_skills: '[]', ...extra });
  const cand = [
    job('ok1', 'Hồ Chí Minh', 70), job('ok2', 'Hồ Chí Minh', 65), job('ok3', 'Remote', 60), job('ok4', 'Hồ Chí Minh', 55),
    job('us-locked', 'Remote (US only)', 90), job('stale', 'Hồ Chí Minh', 80, { last_seen_at: t - 5 * 86400 }),
  ];
  let writes = 0;
  const mk = (rows) => { const DB = { prepare: (sql) => ({ bind() { return this; }, run: async () => { writes++; }, all: async () => ({
    results: /FROM profiles/.test(sql) ? [{ id: 'p', name: 'P', level: 'middle', locations: '["Hồ Chí Minh","Remote"]' }] : /FROM job_matches/.test(sql) && !/tier = 'strong'/.test(sql) ? rows : [] }) }),
    batch: async (l) => Promise.all(l.map((s) => s.all())) }; return { DB }; };
  const user = { id: 'u' };
  let d = await W.buildDigest(mk(cand), user, 'vi');
  assert.deepEqual(d.fresh.map((x) => x.title), ['ok1', 'ok2', 'ok3'], 'top 3, bỏ khoá vùng + stale');
  assert.equal(writes, 0, 'GET không ghi DB');
  await W.buildDigest(mk(cand), user, 'vi', null, true);
  assert.equal(writes, 1, 'persist ghi 1 lần');
  const tg = W.formatDigestTg(d);
  assert(tg.includes('3 tin mới phù hợp') && !tg.includes('us-locked'));
  d = await W.buildDigest(mk([cand[4], cand[5]]), user, 'vi');
  assert.equal(d.fresh.length, 0);
  assert.equal(W.formatDigestTg(d), null, '0/0/0 không gửi');
  assert(W.formatDigestTg({ date: '2026-11-05', strong: [], fresh: [], follow_ups: [{ title: 'a', company: 'b' }] }).includes('Hôm nay không có tin mới phù hợp'));
  assert(/APP_STAGES\.includes\(b\.stage\)\) return json\(\{ error: "invalid_stage" \}, 400\)/.test(src), 'validate stage');
  assert(/ownsProfile\(env, user, pid\)/.test(src), 'digest ownership');
  console.log('digest selfcheck OK');
})().catch((e) => { console.error(e); process.exit(1); });
// Tin "phù hợp" trong bản tin chỉ lấy tier partial (không nhồi tin weak cho đủ 3).
assert.ok(/m\.tier = 'partial' AND j\.first_seen_at >= \?/.test(src), 'fresh query must be partial-only');
console.log('digest partial-only OK');
