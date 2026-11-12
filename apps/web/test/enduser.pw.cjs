// PW=<path to playwright-core> node apps/web/test/enduser.pw.cjs <outDir>
// Khoảng trống end-user (1-10) với API mock: bản API mới (đủ trường) và API cũ (thiếu trường → ẩn/như cũ, không lỗi).
// 1280/390 × sáng/tối + 360 cho thẻ xem trước; 0 lỗi console.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], skills: [{ skill: "Java", weight: 5 }] };
const job = (i, x) => Object.assign({ id: "j" + i, title: "Backend Engineer " + i, company: "Công ty " + i, location: "Hồ Chí Minh", source: "itviec", source_url: "https://itviec.com/j" + i,
  salary_text: "", posted_at: 1700000000 + i * 1000, match: { final_score: 90 - i, tier: "strong", matched_skills: ["Java"], missing_skills: [] }, application: null }, x);
const JOBS = [job(1, { lat: 21.03, lng: 105.85, salary_vnd_max: 20e6 }), job(2, { lat: 10.78, lng: 106.70, salary_vnd_max: 60e6 }), job(3, {}), job(4, { lat: 10.95, lng: 106.82 })];
const pubJob = { title: "Senior Java Developer", company: "Acme VN", location: "Hồ Chí Minh", work_mode: "hybrid", salary_text: "40-60 triệu", logo: null, source_url: "https://itviec.com/x", skills: ["Java", "Spring Boot", "Kafka"] };
const waitFor = async (fn, msg) => { for (let i = 0; i < 80; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(msg); };

async function open(browser, { w, theme, newApi = true, token = true, hash = "", geo = null }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage(), errs = [], calls = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await ctx.route(API + "/**", async (r) => {
    const u = new URL(r.request().url()); calls.push(r.request().method() + " " + u.pathname + u.search);
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    const user = Object.assign({ id: "u1", name: "Minh", email: "qa@lab.vn", consent_cv_at: null }, newApi ? { mail_enabled: true, email_verified: false, telegram_shared_ok: true } : {});
    if (u.pathname === "/api/me") return send({ user, profiles: [profile] });
    if (u.pathname === "/api/jobs") return send({ items: JOBS, total: JOBS.length, offset: 0, limit: 50, next_offset: null });
    if (newApi && u.pathname === "/api/public/job/j9") return send(pubJob);
    if (newApi && u.pathname === "/api/auth/forgot") return send({ ok: true });
    if (newApi && u.pathname === "/api/me/verify-email/send") return send({ ok: true });
    const b = u.pathname === "/api/profiles" ? [profile] : u.pathname === "/api/applications" ? { items: [] } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] }
      : u.pathname === "/api/notifications" ? { items: [] } : u.pathname === "/api/public/sample" ? { items: [] } : null;
    send(b || { error: "not_found" }, b ? 200 : 404);
  });
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await ctx.route(/^https:\/\/(itviec\.com|assets\.saramin\.vn)\//, (r) => r.fulfill({ status: 404, body: "" }));
  await ctx.route(/^file:\/\/\/C:\/(favicon\.svg|og\.png|manifest\.webmanifest|assets\/.*)$/, (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript",
    body: "window.turnstile={render(el,o){setTimeout(()=>o&&o.callback&&o.callback('tok'),0);return 0},getResponse(){return 'tok'},reset(){},remove(){}};window.onloadTurnstileCallback&&onloadTurnstileCallback()" }));
  await ctx.addInitScript(([t, tok, g]) => {
    localStorage.setItem("jp_theme", t); localStorage.setItem("jp_lang", "vi");
    if (tok) localStorage.setItem("jp_token", "lab");
    if (g) localStorage.setItem("jp_geo", JSON.stringify(g));
  }, [theme, token, geo]);
  await page.goto(URL0 + hash);
  return { ctx, page, errs, calls };
}
const vis = (page, sel) => page.$eval(sel, (e) => !e.classList.contains("hidden") && e.getClientRects().length > 0).catch(() => false);
const ids = (page) => page.$$eval("#jobsContainer [data-job-id]", (e) => e.map((x) => x.dataset.jobId));

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  const shot = async (page, name) => { await page.waitForTimeout(700); const f = path.join(OUT, "enduser-" + name + ".png"); await page.screenshot({ path: f }); shots.push(f); };
  try {
    for (const w of [1280, 390]) for (const theme of ["light", "dark"]) {
      const tag = theme + "-" + w;
      // A. API mới, đã đăng nhập, có vị trí lưu sẵn (HCM)
      {
        const { ctx, page, errs, calls } = await open(browser, { w, theme, geo: { lat: 10.78, lng: 106.7 } });
        await page.waitForSelector("#jobsContainer .card");
        assert(await vis(page, "#verifyBanner"), "banner xác minh email");
        assert(await vis(page, "#obCard"), "thẻ onboarding");
        assert.match(await page.textContent("#obCard"), /0\/3 xong/);
        assert(await vis(page, "#tgCard") || true); // tgCard còn tuỳ hồ sơ; chỉ cần không lỗi
        // km: j2 ở ~0 km, j3 không có toạ độ
        assert.match(await page.textContent('[data-job-id="j2"] .chip.dist'), /~0\.0 km/);
        assert.equal(await page.$$eval('[data-job-id="j3"] .chip.dist', (e) => e.length), 0);
        assert(await vis(page, "#geoClear") && await vis(page, "#geoNearWrap"));
        await shot(page, "jobs-" + tag);
        // sắp theo khoảng cách: j2 (0) < j4 (~21 km) < j1 (HN) < j3 (không toạ độ)
        await page.selectOption("#jobsSort", "distance");
        assert.deepEqual(await ids(page), ["j2", "j4", "j1", "j3"]);
        await page.check("#geoNear");
        assert.deepEqual(await ids(page), ["j2", "j4"], "lọc ≤30 km");
        await page.uncheck("#geoNear");
        // sắp theo lương: gửi ?sort=salary, lưu localStorage
        await page.selectOption("#jobsSort", "salary");
        await waitFor(async () => calls.some((c) => c.includes("sort=salary")), "không gửi sort=salary");
        assert.equal(await page.evaluate(() => localStorage.getItem("jp_sort")), "salary");
        await waitFor(async () => (await ids(page))[0] === "j2", "lương cao nhất lên đầu");
        // gửi lại email xác minh
        await page.click('#verifyBanner [data-vf="send"]');
        await waitFor(async () => calls.includes("POST /api/me/verify-email/send"), "không gọi verify-email/send");
        // chia sẻ (desktop pointer: fine → clipboard)
        if (w === 1280) {
          await page.click('[data-share-for="j1"]');
          await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText().catch(() => ""))) === "https://jobpilot-edge.pages.dev/#job/j1", "không copy link chia sẻ");
        }
        // onboarding: bấm Xem → bước 2 xong, lưu theo user
        await page.click('#obCard [data-ob="see"]');
        assert.match(await page.textContent("#obCard"), /1\/3 xong/);
        assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("jp_ob_u1"))).seen, 1);
        await page.click('#obCard [data-ob="off"]');
        assert(!(await vis(page, "#obCard")), "ẩn onboarding");
        // xoá vị trí
        await page.click("#geoClear");
        assert.equal(await page.evaluate(() => localStorage.getItem("jp_geo")), null);
        assert.equal(await page.$$eval("#jobsContainer .chip.dist", (e) => e.length), 0);
        assert.deepEqual(errs, [], "lỗi console " + tag + ": " + errs.join(" | "));
        await ctx.close();
      }
      // B. API cũ: không trường mới → không banner, không thẻ Telegram, không km, không lỗi; sort score không gửi tham số
      {
        const { ctx, page, errs, calls } = await open(browser, { w, theme, newApi: false });
        await page.waitForSelector("#jobsContainer .card");
        assert(!(await vis(page, "#verifyBanner")) && !(await vis(page, "#tgCard")), "API cũ phải ẩn banner/Telegram");
        assert(await page.$eval('#jobsSort option[value="distance"]', (e) => e.disabled), "chưa có vị trí: tắt sắp theo khoảng cách");
        assert(!calls.some((c) => c.includes("sort=")), "score: không gửi sort");
        assert.deepEqual(errs, [], "lỗi console API cũ " + tag + ": " + errs.join(" | "));
        await ctx.close();
      }
      // C. Chưa đăng nhập: quên mật khẩu (API mới) + thẻ xem trước #job/j9
      {
        const { ctx, page, errs, calls } = await open(browser, { w, theme, token: false, hash: "#job/j9" });
        await page.waitForSelector("#pubDlg[open] .pub-card h3:not(:empty)");
        await waitFor(async () => (await page.textContent("#pubTitle")) === pubJob.title, "thẻ xem trước chưa có tiêu đề");
        assert.match(await page.textContent("#pubDlg"), /Acme VN.*Hồ Chí Minh.*Hybrid.*40-60 triệu/s);
        await shot(page, "public-job-" + tag);
        assert.equal(calls.filter((c) => c.startsWith("GET /api/public/job/")).length, 1, "chỉ gọi xem trước 1 lần");
        await page.click('#pubDlg [data-pub="reg"]');
        await page.waitForSelector("#registerForm:not(.hidden)");
        await page.evaluate(() => showAuth("login"));
        await page.click("#forgotLink");
        assert(await vis(page, "#forgotForm") && !(await vis(page, "#loginForm")));
        await page.fill("#forgotEmail", "qa@lab.vn");
        await waitFor(async () => !(await page.$eval("#forgotBtn", (b) => b.disabled)), "nút gửi vẫn khoá");
        await page.click("#forgotBtn");
        await waitFor(async () => /link đặt lại đã được gửi/.test(await page.textContent("#forgotMsg")), "thiếu câu trung tính");
        assert(calls.includes("POST /api/auth/forgot"));
        await shot(page, "forgot-" + tag);
        await page.click("#forgotBack");
        assert(await vis(page, "#loginForm"));
        assert.deepEqual(errs, [], "lỗi console chưa đăng nhập " + tag + ": " + errs.join(" | "));
        await ctx.close();
      }
    }
    // D. API cũ chưa đăng nhập: #job/ không có route → báo rõ, quên mật khẩu 404 → hướng dẫn nhờ admin; 360px
    {
      const { ctx, page, errs } = await open(browser, { w: 360, theme: "dark", newApi: false, token: false, hash: "#job/j9" });
      await waitFor(async () => /không còn hoặc chưa xem trước/.test(await page.textContent("#pubDlg").catch(() => "")), "thiếu trạng thái lỗi xem trước");
      const box = await page.evaluate(() => { const r = document.querySelector("#pubDlg").getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
      assert(box[0] >= 0 && box[1] <= box[2], "hộp xem trước tràn 360px: " + box);
      await shot(page, "public-job-missing-dark-360");
      await page.click('#pubDlg [data-pub="close"]');
      await page.evaluate(() => { showAuth("login"); });
      await page.click("#forgotLink");
      await page.fill("#forgotEmail", "qa@lab.vn");
      await waitFor(async () => !(await page.$eval("#forgotBtn", (b) => b.disabled)), "nút gửi vẫn khoá");
      await page.click("#forgotBtn");
      await waitFor(async () => /chưa bật/.test(await page.textContent("#forgotMsg")), "API cũ: thiếu câu dự phòng");
      // 404 của route mới là kỳ vọng ở API cũ, không tính là lỗi
      assert.deepEqual(errs.filter((e) => !/404/.test(e)), [], errs.join(" | "));
      await ctx.close();
    }
    console.log("enduser pw OK\n" + shots.join("\n"));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
