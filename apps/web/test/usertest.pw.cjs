// PW=<path to playwright-core> node apps/web/test/usertest.pw.cjs <outDir>   (HTML=<path> để chạy trên bản khác, vd. tái hiện lỗi trên main)
// Lỗi user test: (1) Turnstile — nút gửi khoá tới khi widget có token, reset chỉ cấp token mới; (2) danh sách job phân trang
// limit/cursor + lỗi mạng có Thử lại; (3) "Điền hồ sơ từ CV" lưu văn bản CV khi Lưu hồ sơ. API + Turnstile mock, 1280/390.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(process.env.HTML || path.join(__dirname, "../public/index.html")).replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], skills: [{ skill: "Java", weight: 5 }] };
const job = (i) => ({ id: "j" + i, title: "Job " + i, company: "Acme", source: "itviec", source_url: "https://example.com/" + i, match: { final_score: 90 - (i % 50), tier: "strong", matched_skills: ["Java"], missing_skills: [] }, application: null });
// Turnstile giả: token chỉ có sau __tsPass(); reset xoá token (như widget thật).
const TS = `window.turnstile={w:[],render(sel,o){this.w.push({o,tok:""});return this.w.length-1},getResponse(i){return this.w[i].tok},reset(i){this.w[i].tok=""},remove(){}};
window.__tsPass=(n)=>turnstile.w.forEach(w=>{w.tok="tok"+(n||1);w.o.callback&&w.o.callback(w.tok)});`;
const waitFor = async (fn, msg) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(msg); };

