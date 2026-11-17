// T-112: exercise RUM via the real Worker handler and SQLite.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE register_attempts (ip TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip, hour))");
const points = [], logs = [];
const env = { DB: { prepare: (sql) => ({ bind: (...args) => ({ first: async () => db.prepare(sql).get(...args) }) }) }, EVENTS: { writeDataPoint: (p) => points.push(p) } };
const file = path.resolve(process.argv[2] || "apps/api/src/worker.js");
(async () => {
  const originalLog = console.log;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  try {
  const worker = (await import(pathToFileURL(file).href)).default;
  console.log = (...args) => { if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("{")) logs.push(JSON.parse(args[0])); else originalLog(...args); };
  const ip = "203.0.113.2";
  const call = (body, sourceIp = ip) => worker.fetch(new Request("https://api.test/api/rum", { method: "POST", headers: { "cf-connecting-ip": sourceIp }, body }), env, {});
  const good = JSON.stringify({ metric: "LCP", page: "landing", value: 1234 });
  assert.equal((await call(good)).status, 204);
  assert.deepEqual(points[0].blobs, ["web_vital", "LCP:landing"]);
  assert.equal(logs.length, 1); assert.equal(logs[0].route, "/api/rum"); assert.equal(logs[0].status, 204); assert.equal(logs[0].d1_queries, 1); assert(!JSON.stringify(logs).includes(ip));
  assert.equal((await call("x".repeat(1025))).status, 413);
  assert.equal((await call("invalid")).status, 400);
  for (let i = 0; i < 57; i++) assert.equal((await call(good)).status, 204);
  assert.equal((await call(good)).status, 429);
  const rows = db.prepare("SELECT ip, count FROM register_attempts").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 61);
  assert.match(rows[0].ip, /^rum:[a-f0-9]{64}$/);
  assert(!rows[0].ip.includes(ip));
  assert.equal(points.filter((p) => p.blobs[0] === "web_vital").length, 58);
  env.DB = { prepare() { throw Error("simulated database error"); } };
  assert.equal((await call(good, "203.0.113.3")).status, 500);
  globalThis.caches = { default: { match: async () => new Response("{}", { status: 200 }) } };
  let response = await worker.fetch(new Request("https://api.test/api/public/try?skills=Java&level=middle&location=Remote"), env, {});
  assert.equal(response.status, 200);
  assert.equal(logs.at(-1).cache, "hit"); assert.equal(logs.at(-1).d1_queries, 0);
  env.KV = { get: async () => "private-user-id" };
  let reads = 0;
  env.DB = { prepare: () => ({ bind: () => ({ first: async () => ++reads === 1 ? { id: "private-user-id", last_active_day: Math.floor(Date.now() / 86400000) } : null }) }) };
  response = await worker.fetch(new Request("https://api.test/api/jobs/private-token?email=person@example.com", { headers: { authorization: "Bearer secret-token" } }), env, {});
  assert.equal(response.status, 404);
  const entry = logs.at(-1);
  assert.equal(entry.route, "/api/jobs/:id"); assert.equal(entry.d1_queries, 2); assert.match(entry.user_hash, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(entry).includes("private-user-id")); assert(!JSON.stringify(entry).includes("private-token")); assert(!JSON.stringify(entry).includes("person@example.com")); assert(!JSON.stringify(entry).includes("secret-token"));
  console.log("T-112 RUM handler selfcheck OK");
  } finally {
    console.log = originalLog;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else delete globalThis.caches;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });