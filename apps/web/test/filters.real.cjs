// API=http://127.0.0.1:8790 TOKEN=<phiên> PW=<playwright-core> node apps/web/test/filters.real.cjs <outDir>
// Bộ lọc hình thức + lương với API thật (wrangler dev --local, D1 > 50 job có VNĐ/USD/không lương, remote/hybrid/onsite).
// Chuyển mọi gọi API prod sang local. Tổng trên trang phải bằng total API trả, Xem thêm đi theo next_offset và giữ bộ lọc.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".", LOCAL = process.env.API || "http://127.0.0.1:8790", TOKEN = process.env.TOKEN;
const PROD = "https://jobpilot-api.tribui-it-work.workers.dev";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
assert(TOKEN, "thiếu TOKEN");
const direct = (qs) => fetch(LOCAL + "/api/jobs?limit=50&" + qs, { headers: { authorization: "Bearer " + TOKEN } }).then((r) => r.json());
const waitFor = async (fn, msg) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(msg()); };
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const shots = [];
  for (const w of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage(), calls = [], errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await ctx.route(PROD + "/**", async (r) => { // ponytail: chuyển tiếp sang local, không bao giờ chạm prod
      const req = r.request(), u = req.url().replace(PROD, LOCAL);
      calls.push(req.method() + " " + u.slice(LOCAL.length));
      const res = await r.fetch({ url: u });
      await r.fulfill({ response: res, headers: { ...res.headers(), "access-control-allow-origin": "*" } });
    });
    await ctx.addInitScript((tok) => { localStorage.setItem("jp_theme", "light"); localStorage.setItem("jp_lang", "vi"); localStorage.setItem("jp_token", tok); }, TOKEN);
    await page.goto(URL0);
    await page.waitForSelector("#jobsContainer .card");
    const count = async () => (await page.textContent("#jobsCount")).trim();
    const all = await direct("");
    assert(all.total > 50 && all.next_offset === 50, "D1 cần > 50 job");
    await waitFor(async () => (await count()) === all.total + " tin", async () => "tổng đầu " + (await count()));
    // remote + hybrid: total thật, trang 2 giữ bộ lọc
    await page.click('.jf2 [data-mode="remote"]'); await page.click('.jf2 [data-mode="hybrid"]');
    const rh = await direct("mode=remote,hybrid");
    await waitFor(async () => (await count()) === rh.total + " tin", async () => "remote+hybrid " + (await count()) + " vs " + rh.total);
    // lương tối thiểu + chỉ tin có ghi lương
    await page.fill("#filterMinSal", "40"); await page.check("#filterHasSal");
    const f = await direct("mode=remote,hybrid&min_salary=40&has_salary=1");
    await waitFor(async () => (await count()) === f.total + " tin", async () => "lương " + (await count()) + " vs " + f.total);
    assert.match(await page.textContent("#salHint"), new RegExp("^" + f.total + " tin có ghi lương"));
    const cards = await page.$$eval("#jobsContainer .card", (x) => x.map((c) => c.textContent));
    assert(cards.length && cards.every((t) => /triệu\/tháng/.test(t) && /Remote|Hybrid/.test(t) && !/Onsite|Thương lượng/.test(t)), "thẻ sai: " + cards[0]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "tràn ngang " + w);
    await page.$eval(".jf2", (e) => e.scrollIntoView({ block: "start", behavior: "instant" })); await page.waitForTimeout(500);
    let p = path.join(OUT, `real-filters-light-${w}.png`); await page.screenshot({ path: p }); shots.push(p);
    // min_salary=10 (giữ tin không lương): > 50 tin -> phân trang thật theo next_offset, giữ bộ lọc
    await page.click('.jf2 [data-mode="remote"]'); await page.click('.jf2 [data-mode="hybrid"]'); await page.uncheck("#filterHasSal"); await page.fill("#filterMinSal", "10");
    const hs = await direct("min_salary=10");
    assert(hs.next_offset === 50, "cần > 50 tin cho min_salary=10");
    await waitFor(async () => (await count()) === hs.total + " tin", async () => "min_salary=10 " + (await count()) + " vs " + hs.total);
    {
      while ((await page.$$("#jobsContainer .card")).length < 50) await page.click("#loadMoreJobs");
      await page.click("#loadMoreJobs");
      await waitFor(async () => calls.some((c) => /offset=50/.test(c) && /min_salary=10/.test(c)), () => "trang 2 mất bộ lọc: " + calls.filter((c) => c.includes("/api/jobs")).join(" | "));
      await waitFor(async () => (await page.$$("#jobsContainer .card")).length === hs.total, async () => "trang 2: " + (await page.$$("#jobsContainer .card")).length);
    }
    // không tin nào khớp -> empty state + Xoá bộ lọc
    await page.goto(URL0 + "?mode=onsite&min_salary=999&has_salary=1"); await page.waitForSelector("#jobsClearFilters");
    assert.match(await page.textContent("#jobsContainer .empty"), /Không có job khớp bộ lọc/);
    await page.waitForTimeout(300);
    p = path.join(OUT, `real-filters-empty-light-${w}.png`); await page.screenshot({ path: p }); shots.push(p);
    await page.click("#jobsClearFilters");
    await waitFor(async () => (await count()) === all.total + " tin", async () => "Xoá bộ lọc " + (await count()));
    assert.deepEqual(errs, [], "lỗi trang: " + errs.join("; "));
    await ctx.close(); console.log("ok", w, { all: all.total, rh: rh.total, f: f.total, hs: hs.total });
  }
  await browser.close();
  console.log("filters real OK\n" + shots.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
