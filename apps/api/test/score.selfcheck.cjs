// Tự kiểm chấm điểm (T-46). Chạy: node apps/api/test/score.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8');

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
src.match(/const jdOf.*/)[0],
  src.match(/const REGION_LOCK.*/)[0],
  src.match(/const JD_REGION_LOCK.*/)[0],
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
  ['Senior Software Engineer (Java)', 'Hà Nội', ALL, (r) => r.finalScore <= 74, 'senior thuần + khác khu vực → không strong'],
  ['Sr Backend Engineer', 'Ho Chi Minh', ALL, (r) => r.finalScore <= 74, '"Sr" không dấu chấm vẫn nhận ra'],
  ['Mid/Sr Backend Engineer', 'Ho Chi Minh', ALL, (r) => r.tier === 'strong', 'nhiều cấp có Mid → không lệch (T-76)'],
  ['Backend Developer (Java)', 'Ho Chi Minh', ALL, (r) => r.tier === 'strong', 'đúng hết → strong'],
  ['Backend Developer (Java)', 'Remote', ALL, (r) => r.tier === 'strong', 'remote → strong'],
  ['Java Developer (Fresher)', 'Ho Chi Minh', ALL, (r) => r.tier === 'strong', 'middle nhận tin fresher: không phạt'],
  ['Backend Developer', 'Ho Chi Minh', ['Java'], (r) => r.finalScore <= 69, 'ít kỹ năng → tối đa 69'],
];
// T-60: remote khoá vùng → location 0, trần 74; remote mở / đúng thành phố → 8.
const fitBreakdown = new Function(code.replace('return { scoreJob };', 'return fitBreakdown;'))();
const loc = (location) => fitBreakdown(P, { title: 'Backend Developer', location, jd_text: '', posted_at: 1793346000 }).location;
for (const [location, want] of [['Remote (US only)', 0], ['Remote (Europe / US Eastern)', 0], ['Remote (Anywhere in the World)', 8], ['Remote', 8], ['Ho Chi Minh', 8], ['Remote (APAC)', 8], ['Remote (Australia)', 8]]) {
  console.log(String(loc(location)).padStart(3), '/ 8     |', location);
  assert.equal(loc(location), want, location);
}
assert.ok(run('Backend Developer (Java)', 'Remote (US only)').finalScore <= 74, 'remote US only → không strong');
// Kiểm thử người dùng: "chỉ nhận ở châu Âu" từng được 74 (không khớp khoá vùng). Ghi ở địa điểm hoặc trong JD đều phải khoá.
const locJ = (location, jd_text) => fitBreakdown(P, { title: 'Backend Developer', location, jd_text, posted_at: 1793346000 });
for (const [l, jd] of [['Remote (chỉ nhận ở châu Âu)', ''], ['Remote (European Union)', ''], ['Remote', 'We are hiring in Europe only.'], ['Remote', 'Candidates must be based in the EU.'],
  ['Remote', 'Chỉ nhận ứng viên tại châu Âu'], ['Remote', 'Open to candidates from the UK only'], ['Remote', 'This is a US-only role.']]) {
  const f = locJ(l, jd); assert.equal(f.location, 0, `${l} | ${jd}`); assert.ok(f.locationArg, `${l} | ${jd}: thiếu tên vùng`);
}
// JD chỉ nhắc tên vùng (không "only/based in") → không khoá; có Vietnam/APAC → không khoá.
for (const [l, jd] of [['Remote', 'We work with clients in Europe and the US.'], ['Remote', 'Our team is spread across Europe.'], ['Remote', 'HQ based in the US, we hire anywhere.'], ['Remote (APAC)', 'EU only']])
  assert.equal(locJ(l, jd).location, 8, `${l} | ${jd}`);
