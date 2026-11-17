// T-112: parse reduced fixtures captured from live public job sources.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const src = fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const a = src.indexOf("const SKILL_CANON = new Map(");
const b = src.indexOf("const REMOTE_FETCHERS", a);
assert(a >= 0 && b > a, "source parser section");
const m = new Function(src.slice(a, b) + "\nreturn { fetchITviec, fetchTopDev, fetchWWR, fetchRemotive, fetchRemoteOK, fetchHN };")();
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
global.fetch = async (url) => {
  url = String(url);
  const name = url.includes("itviec.com") ? "itviec.html" : url.includes("topdev.vn") ? "topdev.html" : url.includes("weworkremotely.com") ? "wwr.xml" : url.includes("remotive.com") ? "remotive.json" : url.includes("remoteok.com") ? "remoteok.json" : url.includes("search_by_date") ? "hn-search.json" : url.includes("hn.algolia.com/api/v1/items/") ? "hn-item.json" : null;
  if (!name) throw Error("unexpected URL: " + url);
  return new Response(fixture(name), { status: 200 });
};
(async () => {
  for (const [name, fn] of [["itviec", () => m.fetchITviec("Java")], ["topdev", () => m.fetchTopDev("Java")], ["wwr", () => m.fetchWWR()], ["remotive", () => m.fetchRemotive()], ["remoteok", () => m.fetchRemoteOK()], ["hn", () => m.fetchHN()]]) {
    const rows = await fn();
    assert(rows.some((row) => row.title && row.company && /^https:\/\//.test(row.url)), name + " must parse title, company and HTTPS URL");
    console.log(name + " fixture OK");
  }
  console.log("T-112 source fixtures selfcheck OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });