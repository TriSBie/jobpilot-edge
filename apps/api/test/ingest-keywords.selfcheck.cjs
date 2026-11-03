// Tự kiểm ingestKeywords: gộp target_roles + 2 kỹ năng nặng nhất mỗi hồ sơ, dedupe, bỏ từ chung, cắt 12, DB lỗi → mặc định.
// Chạy: node apps/api/test/ingest-keywords.selfcheck.cjs apps/api/src/worker.js
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert(a >= 0 && b > a, from); return src.slice(a, b); };
const code = cut("const DEFAULT_KEYWORDS", "async function ensureSources") + "\nreturn { DEFAULT_KEYWORDS, ingestKeywords };";
const m = new Function(code)();
const db = (rows) => ({ DB: { prepare: () => ({ all: async () => { if (rows instanceof Error) throw rows; return { results: rows }; } }) } });
(async () => {
  const kws = await m.ingestKeywords(db([
    { target_roles: '["Backend Developer","Java"]', top: '["Java","Spring Boot"]' },                     // trùng nền
    { target_roles: '["Frontend Developer"," react "]', top: '["React","TypeScript"]' },                // dedupe react/React + trim
    { target_roles: '["Git","Go","REST APIs"]', top: '["Git","Agile"]' },                               // bỏ từ chung + ≤2 ký tự
  ]));
  assert.deepEqual(kws, [...m.DEFAULT_KEYWORDS, "Backend Developer", "Frontend Developer", "react", "TypeScript"]);
  const many = await m.ingestKeywords(db(Array.from({ length: 20 }, (_, i) => ({ target_roles: `["Role${i}"]`, top: "[]" }))));
  assert.equal(many.length, 12); assert.deepEqual(many.slice(0, 4), m.DEFAULT_KEYWORDS);
  assert.deepEqual(await m.ingestKeywords(db(new Error("D1 down"))), m.DEFAULT_KEYWORDS);
  assert.deepEqual(await m.ingestKeywords(db([])), m.DEFAULT_KEYWORDS);
  console.log("ingest-keywords selfcheck OK");
})().catch((e) => { console.error(e); process.exit(1); });
