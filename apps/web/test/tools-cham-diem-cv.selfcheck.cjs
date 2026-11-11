// node apps/web/test/tools-cham-diem-cv.selfcheck.cjs [apps/web/public/tools/cham-diem-cv.html]
// Kiểm tĩnh trang /tools/cham-diem-cv: title/meta, canonical, FAQPage JSON-LD khớp chữ trên trang, sitemap, link từ trang chủ.
const fs = require("fs"), path = require("path"), assert = require("assert");
const file = process.argv[2] || "apps/web/public/tools/cham-diem-cv.html", pub = path.join(path.dirname(file), "..");
assert(fs.existsSync(file), "thiếu " + file);
const src = fs.readFileSync(file, "utf8");
const URL = "https://jobpilot-edge.pages.dev/tools/cham-diem-cv";
const txt = (h) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const len = (s) => [...s].length;
const ok = [];
const item = (id, fn) => { fn(); ok.push(id); };

item("title≤60", () => { const t = txt(src.match(/<title>([\s\S]*?)<\/title>/)[1]); assert(len(t) <= 60, "title " + len(t)); });
item("desc≤155", () => { const d = src.match(/<meta name="description" content="([^"]*)"/)[1]; assert(len(d) <= 155, "desc " + len(d)); });
item("canonical", () => assert.equal(src.match(/<link rel="canonical" href="([^"]*)"/)[1], URL));
item("FAQPage", () => {
  const ld = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(ld.length, 1, "phải có đúng 1 ld+json");
  const j = JSON.parse(ld[0][1]);
  assert.equal(j["@type"], "FAQPage");
  assert.equal(j.mainEntity.length, 6, "phải 6 câu hỏi");
  const faq = src.slice(src.indexOf("<h2>Câu hỏi thường gặp</h2>"));
  const qa = [...faq.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [txt(m[1]), txt(m[2])]);
  assert.equal(qa.length, 6, "trang phải có 6 h3/p FAQ");
  j.mainEntity.forEach((q, i) => { assert.equal(q.name, qa[i][0]); assert.equal(q.acceptedAnswer.text, qa[i][1]); });
});
item("sitemap", () => assert(fs.readFileSync(path.join(pub, "sitemap.xml"), "utf8").includes(`<loc>${URL}</loc>`)));
item("wording", () => { assert(!/máy chủ của bạn/.test(src)); assert(!/xóa|Xóa/.test(src), "dùng xoá, không xóa"); });
item("no app JS", () => assert.equal((src.match(/<script\b/g) || []).length, 1, "chỉ được có script ld+json"));
item("#ats", () => assert(src.includes('id="ats"')));
item("home link", () => assert(fs.readFileSync(path.join(pub, "index.html"), "utf8").includes('href="/tools/cham-diem-cv"')));
item("no transition:all", () => assert(!/transition\s*:\s*all/.test(src)));
item("hover gated", () => src.split("\n").filter((l) => /:hover/.test(l)).forEach((l) => assert(l.includes("hover:hover"), "hover không gate: " + l.trim())));
item("view() reveal", () => assert(src.includes("animation-timeline:view()")));
item("hero proof", () => {
  const f = src.match(/<figure class="proof"[^>]*aria-label="[^"]+"[\s\S]*?<\/figure>/);
  assert(f, "thiếu card hero có aria-label");
  assert(/>77</.test(f[0]), "card hero phải có 77");
});
console.log("tools-cham-diem-cv selfcheck OK: " + ok.join(" · "));
