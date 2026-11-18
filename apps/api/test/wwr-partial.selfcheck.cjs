// T-120: đưa lỗi từng feed WWR qua queue ingest thật.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const workerPath = path.resolve(process.argv[2] || "apps/api/src/worker.js");
const migrations = path.resolve(__dirname, "../../../db/migrations");
const db = new DatabaseSync(":memory:");
const feedCount = 5;
const ingestBatchSize = Number(
  fs.readFileSync(path.resolve(__dirname, "../wrangler.toml.example"), "utf8")
    .split("[[queues.consumers]]").slice(1).find((block) => block.includes('queue = "jobpilot-ingest"'))
    .match(/max_batch_size\s*=\s*(\d+)/)[1]
);
let queries = 0;
function execute(sql, args) {
  const stmt = db.prepare(sql);
  if (/^\s*SELECT\b/i.test(sql)) return stmt.all(...args);
  stmt.run(...args);
  return [];
}
function statement(sql, args = []) {
  return {
    sql, args,
    bind: (...values) => statement(sql, values),
    first: async () => { queries++; return execute(sql, args)[0] ?? null; },
    run: async () => { queries++; execute(sql, args); return { success: true }; },
  };
}
const env = {
  DB: {
    prepare: statement,
    batch: async (items) => {
      queries++;
      return items.map(({ sql, args }) => ({ results: execute(sql, args) }));
    },
  },
  Q_SCORE: { send: async () => {}, sendBatch: async () => {} },
};
const scan = (scanId) => ({
  kind: "ingest", sourceType: "wwr", keyword: "*", scanId,
  scanGroup: "a".repeat(64), keywordIndex: 0, expectedCount: 1,
});

async function main() {
  for (const file of fs.readdirSync(migrations).sort()) {
    db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
  }
  db.exec("INSERT INTO sources (id, type, name, created_at) VALUES ('src-wwr', 'wwr', 'WWR', 0)");
  const worker = (await import(pathToFileURL(workerPath).href)).default;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const fullStack = "remote-full-stack-programming-jobs";
  const calls = [], lines = [];
  let allFail = false;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      assert.equal(url.hostname, "weworkremotely.com");
      const feed = url.pathname.split("/").at(-1).replace(/\.rss$/, "");
      calls.push(feed);
      if (allFail || feed === fullStack) throw new DOMException("mock feed timeout", "TimeoutError");
      return new Response(`<rss><channel><item><title>Acme: Backend Developer</title>
        <link>https://weworkremotely.com/remote-jobs/${feed}</link>
        <description>Java Spring Boot PostgreSQL</description></item></channel></rss>`);
    };

    const run = async (scanIds) => {
      calls.length = 0;
      lines.length = 0;
      queries = 0;
      let acknowledged = 0;
      console.log = (...args) => lines.push(args.join(" "));
      try {
        await worker.queue({
          queue: "jobpilot-ingest",
          messages: scanIds.map((scanId) => ({
            body: scan(scanId), ack() { acknowledged++; }, retry() { throw new Error("unexpected retry"); },
          })),
        }, env, {});
      } finally {
        console.log = originalLog;
      }
      assert.equal(acknowledged, scanIds.length);
      return lines.filter((line) => line.startsWith("ingest wwr/*: "))
        .map((line) => JSON.parse(line.slice("ingest wwr/*: ".length)));
    };

    const [partial] = await run([1]);
    console.log("T-120 WWR one timeout:", JSON.stringify({ ...partial, fetches: calls.length, queries }));
    assert.equal(partial.status, "ok", "1 feed timeout không làm hỏng cả lượt");
    assert.equal(partial.raw, 4);
    assert.equal(partial.created, 4);
    assert.equal(calls.length, feedCount);
    assert.ok(lines.some((line) => line.includes(fullStack) && line.includes("timeout")));
    const sources = db.prepare("SELECT source_url FROM jobs WHERE source_id = 'src-wwr'").all();
    assert.deepEqual(sources.map((row) => row.source_url).sort(),
      calls.filter((feed) => feed !== fullStack).map((feed) => `https://weworkremotely.com/remote-jobs/${feed}`).sort());

    allFail = true;
    const [failed] = await run([2]);
    console.log("T-120 WWR all timeouts:", JSON.stringify({ ...failed, fetches: calls.length, queries }));
    assert.equal(failed.status, "error", "5 feed lỗi phải báo lỗi nguồn");
    assert.equal(failed.error, "mock feed timeout");
    assert.equal(failed.raw, 0);
    assert.equal(calls.length, feedCount);
    assert.deepEqual(db.prepare("SELECT success FROM ingest_scan_results ORDER BY scan_id").all().map((row) => row.success), [1, 0]);

    allFail = false;
    const batch = await run(Array.from({ length: ingestBatchSize }, (_, index) => index + 3));
    assert.equal(batch.length, ingestBatchSize);
    assert.ok(batch.every((result) => result.status === "ok" && result.raw === 4));
    assert.equal(calls.length, feedCount * ingestBatchSize);
    assert.ok(calls.length <= 50, "ngân sách fetch trực tiếp Workers Free");
    assert.ok(queries <= 40, "ngân sách D1 queue");
    console.log(`T-120 wwr-partial selfcheck OK; batch ${batch.length}, fetches ${calls.length}, D1 queries ${queries}`);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
