// node apps/web/test/quick-apply-flow.selfcheck.cjs [apps/web/public/index.html]
// P1 nộp nhanh: jobReady (C8) đúng luật; mọi chuỗi t("...") mới của khối P1 có bản EN; không có auto-submit/bulk.
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || "apps/web/public/index.html", "utf8");
const start = src.indexOf("/* Nộp nhanh hơn (P1, 3C)"), end = src.indexOf("function qaOpen(", start);
assert(start > 0 && end > start, "không thấy khối P1");
const block = src.slice(start, end);
// C8
const ready = new Function("STAGE_KEYS", block.match(/const jobReady = [^\n]+/)[0] + "\nreturn jobReady;")(["new", "saved", "applied", "interview", "offer", "rejected", "archived"]);
const J = (o) => Object.assign({ source_url: "https://x", flags: [], application: null }, o);
assert(ready(J({})), "tin mới có link: được");
assert(ready(J({ application: { stage: "saved" } })), "đã lưu: vẫn được");
assert(!ready(J({ source_url: "" })), "không link: không");
for (const s of ["applied", "interview", "offer", "rejected", "archived"]) assert(!ready(J({ application: { stage: s } })), "stage " + s);
assert(!ready(J({ flags: [{ type: "stale", label: "Có thể đã gỡ" }] })), "stale: không");
assert(ready(J({ flags: [{ type: "reposted" }] })), "cờ khác vẫn được");
// i18n: chuỗi trong t("…") của khối P1 phải có trong EN của khối
const en = new Function("const EN = {};" + block.match(/Object\.assign\(EN, \{[\s\S]*?\n\}\);/)[0] + "return EN;")();
const keys = [...block.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).concat([...block.matchAll(/\? "(Đã [^"]+%s)"/g)].map((m) => m[1]));
const known = new Set(["Đóng", "%s triệu/tháng"]); // đã dịch ở khối khác
const miss = [...new Set(keys)].filter((k) => !(k in en) && !known.has(k) && !src.includes(JSON.stringify(k) + ":"));
assert.deepEqual(miss, [], "thiếu EN: " + miss.join(" | "));
assert(src.includes('"Nộp được ngay"') && src.includes('data-en="Ready to apply"'), "nhãn lọc C8 chưa song ngữ");
// Luật cứng: không auto-submit / bulk apply
assert(!/\.submit\(\)|requestSubmit|bulk/i.test(block), "khối P1 không được auto-submit/bulk");
console.log("quick-apply-flow selfcheck OK");
