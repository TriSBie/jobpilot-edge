// Tự kiểm cờ rủi ro tin ảo. Chạy: node apps/api/test/posting-risk.selfcheck.cjs
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8').replace(/\r\n/g, '\n');
const m = src.match(/const EN = \{[\s\S]*?\n\};\nfunction tr[\s\S]*?\n\}/)[0] + '\n' + src.match(/function postingFlags[\s\S]*?\n\}/)[0];
const postingFlags = new Function(m + '\nreturn postingFlags;')();
const N = 1_000_000, D = 86400;
const base = { posted_at: N - D, first_seen_at: N - D, last_seen_at: N, repost_count: 0, salary_text: '25 - 40 triệu', skillCount: 3 };
const types = (r, lang) => postingFlags({ ...base, ...r }, N, lang).map((f) => f.type);
assert.deepEqual(types({}), []);
assert.deepEqual(types({ repost_count: 2 }), ['reposted']);
assert.equal(postingFlags({ ...base, repost_count: 2 }, N, 'en')[0].label, 'Reposted (2)');
assert.deepEqual(types({ first_seen_at: N - 25 * D }), ['long_open']);
assert.ok(!types({ first_seen_at: N - 25 * D, last_seen_at: N - 3 * D }).includes('long_open'), 'đã gỡ thì không treo');
for (const s of [null, '', 'Thỏa thuận', 'THƯƠNG LƯỢNG', 'Negotiable']) assert.deepEqual(types({ salary_text: s }), ['salary_hidden'], String(s));
const gone = postingFlags({ ...base, last_seen_at: N - 3 * D }, N, 'vi');
assert.deepEqual(gone.map((f) => f.type), ['stale']); assert.equal(gone[0].label, 'Có thể đã gỡ');
assert.equal(postingFlags({ ...base, posted_at: N - 40 * D, first_seen_at: N - 2 * D }, N, 'vi')[0].label, 'Tin cũ 40 ngày');
const all = types({ last_seen_at: N - 3 * D, repost_count: 1, salary_text: null, skillCount: 13, dup: true });
assert.deepEqual(all, ['stale', 'duplicate', 'reposted', 'salary_hidden', 'bloated']);
console.log('posting-risk selfcheck OK');
// B1 (review 05/11): repost chỉ khi ngày đăng mới hơn >= 2 ngày; ITviec (nhãn tương đối) không được đẩy posted_at.
assert.ok(/repost_count \+ \(CASE WHEN \? >= COALESCE\(posted_at,0\) \+ 172800 THEN 1 ELSE 0 END\)/.test(src), 'repost threshold 2 days');
assert.ok(/const trust = sourceId === "src-itviec" \? 0 : posted \|\| 0;/.test(src), 'itviec posted_at not trusted');
console.log('posting-risk B1 OK');
// T-94: tin dán tay (source_id null / manual://) không bị "Có thể đã gỡ".
assert.ok(!types({ source_id: null, last_seen_at: N - 3 * D }).includes('stale'), 'dán tay không gone');
assert.ok(!types({ source_url: 'manual://abc', source_id: 'x', last_seen_at: N - 3 * D }).includes('stale'), 'manual:// không gone');
assert.deepEqual(types({ source_id: 'src-itviec', last_seen_at: N - 3 * D }), ['stale'], 'tin quét vẫn gone');
console.log('posting-risk T-94 OK');
