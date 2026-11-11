// node apps/web/test/wording-seo.selfcheck.cjs apps/web/public/index.html
// Kiểm tĩnh các mục review live (A5–A9 web, B, C1, C2, C4): đọc index.html như text, không cần trình duyệt.
const fs = require("fs"), path = require("path"), assert = require("assert");
const file = process.argv[2] || "apps/web/public/index.html", dir = path.dirname(file);
const src = fs.readFileSync(file, "utf8");
const has = (s, msg) => assert(src.includes(s), msg || "thiếu: " + s);
const no = (re, msg) => assert(!re.test(src), msg || "còn: " + re);
const ok = [];
const item = (id, fn) => { fn(); ok.push(id); };

item("A5 slider clamp", () => { has("mEl.max = req; var m = Math.min(Number(mEl.value), req)"); no(/var m = Number\(mEl\.value\)/); });
item("A6 counts", () => { has('t("%s/%s tin"'); has('"%s/%s tin": "%s/%s jobs"'); has("const jobsLeft = (state.jobsTotal != null && !clientFiltered ? state.jobsTotal : list.length) - visible;"); no(/t\("job"\)/); });
item("A7 bench guard", () => { has("u.count >= 5 && u.median_mid != null"); has("d.count >= 5 && d.median_mid != null"); no(/u\.count > 0 && u\.median_mid/); });
item("A9 lang param", () => { has('"/api/public/sample?lang=" + LANG'); has("level, location, lang: LANG }"); has("esc(t(j.salary))"); assert.equal((src.match(/map\(x => t\(x\.trim\(\)\.replace/g) || []).length, 2, "loc() phải qua t()"); });
item("B data claim", () => { no(/máy chủ của bạn/); has("Không bán dữ liệu, không chia sẻ CV, xoá được bất cứ lúc nào."); });
item("B tin/nộp", () => { no(/Đã apply/); no(/"[^"\n]*[à-ỹđ][^"\n]*\b[Jj]ob\b[^"\n]*"\s*:/, "khoá EN tiếng Việt còn chữ job"); has('label: "Đã nộp" }'); has('key: "applied"'); });
item("B explain", () => { has("Khớp %s/%s kỹ năng (kỹ năng %s) + phần còn lại %s (khu vực 8 + độ mới %s + cấp bậc 5) = %sđ, mức %s"); no(/rule %s\) \+ fit/); has('strong: "mạnh", partial: "một phần", weak: "yếu"'); });
item("D3 tier badge", () => { has("tierEl.textContent = t(TIER_VI[tier]);"); no(/tierEl.textContent = tier;/); has('class="badge strong" data-en="strong">mạnh<'); });
item("B xoá", () => no(/xóa|Xóa/));
item("B about", () => { no(/sg-log/); has('<p class="sg-about-note" data-en='); no(/sg-about-note hidden/); });
item("B testimonial", () => { has('<section class="lp-sec" id="lp-testi">'); has("Minh hoạ, không phải đánh giá của người dùng thật."); no(/lp-salary/); });
item("B negotiation", () => { has("Chỉ dùng khi bạn thật sự có offer khác:"); has("Only use this when you really have another offer:"); });
item("B kanban hint", () => { no(/nút mũi tên/); has("Đổi giai đoạn bằng ô chọn trên thẻ."); });
item("C1 404+favicon", () => {
  has('<link rel="icon" href="/favicon.svg"');
  assert(fs.existsSync(path.join(dir, "favicon.svg")), "thiếu favicon.svg");
  const nf = fs.readFileSync(path.join(dir, "404.html"), "utf8");
  assert(/<html lang="vi">/.test(nf) && /name="robots" content="noindex"/.test(nf) && /href="\/"/.test(nf), "404.html sai");
});
item("C2 hreflang", () => {
  no(/hreflang="en"/); no(/og:locale:alternate/); has('hreflang="vi"'); has('hreflang="x-default"'); has('"inLanguage":"vi"');
  no(/\?lang=en"/);
  assert(!/lang=en/.test(fs.readFileSync(path.join(dir, "sitemap.xml"), "utf8")), "sitemap còn ?lang=en");
});
item("C4 title/desc", () => {
  const T = "JobPilot — Chấm điểm việc làm IT theo CV của bạn, miễn phí", D = "Gom tin IT từ ITviec, TopDev và các trang remote, chấm khớp với CV kèm lý do, theo dõi đơn ứng tuyển và khung lương. Miễn phí cho lập trình viên Việt Nam.";
  has(`<title>${T}</title>`); has(`name="description" content="${D}"`);
  has(`og:title" content="${T}"`); has(`og:description" content="${D}"`); has(`twitter:title" content="${T}"`); has(`twitter:description" content="${D}"`);
  has(`"name":"JobPilot","url"`); has(`"description":"${D}"`);
});
console.log("wording-seo selfcheck OK: " + ok.join(" · "));
