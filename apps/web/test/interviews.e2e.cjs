// PW=<playwright-core> node apps/web/test/interviews.e2e.cjs <outDir> — Vòng phỏng vấn, API mock trong trình duyệt
const { chromium } = require(process.env.PW);
const assert = require("assert");
const OUT = process.argv[2];
const URL0 = require("url").pathToFileURL(require("path").join(__dirname, "../public/index.html")).href + "?v=1";
const skills = [{ skill: "NestJS", weight: 5 }, { skill: "PostgreSQL", weight: 4 }, { skill: "Kafka", weight: 4 }];
const T0 = Math.floor(new Date(2026, 10, 12, 10, 0).getTime() / 1000); // T5 12/11 10:00 giờ máy
const CK = { screen: ["Đọc lại JD", "Chuẩn bị giới thiệu 2 phút", "Câu hỏi về team"], technical: ["Ôn system design", "Ôn SQL", "Chuẩn bị câu hỏi kỹ thuật"] };
const now = Math.floor(Date.now() / 1000);

async function open(browser, { w, theme, lang = "vi", failList = false }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  const calls = [], db = {
    a1: [
      { id: "i1", application_id: "a1", kind: "screen", round_label: "", scheduled_at: T0 - 7 * 86400, result: "pass", note: "", checklist: CK.screen.map(text => ({ text, done: true })), created_at: 1 },
      { id: "i2", application_id: "a1", kind: "technical", round_label: "", scheduled_at: T0, result: "pending", note: "Mang laptop", checklist: CK.technical.map(text => ({ text, done: false })), created_at: 2 },
    ], a2: [],
  };
  let seq = 10;
  page.on("pageerror", (e) => calls.push("PAGEERROR " + e.message));
  await ctx.route("https://jobpilot-api.tribui-it-work.workers.dev/**", async (r) => {
    const u = new URL(r.request().url()), m = r.request().method(), body = r.request().postData();
    calls.push(m + " " + u.pathname + (body ? " " + body : ""));
    const send = (st, b, delay = 0) => setTimeout(() => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) }).catch(() => {}), delay);
    let mm;
    if ((mm = u.pathname.match(/^\/api\/applications\/(\w+)\/interviews$/))) {
      if (m === "GET") return failList ? send(500, { error: "db_down" }) : send(200, db[mm[1]], 150);
      const d = JSON.parse(body), row = { id: "i" + ++seq, application_id: mm[1], kind: d.kind, round_label: d.round_label || "", scheduled_at: d.scheduled_at || 0, result: "pending", note: d.note || "", checklist: (CK[d.kind] || ["Chuẩn bị"]).map(text => ({ text, done: false })), created_at: now };
      db[mm[1]].push(row); return send(200, row);
    }
    if ((mm = u.pathname.match(/^\/api\/interviews\/(\w+)$/))) {
      const all = Object.values(db).flat(), row = all.find(x => x.id === mm[1]);
      if (m === "DELETE") { for (const k in db) db[k] = db[k].filter(x => x.id !== mm[1]); return send(200, { ok: true }); }
      Object.assign(row, JSON.parse(body)); return send(200, JSON.parse(JSON.stringify(row)), 120); // chậm để bấm nhanh chồng lên nhau
    }
    const apps = [
      { id: "a1", stage: "interview", job: { title: "Senior Backend Engineer", company: "Acme", source_url: "https://example.com/j1" }, updated_at: now, rounds: { done: 1, total: 2 }, next_interview: { id: "i2", kind: "technical", round_label: "", scheduled_at: T0 } },
      { id: "a2", stage: "applied", job: { title: "Java Developer", company: "Beta", source_url: "https://example.com/j2" }, updated_at: now, rounds: { done: 0, total: 0 }, next_interview: null },
    ];
    const b = u.pathname === "/api/me" ? { user: { id: "u1", name: "Minh", email: "qa@lab", telegram_linked: true }, profiles: [{ id: "p1", name: "Backend", level: "senior", locations: [], skills }], notifications_unread: 2 }
      : u.pathname === "/api/profiles" ? [{ id: "p1", name: "Backend", level: "senior", locations: [], skills }]
      : u.pathname === "/api/jobs" ? [] : u.pathname === "/api/applications" ? { items: apps, stats: null } : u.pathname === "/api/digest/today" ? { strong: [], follow_ups: [] }
      : u.pathname === "/api/notifications" ? [{ id: 1, type: "interview", ref_id: "a1", title: "", body: "", is_read: 0, created_at: now - 60 }, { id: 2, type: "follow_up", ref_id: "a2", title: "", body: "", is_read: 0, created_at: now - 120 }]
      : u.pathname === "/api/notifications/read" ? { unread_count: 1 } : null;
    if (b === null) return send(404, { error: "not_found" });
    send(200, b);
  });
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "window.turnstile={render(){return 1},reset(){},getResponse(){return 't'}}" }));
  await ctx.addInitScript(([theme, lang]) => { localStorage.setItem("jp_theme", theme); localStorage.setItem("jp_lang", lang); localStorage.setItem("jp_token", "lab"); }, [theme, lang]);
  await page.goto(URL0);
  await page.waitForSelector('.tab[data-tab="kanban"]', { state: "visible", timeout: 8000 });
  await page.click('.tab[data-tab="kanban"]');
  await page.waitForSelector('[data-iv="a1"]', { timeout: 8000 });
  await page.waitForTimeout(400);
  return { ctx, page, calls, db };
}
const errs = (calls) => calls.filter(c => c.startsWith("PAGEERROR"));
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  for (const theme of ["dark", "light"]) for (const w of [1280, 390]) {
    const tag = `${theme}-${w}`, { ctx, page, calls, db } = await open(browser, { w, theme });
    // 1) dòng quiet trên thẻ; thẻ không có vòng thì không có dòng
    const line = await page.textContent('.kcard[data-app="a1"] .iv-line');
    assert.equal(line.trim(), "Vòng 2/2 · Kỹ thuật · T5 12/11 10:00");
    assert.equal(await page.$('.kcard[data-app="a2"] .iv-line'), null);
    await page.locator('.kcard[data-app="a1"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/${tag}-kanban.png` });
    // 2) mở bằng bàn phím, trạng thái tải, rồi danh sách
    await page.focus('[data-iv="a1"]'); await page.keyboard.press("Enter");
    assert(await page.$("#ivDlg [aria-busy=true]"), "loading state");
    await page.waitForSelector("#ivDlg .iv");
    assert.equal(await page.evaluate(() => document.activeElement.id), "ivTitle");
    assert.equal(await page.$$eval("#ivDlg .iv", (l) => l.length), 2);
    await page.screenshot({ path: `${OUT}/${tag}-detail.png` });
    // 3) thêm vòng
    await page.selectOption("#ivAddKind", "technical"); await page.fill("#ivAddLabel", "Onsite"); await page.fill("#ivAddAt", "2026-11-20T14:30");
    await page.click("#ivAddBtn"); await page.waitForSelector("#ivDlg .iv >> nth=2");
    assert.equal(db.a1.length, 3); const nr = db.a1[2];
    assert.equal(nr.round_label, "Onsite"); assert.equal(nr.scheduled_at, Math.floor(new Date(2026, 10, 20, 14, 30).getTime() / 1000));
    assert.equal(await page.evaluate(() => document.activeElement.id), "ivh-" + nr.id);
    assert((await page.textContent("#toasts")).includes("Đã thêm vòng."));
    // 4) bấm nhanh 3 checklist của vòng mới → cả 3 vào mock
    const cks = page.locator(`[data-row="${nr.id}"] [data-ck]`);
    await cks.nth(0).click(); await cks.nth(1).click(); await cks.nth(2).click();
    await page.waitForTimeout(800);
    assert.deepEqual(db.a1[2].checklist.map(c => c.done), [true, true, true], "rapid toggles persisted");
    assert(await cks.nth(2).isEnabled());
    // 5) kết quả: vòng 2 Đạt → thẻ cập nhật
    await page.selectOption('#ivr-i2', "pass"); await page.waitForTimeout(400);
    assert.equal(db.a1[1].result, "pass");
    // ICS có cho vòng có giờ
    const href = await page.getAttribute(`[data-row="${nr.id}"] a[download]`, "href");
    assert(decodeURIComponent(href).includes("DTSTART:") && decodeURIComponent(href).includes("BEGIN:VEVENT"));
    await page.screenshot({ path: `${OUT}/${tag}-detail-edited.png`, fullPage: false });
    await page.locator(`[data-row="${nr.id}"]`).screenshot({ path: `${OUT}/${tag}-round.png` });
    // 6) xoá: Huỷ giữ lại, Xác nhận xoá
    await page.click(`[data-row="${nr.id}"] [data-iva="del"]`);
    assert(await page.$eval("#confirmDlg", d => d.open));
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
    assert(await page.$eval("#ivDlg", d => d.open), "ivDlg stays open after cancel");
    assert.equal(db.a1.length, 3);
    await page.click(`[data-row="${nr.id}"] [data-iva="del"]`);
    await page.click('#confirmDlg button[value="ok"]'); await page.waitForTimeout(300);
    assert.equal(db.a1.length, 2); assert.equal(await page.$$eval("#ivDlg .iv", (l) => l.length), 2);
    // Esc đóng, focus về nút mở; thẻ cập nhật theo kết quả mới
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    assert(!(await page.$eval("#ivDlg", d => d.open)));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.iv), "a1");
    assert.equal((await page.textContent('.kcard[data-app="a1"] .iv-line')).trim(), "Vòng 2/2 · Xong");
    // 7) trạng thái trống
    await page.click('[data-iv="a2"]'); await page.waitForSelector("#ivDlg .iv-state:not([aria-busy])");
    assert((await page.textContent("#ivDlg")).includes("Chưa có vòng nào"));
    await page.screenshot({ path: `${OUT}/${tag}-empty.png` });
    await page.keyboard.press("Escape");
    assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), "overflow " + tag);
    assert(!errs(calls).length, errs(calls).join("\n"));
    await ctx.close();
  }
  // lỗi tải + thử lại
  {
    const { ctx, page, calls } = await open(browser, { w: 390, theme: "dark", failList: true });
    await page.click('[data-iv="a1"]'); await page.waitForSelector('#ivDlg [role=alert]');
    assert((await page.textContent("#ivDlg")).includes("Không tải được vòng phỏng vấn: db_down"));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.iva), "retry");
    await page.screenshot({ path: `${OUT}/dark-390-error.png` });
    await ctx.close();
  }
  // EN + thông báo interview mở đúng đơn
  {
    const { ctx, page, calls } = await open(browser, { w: 1280, theme: "light", lang: "en" });
    assert.equal((await page.textContent('.kcard[data-app="a1"] .iv-line')).trim(), "Round 2/2 · Technical · Thu 12/11 10:00");
    await page.click("#nfBell"); await page.waitForSelector(".nf-row");
    const rows = await page.$$eval(".nf-row .nf-ttl", (l) => l.map(e => e.textContent));
    assert(rows.some(r => r.includes("Interview scheduled")) && rows.some(r => r.includes("Follow-up reminder")), rows.join("|"));
    await page.screenshot({ path: `${OUT}/light-1280-bell-en.png` });
    await page.click('.nf-row >> nth=0'); await page.waitForSelector("#ivDlg .iv");
    assert((await page.textContent("#ivDlg .iv-sub")).includes("Senior Backend Engineer"));
    assert((await page.textContent("#ivDlg")).includes("Preparation checklist"));
    await page.screenshot({ path: `${OUT}/light-1280-detail-en.png` });
    assert(!errs(calls).length, errs(calls).join("\n"));
    await ctx.close();
  }
  await browser.close();
  console.log("IV E2E OK");
})().catch((e) => { console.error(e); process.exit(1); });
