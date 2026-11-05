// Tự kiểm formatDigestTg. Chạy: node apps/api/test/telegram.selfcheck.cjs apps/api/src/worker.js
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8').replace(/\r\n/g, '\n');
const m = src.match(/const APP_URL[\s\S]*?function tgQuiet[\s\S]*?\n\}\n[\s\S]*?function formatDigestTg[\s\S]*?\n\}\n/);
assert(m, 'không thấy formatDigestTg');
const { formatDigestTg, tgQuiet } = new Function(m[0] + '\nreturn { formatDigestTg, tgQuiet };')();
assert.equal(formatDigestTg({ date: '2026-11-03', strong: [], follow_ups: [] }), null);
const strong = Array.from({ length: 8 }, (_, i) => ({ title: 'Dev <' + i + '> & co', company: 'C', source_url: 'https://x/' + i, final_score: 80.4 }));
const out = formatDigestTg({ date: '2026-11-03', strong, follow_ups: [{ title: 'a', company: 'b' }] });
assert(out.includes('JobPilot, 03/11') && out.includes('8 tin khớp mạnh mới') && out.includes('1 việc cần follow-up'));
assert.equal((out.match(/^• .*\(80\)/gm) || []).length, 5, '≤ 5 tin');
assert(out.includes('Dev &lt;0&gt; &amp; co') && !out.includes('<0>'), 'escape');
assert(out.endsWith('Mở JobPilot: https://jobpilot-edge.pages.dev'));
const T = (h) => Date.UTC(2026, 10, 3, h - 7);
assert(tgQuiet({}, T(23)) && tgQuiet({}, T(6)) && !tgQuiet({}, T(8)) && !tgQuiet({}, T(21)));
assert(!tgQuiet({ TELEGRAM_QUIET_OVERRIDE: '1' }, T(23)));
console.log('telegram selfcheck OK');
// T-99/T-98: mã link sống trong KV TTL 900s, không còn ghi vào cột; export/backup xoá telegram_link_code; enrichJd chỉ '-' khi 404/410.
assert(/KV\.put\(`tglink:\$\{code\}`, user\.id, \{ expirationTtl: 900 \}\)/.test(src) && !/SET telegram_link_code = \?/.test(src), 'link code vào KV TTL 900');
assert(/KV\.get\(`tglink:\$\{start\[1\]\}`\)/.test(src), 'webhook đọc KV');
assert(/delete u\.telegram_link_code/.test(src) && /delete r\.telegram_link_code/.test(src), 'export + backup bỏ mã');
assert(/HTTP \(\?:404\|410\)/.test(src) && /if \(gone\) await env\.DB\.prepare\("UPDATE jobs SET jd_text = '-'/.test(src), 'enrichJd chỉ 404/410');
console.log('telegram T-98/T-99 OK');