// Onsite có JD "EU only" không đổi (khoá vùng chỉ áp cho remote).
assert.equal(locJ('Ho Chi Minh', 'EU only').location, 8);
console.log('region lock (châu Âu, JD) OK');
for (const [title, loc, skills, ok, why] of cases) {
  const r = run(title, loc, skills);
  console.log(String(r.finalScore).padStart(3), r.tier.padEnd(8), '|', why);
  assert.ok(ok(r), why);
}
// Hồ sơ không chấp nhận remote, tin ở tỉnh khác → location 0 → không strong.
const noRemote = run('Backend Developer (Java)', 'Đà Nẵng', ALL, { level: 'middle', locations: ['Hồ Chí Minh'] });
console.log(String(noRemote.finalScore).padStart(3), noRemote.tier.padEnd(8), '| khác khu vực, không remote → không strong');
assert.ok(noRemote.finalScore <= 74);
// T-JD: JD đòi nhiều năm kinh nghiệm → level 2 (middle ≥ 7, junior ≥ 4); '-' coi như rỗng.
const lv = (jd, level = 'middle') => fitBreakdown({ level, locations: ['Remote'] }, { title: 'Backend Developer', location: 'Remote', jd_text: jd, posted_at: 1793346000 });
assert.equal(lv('We need 8+ years of experience with Java').level, 2, 'middle + 8 năm → 2');
assert.equal(lv('Yêu cầu từ 5 năm kinh nghiệm').level, 5, 'middle + 5 năm → giữ 5');
assert.equal(lv('at least 4 years', 'junior').level, 2, 'junior + 4 năm → 2');
assert.equal(lv('-', 'junior').level, 5, "'-' là rỗng");
// T-76: tin ghi nhiều cấp mà có cấp của hồ sơ → không lệch; chỉ lệch khi rõ ràng một phía.
const lvT = (title, level = 'middle') => fitBreakdown({ level, locations: ['Remote'] }, { title, location: 'Remote', jd_text: '', posted_at: 1793346000 }).level;
for (const t of ['Expert/Senior/Middle Software Engineer', 'Mid/Sr Java Engineer', 'Mid - Senior Software Engineer', 'Middle/Senior Backend Developer', 'Senior/Middle Node.js Developer', 'Mid to Senior Java Engineer'])
  assert.equal(lvT(t), 5, t);
assert.equal(lvT('Junior/Senior Developer', 'junior'), 5, 'junior trong nhiều cấp');
for (const [t, l] of [['Senior Java Engineer', 'middle'], ['Lead Backend Developer', 'middle'], ['Principal Software Engineer', 'junior'], ['Staff Engineer', 'middle'], ['Software Engineer Intern', 'senior']])
  assert.equal(lvT(t, l), 2, t);
// T-77: khoá vùng ghi trong tiêu đề.
const locT = (title, location = 'Remote') => fitBreakdown(P, { title, location, jd_text: '', posted_at: 1793346000 }).location;
for (const t of ['U.S. Based Remote Contractor', 'Remote (US only) Backend Engineer', 'Backend Engineer - EU timezone Remote']) assert.equal(locT(t), 0, t);
assert.equal(locT('Backend Engineer', 'Remote'), 8, 'tiêu đề thường vẫn khớp');
// T-07: bảng titleGate.
const { titleGate } = new Function(src.slice(src.indexOf('const TITLE_TECH'), src.indexOf('async function runIngestSource')) + 'return { titleGate };')();
for (const [t, want] of [['Backend Developer', 1], ['Java Engineer', 1], ['Software Engineer', 1], ['Node.js Developer', 1], ['QA Engineer', 1], ['Senior DevOps Engineer', 1], ['Fullstack Developer (React/Node)', 1], ['Mobile Developer (Android)', 1], ['Data Engineer', 1],
  ['Sales Engineer', 0], ['Pre-sales Engineer', 0], ['Presales Engineer', 0], ['Customer Support Engineer', 0], ['Content Engineer', 0], ['Engineering Manager', 0], ['Data Entry Clerk', 0], ['HR Recruiter', 0], ['Kế toán', 0]])
  assert.equal(titleGate(t), !!want, t);
console.log('OK');
// T-95: đại từ "us" không phải khoá vùng; Remote có Vietnam/APAC không khoá.
for (const t of ['Help us build Backend', 'Let us hire a Backend Engineer', 'Join us as Backend Dev']) assert.equal(locT(t), 8, t);
for (const l of ['Remote (US, Vietnam)', 'Vietnam or US Remote', 'Remote (US / APAC)']) assert.equal(loc(l), 8, l);
assert.equal(locT('Backend Engineer - US Remote'), 0, 'vẫn khoá US');
// T-96: năm kinh nghiệm chỉ khi câu có ngữ cảnh yêu cầu, ≤ 15.
assert.equal(lv('We have been in business for 20 years and love Java').level, 5, '20 years giới thiệu công ty');
assert.equal(lv('Founded 10 years ago, great culture').level, 5, 'giới thiệu 10 years');
assert.equal(lv('Requirements: 8 years of experience in Java').level, 2, 'vẫn bắt yêu cầu');
console.log('score T-95/T-96 OK');
