// T-112: verify metric delivery and isolation from telemetry failures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const src = process.argv[2] === "--base" ? execFileSync("git", ["show", "main:apps/api/src/worker.js"], { encoding: "utf8" }) : fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const start = src.indexOf("function metric(env, event, label, values)");
const end = src.indexOf("// Gọi Bot API", start);
assert(start >= 0 && end > start, "T-112 metric helper must exist");
const { metric, tgSend } = new Function(src.slice(start, end) + "\nreturn { metric, tgSend };")();
(async () => {
  const points = [];
  const env = { EVENTS: { writeDataPoint: (point) => points.push(point) }, TELEGRAM_API_BASE: "https://test.invalid", TELEGRAM_BOT_TOKEN: "fake" };
  metric(env, "ingest", "test-source", [3, 2, 1, 0]);
  assert.deepEqual(points[0], { blobs: ["ingest", "test-source"], doubles: [3, 2, 1, 0], indexes: ["ingest"] });
  assert.doesNotThrow(() => metric({}, "x", "y", [1]));
  assert.doesNotThrow(() => metric({ EVENTS: { writeDataPoint() { throw Error("quota"); } } }, "x", "y", [1]));
  global.fetch = async () => ({ ok: true, status: 200 });
  assert.equal(await tgSend(env, "fake-chat", "test"), 200);
  assert.deepEqual(points[1], { blobs: ["telegram", "ok"], doubles: [1], indexes: ["telegram"] });
  global.fetch = async () => ({ ok: false, status: 503 });
  assert.equal(await tgSend(env, "fake-chat", "test"), 503);
  assert.deepEqual(points[2], { blobs: ["telegram", "error"], doubles: [1], indexes: ["telegram"] });
  global.fetch = async () => { throw Error("simulated network failure"); };
  assert.equal(await tgSend(env, "fake-chat", "test"), 0);
  assert.deepEqual(points[3], { blobs: ["telegram", "error"], doubles: [1], indexes: ["telegram"] });
  console.log("T-112 metrics selfcheck OK");
})().catch((err) => { console.error(err); process.exitCode = 1; });