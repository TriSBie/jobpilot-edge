// PW=<path to playwright-core> node apps/web/test/account.pw.cjs <outDir>
// Menu ảnh đại diện + view Tài khoản (5 nhóm) + Benchmark, API mock: dark/light × 1280/390.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
const API = "https://jobpilot-api.tribui-it-work.workers.dev";
const profile = { id: "p1", name: "Backend", level: "senior", locations: [], skills: [{ skill: "Java", weight: 5 }] };
async function open(browser, { w, theme }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(), calls = [], errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await ctx.route(API + "/**", async (r) => {
    const req = r.request(), u = new URL(req.url()), body = req.postData();
    calls.push(req.method() + " " + u.pathname + (body ? " " + body : ""));
    const send = (b, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    const k = req.method() + " " + u.pathname;
    if (k === "GET /api/me") return send({ user: { id: "u1", name: "Minh", email: "qa@lab.vn", telegram_linked: false, ai_opt_out: 0 }, profiles: [profile] });
    if (k === "PATCH /api/me") return send({ ai_opt_out: JSON.parse(body).ai_opt_out });
    if (k === "DELETE /api/me") return send({ ok: true });
    if (k === "POST /api/me/telegram/link") return send({ code: "ABC123", deeplink: "https://t.me/x?start=ABC123" });
    if (k === "GET /api/me/export") return send({ profiles: [] });
    if (k === "POST /api/auth/change-password") return send({ token: "lab2" });
    if (k === "POST /api/auth/logout") return send({ ok: true });
    if (k === "GET /api/benchmark") return send({ count: 1 });
    if (u.pathname === "/api/notifications") return send({ items: [] });
    const b = u.pathname === "/api/profiles" ? [profile] : u.pathname === "/api/jobs" ? [] : u.pathname === "/api/applications" ? { items: [] } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] } : null;
    send(b || { error: "not_found" }, b ? 200 : 404);
  });
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 1},reset(){},getResponse(){return 't'}}" }));
  await ctx.addInitScript((theme) => { localStorage.setItem("jp_theme", theme); localStorage.setItem("jp_lang", "vi"); localStorage.setItem("jp_token", "lab"); }, theme);
  await page.goto(URL0);
  await page.waitForFunction(() => document.querySelector("#acctInitial").textContent === "q", null, { timeout: 8000 });
  await page.waitForTimeout(300);
  return { ctx, page, calls, errs };
}
const vis = (page, sel) => page.$eval(sel, (e) => !e.closest(".hidden") && !!e.offsetParent);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const waitCall = async (calls, prefix) => { for (let i = 0; i < 40 && !calls.some((c) => c.startsWith(prefix)); i++) await new Promise((r) => setTimeout(r, 50)); assert(calls.some((c) => c.startsWith(prefix)), "thiếu lời gọi " + prefix + " trong " + calls.join(" | ")); };
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  for (const theme of ["dark", "light"]) for (const w of [1280, 390]) {
    const tag = `${theme}-${w}`;
    const { ctx, page, calls, errs } = await open(browser, { w, theme });
    // menu: click mở, Esc đóng + focus về avatar
    assert.equal(await page.textContent("#acctInitial"), "q");
    await page.click("#acctBtn");
    assert.equal(await page.getAttribute("#acctBtn", "aria-expanded"), "true");
    assert.equal(await page.textContent("#acctEmail"), "qa@lab.vn");
    assert.equal(await page.evaluate(() => document.activeElement.id), "acctSettingsBtn");
    await page.screenshot({ path: `${OUT}/menu-${tag}.png` }); shots.push(`menu-${tag}.png`);
    await page.keyboard.press("Escape");
    assert(await page.$eval("#acctMenu", (e) => e.classList.contains("hidden")));
    assert.equal(await page.evaluate(() => document.activeElement.id), "acctBtn");
    // bàn phím: Enter mở, mũi tên đi, click ngoài đóng
    await page.keyboard.press("Enter");
    assert.equal(await page.getAttribute("#acctBtn", "aria-expanded"), "true");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.id), "logoutBtn");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.id), "acctSettingsBtn");
    await page.mouse.click(5, 600);
    assert(await page.$eval("#acctMenu", (e) => e.classList.contains("hidden")));
    // vào Tài khoản bằng bàn phím
    await page.focus("#acctBtn"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    assert(await vis(page, "#tab-account"), "view Tài khoản chưa hiện");
    assert(!(await page.$('.tab[data-tab="account"]')), "Tài khoản không được nằm trên tabbar");
    const groups = await page.$$eval("#tab-account [data-acct-group] > h3", (h) => h.map((x) => x.textContent));
    assert.deepEqual(groups, ["Kết nối", "AI & quyền riêng tư", "Dữ liệu của bạn", "Bảo mật", "Vùng nguy hiểm"]);
    for (const id of ["tgBox", "tgOwn", "aiOptOut", "exportBtn", "cpBtn", "delAccountBtn"]) assert(await page.$(`#tab-account #${id}`), id + " chưa nằm trong Tài khoản");
    assert(!(await page.$("#tab-profile #tgBox, #tab-profile #aiOptOut, #tab-profile #exportBtn, #tab-profile #cpBtn")));
    assert(await noOverflow(page), "tràn ngang ở Tài khoản " + tag);
    await page.screenshot({ path: `${OUT}/account-${tag}.png`, fullPage: true }); shots.push(`account-${tag}.png`);
    // handler sau khi chuyển chỗ
    await page.click("#tgLinkBtn"); await waitCall(calls, "POST /api/me/telegram/link");
    await page.waitForFunction(() => document.querySelector("#tgCode").textContent === "ABC123");
    await page.click("#aiOptOut"); await waitCall(calls, 'PATCH /api/me {"ai_opt_out":1}');
    const dl = page.waitForEvent("download"); await page.click("#exportBtn"); await dl; await waitCall(calls, "GET /api/me/export");
    await page.fill("#cpCurrent", "oldpass12"); await page.fill("#cpNew", "newpass12"); await page.click("#cpBtn");
    await waitCall(calls, 'POST /api/auth/change-password {"current_password":"oldpass12","new_password":"newpass12"}');
    await page.waitForFunction(() => localStorage.getItem("jp_token") === "lab2");
    // xoá tài khoản: Huỷ không gọi API, Xác nhận mới gọi
    await page.fill("#delAccountPw", "pw12345678"); await page.click("#delAccountBtn");
    await page.waitForSelector("#confirmDlg[open]"); await page.click('#confirmDlg button[value="cancel"]');
    await page.waitForTimeout(150); assert(!calls.some((c) => c.startsWith("DELETE /api/me")), "Huỷ mà vẫn xoá");
    await page.click("#delAccountBtn"); await page.waitForSelector("#confirmDlg[open]");
    await page.click('#confirmDlg button[value="ok"]'); await waitCall(calls, 'DELETE /api/me {"password":"pw12345678"}');
    await page.waitForSelector("#landingView:not(.hidden)");
    assert.deepEqual(errs, [], "lỗi trang: " + errs.join("; "));
    await ctx.close();

    // Logout + Benchmark + mở Tài khoản từ chuông
    const s2 = await open(browser, { w, theme });
    const p = s2.page;
    await p.click("#nfBell"); await p.waitForSelector("#nfList .nf-link");
    await p.click("#nfList .nf-link"); await p.waitForTimeout(250);
    assert(await vis(p, "#tab-account"), "Bật Telegram trong chuông phải mở Tài khoản");
    assert.equal(await p.evaluate(() => document.activeElement.id), "tgLinkBtn");
    await p.click('.tab[data-tab="profile"]'); await p.waitForTimeout(200);
    for (const id of ["benchRole", "benchLoc"]) {
      assert.equal(await p.getAttribute("#" + id, "autocomplete"), "off");
      assert(!/mail|user|login/i.test(await p.getAttribute("#" + id, "name")));
      assert.equal(await p.inputValue("#" + id), "");
    }
    assert.equal(await p.$eval(".neg-box", (d) => d.tagName + ":" + d.open), "DETAILS:false");
    await p.fill("#benchRole", "backend"); await p.click("#benchBtn");
    await p.waitForFunction(() => /Dữ liệu còn mỏng/.test(document.querySelector("#benchResult").textContent));
    assert(!(await p.$("#benchResult .tile")), "count<5 không được hiện số");
    assert(await noOverflow(p), "tràn ngang ở Hồ sơ " + tag);
    await p.locator(".bench-card").screenshot({ path: `${OUT}/bench-${tag}.png` }); shots.push(`bench-${tag}.png`);
    await p.click("#acctBtn"); await p.click("#logoutBtn");
    await s2.calls.length; await waitCall(s2.calls, "POST /api/auth/logout");
    await p.waitForSelector("#landingView:not(.hidden)");
    assert.equal(await p.evaluate(() => localStorage.getItem("jp_token")), null);
    assert.deepEqual(s2.errs, [], "lỗi trang: " + s2.errs.join("; "));
    await s2.ctx.close();
    console.log("ok", tag);
  }
  await browser.close();
  console.log("account e2e OK\n" + shots.map((f) => path.resolve(OUT, f)).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
