// API=http://127.0.0.1:8790 TOKEN=<phiên> PW=<playwright-core> node apps/web/test/usertest.real.cjs <outDir>
// Chạy với API thật (wrangler dev --local, D1 có > 50 job, user đã đồng ý lưu CV): chuyển tiếp mọi gọi API prod sang API local.
// Kiểm tra: tải 2 trang (offset=next_offset), caption benchmark VNĐ + dòng USD, Điền hồ sơ từ CV + Lưu đặt cv_file_id.
const { chromium } = require(process.env.PW || "playwright-core");
const assert = require("assert"), path = require("path");
const OUT = process.argv[2] || ".", LOCAL = process.env.API || "http://127.0.0.1:8790", TOKEN = process.env.TOKEN;
const PROD = "https://jobpilot-api.tribui-it-work.workers.dev";
const URL0 = "file:///" + path.resolve(__dirname, "../public/index.html").replace(/\\/g, "/");
assert(TOKEN, "thiếu TOKEN");
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  const cards = () => page.$$eval("#jobsContainer .card", (x) => x.length);
  await page.waitForSelector("#jobsContainer .card");
  assert.equal(await cards(), 20);
  await page.click("#loadMoreJobs"); await page.click("#loadMoreJobs");
  assert.equal(await cards(), 50);
  assert.equal((await page.textContent("#loadMoreJobs")).trim(), "Xem thêm job");
  await page.$eval("#loadMoreJobs", (e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
  const shots = [path.join(OUT, "real-jobs-more-1280-light.png")];
  await page.screenshot({ path: shots[0] });
  await page.click("#loadMoreJobs");
  for (let i = 0; i < 100 && (await cards()) < 60; i++) await page.waitForTimeout(100);
  assert.equal(await cards(), 60, "không nối trang 2");
  assert(calls.some((c) => /GET \/api\/jobs\?.*limit=50.*offset=50/.test(c)), "thiếu offset=50: " + calls.join("\n"));
  assert.equal(await page.$("#loadMoreJobs"), null);
  // benchmark
  await page.evaluate(() => switchTab("profile"));
  await page.fill("#benchRole", "backend"); await page.click("#benchBtn");
  await page.waitForFunction(() => /tin VNĐ/.test(document.querySelector("#benchResult").textContent));
  const bench = await page.textContent("#benchResult");
  assert.match(bench, /Từ \d+ tin VNĐ, nguồn:/); assert.match(bench, /Tin trả USD \(\d+ tin\): trung vị \$[\d,]+\/tháng/);
  await page.$eval("#benchResult", (e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
  shots.push(path.join(OUT, "real-benchmark-1280-light.png")); await page.screenshot({ path: shots[1] });
  // CV
  const cv = "Nguyen Van Minh\nBackend Developer\nSkills: Java, Spring Boot, Kafka, PostgreSQL, Docker\n" + "Built loyalty platform services. ".repeat(5);
  await page.setInputFiles("#cvDraftFile", { name: "cv.txt", mimeType: "text/plain", buffer: Buffer.from(cv) });
  await page.click("#cvDraftBtn");
  await page.waitForFunction(() => /Đã đọc/.test(document.querySelector("#cvDraftStatus").textContent));
  await page.click("#pfSaveBtn");
  for (let i = 0; i < 100 && !calls.some((c) => /POST \/api\/profiles\/[^/]+\/cv-text/.test(c)); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(1500);
  const me = await (await ctx.request.get(LOCAL + "/api/me", { headers: { authorization: "Bearer " + TOKEN } })).json();
  const p = (me.profiles || [])[0];
  assert(p && p.cv_file_id, "cv_file_id chưa đặt: " + JSON.stringify(p));
  assert.deepEqual(errs, []);
  await browser.close();
  console.log("real OK cv_file_id=" + p.cv_file_id + "\n" + shots.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
