// T-112: bounded, anonymous RUM input and request throttling.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const src = process.argv[2] === "--base" ? execFileSync("git", ["show", "main:apps/api/src/worker.js"], { encoding: "utf8" }) : fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const start = src.indexOf("async function handleRum(");
const end = src.indexOf("// ---------------- router ----------------", start);
assert(start >= 0 && end > start, "RUM endpoint helper must exist");
assert(src.includes('path === "/api/rum" && request.method === "POST"'), "RUM route must be registered");
let attempts = 0, keys = [], points = [];
const handle = new Function("json", "sha256hex", "registerAttemptAllowed", "now", "metric", "CORS", src.slice(start, end) + "\nreturn handleRum;")(
  (data, status) => new Response(JSON.stringify(data), { status }),
  async () => "hashed", async (_, key) => { keys.push(key); return ++attempts <= 5; }, () => 3600,
  (_, ...args) => points.push(args), {}
);
const req = (body, ip = "203.0.113.2") => new Request("https://example.invalid/api/rum", { method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {}, body });
(async () => {
  assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "landing", value: 500 })), {})).status, 204);
  assert.deepEqual(points, [["web_vital", "LCP:landing", [500]]]);
  assert.equal(keys[0], "rum:hashed");
  assert.equal((await handle(req("x".repeat(1025)), {})).status, 413);
  assert.equal((await handle(req("not json"), {})).status, 400);
  assert.equal((await handle(req(JSON.stringify({ metric: "INP", page: "app", value: -1 })), {})).status, 400);
  assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "/secret", value: 1 })), {})).status, 400);
  assert.equal((await handle(req(JSON.stringify({ metric: "LCP", page: "app", value: 1 })), {})).status, 429);
  assert.equal((await handle(req("{}", ""), {})).status, 400);
  assert.equal(points.length, 1);
  console.log("T-112 RUM selfcheck OK");
})().catch((err) => { console.error(err); process.exitCode = 1; });