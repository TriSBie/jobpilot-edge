// PW=<path to playwright-core> node apps/web/test/quick-apply-flow.pw.cjs <outDir>
// P1 nộp nhanh (API mock): C8 lọc "Nộp được ngay"; C1 "Đã nộp" trên thẻ -> POST quick applied, toast Hoàn tác -> PATCH stage cũ;
// lỗi API -> toast lỗi, thẻ giữ nguyên; C2 checklist lưu localStorage theo job, không chặn nút; C3 j/k/a/s/x/?, tắt khi gõ.
// 1280/390 × sáng/tối, 0 lỗi console.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], salary_min: 30000000, skills: [{ skill: "Java", weight: 5 }] };
const mkJobs = () => Array.from({ length: 6 }, (_, k) => ({ id: "j" + (k + 1), title: "Job " + (k + 1), company: "Acme", source: "itviec",
  source_url: k === 3 ? "" : "https://example.com/" + (k + 1), work_mode: "hybrid", salary_vnd_min: 20e6, salary_vnd_max: k === 0 ? 25e6 : 40e6, salary_text: "",
  flags: k === 4 ? [{ type: "stale", label: "Có thể đã gỡ" }] : [], verdict: "apply",
  match: { final_score: 90 - k, tier: "strong", matched_skills: ["Java"], missing_skills: ["Kafka"] },
  application: k === 5 ? { id: "a6", stage: "applied" } : null }));
