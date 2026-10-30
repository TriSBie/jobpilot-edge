// Tự kiểm chấm điểm (T-46). Chạy: node apps/api/test/score.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');

function block(start) {
  const s = src.indexOf(start);
  if (s < 0) throw new Error('không thấy ' + start);
  let d = 0;
  for (let j = src.indexOf('{', s); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(s, j + 1);
  }
}
const catalog = src.slice(src.indexOf('const SKILL_CATALOG'), src.indexOf('const CORE_SKILLS'));
const code = [
  'const now = () => 1793346000;',
  catalog,
  block('function normLoc'),
  block('function fitBreakdown'),
  block('function scoreJob'),
  'return { scoreJob };',
].join('\n');
const { scoreJob } = new Function(code)();

const P = { level: 'middle', locations: ['Hồ Chí Minh', 'Remote'] };
const S = [{ skill: 'Java', weight: 5 }, { skill: 'Spring Boot', weight: 5 }, { skill: 'PostgreSQL', weight: 3 }];
const ALL = ['Java', 'Spring Boot', 'PostgreSQL'];
const run = (title, location, skills = ALL, profile = P) =>
  scoreJob(profile, S, { title, location, skills, jd_text: '', posted_at: 1793346000 - 2 * 86400 });

const cases = [
  ['Expert/Senior/Middle Software Engineer (Java)', 'Hà Nội', ALL, (r) => r.finalScore <= 74, 'senior + khác khu vực → không strong'],
  ['Mid/Sr Backend Engineer', 'Ho Chi Minh', ALL, (r) => r.finalScore <= 74, '"Sr" không dấu chấm vẫn nhận ra'],
  ['Backend Developer (Java)', 'Ho Chi Minh', ALL, (r) => r.tier === 'strong', 'đúng hết → strong'],
  ['Backend Developer (Java)', 'Remote', ALL, (r) => r.tier === 'strong', 'remote → strong'],
  ['Java Developer (Fresher)', 'Ho Chi Minh', ALL, (r) => r.tier === 'strong', 'middle nhận tin fresher: không phạt'],
  ['Backend Developer', 'Ho Chi Minh', ['Java'], (r) => r.finalScore <= 69, 'ít kỹ năng → tối đa 69'],
];
for (const [title, loc, skills, ok, why] of cases) {
  const r = run(title, loc, skills);
  console.log(String(r.finalScore).padStart(3), r.tier.padEnd(8), '|', why);
  assert.ok(ok(r), why);
}
// Hồ sơ không chấp nhận remote, tin ở tỉnh khác → location 0 → không strong.
const noRemote = run('Backend Developer (Java)', 'Đà Nẵng', ALL, { level: 'middle', locations: ['Hồ Chí Minh'] });
console.log(String(noRemote.finalScore).padStart(3), noRemote.tier.padEnd(8), '| khác khu vực, không remote → không strong');
assert.ok(noRemote.finalScore <= 74);
console.log('OK');