async function open(browser, w, { token = "lab", jobsMode = "ok", consent = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage(), calls = [], errs = [], st = { jobsFail: jobsMode === "down" ? 1 : 0, moreFail: 1, register: [] };
  page.on("pageerror", (e) => errs.push(e.message));
  await ctx.route(API + "/**", async (r) => {
    const req = r.request(), u = new URL(req.url()), body = req.postData();
    calls.push(req.method() + " " + u.pathname + u.search + (body ? " " + body : ""));
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/auth/register") { const b = JSON.parse(body); st.register.push(b.turnstile_token); return b.turnstile_token ? send({ error: "email_taken" }, 409) : send({ error: "turnstile_failed" }, 403); }
    if (u.pathname === "/api/me") return send({ user: { id: "u1", name: "Minh", email: "qa@lab.vn", consent_cv_at: consent ? 1 : null }, profiles: [profile] });
    if (u.pathname === "/api/jobs") {
      if (st.jobsFail-- > 0) return r.abort("internetdisconnected");
      const off = Number(u.searchParams.get("offset") || 0);
      if (!off) return send({ items: Array.from({ length: 50 }, (_, i) => job(i + 1)), total: 60, offset: 0, limit: 50, next_offset: 50 });
      if (st.moreFail-- > 0) return send({ error: "server_error" }, 500);
      return send({ items: Array.from({ length: 10 }, (_, i) => job(i + 51)), total: 60, offset: 50, limit: 50, next_offset: null });
    }
    if (u.pathname === "/api/profiles/p1/cv-text") return send({ file_id: "f1", suggested_skills: [] });
    if (u.pathname === "/api/profiles/p1" && req.method() === "PATCH") return send({ ...profile, ...JSON.parse(body) });
    const b = u.pathname === "/api/profiles" ? [profile] : u.pathname === "/api/applications" ? { items: [] } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] } : u.pathname === "/api/notifications" ? { items: [] } : null;
    send(b || { error: "not_found" }, b ? 200 : 404);
  });
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: TS + "window.onloadTurnstileCallback&&setTimeout(onloadTurnstileCallback)" }));
  await ctx.addInitScript((tok) => { localStorage.setItem("jp_theme", "dark"); localStorage.setItem("jp_lang", "vi"); if (tok) localStorage.setItem("jp_token", tok); }, token);
  await page.goto(URL0);
  return { ctx, page, calls, errs, st };
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  const shot = async (page, name, sel) => { if (sel) await page.$eval(sel, (e) => e.scrollIntoView({ block: "center", behavior: "instant" })); const f = path.join(OUT, name + ".png"); await page.screenshot({ path: f }); shots.push(f); };
  for (const w of [1280, 390]) {
    // ---- 1. Đăng ký: chưa có token thì không gửi được; xác minh xong mới gửi, token đúng; lỗi thì reset và khoá lại ----
    {
      const { ctx, page, errs, st } = await open(browser, w, { token: "" });
      await page.evaluate(() => showAuth("register"));
      await page.waitForFunction(() => window.turnstile && turnstile.w.length > 0);
      await page.fill("#regName", "Minh QA"); await page.fill("#regEmail", "qa@lab.vn");
      await page.fill("#regPassword", "Passw0rd!x"); await page.fill("#regPassword2", "Passw0rd!x");
      await page.focus("#regPassword2"); await page.keyboard.press("Enter"); // gửi trước khi widget xong (đúng thao tác của user)
      await page.waitForTimeout(400);
      assert.deepEqual(st.register, [], "gửi đăng ký khi chưa có token: " + JSON.stringify(st.register));
      assert(await page.$eval("#registerBtn", (b) => b.disabled), "nút Tạo tài khoản phải khoá khi chưa xác minh");
      await shot(page, `register-waiting-${w}`, "#registerBtn");
      await page.evaluate(() => __tsPass(1));
      assert(!(await page.$eval("#registerBtn", (b) => b.disabled)), "xác minh xong phải mở nút");
      await page.click("#registerBtn");
      await waitFor(async () => st.register.length === 1, "không gửi đăng ký");
      assert.equal(st.register[0], "tok1");
      await page.waitForFunction(() => /tài khoản/.test(document.querySelector("#registerError").textContent));
      assert(await page.$eval("#registerBtn", (b) => b.disabled), "sau lần gửi lỗi: token cũ đã dùng, nút khoá tới khi có token mới");
      await page.evaluate(() => __tsPass(2)); await page.click("#registerBtn");
      await waitFor(async () => st.register.length === 2, "không gửi lần 2");
      assert.equal(st.register[1], "tok2", "lần 2 phải dùng token mới, không dùng lại token cũ");
      assert.deepEqual(errs, []);
      await ctx.close();
    }
    // ---- 2. Danh sách job: lỗi mạng có Thử lại; 50/trang, Xem thêm hiện dần rồi gọi trang kế; lỗi trang kế có Thử lại ----
    {
      const { ctx, page, calls, errs } = await open(browser, w, { jobsMode: "down" });
      await page.waitForSelector("#jobsRetryBtn");
      assert.match(await page.textContent("#jobsContainer"), /Không kết nối được máy chủ/);
      await shot(page, `jobs-offline-${w}`, "#jobsRetryBtn");
      await page.focus("#jobsRetryBtn"); await page.keyboard.press("Enter");
      await page.waitForSelector("#jobsContainer .card");
      assert(calls.some((c) => /GET \/api\/jobs\?.*limit=50/.test(c)), "thiếu limit=50");
      assert.equal(await page.$$eval("#jobsContainer .card", (x) => x.length), 20);
      await page.click("#loadMoreJobs"); await page.click("#loadMoreJobs");
      assert.equal(await page.$$eval("#jobsContainer .card", (x) => x.length), 50);
      assert.match((await page.textContent("#loadMoreJobs")).trim(), /^Xem thêm \(\d+ tin còn lại\)$/);
      await shot(page, `jobs-more-${w}`, "#loadMoreJobs");
      await page.click("#loadMoreJobs");
      await page.waitForSelector(".loadmore[role=alert] #loadMoreJobs");
      assert.match(await page.textContent(".loadmore[role=alert]"), /Không tải thêm được tin/);
      await shot(page, `jobs-more-error-${w}`, "#loadMoreJobs");
      await page.click("#loadMoreJobs");
      await waitFor(async () => (await page.$$eval("#jobsContainer .card", (x) => x.length)) === 60, "không nối trang 2");
      assert(calls.some((c) => /offset=50/.test(c) && /limit=50/.test(c)));
      assert.equal(await page.$("#loadMoreJobs"), null, "hết trang thì không còn nút");
      assert.equal(await page.evaluate(() => document.activeElement.textContent), "Job 51", "focus về job đầu của trang mới");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "tràn ngang");
      assert.deepEqual(errs, []);
      await ctx.close();
    }
  }
  // ---- 3. Điền hồ sơ từ CV → Lưu hồ sơ gửi cv-text với văn bản CV ----
  {
    const { ctx, page, calls, errs } = await open(browser, 1280);
    await page.waitForSelector("#jobsContainer .card");
    await page.evaluate(() => switchTab("profile"));
    const cv = "Nguyen Van Minh\nBackend Developer\nSkills: Java, Spring Boot, Kafka, PostgreSQL, Docker\n" + "Built loyalty platform services. ".repeat(5);
    await page.setInputFiles("#cvDraftFile", { name: "cv.txt", mimeType: "text/plain", buffer: Buffer.from(cv) });
    await page.click("#cvDraftBtn");
    await page.waitForFunction(() => /Đã đọc/.test(document.querySelector("#cvDraftStatus").textContent));
    assert(!calls.some((c) => c.includes("cv-text")), "chưa bấm Lưu thì chưa gửi CV");
    await page.click("#pfSaveBtn");
    await waitFor(async () => calls.some((c) => c.startsWith("POST /api/profiles/p1/cv-text")), "Lưu hồ sơ không lưu CV");
    const sent = JSON.parse(calls.find((c) => c.startsWith("POST /api/profiles/p1/cv-text")).replace(/^POST \S+ /, ""));
    assert.equal(sent.filename, "cv.txt"); assert.equal(sent.text, cv.trim());
    assert.deepEqual(errs, []);
    await ctx.close();
  }
  await browser.close();
  console.log("usertest OK\n" + shots.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
