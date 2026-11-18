// T-112: bounded, anonymous RUM input and request throttling.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");
const file = path.resolve(process.argv[2] || "apps/api/src/worker.js");
const ip = "203.0.113.2";
const key = "rum:" + createHash("sha256").update("rum:" + ip).digest("hex");
const req = (body, ip = "203.0.113.2") => new Request("https://example.invalid/api/rum", { method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {}, body });
(async () => {
  const worker = (await import(pathToFileURL(path.join(path.dirname(file), "index.ts")).href)).default;
  const db = new DatabaseSync(":memory:");
  const originalNow = Date.now;
  const points = [];
  try {
    Date.now = () => 3600000;
    db.exec("CREATE TABLE register_attempts (ip TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip, hour))");
    // Bắt đầu với 55 lượt để giữ nguyên 5 lần qua quota và lần thứ 6 bị chặn.
    db.prepare("INSERT INTO register_attempts (ip, hour, count) VALUES (?, 1, 55)").run(key);
    const env = {
      DB: { prepare: (sql) => ({ bind: (...args) => ({ first: async () => db.prepare(sql).get(...args) }) }) },
      EVENTS: { writeDataPoint: ({ blobs, doubles }) => {
        if (blobs[0] === "web_vital") points.push([...blobs, doubles]);
      } },
    };
    const handle = (request) => worker.fetch(request, env, {});
    assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "landing", value: 500 })))).status, 204, "RUM route must be registered");
    assert.deepEqual(points, [["web_vital", "LCP:landing", [500]]]);
    const rows = db.prepare("SELECT ip FROM register_attempts WHERE count = 56").all();
    assert.equal(rows[0]?.ip, key);
    assert.equal((await handle(req("x".repeat(1025)))).status, 413);
    assert.equal((await handle(req("not json"))).status, 400);
    assert.equal((await handle(req(JSON.stringify({ metric: "INP", page: "app", value: -1 })))).status, 400);
    assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "/secret", value: 1 })))).status, 400);
    assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "app", value: 1 })))).status, 429);
    assert.equal((await handle(req("{}", ""))).status, 400);
    const validationIp = "203.0.113.3";
    assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "app", value: 3600001 }), validationIp))).status, 400);
    assert.equal((await handle(req(JSON.stringify({ metric: "FID", page: "app", value: 1 }), validationIp))).status, 400);
    assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "app", value: 1 }), "x".repeat(65)))).status, 400);
    assert.equal(points.length, 1);
    console.log("T-112 RUM selfcheck OK");
  } finally {
    Date.now = originalNow;
    db.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
