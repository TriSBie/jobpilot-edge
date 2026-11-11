// PW=<path to playwright-core> node apps/web/test/filters.pw.cjs <outDir>
// Bộ lọc hình thức + lương (API mock lọc ở server như hợp đồng): chip aria-pressed gửi mode, lương tối thiểu + has_salary,
// đổi lọc thì tải lại trang 1, tổng = total của server, URL giữ bộ lọc qua reload, thẻ hiện badge + lương, empty state + Xoá bộ lọc. 1280/390.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], skills: [{ skill: "Java", weight: 5 }] };
const MODES = ["remote", "hybrid", "onsite", null];
// 70 job: (i-1)%4 quyết định hình thức; i%3: 0 = VNĐ, 1 = USD (API quy VNĐ, thẻ vẫn hiện salary_text gốc), 2 = không lương ("Thương lượng")
const jobs = Array.from({ length: 70 }, (_, k) => { const i = k + 1, s = i % 3;
  return { id: "j" + i, title: "Job " + i, company: "Acme", source: "itviec", source_url: "https://example.com/" + i, work_mode: MODES[(i - 1) % 4],
    salary_vnd_min: s === 0 ? (10 + i) * 1e6 : s === 1 ? 38250000 : null, salary_vnd_max: s === 0 ? (20 + i) * 1e6 : s === 1 ? 63750000 : null, salary_text: s === 0 ? "" : s === 1 ? "1,500 - 2,500 USD" : "Thương lượng",
    match: { final_score: 90 - (i % 50), tier: "strong", matched_skills: ["Java"], missing_skills: [] }, application: null }; });
