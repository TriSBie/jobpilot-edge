// Tự kiểm parseSalary. Chạy: node apps/api/test/salary.selfcheck.cjs
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8').replace(/\r\n/g, '\n');
const { parseSalary, monthlyVND, USD_VND } = new Function(src.match(/const USD_VND[^\n]*\n/)[0] + src.match(/function parseSalary\([\s\S]*?\n\}\n/)[0] + src.match(/function monthlyVND[\s\S]*?\n\}/)[0] + '\nreturn {parseSalary, monthlyVND, USD_VND};')();
const eq = (t, e) => assert.deepEqual(parseSalary(t), e, t);
eq('25 - 40 triệu', { min: 25e6, max: 40e6, currency: 'VND', period: 'month' });
eq('Up to 30 triệu', { min: 30e6, max: 30e6, currency: 'VND', period: 'month' });
eq('$80k - $100k/năm', { min: 80e3, max: 100e3, currency: 'USD', period: 'year' });
eq('$170k to $230k', { min: 170e3, max: 230e3, currency: 'USD', period: 'year' });
eq('USD 3,000 - 5,000', { min: 3000, max: 5000, currency: 'USD', period: 'month' });
eq('3000-5000 USD/month', { min: 3000, max: 5000, currency: 'USD', period: 'month' });
eq('$4k/month', { min: 4000, max: 4000, currency: 'USD', period: 'month' });
eq('Thỏa thuận', null); eq('', null);
assert.equal(monthlyVND(parseSalary('$120k/year')).min, 10000 * USD_VND);
console.log('salary selfcheck OK');