const waitFor = async (fn, msg) => { for (let i = 0; i < 80; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(msg); };

async function open(browser, w, theme, failQuick = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage(), calls = [], errs = [], jobs = mkJobs(), apps = {};
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text() + " @ " + (m.location().url || "")); });
  await ctx.route(API + "/**", async (r) => {
    const req = r.request(), u = new URL(req.url()), body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push(req.method() + " " + u.pathname + (body ? " " + JSON.stringify(body) : ""));
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    const p = u.pathname;
    if (p === "/api/me") return send({ user: { id: "u1", name: "Minh", email: "qa@lab.vn", consent_cv_at: 1 }, profiles: [profile] });
    if (p === "/api/jobs") return send({ items: jobs.map((j) => Object.assign({}, j, { application: apps[j.id] || j.application })), total: jobs.length, offset: 0, limit: 50, next_offset: null });
    if (p === "/api/applications/quick") {
      if (failQuick) return send({ error: "job_not_found" }, 404);
      const a = apps[body.job_id] = Object.assign({ id: "a-" + body.job_id }, apps[body.job_id], { stage: "applied", next_follow_up_at: 999 });
      return send(a);
    }
    if (p === "/api/applications" && req.method() === "POST") return send(apps[body.job_id] = { id: "a-" + body.job_id, stage: body.stage });
    const m = p.match(/^\/api\/applications\/([^/]+)$/);
    if (m && req.method() === "PATCH") { const id = Object.keys(apps).find((k) => apps[k].id === m[1]); Object.assign(apps[id], body); return send(apps[id]); }
    if (p === "/api/public/sample") return send({ items: [] });
    const b = p === "/api/profiles" ? [profile] : p === "/api/applications" ? { items: [] } : p === "/api/digest/today" ? { strong: [], follow_ups: [] } : p === "/api/notifications" ? { items: [] } : null;
    send(b || { error: "not_found" }, b ? 200 : 404);
  });
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 0},getResponse(){return ''},reset(){},remove(){}}" }));
  await ctx.route("file:///C:/favicon.svg", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" })); // trên Pages là /favicon.svg
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: "" }));
  await ctx.addInitScript((th) => { localStorage.setItem("jp_theme", th); localStorage.setItem("jp_lang", "vi"); localStorage.setItem("jp_token", "lab"); }, theme);
  await page.goto(URL0);
  await page.waitForSelector("#jobsContainer .card");
  await page.evaluate(() => window.open = () => null); // không mở tab thật
  return { ctx, page, calls, errs };
}
const ids = (page) => page.$$eval("#jobsContainer .card", (cs) => cs.map((c) => c.dataset.jobId));
const toastText = (page) => page.textContent("#toasts").catch(() => "");

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  for (const w of [1280, 390]) for (const theme of ["light", "dark"]) {
    const { ctx, page, calls, errs } = await open(browser, w, theme);
    // C8
    assert.deepEqual(await ids(page), ["j1", "j2", "j3", "j4", "j5", "j6"]);
    await page.check("#filterReady");
    assert.deepEqual(await ids(page), ["j1", "j2", "j3"], "C8: bỏ tin không link, stale, đã nộp");
    // C3: j/k chọn, focus ring trên link tiêu đề, aria-live
    await page.keyboard.press("j"); // focus còn ở checkbox lọc: phím tắt vẫn chạy
    assert.equal(await page.evaluate(() => document.activeElement.closest(".card").dataset.jobId), "j1");
    assert(await page.$('[data-job-id="j1"].kb-sel'), "thẻ chọn có viền");
    await page.keyboard.press("j"); await page.keyboard.press("k"); await page.keyboard.press("j");
    assert.match(await page.textContent("#kbLive"), /Job 2 \(2\/3\)/);
    // C1 qua phím? Không: C1 qua nút trên thẻ. Bấm "Đã nộp" trên j2 -> quick applied -> rời bộ lọc C8 -> Hoàn tác
    await page.click('[data-applied-for="j2"]');
    await waitFor(async () => calls.some((c) => c.includes("/api/applications/quick") && c.includes('"action":"applied"') && c.includes('"j2"')), "C1 không gọi quick");
    await waitFor(async () => /Đã đánh dấu đã nộp: Job 2/.test(await toastText(page)), "C1 không có toast");
    assert.deepEqual(await ids(page), ["j1", "j3"], "đã nộp thì rời Nộp được ngay");
    if (theme === "light") { const f = path.join(OUT, `qa-flow-undo-${theme}-${w}.png`); await page.screenshot({ path: f }); shots.push(f); }
    await page.click(".toast-act");
    await waitFor(async () => calls.some((c) => c.startsWith("PATCH /api/applications/a-j2") && c.includes('"stage":"new"') && c.includes('"next_follow_up_at":null')), "Hoàn tác không PATCH stage cũ: " + calls.slice(-3).join(" | "));
    await waitFor(async () => (await ids(page)).includes("j2"), "Hoàn tác không đưa thẻ về");
    // C3: s lưu, x bỏ qua (chọn tin kế), có Hoàn tác
    await page.focus('[data-job-id="j1"] .ttl a'); await page.keyboard.press("s");
    await waitFor(async () => calls.some((c) => c.startsWith("POST /api/applications ") && c.includes('"stage":"saved"')), "s không lưu");
    await waitFor(async () => (await page.$eval('[data-job-id="j1"] [data-stage-for]', (s) => s.value)) === "saved", "s: thẻ chưa đổi Đã lưu");
    await page.focus('[data-job-id="j3"] .ttl a'); await page.keyboard.press("x");
    await waitFor(async () => !(await ids(page)).includes("j3"), "x không bỏ qua");
    // Tắt khi gõ
    const n = calls.length; await page.focus("#filterQ"); await page.keyboard.type("jsx");
    assert.equal(await page.inputValue("#filterQ"), "jsx"); await page.fill("#filterQ", "");
    await page.waitForTimeout(450); assert(!calls.slice(n).some((c) => /applications/.test(c)), "phím tắt chạy khi đang gõ");
    // ? bảng phím tắt, Esc đóng
    await page.focus('[data-job-id="j1"] .ttl a'); await page.keyboard.press("?");
    await page.waitForSelector("#kbDlg[open]");
    if (theme === "dark" || w === 390) { const f = path.join(OUT, `qa-flow-keys-${theme}-${w}.png`); await page.screenshot({ path: f }); shots.push(f); }
    await page.keyboard.press("Escape"); assert(!(await page.$("#kbDlg[open]")));
    // a mở Nộp nhanh; C2 checklist, lưu tick theo job, không chặn nút
    await page.focus('[data-job-id="j1"] .ttl a'); await page.keyboard.press("a");
    await page.waitForSelector("#qaDlg[open] .qa-check");
    const qc = await page.textContent("#qaDlg .qa-check");
    assert.match(qc, /CV đúng hồ sơ Backend/); assert.match(qc, /thấp hơn mức bạn muốn/); assert.match(qc, /Kafka/);
    await page.check('#qaDlg [data-qc="cv"]'); await page.check('#qaDlg [data-qc="start"]');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("jp_qc")).j1.sort()), ["cv", "start"]);
    assert(!(await page.$eval('#qaDlg [data-qa="open"]', (b) => b.disabled)), "checklist không được chặn");
    await page.$eval("#qaDlg .qa-check", (e) => e.scrollIntoView({ block: "center" }));
    { const f = path.join(OUT, `qa-flow-checklist-${theme}-${w}.png`); await page.screenshot({ path: f }); shots.push(f); }
    await page.keyboard.press("Escape");
    await page.click('[data-qa-for="j1"]'); await page.waitForSelector("#qaDlg[open]");
    assert(await page.isChecked('#qaDlg [data-qc="cv"]'), "tick không được nhớ"); assert(!(await page.isChecked('#qaDlg [data-qc="salary"]')));
    await page.click('#qaDlg [data-qa="open"]');
    await waitFor(async () => calls.some((c) => c.includes('"action":"open"')), "Mở trang nộp không ghi open");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "tràn ngang " + w);
    { await page.uncheck("#filterReady"); await page.evaluate(() => scrollTo(0, 0)); const f = path.join(OUT, `qa-flow-list-${theme}-${w}.png`); await page.screenshot({ path: f }); shots.push(f); }
    assert.deepEqual(errs, [], "lỗi console: " + errs.join("; "));
    await ctx.close();
    console.log("ok", w, theme);
  }
  // Lỗi API: toast lỗi, thẻ không đổi, nút bật lại
  { const { ctx, page, errs } = await open(browser, 1280, "light", true);
    await page.click('[data-applied-for="j1"]');
    await waitFor(async () => /Tin này không còn/.test(await toastText(page)), "lỗi không có toast");
    assert.equal(await page.$eval('[data-job-id="j1"] [data-stage-for]', (s) => s.value), "new");
    assert(!(await page.$eval('[data-applied-for="j1"]', (b) => b.disabled)));
    assert.deepEqual(errs.filter((e) => !/404/.test(e)), []); await ctx.close(); console.log("ok error state"); }
  await browser.close();
  console.log("quick-apply-flow e2e OK\n" + shots.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
