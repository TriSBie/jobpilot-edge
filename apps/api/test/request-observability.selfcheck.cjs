// T-112: D1 execution counter preserves receivers, bind and batch semantics.
const assert = require("node:assert/strict"), fs = require("node:fs"), { execFileSync } = require("node:child_process");
const src = process.argv[2] === "--base" ? execFileSync("git", ["show", "main:apps/api/src/worker.js"], { encoding: "utf8" }) : fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const start = src.indexOf("function observeEnv("); const end = src.indexOf("async function handleRum(", start);
assert(start >= 0 && end > start, "request observation helper must exist");
const { observeEnv, observedRoute } = new Function(src.slice(start, end) + "\nreturn { observeEnv, observedRoute };")();
class Statement { constructor(value) { this.value = value; } bind(value) { assert(this instanceof Statement); return new Statement(value); } first() { assert(this instanceof Statement); return this.value; } all() { assert(this instanceof Statement); return [this.value]; } run() { assert(this instanceof Statement); return this.value; } }
const db = { prepare() { assert.equal(this, db); return new Statement(0); }, batch(items) { assert.equal(this, db); assert(items.every((i) => i instanceof Statement)); return items.map((i) => i.value); } };
const state = { d1_queries: 0 }, env = observeEnv({ DB: db, KV: "kv" }, state);
assert.equal(env.KV, "kv");
const s = env.DB.prepare("test").bind(12);
assert.equal(s.first(), 12); assert.deepEqual(s.all(), [12]); assert.equal(s.run(), 12);
assert.deepEqual(env.DB.batch([s, env.DB.prepare("test").bind(99)]), [12, 99]);
assert.equal(state.d1_queries, 4);
assert.equal(observedRoute("/api/jobs/secret-email@example.com"), "/api/jobs/:id");
assert.equal(observedRoute("/api/secret-token/a"), "/api/other");
assert.equal(observedRoute("/api/public/try"), "/api/public/try");
assert.equal(observeEnv({}, state).__trace, state);
console.log("T-112 request observation selfcheck OK");