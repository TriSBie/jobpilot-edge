// T-120: chạy cron thật với lịch sử quét và Telegram giả.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const workerPath = path.resolve(process.argv[2] || "apps/api/src/worker.js");
const migrations = path.resolve(__dirname, "../../../db/migrations");
const db = new DatabaseSync(":memory:");
const scanInterval = 30 * 60_000;
const start = Date.now() - 12 * scanInterval;
const sent = [];
let queries = 0, maxQueries = 0, telegramStatus = 200;

function statement(sql, args = []) {
  const stmt = db.prepare(sql);
  return {
    bind: (...values) => statement(sql, values),
    all: async () => { queries++; return { results: stmt.all(...args) }; },
    first: async () => { queries++; return stmt.get(...args) ?? null; },
    run: async () => { queries++; stmt.run(...args); return { success: true }; },
  };
}

async function main() {
  for (const file of fs.readdirSync(migrations).sort()) {
    db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
  }
  db.exec(`
    INSERT INTO sources (id, type, name, is_enabled, created_at) VALUES ('src-itviec', 'itviec', 'ITviec', 1, 0);
    INSERT INTO users (id, email, name, created_at, telegram_chat_id) VALUES ('owner', 'owner@example.invalid', 'Owner', 0, 'fake-chat');
  `);
  const insert = db.prepare(`
    INSERT INTO ingest_scan_results (scan_id, source_type, keyword_index, scan_group, expected_count, success, raw_count)
    VALUES (?, 'itviec', ?, ?, 2, ?, ?)
  `);
  const record = (slot, outcomes) => {
    outcomes.forEach((success, keyword) => {
      insert.run(start + slot * scanInterval, keyword, "a".repeat(64), success, success ? 10 : 0);
    });
  };
  const env = {
    DB: { prepare: statement },
    Q_NOTIFY: { send: async () => {} },
    OWNER_EMAIL: "owner@example.invalid",
    TELEGRAM_BOT_TOKEN: "fake",
    TELEGRAM_API_BASE: "https://telegram.invalid",
  };
  const worker = (await import(pathToFileURL(workerPath).href)).default;
  const daily = async () => {
    queries = 0;
    await worker.scheduled({ cron: "0 1 * * *" }, env, {});
    maxQueries = Math.max(queries, maxQueries);
    assert.ok(queries <= 40, `cron 0 1: ${queries} truy vấn D1`);
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://telegram.invalid/botfake/sendMessage");
      const body = JSON.parse(options.body);
      assert.equal(body.chat_id, "fake-chat");
      sent.push(body.text);
      return new Response("{}", { status: telegramStatus });
    };

    for (let slot = 0; slot < 3; slot++) record(slot, [1, 0]);
    await daily();
    console.log("T-120 failure alert after 3 scans:", sent.length);
    assert.equal(sent.length, 0, "3 lượt có keyword lỗi chưa gửi cảnh báo");

    record(3, [0]); // Một keyword đã lỗi, dù keyword thứ hai chưa trả kết quả.
    telegramStatus = 503;
    await daily();
    console.log("T-120 failure alert after 4 scans:", JSON.stringify(sent));
    const message = "Scraper alert: itviec lỗi 4 lượt liên tiếp";
    assert.deepEqual(sent, [message], "4 lượt lỗi phải gửi cảnh báo");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_scan_alerts").get().n, 0, "gửi lỗi chưa ghi nhận");

    telegramStatus = 200;
    await daily();
    record(4, [1, 0]);
    await daily();
    assert.deepEqual(sent, [message, message], "thử lại khi Telegram lỗi, không báo lặp ở lượt lỗi thứ 5");

    record(5, [1]); // Chưa hoàn tất, chưa xác nhận nguồn phục hồi.
    for (let slot = 6; slot < 10; slot++) record(slot, [1, 0]);
    await daily();
    assert.equal(sent.length, 2, "lượt chưa đủ keyword thành công không reset chuỗi");

    insert.run(start + 5 * scanInterval, 1, "a".repeat(64), 1, 10);
    await daily();
    await daily();
    assert.deepEqual(sent, [message, message, message], "sau một lượt thành công, chuỗi mới chỉ báo một lần");
    console.log("T-120 scan-failure-alert selfcheck OK; daily max queries:", maxQueries);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
