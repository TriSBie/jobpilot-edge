// node apps/web/test/enduser.selfcheck.cjs [apps/web/public/index.html]
// Khoảng trống end-user: haversine, parse #job/<id>, tham số sort, sắp phía client; mọi t("…") của khối có EN; PWA không cache /api.
const fs = require("fs"), path = require("path"), assert = require("assert");
const file = process.argv[2] || "apps/web/public/index.html", src = fs.readFileSync(file, "utf8");
const a = src.indexOf("/* EU-PURE start"), b = src.indexOf("/* EU-PURE end", a);
assert(a > 0 && b > a, "không thấy khối EU-PURE");
const { sortParam, parseJobHash, haversineKm, jobSort } = new Function(src.slice(a, b) + "\nreturn { sortParam, parseJobHash, haversineKm, jobSort };")();
// haversine: HCM (Q1) -> Hà Nội ~1137 km; cùng điểm = 0
const hcm = { lat: 10.7769, lng: 106.7009 }, hn = { lat: 21.0285, lng: 105.8542 };
assert(Math.abs(haversineKm(hcm, hn) - 1137) < 15, "HCM-HN " + haversineKm(hcm, hn));
assert.strictEqual(haversineKm(hcm, hcm), 0);
// deep link
assert.strictEqual(parseJobHash("#job/abc_12-3"), "abc_12-3");
for (const h of ["", "#job/", "#jobs", "#job/a/b", "#job/<x>", null, "#job/" + "a".repeat(81)]) assert.strictEqual(parseJobHash(h), "", String(h));
// sort: chỉ new/salary lên server
assert.deepStrictEqual(["score", "new", "salary", "distance", "x"].map(sortParam), ["", "new", "salary", "", ""]);
const L = [{ id: 1, posted_at: 5, salary_vnd_max: 0, lat: 21.03, lng: 105.85 }, { id: 2, posted_at: 9, salary_vnd_min: 30e6 }, { id: 3, posted_at: 7, salary_vnd_max: 50e6, lat: 10.78, lng: 106.7 }];
assert.deepStrictEqual(jobSort(L, "new").map(j => j.id), [2, 3, 1]);
assert.deepStrictEqual(jobSort(L, "salary").map(j => j.id), [3, 2, 1]);
assert.deepStrictEqual(jobSort(L, "distance", hcm).map(j => j.id), [3, 1, 2], "không toạ độ xuống cuối");
assert.deepStrictEqual(jobSort(L, "score").map(j => j.id), [1, 2, 3], "score giữ thứ tự server");
// i18n khối mới
const s = src.indexOf("/* ---------------- End-user gaps"), e = src.indexOf("(async function init(){", s);
const block = src.slice(s, e);
const en = new Function("const EN = {};" + block.match(/Object\.assign\(EN, \{[\s\S]*?\n\}\);/)[0] + "return EN;")();
const keys = [...new Set([...block.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1]))];
const miss = keys.filter(k => !(k in en) && !src.includes(JSON.stringify(k) + ":"));
assert.deepStrictEqual(miss, [], "thiếu EN: " + miss.join(" | "));
// PWA: sw không chạm /api, manifest hợp lệ, geolocation cho phép self
const pub = path.dirname(file);
const sw = fs.readFileSync(path.join(pub, "sw.js"), "utf8");
assert(/startsWith\("\/api\/"\)\) return|startsWith\("\/api\/"\)[^\n]*return;/.test(sw) && sw.includes("url.origin !== location.origin"), "sw phải bỏ qua /api và origin khác");
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pub, "manifest.webmanifest"), "utf8")).start_url, "/?source=pwa");
assert(/geolocation=\(self\)/.test(fs.readFileSync(path.join(pub, "_headers"), "utf8")), "_headers chặn geolocation");
console.log("enduser selfcheck OK");
