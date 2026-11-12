// PW=<path to playwright-core> node apps/web/test/admin-ui.pw.cjs <outDir>
// Admin CRM (SPEC §3D) với API mock theo hợp đồng PR #11. Phục vụ apps/web/public qua http (pushState không chạy trên file://).
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path"), http = require("http"), fs = require("fs");
const OUT = process.argv[2] || ".";
const ROOT = path.resolve(__dirname, "../public");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const NOW = Math.floor(Date.now() / 1000);
const STAGES = ["applied", "interview", "saved", "offer", "rejected"];
// 53 đơn -> 24 + 24 + 5 trang
const APPS = Array.from({ length: 53 }, (_, i) => ({
  id: "a" + String(i).padStart(3, "0"), stage: STAGES[i % 5], applied_at: NOW - i * 3600, next_follow_up_at: null, updated_at: NOW - i * 3600, admin_note: i === 0 ? "đã gọi" : null,
  user: { id: "u" + (i % 4), email: `ung.vien${i % 4}@lab.vn`, name: "Ứng viên " + (i % 4) }, profile: { id: "p1", name: "Backend", level: "senior" },
  job: { id: "j" + i, title: `Backend Engineer ${i}`, company: `Công ty ${i}`, location: "HCM", source: "itviec", source_url: "https://itviec.com/x" + i, work_mode: "hybrid", company_logo_url: null },
  events_count: 2, last_event: { type: "stage_changed", created_at: NOW - i * 3600 }, rounds: { done: i % 3, total: 2 },
}));
const USERS = Array.from({ length: 4 }, (_, i) => ({ id: "u" + i, email: `ung.vien${i}@lab.vn`, name: "Ứng viên " + i, created_at: NOW - 86400 * i, last_active_day: Math.floor(NOW / 86400), ref_source: i ? "fb" : null,
  consent_cv_at: NOW, ai_opt_out: 0, telegram_linked: i === 1, deleted_at: null, profiles_count: 1, skills_count: 3, applications_count: 13, applied_count: 5 }));
const JOBS = Array.from({ length: 3 }, (_, i) => ({ id: "j" + i, title: "Java Dev " + i, company: "Acme " + i, location: "HN", source: "topcv", source_url: "https://topcv.vn/" + i, salary_text: null, posted_at: NOW,
  first_seen_at: NOW - 86400 * 20, last_seen_at: NOW, seen_count: 4, repost_count: i, jd_len: 900, work_mode: "onsite", flags: i ? ["reposted"] : [], applications_count: i, strong_count: 1 }));
const OVERVIEW = { users_total: 4, users_7d: 2, active_7d: 3, applications_by_stage: { new: 0, saved: 11, applied: 11, interview: 11, offer: 10, rejected: 10, archived: 0 }, applied_7d: 9,
  interviews_upcoming: 2, jobs_total: 3, jobs_24h: 1, quota: { "quota:gemini:2026-11-12": "37" },
  sources: [{ id: "itviec", type: "html", name: "ITviec", is_enabled: 1, last_run_at: NOW - 600, last_status: "ok", last_error: null },
    { id: "topcv", type: "html", name: "TopCV", is_enabled: 1, last_run_at: NOW - 900, last_status: "error", last_error: "HTTP 503" }],
  backups_last: { date: "2026-11-09", finished_at: new Date((NOW - 72 * 3600) * 1000).toISOString(), errors: {} },
  recent_events: [{ id: "e1", type: "stage_changed", created_at: NOW - 60, application_id: "a000", user_email: "ung.vien0@lab.vn", job_title: "Backend Engineer 0" }] };
