// Tự kiểm wrangler.toml.example khớp worker.js: mọi env.X có binding/var/secret khai báo,
// mỗi queue consumer có DLQ riêng `<queue>-dlq`, max_retries đúng theo queue, main trỏ đúng file.
// Chạy: node apps/api/test/wrangler-config.selfcheck.cjs apps/api/src/worker.js [apps/api/wrangler.toml.example]
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(process.argv[2] || 'apps/api/src/worker.js', 'utf8');
const toml = fs.readFileSync(process.argv[3] || 'apps/api/wrangler.toml.example', 'utf8').replace(/\r\n/g, '\n');

// ponytail: regex trên TOML phẳng của repo, không phải parser đầy đủ; đổi sang parser nếu toml có bảng lồng/inline phức tạp.
const live = toml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const declared = new Set([
  ...[...live.matchAll(/^\s*binding\s*=\s*"([A-Z_]+)"/gm)].map((m) => m[1]),
  ...[...live.matchAll(/\{\s*name\s*=\s*"([A-Z_]+)"/g)].map((m) => m[1]), // durable_objects
  ...[...(live.match(/^\[vars\]\n([\s\S]*?)(?=^\[)/m) || ['', ''])[1].matchAll(/^([A-Z_]+)\s*=/gm)].map((m) => m[1]),
  ...[...toml.matchAll(/^#\s*-\s*([A-Z_]+)\b/gm)].map((m) => m[1]), // secret/biến tuỳ chọn liệt kê ở comment cuối file
]);
const used = new Set([...src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
assert(used.size > 5, 'không đọc được env.X trong worker.js');
const missing = [...used].filter((x) => !declared.has(x));
assert.deepStrictEqual(missing, [], 'env.X dùng trong worker.js nhưng thiếu trong toml.example: ' + missing.join(', '));

assert.match(live, /^main\s*=\s*"src\/worker\.js"\s*$/m, 'main phải là src/worker.js');
assert(!/\[\[workflows\]\]/.test(live), 'không có Workflow class trong worker.js — bỏ [[workflows]]');

const consumers = live.split(/^\[\[queues\.consumers\]\]\s*$/m).slice(1).map((b) => b.split(/^\[/m)[0]);
const producers = [...live.matchAll(/^\[\[queues\.producers\]\]\n[\s\S]*?^queue\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
assert.strictEqual(consumers.length, 3, 'cần đúng 3 consumer (ingest, score, notify)');
const RETRIES = { 'jobpilot-ingest': 3, 'jobpilot-score': 3, 'jobpilot-notify': 5 }; // notify 5: anh chốt 06/11/2026
const seen = new Set();
for (const b of consumers) {
  const q = (b.match(/^queue\s*=\s*"([^"]+)"/m) || [])[1];
  const dlq = (b.match(/^dead_letter_queue\s*=\s*"([^"]+)"/m) || [])[1];
  assert(q && producers.includes(q), 'consumer không khớp producer: ' + q);
  assert.strictEqual(dlq, q + '-dlq', q + ' thiếu dead_letter_queue riêng');
  assert.strictEqual(Number((b.match(/^max_retries\s*=\s*(\d+)/m) || [])[1]), RETRIES[q], q + ' phải max_retries = ' + RETRIES[q]);
  seen.add(q);
}
assert.strictEqual(seen.size, 3, 'consumer bị trùng queue');

console.log('wrangler-config selfcheck OK — env đã khai báo: ' + used.size + ', consumer có DLQ: ' + seen.size);
