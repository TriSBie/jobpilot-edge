// Tự kiểm parser 3 nguồn remote (WWR RSS, Remotive, RemoteOK) với dữ liệu giả, không gọi mạng.
// Chạy: node apps/api/test/remote-sources.selfcheck.cjs apps/api/src/worker.js
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert(a >= 0 && b > a, from); return src.slice(a, b); };
const code = cut("const SKILL_CANON = new Map(", "function slugifyKeyword")        // canon, catalog, skillInText, stripTags, filterTechTags
  + cut("const REMOTE_UA", "const REMOTE_FETCHERS")                                // fetchJSON, xmlTag, toISODate, 3 fetcher
  + "\nreturn { fetchWWR, fetchRemotive, fetchRemoteOK, fetchHN, xmlTag };";
const feeds = {
  rss: `<rss><channel><item><title>Acme: Senior Java Developer</title><region>Anywhere in the World</region><link>https://weworkremotely.com/remote-jobs/acme-java</link><pubDate>Mon, 12 Oct 2026 16:28:34 +0000</pubDate><description>&lt;p&gt;We use Java, Spring Boot and PostgreSQL on AWS.&lt;/p&gt;</description></item>
<item><title>NoCompanyColon</title><link>https://weworkremotely.com/remote-jobs/x</link><description></description></item></channel></rss>`,
  remotive: { jobs: [{ title: "Backend Engineer", company_name: "Lemon", url: "https://remotive.com/remote-jobs/software-dev/backend-1", publication_date: "2026-10-27T12:56:13", candidate_required_location: "Worldwide", salary: "", tags: ["golang", "docker"], description: "<p>Go and Kubernetes.</p>" }] },
  remoteok: [{ legal: "..." }, { position: "Front End Developer", company: "Edconic", url: "https://remoteok.com/remote-jobs/1", date: "2026-10-28T21:53:15+00:00", location: "", tags: ["react", "typescript"], salary_min: 80000, salary_max: 100000 }, { slug: "no-url" }],
  hnSearch: { hits: [{ objectID: "49922569", title: "Ask HN: Who is hiring? (October 2026)" }] },
  hnItem: { children: [
    { id: 1, created_at: "2026-10-01T15:02:37.000Z", text: "Sidekick Labs (YC) | Senior SWE | REMOTE (US &#x2F; Canada) | Full-time<p>Stack: Python, PostgreSQL, Kubernetes." },
    { id: 6, created_at: "2026-10-01T15:07:00.000Z", text: "Rootly | design, engineering, GTM | Remote (SF Bay) | we use whiteboards only" },
    { id: 7, created_at: "2026-10-01T15:08:00.000Z", text: "Cardog | https://cardog.app/careers Cardog turns raw vehicle data into facts you can check, built by engineers who love cars and ship fast every single day of the week | Remote | Python, Go" },
    { id: 2, created_at: "2026-10-01T15:03:00.000Z", text: "Shepherd | ONSITE | San Francisco, CA | Senior Engineer" },
    { id: 3, created_at: "2026-10-01T15:04:00.000Z", text: "Acme | Remote | Head of Sales" },
    { id: 4, created_at: "2026-10-01T15:05:00.000Z", text: "no pipes here at all, remote developer" },
    { id: 5, created_at: "2026-10-01T15:06:00.000Z", text: null },
  ] },
};
// Thay fetch toàn cục: trả RSS cho mọi feed WWR (nên dedupe phải gộp 5×2 item → 2), JSON cho các API.
global.fetch = async (url) => ({ ok: true, text: async () => feeds.rss, json: async () => (url.includes("remotive") ? feeds.remotive : url.includes("search_by_date") ? feeds.hnSearch : url.includes("/items/") ? feeds.hnItem : feeds.remoteok) });
const m = new Function(code)();
(async () => {
  const w = await m.fetchWWR();
  assert.equal(w.length, 2, "WWR dedupe theo link qua 5 feed");
  assert.deepEqual([w[0].title, w[0].company, w[0].location, w[0].postedAt], ["Senior Java Developer", "Acme", "Remote (Anywhere in the World)", "2026-10-12"]);
  assert.deepEqual(w[0].skills.sort(), ["AWS", "Java", "PostgreSQL", "Spring Boot"]);
  assert.deepEqual([w[1].title, w[1].company], ["NoCompanyColon", ""]);
  const r = await m.fetchRemotive();
  assert.equal(r.length, 1); assert.equal(r[0].location, "Remote (Worldwide)"); assert.equal(r[0].salaryText, null);
  assert(r[0].skills.includes("Docker") && r[0].skills.includes("Kubernetes"), r[0].skills);
  const o = await m.fetchRemoteOK();
  assert.equal(o.length, 1, "bỏ phần tử legal và phần tử thiếu url");
  assert.equal(o[0].salaryText, "$80k - $100k/năm"); assert.deepEqual(o[0].skills.sort(), ["React", "TypeScript"]);
  const h = await m.fetchHN();
  assert.equal(h.length, 1, "chỉ tin remote + vai trò dev + có dấu | + có ≥1 kỹ năng catalog");
  assert.deepEqual([h[0].company, h[0].title, h[0].location, h[0].url, h[0].postedAt], ["Sidekick Labs", "Senior SWE", "REMOTE (US / Canada)", "https://news.ycombinator.com/item?id=1", "2026-10-01"]);
  assert.deepEqual(h[0].skills.sort(), ["Kubernetes", "PostgreSQL", "Python"]);
  console.log("remote-sources selfcheck OK");
})().catch((e) => { console.error(e); process.exit(1); });