function serve(q){
  const mode = q.get("mode"), ms = q.get("min_salary"), has = q.get("has_salary") === "1";
  if (mode && mode.split(",").some((m) => !["remote", "hybrid", "onsite"].includes(m))) return null;
  if (ms && !/^\d+$/.test(ms)) return null;
  let r = jobs.filter((j) => (!mode || mode.split(",").includes(j.work_mode)) && (!has || j.salary_vnd_min != null) && (!ms || j.salary_vnd_max == null || j.salary_vnd_max >= ms * 1e6));
  const off = Number(q.get("offset") || 0), lim = Number(q.get("limit") || 50), items = r.slice(off, off + lim);
  return { items, total: r.length, offset: off, limit: lim, next_offset: off + items.length < r.length ? off + items.length : null };
}
const waitFor = async (fn, msg) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(msg); };
async function open(browser, w, search = "") {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage(), calls = [], errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await ctx.route(API + "/**", async (r) => {
    const req = r.request(), u = new URL(req.url());
    calls.push(req.method() + " " + u.pathname + u.search);
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send({ user: { id: "u1", name: "Minh", email: "qa@lab.vn", consent_cv_at: 1 }, profiles: [profile] });
    if (u.pathname === "/api/jobs") { const b = serve(u.searchParams); return b ? send(b) : send({ error: "invalid_query" }, 400); }
    const b = u.pathname === "/api/profiles" ? [profile] : u.pathname === "/api/applications" ? { items: [] } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] } : u.pathname === "/api/notifications" ? { items: [] } : null;
    send(b || { error: "not_found" }, b ? 200 : 404);
  });
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 0},getResponse(){return ''},reset(){},remove(){}}" }));
  await ctx.addInitScript(() => { localStorage.setItem("jp_theme", "light"); localStorage.setItem("jp_lang", "vi"); localStorage.setItem("jp_token", "lab"); });
  await page.goto(URL0 + search);
  await page.waitForSelector("#jobsContainer .card");
  return { ctx, page, calls, errs };
}
const jobsCalls = (calls) => calls.filter((c) => c.startsWith("GET /api/jobs?"));
const count = (page) => page.textContent("#jobsCount");

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  for (const w of [1280, 390]) {
    const { ctx, page, calls, errs } = await open(browser, w);
    assert.equal((await count(page)).trim(), "70 tin", "tổng phải lấy total của server");
    // Thẻ: badge + lương VNĐ, USD giữ salary_text, "Thương lượng" không hiện
    const card = (id) => page.textContent(`[data-job-id="${id}"]`);
    assert.match(await card("j3"), /13–23 triệu\/tháng/); assert.match(await card("j3"), /Onsite/);
    assert.match(await card("j1"), /1,500 - 2,500 USD/); assert.doesNotMatch(await card("j1"), /triệu/, "USD: không hiện số quy đổi"); assert.match(await card("j1"), /Remote/);
    assert.doesNotMatch(await card("j2"), /Thương lượng/);
    assert.doesNotMatch(await card("j4"), /Remote|Hybrid|Onsite/, "work_mode null: không badge");
    // Chip hình thức: bàn phím, aria-pressed, gửi mode, tải lại trang 1
    await page.focus('.jf2 [data-mode="remote"]'); await page.keyboard.press("Enter");
    await page.click('.jf2 [data-mode="hybrid"]');
    assert.equal(await page.getAttribute('.jf2 [data-mode="remote"]', "aria-pressed"), "true");
    await waitFor(async () => jobsCalls(calls).some((c) => /mode=remote%2Chybrid/.test(c) && !/offset=/.test(c)), "không gửi mode: " + jobsCalls(calls).join(" | "));
    await waitFor(async () => (await count(page)).trim() === "36 tin", "total remote+hybrid sai: " + (await count(page)));
    // Xem thêm: trang 2 giữ bộ lọc
    await page.click("#loadMoreJobs");
    await waitFor(async () => (await page.$$("#jobsContainer .card")).length > 20, "không hiện thêm");
    // Lương tối thiểu + Chỉ tin có ghi lương
    await page.fill("#filterMinSal", "0");
    await waitFor(async () => /từ 1 đến 1000/.test(await page.textContent("#filterSalErr")), "không báo lỗi lương");
    await page.fill("#filterMinSal", "40");
    await page.check("#filterHasSal");
    await waitFor(async () => jobsCalls(calls).some((c) => /min_salary=40/.test(c) && /has_salary=1/.test(c)), "không gửi lương");
    const exp = serve(new URLSearchParams("mode=remote,hybrid&min_salary=40&has_salary=1")).total;
    await waitFor(async () => (await count(page)).trim() === exp + " tin", "total lương sai: " + (await count(page)) + " vs " + exp);
    assert.match(await page.textContent("#salHint"), new RegExp("^" + exp + " tin có ghi lương"));
    const u = new URL(page.url());
    assert.deepEqual([u.searchParams.get("mode"), u.searchParams.get("min_salary"), u.searchParams.get("has_salary")], ["remote,hybrid", "40", "1"]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "tràn ngang " + w);
    await page.$eval(".jf2", (e) => e.scrollIntoView({ block: "start", behavior: "instant" })); await page.waitForTimeout(500);
    let f = path.join(OUT, `filters-light-${w}.png`); await page.screenshot({ path: f }); shots.push(f);
    // Reload giữ bộ lọc
    await page.reload(); await page.waitForSelector("#jobsContainer .card");
    assert.equal(await page.getAttribute('.jf2 [data-mode="hybrid"]', "aria-pressed"), "true");
    assert.equal(await page.inputValue("#filterMinSal"), "40"); assert(await page.isChecked("#filterHasSal"));
    // Empty state + Xoá bộ lọc
    await page.click('.jf2 [data-mode="remote"]'); await page.click('.jf2 [data-mode="hybrid"]'); await page.click('.jf2 [data-mode="onsite"]');
    await page.fill("#filterMinSal", "999");
    await page.waitForSelector("#jobsClearFilters");
    assert.match(await page.textContent("#jobsContainer .empty"), /Không có job khớp bộ lọc/);
    await page.waitForTimeout(300);
    f = path.join(OUT, `filters-empty-light-${w}.png`); await page.screenshot({ path: f }); shots.push(f);
    await page.click("#jobsClearFilters");
    await waitFor(async () => (await count(page)).trim() === "70 tin", "Xoá bộ lọc không về 70");
    assert.equal(await page.getAttribute('.jf2 [data-mode="onsite"]', "aria-pressed"), "false");
    assert.equal(new URL(page.url()).search, "", "Xoá bộ lọc phải xoá query");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mode), "remote", "focus sau Xoá bộ lọc");
    // URL rác: bỏ qua giá trị sai
    await page.goto(URL0 + "?mode=remote,space&min_salary=-5&has_salary=yes"); await page.waitForSelector("#jobsContainer .card");
    await waitFor(async () => jobsCalls(calls).slice(-1)[0].includes("mode=remote&limit"), "URL rác: " + jobsCalls(calls).slice(-1)[0]);
    assert.deepEqual(errs, [], "lỗi trang: " + errs.join("; "));
    await ctx.close();
    console.log("ok", w);
  }
  await browser.close();
  console.log("filters e2e OK\n" + shots.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
