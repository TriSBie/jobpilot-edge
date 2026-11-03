// Tự kiểm backup T-25 (mock D1/R2, không mạng). Chạy: node apps/api/test/backup.selfcheck.cjs apps/api/src/worker.js
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || "apps/api/src/worker.js", "utf8");
const code = src.slice(src.indexOf("const BACKUP_TABLES"), src.indexOf("async function listBackupManifests"));
const { toNdjson, staleBackupDays, backupToR2, BACKUP_TABLES } = new Function(code + "\nreturn { toNdjson, staleBackupDays, backupToR2, BACKUP_TABLES };")();

assert.equal(toNdjson([]), "");
assert.equal(toNdjson([{ a: 1, b: "x\ny" }, { a: null }]), '{"a":1,"b":"x\\ny"}\n{"a":null}\n');

const days = (n) => Array.from({ length: n }, (_, i) => `backups/2026-10-${String(i + 1).padStart(2, "0")}/`);
assert.deepEqual(staleBackupDays(days(14), 14), []);
assert.deepEqual(staleBackupDays(days(16).reverse(), 14), ["backups/2026-10-02/", "backups/2026-10-01/"]);
assert.deepEqual(staleBackupDays(["backups/junk/", ...days(15)], 14), ["backups/2026-10-01/"]);

// Mock: bảng jobs 1203 dòng (3 trang), bảng users lỗi, 16 thư mục ngày trong R2.
(async () => {
  const r2 = new Map(days(16).map((p) => [p + "manifest.json", "{}"]));
  let calls = 0;
  const env = {
    DB: { prepare: (sql) => ({ bind: (off) => ({ all: async () => {
      calls++;
      if (sql.startsWith("SELECT * FROM users")) throw new Error("boom");
      const total = sql.startsWith("SELECT * FROM jobs") ? 1203 : 0;
      return { results: Array.from({ length: Math.max(0, Math.min(500, total - off)) }, (_, i) => ({ id: off + i }) ) };
    } }) }) },
    FILES: {
      put: async (k, v) => { calls++; r2.set(k, v); },
      list: async ({ prefix, delimiter }) => { calls++; const keys = [...r2.keys()].filter((k) => k.startsWith(prefix));
        return delimiter ? { delimitedPrefixes: [...new Set(keys.map((k) => k.slice(0, k.indexOf("/", prefix.length) + 1)))] } : { objects: keys.map((key) => ({ key })) }; },
      delete: async (keys) => { calls++; for (const k of keys) r2.delete(k); },
    },
  };
  const m = await backupToR2(env);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(m.tables.jobs.rows, 1203);
  assert.equal(m.errors.users, "boom");
  assert.equal(Object.keys(m.tables).length, BACKUP_TABLES.length - 1);
  assert.equal(m.subrequests, calls);
  const manifest = JSON.parse(r2.get(`backups/${today}/manifest.json`));
  assert.equal(manifest.tables.jobs.rows, 1203);
  const dirs = new Set([...r2.keys()].map((k) => k.slice(0, 19)));
  assert.equal(dirs.size, 14, "giữ 14 thư mục (16 giả + hôm nay − 3 cũ nhất)");
  assert.deepEqual(m.deleted, ["backups/2026-10-03/", "backups/2026-10-02/", "backups/2026-10-01/"]);
  console.log("backup selfcheck OK — subrequests/lượt (mock, jobs 3 trang, 3 ngày xoá):", m.subrequests);
})();