function page(items, u){
  const limit = Math.min(50, +(u.searchParams.get("limit") || 20)), start = +(u.searchParams.get("cursor") || 0);
  const s = items.slice(start, start + limit);
  return { items: s, total: items.length, next_cursor: start + limit < items.length ? String(start + limit) : null };
}
function server(){
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html; charset=utf-8" : f.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream" });
      fs.createReadStream(f).pipe(r);
    }).listen(0, "127.0.0.1", () => res(s));
  });
}
async function open(browser, base, { w, h = 900, owner = true, token = "lab", url = "/admin/" }){
  APPS[0].admin_note = "đã gọi"; // mock bị PATCH ở lượt trước
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage(), calls = [], errs = [];
  pg.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  pg.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await ctx.route(API + "/**", async (r) => {
    const req = r.request(), u = new URL(req.url()), body = req.postData();
    calls.push(req.method() + " " + u.pathname + u.search + (body ? " " + body : ""));
    const send = (b, st = 200) => r.fulfill({ status: st, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(b) });
    const k = req.method() + " " + u.pathname;
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } });
    if (k === "GET /api/me") return send({ user: { id: "u9", name: "Tri", email: owner ? "owner@lab.vn" : "khach@lab.vn", is_owner: owner }, profiles: [] });
    if (k === "POST /api/auth/login") return send({ token: "lab", user: {} });
    if (!owner && u.pathname.startsWith("/api/admin")) return send({ error: "forbidden" }, 403);
    if (k === "GET /api/admin/overview") return send(OVERVIEW);
    if (k === "GET /api/admin/applications") {
      const st = u.searchParams.get("stage"), q = (u.searchParams.get("q") || "").toLowerCase();
      return send(page(APPS.filter((a) => (!st || a.stage === st) && (!q || a.job.title.toLowerCase().includes(q))), u));
    }
    let m;
    if ((m = u.pathname.match(/^\/api\/admin\/applications\/(.+)$/))) {
      const a = APPS.find((x) => x.id === m[1]); if (!a) return send({ error: "application_not_found" }, 404);
      if (req.method() === "PATCH") { const n = JSON.parse(body).admin_note; if (n && n.length > 2000) return send({ error: "admin_note_too_long", max: 2000 }, 400); a.admin_note = n || null; return send({ id: a.id, stage: a.stage, updated_at: NOW, admin_note: a.admin_note }); }
      return send(Object.assign({}, a, { note: null, created_at: NOW - 9e4, job: Object.assign({ salary_text: "Thoả thuận" }, a.job),
        events: [{ id: "e1", type: "stage_changed", payload: { from: "saved", to: "applied", via: "quick_apply" }, created_at: NOW - 3600 }], interviews: [] }));
    }
    if (k === "GET /api/admin/users") return send(page(USERS, u));
    if ((m = u.pathname.match(/^\/api\/admin\/users\/(.+)$/))) {
      const x = USERS.find((y) => y.id === m[1]); if (!x) return send({ error: "user_not_found" }, 404);
      return send(Object.assign({}, x, { digest_hour: 8, profiles: [{ id: "p1", name: "Backend", level: "senior", target_roles: ["Backend"], locations: ["HCM"], salary_min: 3e7, has_cv: 1, skills: [{ skill: "Java", weight: 5, source: "cv" }] }],
        applications: APPS.filter((a) => a.user.id === x.id).slice(0, 20).map((a) => ({ id: a.id, stage: a.stage, applied_at: a.applied_at, updated_at: a.updated_at, job: { id: a.job.id, title: a.job.title, company: a.job.company } })),
        events: [{ id: "e1", application_id: "a000", type: "stage_changed", payload: { to: "applied" }, created_at: NOW - 60 }] }));
    }
    if (k === "GET /api/admin/jobs") { const f = u.searchParams.get("flag"); return send(page(JOBS.filter((j) => !f || j.flags.includes(f)), u)); }
    send({ error: "not_found" }, 404);
  });
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 1},reset(){},getResponse(){return 't'}};window.onTs&&onTs()" }));
  if (token) await ctx.addInitScript((t) => localStorage.setItem("jp_token", t), token);
  await pg.goto(base + url);
  return { ctx, pg, calls, errs };
}
const box = (pg, sel) => pg.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cardTexts = (pg) => pg.$$eval("#main .card .nm", (els) => els.map((e) => e.textContent));
const near = (a, b, msg) => assert(Math.abs(a - b) <= 1, `${msg}: ${a} != ${b}`);
const noOverflow = (pg) => pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const ALLOWED = /^(GET|POST|PATCH|OPTIONS) \/api\/(auth\/|me($|\?)|admin\/)/;
(async () => {
  const srv = await server(), base = "http://127.0.0.1:" + srv.address().port;
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [], allCalls = [], allErrs = [];
  try {
    // 1) 1919: 254 / 56 / 403, gap 24, 3 cột lưới
    {
      const { ctx, pg, calls, errs } = await open(browser, base, { w: 1919, h: 1080, url: "/admin/?p=overview" });
      await pg.waitForSelector("#recent .act");
      await pg.waitForSelector("#ovList .card .nm");
      near((await box(pg, ".top")).h, 56, "top bar");
      near((await box(pg, ".side")).w, 254, "sidebar");
      near((await box(pg, ".ov > .col:first-child")).w, 403, "cột trái");
      const L = await box(pg, ".ov > .col:first-child"), R = await box(pg, "#ovList");
      near(R.x - (L.x + L.w), 24, "gap");
      assert.equal(await pg.$eval(".side", (e) => getComputedStyle(e).backgroundColor), "rgb(250, 250, 250)");
      assert.equal(await pg.textContent("#navPill"), "9");
      assert.match(await pg.textContent("#alerts"), /TopCV: HTTP 503/);
      assert.match(await pg.textContent("#alerts"), /Backup gần nhất cách đây 72 giờ/);
      assert.match(await pg.textContent("#alerts"), /DLQ: chưa đo/);
      const cols = await pg.$eval("#ovList #cards", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
      assert.equal(cols, 3, "3 cột lưới cạnh cột 403 ở 1919");
      assert.equal(await pg.$eval("#ovList #cards", (e) => getComputedStyle(e).columnGap), "24px");
      const c = await box(pg, "#ovList .card"); near(c.h, 124, "card cao");
      console.log("1919: card", Math.round(c.w) + "x" + Math.round(c.h));
      allCalls.push(...calls); allErrs.push(...errs); await ctx.close();
    }
    // 2) 1280: tải thêm hết trang, grid == list, menu •••, chi tiết + ghi chú, ảnh chụp
    for (const w of [1280, 390]) {
      const { ctx, pg, calls, errs } = await open(browser, base, { w, url: "/admin/?p=overview" });
      await pg.waitForSelector("#recent .act"); await pg.waitForSelector("#ovList .card .nm");
      await pg.screenshot({ path: path.join(OUT, `admin-overview-${w}.png`), fullPage: true }); shots.push(`admin-overview-${w}.png`);
      assert(await noOverflow(pg), "tràn ngang overview " + w);
      await pg.goto(base + "/admin/?p=apps&view=grid");
      await pg.waitForSelector("#main .card .nm");
      for (let i = 0; i < 5 && await pg.isVisible("#more"); i++) { const n = (await cardTexts(pg)).length; await pg.click("#more"); await pg.waitForFunction((n) => document.querySelectorAll("#main .card .nm").length > n, n); }
      assert.equal(await pg.isVisible("#more"), false, "hết trang thì ẩn Tải thêm");
      const grid = await cardTexts(pg);
      assert.equal(grid.length, 53, "đủ 53 đơn sau Tải thêm");
      assert.deepEqual(grid, APPS.map((a) => a.job.title), "đúng thứ tự, không trùng");
      assert.match(await pg.textContent("#count"), /Đã hiện hết 53/);
      assert.deepEqual(calls.filter((c) => c.startsWith("GET /api/admin/applications?limit=24")).map((c) => new URL("http://x" + c.split(" ")[1]).searchParams.get("cursor")), [null, "24", "48"]);
      await pg.evaluate(() => scrollTo(0, 0));
      await pg.screenshot({ path: path.join(OUT, `admin-apps-grid-${w}.png`) }); shots.push(`admin-apps-grid-${w}.png`);
      const gridFull = await pg.$$eval("#main .card", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
      await pg.click('.seg button[data-view="list"]');
      assert.match(pg.url(), /view=list/);
      assert.equal(await pg.$eval("#cards", (e) => e.className), "cards list");
      const listFull = await pg.$$eval("#main .card", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
      assert.deepEqual(listFull, gridFull, "grid và list cùng dữ liệu");
      if (w === 1280) near((await box(pg, "#main .card")).h, 75, "hàng list");
      await pg.screenshot({ path: path.join(OUT, `admin-apps-list-${w}.png`) }); shots.push(`admin-apps-list-${w}.png`);
      assert(await noOverflow(pg), "tràn ngang list " + w);
      // reload với ?view=list giữ nguyên kiểu
      await pg.reload(); await pg.waitForSelector("#main .card .nm");
      assert.equal(await pg.$eval("#cards", (e) => e.className), "cards list");
      // menu ••• : bàn phím, Esc trả focus
      await pg.focus("#main .card .more"); await pg.keyboard.press("Enter");
      assert.equal(await pg.$eval("#menu", (e) => e.className), "menu open");
      assert.deepEqual(await pg.$$eval("#menu button", (b) => b.map((x) => x.textContent)), ["Xem", "Xem ứng viên", "Mở tin gốc", "Ghi chú nội bộ", "Export JSON đơn này"]);
      await pg.keyboard.press("Escape");
      assert.equal(await pg.$eval("#menu", (e) => e.className), "menu");
      assert.equal(await pg.evaluate(() => document.activeElement.classList.contains("more")), true, "focus về nút •••");
      // chi tiết + ghi chú nội bộ
      await pg.click("#main .card .more"); await pg.click("#menu button:has-text('Ghi chú nội bộ')");
      await pg.waitForSelector("#note");
      assert.match(pg.url(), /p=app&id=a000/);
      assert.equal(await pg.evaluate(() => document.activeElement.id), "note");
      assert.equal(await pg.textContent("#noteCount"), "6/2000");
      await pg.fill("#note", "x".repeat(2100));
      assert.equal(await pg.textContent("#noteCount"), "2000/2000", "maxlength chặn ở 2000");
      await pg.fill("#note", "Đã hẹn gọi thứ 6");
      await pg.click("#noteSave"); await pg.waitForFunction(() => document.querySelector("#noteMsg").textContent === "Đã lưu ghi chú.");
      assert(calls.some((c) => c === 'PATCH /api/admin/applications/a000 {"admin_note":"Đã hẹn gọi thứ 6"}'), "PATCH admin_note");
      await pg.screenshot({ path: path.join(OUT, `admin-app-detail-${w}.png`), fullPage: true }); shots.push(`admin-app-detail-${w}.png`);
      await pg.fill("#note", ""); await pg.click("#noteSave"); await pg.waitForFunction(() => document.querySelector("#noteMsg").textContent === "Đã lưu ghi chú.");
      assert(calls.some((c) => c === 'PATCH /api/admin/applications/a000 {"admin_note":null}'), "xoá ghi chú gửi null");
      assert.match(await pg.textContent("#main"), /Đã lưu → Đã nộp qua Nộp nhanh/);
      // users -> chi tiết, jobs lọc cờ
      await pg.goto(base + "/admin/?p=users"); await pg.waitForSelector("#main .card .nm");
      assert.equal((await cardTexts(pg)).length, 4);
      await pg.click("#main .card .nm"); await pg.waitForSelector(".dhead h1");
      assert.equal(await pg.textContent(".dhead h1"), "ung.vien0@lab.vn");
      await pg.goto(base + "/admin/?p=jobs"); await pg.waitForSelector("#f-flag");
      await pg.waitForSelector("#main .card .nm");
      await pg.selectOption("#f-flag", "reposted"); await pg.waitForFunction(() => document.querySelectorAll("#main .card .nm").length === 2);
      assert(calls.some((c) => c.startsWith("GET /api/admin/jobs?") && c.includes("flag=reposted")));
      await pg.screenshot({ path: path.join(OUT, `admin-jobs-${w}.png`) }); shots.push(`admin-jobs-${w}.png`);
      // rỗng
      await pg.goto(base + "/admin/?p=apps&q=khongcogi"); await pg.waitForSelector(".empty");
      assert.match(await pg.textContent(".empty"), /Không có kết quả/);
      if (w === 390) { // drawer
        assert.equal(await pg.isVisible("#drawerBtn"), true);
        await pg.click("#drawerBtn"); assert.equal(await pg.$eval("#side", (e) => e.classList.contains("open")), true);
        await pg.keyboard.press("Escape"); assert.equal(await pg.$eval("#side", (e) => e.classList.contains("open")), false);
      }
      allCalls.push(...calls); allErrs.push(...errs); await ctx.close();
    }
    // 3) không phải owner: chỉ /api/me, không có dữ liệu
    {
      const { ctx, pg, calls, errs } = await open(browser, base, { w: 1280, owner: false, url: "/admin/?p=apps" });
      await pg.waitForSelector("#gTitle");
      assert.equal(await pg.textContent("#gTitle"), "Không có quyền");
      await pg.waitForTimeout(300);
      assert.deepEqual(calls, ["GET /api/me"], "non-owner không gọi gì khác");
      assert.equal(await pg.$$eval(".card, .side, #main", (e) => e.length), 0, "không render dữ liệu");
      await pg.screenshot({ path: path.join(OUT, "admin-forbidden-1280.png") }); shots.push("admin-forbidden-1280.png");
      allCalls.push(...calls); allErrs.push(...errs); await ctx.close();
    }
    // 4) chưa có token: form đăng nhập -> login -> vào được
    {
      const { ctx, pg, calls, errs } = await open(browser, base, { w: 390, token: null });
      await pg.waitForSelector("#lf");
      assert.equal(calls.length, 0, "chưa token thì không gọi API");
      await pg.screenshot({ path: path.join(OUT, "admin-login-390.png") }); shots.push("admin-login-390.png");
      await pg.fill("#lEmail", "owner@lab.vn"); await pg.fill("#lPass", "pw"); await pg.click("#lGo");
      await pg.waitForSelector("#recent .act");
      assert.equal(await pg.evaluate(() => localStorage.getItem("jp_token")), "lab");
      assert(calls[0].startsWith('POST /api/auth/login {"email":"owner@lab.vn","password":"pw","turnstile_token":"t"}'));
      allCalls.push(...calls); allErrs.push(...errs); await ctx.close();
    }
    const bad = allCalls.filter((c) => !ALLOWED.test(c));
    assert.deepEqual(bad, [], "chỉ gọi /api/auth/*, /api/me, /api/admin/*");
    assert.deepEqual(allErrs, [], "0 lỗi console");
    console.log(`admin-ui OK: ${allCalls.length} lời gọi API, 0 lỗi console\nshots: ${shots.map((s) => path.join(OUT, s)).join("\n       ")}`);
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
