// T-106: kiểm query plan và ranh giới job chung của câu tra trùng ingest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const workerPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const migrations = path.resolve(__dirname, '../../../db/migrations');
const source = fs.readFileSync(workerPath, 'utf8');
const inJson = source.match(/const IN_JSON = "([^"]+)";/);
const query = source.match(/env\.DB\.prepare\(`(SELECT DISTINCT source_url FROM jobs WHERE [^`]+)`\)/);
assert.ok(inJson && query && query[1].includes('${IN_JSON}'), 'tìm thấy câu tra trùng ingest');
const sql = query[1].replace('${IN_JSON}', inJson[1]);

const db = new DatabaseSync(':memory:');
try {
  for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }
  db.exec(`
    INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@example.invalid', 'U', 1);
    INSERT INTO sources (id, type, name, created_at) VALUES ('src', 'topdev', 'TopDev', 1);
    INSERT INTO jobs (id, source_id, source_url, title, company, skills, content_hash, first_seen_at, created_at, submitted_by)
    VALUES ('public', 'src', 'https://example.invalid/public', 'Dev', 'Co', '[]', 'public', 1, 1, NULL),
           ('manual', 'src', 'https://example.invalid/manual', 'Dev', 'Co', '[]', 'manual', 1, 1, 'u');
  `);
  const urls = JSON.stringify(['https://example.invalid/public', 'https://example.invalid/manual']);
  const rows = db.prepare(sql).all(urls).map((row) => row.source_url);
  console.log('ingest dedupe URLs:', JSON.stringify(rows));
  assert.deepEqual(rows, ['https://example.invalid/public'], 'chỉ trả URL của job chung');

  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(urls).map((row) => row.detail);
  console.log('ingest dedupe query plan:', JSON.stringify(plan));
  assert.ok(plan.some((detail) => /\bidx_jobs_source_url\b/.test(detail)), 'phải dùng index source_url');
  assert.ok(plan.every((detail) => !/\bidx_jobs_submitted_by\b/.test(detail)), 'không dùng index submitted_by');
  console.log('ingest-dedupe-plan selfcheck OK');
} finally {
  db.close();
}
