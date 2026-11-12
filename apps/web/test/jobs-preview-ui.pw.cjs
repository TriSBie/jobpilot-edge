// PW=<path to playwright-core> node apps/web/test/jobs-preview-ui.pw.cjs <outDir>
// SPEC §3A UI: logo/chữ viết tắt, badge chế độ (chữ + icon, ≈ khi suy ra), địa chỉ -> Google Maps, ≤3 phúc lợi + "+n".
// Mock /api/jobs theo shape PR #10; tin không có dữ liệu mới thì thẻ phải y như cũ. 1280/390 × sáng/tối, 0 lỗi console.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhgGAnd2dVAAAAABJRU5ErkJggg==", "base64");
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], skills: [{ skill: "Java", weight: 5 }] };
const base = (i, x) => Object.assign({ id: "j" + i, title: "Job " + i, company: "Công ty Bbv " + i, location: "Hồ Chí Minh", source: "itviec", source_url: "https://itviec.com/j" + i,
  salary_text: "", match: { final_score: 90 - i, tier: "strong", matched_skills: ["Java"], missing_skills: [] }, application: null }, x);
const pv = (x) => Object.assign({ company_logo_url: null, address: null, benefits: [], work_mode_source: null }, x);
const jobs = [
  base(1, pv({ work_mode: "onsite", work_mode_source: "source", company_logo_url: "https://itviec.com/logo-ok.png", address: "Anna Building, QTSC, Quận 12, Hồ Chí Minh",
    benefits: ["Lương tháng 13", "Bảo hiểm sức khoẻ", "MacBook Pro", "Du lịch hằng năm", "Đào tạo"] })),
  base(2, pv({ work_mode: "hybrid", work_mode_source: "inferred", company_logo_url: "https://itviec.com/logo-broken.png", benefits: ["Hybrid 3/2"] })),
  base(3, pv({ work_mode: "remote", work_mode_source: "source", address: "Remote" })),
  base(4, pv({ work_mode: null, address: "12 Lý Thường Kiệt, Hoàn Kiếm, Hà Nội" })),
  base(5, pv({ work_mode: null })),            // shape #10, mọi trường mới null -> như cũ
  base(6, { work_mode: "onsite" }),            // API cũ, không có khoá mới -> như cũ
];
const waitFor = async (fn, msg) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(msg); };
async function open(browser, w, theme, lang = "vi") {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage(), errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errs.push("http " + r.status() + " " + r.url()); });
  await ctx.route(API + "/**", async (r) => {
    const u = new URL(r.request().url());
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send({ user: { id: "u1", name: "Minh", email: "qa@lab.vn", consent_cv_at: 1 }, profiles: [profile] });
    if (u.pathname === "/api/jobs") return send({ items: jobs, total: jobs.length, offset: 0, limit: 50, next_offset: null });
    const b = u.pathname === "/api/profiles" ? [profile] : u.pathname === "/api/applications" ? { items: [] } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] } : u.pathname === "/api/notifications" ? { items: [] } : u.pathname === "/api/public/sample" ? { items: [] } : null;
    send(b || { error: "not_found" }, b ? 200 : 404);
  });
  await ctx.route("https://itviec.com/logo-ok.png", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await ctx.route("https://itviec.com/logo-broken.png", (r) => r.fulfill({ status: 200, contentType: "image/png", body: "not a png" })); // giải mã lỗi -> onerror
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await ctx.route("file:///C:/favicon.svg", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 0},getResponse(){return ''},reset(){},remove(){}}" }));
  await ctx.addInitScript(([t, l]) => { localStorage.setItem("jp_theme", t); localStorage.setItem("jp_lang", l); localStorage.setItem("jp_token", "lab"); }, [theme, lang]);
  await page.goto(URL0);
  await page.waitForSelector("#jobsContainer .card");
  return { ctx, page, errs };
}
const card = (page, id) => `[data-job-id="${id}"]`;
const text = (page, id) => page.$eval(card(page, id), (e) => e.textContent.replace(/\s+/g, " ").trim());

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  try {
    for (const w of [1280, 390]) for (const theme of ["light", "dark"]) {
      const { ctx, page, errs } = await open(browser, w, theme);
      // j1: logo thật 32px, alt rỗng, lazy, no-referrer; tên công ty là chữ cạnh logo
      const img = await page.$eval(card(page, "j1") + " img.logo", (e) => ({ alt: e.getAttribute("alt"), l: e.loading, rp: e.referrerPolicy, w: e.getBoundingClientRect().width }));
      assert.deepEqual(img, { alt: "", l: "lazy", rp: "no-referrer", w: 32 });
      assert.match(await page.textContent(card(page, "j1") + " .co"), /Công ty Bbv 1/);
      // Chế độ: chữ + icon, thay chip MODE_LABEL cũ (không hiện cả hai)
      assert.equal(await page.textContent(card(page, "j1") + " .wm"), "Onsite bắt buộc");
      assert.equal(await page.$eval(card(page, "j1") + " .wm use", (e) => e.getAttribute("href")), "#building");
      assert.equal(await page.$$eval(card(page, "j1") + " .chip.mode", (e) => e.length), 0, "không trùng chip mode");
      // Địa chỉ: 1 dòng rút gọn, title đầy đủ, link Maps
      const a = await page.$eval(card(page, "j1") + " a.addr", (e) => ({ t: e.textContent, title: e.title, href: e.href, tg: e.target, rel: e.rel }));
      assert.deepEqual(a, { t: "Quận 12, Hồ Chí Minh", title: "Anna Building, QTSC, Quận 12, Hồ Chí Minh",
        href: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Anna Building, QTSC, Quận 12, Hồ Chí Minh"), tg: "_blank", rel: "noopener" });
      // Phúc lợi: 3 chip + "+2"
      assert.deepEqual(await page.$$eval(card(page, "j1") + " .bnf span", (e) => e.map((x) => x.textContent)), ["Lương tháng 13", "Bảo hiểm sức khoẻ", "MacBook Pro", "+2"]);
      // j2: logo lỗi -> chữ viết tắt; hybrid suy ra có ≈ + title
      await waitFor(async () => !(await page.$(card(page, "j2") + " img")), "logo lỗi không đổi sang chữ viết tắt");
      assert.equal(await page.textContent(card(page, "j2") + " .logo"), "CT");
      const wm2 = await page.$eval(card(page, "j2") + " .wm", (e) => ({ t: e.textContent, title: e.title }));
      assert.deepEqual(wm2, { t: "≈ Hybrid", title: "Suy ra từ tin, nguồn không ghi rõ" });
      assert.equal(await page.$$eval(card(page, "j2") + " .bnf span", (e) => e.length), 1);
      // j3: remote, logo null -> chữ viết tắt
      assert.equal(await page.textContent(card(page, "j3") + " .wm"), "Remote OK");
      assert.equal(await page.$eval(card(page, "j3") + " .wm use", (e) => e.getAttribute("href")), "#wifi");
      assert.equal(await page.$$eval(card(page, "j3") + " .bnf", (e) => e.length), 0, "không phúc lợi -> không hàng");
      // j4: có địa chỉ, chế độ null -> "Chưa rõ chế độ" màu mute
      assert.equal(await page.textContent(card(page, "j4") + " .wm.unk"), "Chưa rõ chế độ");
      assert.equal(await page.textContent(card(page, "j4") + " a.addr"), "Hoàn Kiếm, Hà Nội");
      // j5 (mọi trường mới null) & j6 (API cũ): y như thẻ cũ
      for (const id of ["j5", "j6"]) {
        assert.equal(await page.$$eval(card(page, id) + " :is(.logo,.wm,.addr,.bnf,.meta.pv)", (e) => e.length), 0, id + " có phần tử mới");
        assert.deepEqual(await page.$$eval(card(page, id) + " .meta span", (e) => e.map((x) => x.textContent)), ["Công ty Bbv " + id.slice(1), "Hồ Chí Minh"]);
      }
      assert.equal(await page.textContent(card(page, "j6") + " .chip.mode"), "Onsite", "API cũ vẫn giữ chip mode");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "tràn ngang " + w);
      // nhãn vẫn đọc được: chữ badge không trùng màu nền
      const c = await page.$eval(card(page, "j1") + " .bnf span", (e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
      assert.notEqual(c[0], c[1]);
      await page.$eval("#jobsContainer", (e) => e.scrollIntoView({ block: "start", behavior: "instant" })); await page.waitForTimeout(600);
      const f = path.join(OUT, `jobs-preview-${w}-${theme}.png`);
      await page.screenshot({ path: f }); shots.push(f);
      assert.deepEqual(errs, [], "lỗi console " + w + " " + theme + ": " + errs.join(" | "));
      console.log("ok", w, theme);
      await ctx.close();
    }
    // EN
    const { ctx, page, errs } = await open(browser, 1280, "light", "en");
    assert.equal(await page.textContent(card(page, "j1") + " .wm"), "Onsite only");
    assert.equal(await page.$eval(card(page, "j2") + " .wm", (e) => e.title), "Inferred from the posting, the source does not say");
    assert.equal(await page.textContent(card(page, "j4") + " .wm"), "Work mode unknown");
    assert.equal(await page.getAttribute(card(page, "j1") + " .bnf", "aria-label"), "Benefits");
    assert.deepEqual(errs, []);
    console.log("ok en");
    await ctx.close();
    console.log("jobs-preview-ui e2e OK\nshots: " + shots.join("\n       "));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
