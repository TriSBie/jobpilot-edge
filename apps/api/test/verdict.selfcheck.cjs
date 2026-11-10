// Chạy: node apps/api/test/verdict.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8');
const cut = (a) => { const s = src.indexOf(a); let d = 0; for (let j = src.indexOf('{', s); ; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(s, j + 1); } };
const EN = src.slice(src.indexOf('const EN = {'), src.indexOf('function tr(lang'));
const { verdictFor } = new Function(EN + cut('function tr(') + cut('function verdictFor') + 'return { verdictFor };')();
const miss = (...w) => ({ rule_detail: { missing: w.map((x, i) => ({ skill: 'S' + i, weight: x })) } });
const fit = (location = 8, level = 5) => ({ location, level });
const v = (m, f, fl, r, l) => verdictFor(m, f, fl, r, l);
assert.equal(v({ tier: 'strong', ...miss() }, fit(0)).verdict, 'skip');
assert.equal(v({ tier: 'partial', ...miss() }, fit(8, 2)).verdict, 'skip');
assert.equal(v({ tier: 'strong', ...miss() }, fit(8, 2)).verdict, 'apply');
assert.equal(v({ tier: 'strong', ...miss() }, fit(), [], 3).verdict, 'skip');
assert.equal(v({ tier: 'strong', ...miss() }, fit(), [{ type: 'stale' }]).verdict, 'skip');
assert.equal(v({ tier: 'partial', ...miss(5) }, fit(), [], undefined).verdict, 'apply');
const a = v({ tier: 'partial', ...miss(3, 5, 4, 4) }, fit(), [], 0, 'en');
assert.equal(a.verdict, 'apply_if'); assert.equal(a.why, 'Apply if you add S1, S2');
assert.equal(v({ tier: 'partial', ...miss(5, 5) }, fit(6)).why, 'Nộp nếu chấp nhận onsite');
assert.equal(v({ tier: 'partial', ...miss() }, fit(0), [], 0, 'en').why, 'Skip: location mismatch');
console.log('verdict selfcheck OK');
// S5 (review 05/11): tin weak không bao giờ "apply", dù thiếu ít skill.
assert.equal(v({ tier: 'weak', ...miss(3) }, fit()).verdict, 'apply_if');
assert.equal(v({ tier: 'partial', ...miss(3) }, fit()).verdict, 'apply');
console.log('verdict S5 OK');
