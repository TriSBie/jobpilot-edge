// PW=<path to playwright-core> node apps/web/test/cv-suggest.pw.cjs <outDir>
// Gợi ý sửa CV (T-28) với API mock: success, chọn 2 dòng → copy đúng 2 dòng, khối missing, no_cv, 429, ai_used:false, empty, 404 → toast.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], skills: [{ skill: "Java", weight: 5 }, { skill: "Spring Boot", weight: 4 }, { skill: "Kafka", weight: 4 }] };
const jobs = [{ id: "j1", title: "Senior Java Engineer", company: "Acme", source: "itviec", source_url: "https://example.com/j1", verdict: "apply", match: { final_score: 82, tier: "strong", matched_skills: ["Java", "Spring Boot", "Kafka"], missing_skills: ["Kubernetes"] }, application: null }];
const OK = {
  matched: ["Java", "Spring Boot", "Kafka"], missing: ["Kubernetes", "AWS"], dropped: 2, ai_used: true,
  skills_text: "Java, Spring Boot, Kafka, PostgreSQL",
  suggestions: [
    { id: "s1", section: "Kinh nghiệm", original: "Làm backend cho hệ thống loyalty.", suggested: "Xây dựng backend Spring Boot 3 cho nền tảng loyalty, xử lý sự kiện qua Kafka.", reason: "JD nhấn mạnh Spring Boot và Kafka; CV có nhưng chưa nêu rõ." },
    { id: "s2", section: "Kinh nghiệm", original: "Viết API.", suggested: "Thiết kế REST API cho hệ thống đổi điểm, dùng PostgreSQL.", reason: "Nêu rõ công nghệ đã dùng." },
    { id: "s3", section: "Tóm tắt", original: "Backend developer.", suggested: "Backend developer Java/Spring Boot, mảng loyalty và reward.", reason: "Khớp tiêu đề tin." },
  ],
};
const CASES = {
  ok: [200, OK],
  empty: [200, { ...OK, suggestions: [], dropped: 0 }],
  noai: [200, { ...OK, suggestions: [], dropped: 0, ai_used: false }],
  nocv: [409, { error: "no_cv" }],
  rate: [429, { error: "rate_limited", retry_after: 600 }],
  gone: [404, { error: "not_found" }],
};
async function open(browser, { w, theme, lang = "vi", kase }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage(), calls = [], errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await ctx.route(API + "/**", async (r) => {
    const u = new URL(r.request().url()), body = r.request().postData();
    calls.push(r.request().method() + " " + u.pathname + (body ? " " + body : ""));
    const send = (st, b) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/profiles/p1/cv-suggest") return send(...CASES[kase]);
    const b = u.pathname === "/api/me" ? { user: { id: "u1", name: "Minh", email: "qa@lab", telegram_linked: true }, profiles: [profile] }
      : u.pathname === "/api/profiles" ? [profile] : u.pathname === "/api/jobs" ? JSON.parse(JSON.stringify(jobs))
      : u.pathname === "/api/applications" ? { items: [] } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] } : null;
    send(b ? 200 : 404, b || { error: "not_found" });
  });
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 1},reset(){},getResponse(){return 't'}}" }));
  await ctx.addInitScript(([theme, lang]) => {
    localStorage.setItem("jp_theme", theme); localStorage.setItem("jp_lang", lang); localStorage.setItem("jp_token", "lab");
    navigator.clipboard.writeText = async (x) => { window.__clip = x; };
  }, [theme, lang]);
  await page.goto(URL0);
  await page.waitForSelector('[data-cvs-for="j1"]', { timeout: 8000 });
  await page.waitForTimeout(300);
  return { ctx, page, calls, errs };
}
const body = (page) => page.textContent("#cvsBody");
const settled = (page) => page.waitForSelector('#cvsBody[aria-busy="false"]');
const noOverflow = (page) => page.$eval("#cvsDlg", (d) => d.scrollWidth <= d.clientWidth + 1);
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  const shot = async (page, name) => { const f = `${OUT}/${name}.png`; await page.locator("#cvsDlg").screenshot({ path: f }); shots.push(f); };
  for (const theme of ["dark", "light"]) for (const w of [1280, 390]) {
    const tag = `${theme}-${w}`;
    // success: mở bằng bàn phím từ thẻ job
    let { ctx, page, calls, errs } = await open(browser, { w, theme, kase: "ok" });
    await page.focus('[data-cvs-for="j1"]'); await page.keyboard.press("Enter"); await settled(page);
    assert(await page.$eval("#cvsDlg", (d) => d.open));
    assert.equal(await page.evaluate(() => document.activeElement.id), "cvsTitle", "focus title");
    assert(calls.includes('POST /api/profiles/p1/cv-suggest {"job_id":"j1"}'));
    const txt = await body(page);
    assert(txt.includes("Chỉ dùng thông tin có trong CV của bạn. JobPilot không thêm kinh nghiệm bạn không có."));
    assert(txt.includes("Đã loại 2 gợi ý vì không có trong CV"));
    assert(txt.includes("JD yêu cầu nhưng CV chưa có") && txt.includes("Kubernetes") && txt.includes("AWS"));
    assert(txt.includes("thật sự có kinh nghiệm"));
    assert.equal(await page.$$eval("[data-cvs-pick]", (a) => a.length), 3);
    assert(await page.$eval('[data-cvs="copy-lines"]', (b) => b.disabled), "copy disabled at 0");
    // checkbox có nhãn truy cập được
    assert.equal(await page.getByRole("checkbox", { name: "Dùng dòng gợi ý 2" }).count(), 1);
    // cột: cạnh nhau ở desktop, xếp chồng ở 390
    const cols = await page.$eval(".cvs-cols", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
    assert.equal(cols, w > 640 ? 2 : 1, "cols " + tag);
    // chọn dòng 1 và 3 bằng bàn phím → copy đúng 2 dòng suggested
    await page.focus('[data-cvs-pick][value="s1"]'); await page.keyboard.press("Space");
    await page.check('[data-cvs-pick][value="s3"]');
    assert((await page.textContent("#cvsPickCount")).includes("Đã chọn 2 dòng"));
    await page.click('[data-cvs="copy-lines"]');
    assert.equal(await page.evaluate(() => window.__clip), OK.suggestions[0].suggested + "\n" + OK.suggestions[2].suggested);
    await page.click('[data-cvs="copy-skills"]');
    assert.equal(await page.evaluate(() => window.__clip), OK.skills_text);
    assert(await noOverflow(page), "overflow " + tag);
    await shot(page, `${tag}-success`);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.getElementById("cvsDlg").contains(document.activeElement)), "focus trap");
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.cvsFor), "j1", "focus back");
    // lối vào từ Nộp nhanh
    await page.click('[data-qa-for="j1"]'); await page.click('[data-qa="cv-suggest"]'); await settled(page);
    assert(await page.$eval("#cvsDlg", (d) => d.open));
    assert(!errs.length, errs.join("\n")); await ctx.close();

    // no_cv → link tab Hồ sơ
    ({ ctx, page, errs } = await open(browser, { w, theme, kase: "nocv" }));
    await page.click('[data-cvs-for="j1"]'); await settled(page);
    assert((await body(page)).includes("Hồ sơ này chưa có CV"));
    await shot(page, `${tag}-no_cv`);
    await page.click('[data-cvs="to-profile"]'); await page.waitForTimeout(400);
    assert(!(await page.$eval("#tab-profile", (e) => e.classList.contains("hidden"))));
    assert.equal(await page.evaluate(() => document.activeElement.id), "cvFile");
    assert(!errs.length, errs.join("\n")); await ctx.close();

    // 429 → thử lại sau 10 phút
    ({ ctx, page, errs } = await open(browser, { w, theme, kase: "rate" }));
    await page.click('[data-cvs-for="j1"]'); await settled(page);
    assert((await body(page)).includes("Thử lại sau 10 phút."));
    await shot(page, `${tag}-429`);
    assert(!errs.length, errs.join("\n")); await ctx.close();

    // ai_used:false → chỉ matched/missing/skills_text
    ({ ctx, page, errs } = await open(browser, { w, theme, kase: "noai" }));
    await page.click('[data-cvs-for="j1"]'); await settled(page);
    const t2 = await body(page);
    assert(t2.includes("AI đang tắt hoặc tạm không khả dụng"));
    assert.equal(await page.$$eval("[data-cvs-pick]", (a) => a.length), 0);
    assert.equal(await page.$('[data-cvs="copy-lines"]'), null);
    assert(t2.includes("JD yêu cầu nhưng CV chưa có") && (await page.inputValue("#cvsSkills")) === OK.skills_text);
    assert(!t2.includes("Đã loại"));
    await shot(page, `${tag}-ai_off`);
    assert(!errs.length, errs.join("\n")); await ctx.close();
  }
  // empty + loading (dark 1280)
  {
    const { ctx, page } = await open(browser, { w: 1280, theme: "dark", kase: "empty" });
    await page.route(API + "/api/profiles/p1/cv-suggest", async (r) => { await new Promise((ok) => setTimeout(ok, 800)); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CASES.empty[1]) }); });
    await page.click('[data-cvs-for="j1"]');
    assert((await body(page)).includes("có thể mất vài giây"));
    assert.equal(await page.$eval("#cvsBody", (e) => e.getAttribute("aria-busy")), "true");
    await shot(page, "dark-1280-loading");
    await settled(page);
    assert((await body(page)).includes("chưa có dòng nào cần sửa"));
    await shot(page, "dark-1280-empty");
    await ctx.close();
  }
  // 404 → toast, dialog đóng
  {
    const { ctx, page } = await open(browser, { w: 390, theme: "light", kase: "gone" });
    await page.click('[data-cvs-for="j1"]'); await page.waitForTimeout(300);
    assert(!(await page.$eval("#cvsDlg", (d) => d.open)));
    assert((await page.textContent("#toasts")).includes("Không tìm thấy hồ sơ hoặc tin này."));
    await ctx.close();
  }
  // EN
  {
    const { ctx, page } = await open(browser, { w: 390, theme: "dark", lang: "en", kase: "ok" });
    assert.equal(await page.textContent('[data-cvs-for="j1"]'), "Suggest CV edits");
    await page.click('[data-cvs-for="j1"]'); await settled(page);
    const t3 = await body(page);
    assert(t3.includes("Only uses what is already in your CV.") && t3.includes("Dropped 2 suggestions") && t3.includes("Asked for in the JD"));
    await shot(page, "dark-390-success-en");
    await ctx.close();
  }
  await browser.close();
  console.log("CV-SUGGEST OK\n" + shots.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
