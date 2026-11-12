-- 0020: end-user gaps (Ada audit 12/11). Columns only; run by hand on prod (wrangler d1 execute --file), ONCE (ALTER has no IF NOT EXISTS).
-- Order: apply this BEFORE deploying the worker that reads these columns.
-- Backfill (not run): old rows have derived_at/enriched_at NULL. /api/jobs computes their values at read time until filled.
--   derived columns: POST /api/admin/backfill/derived {limit<=500} (owner only; {dry_run:true} returns the SQL instead of writing), repeat until remaining = 0.
--   logo/address/benefits: POST /api/admin/jd/enrich {limit<=20} (owner only); cron */30 also does 8 per run, never-tried rows first.
-- Reverse: ALTER TABLE <t> DROP COLUMN <col> for each column below (SQLite >= 3.35). Nothing else depends on them.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER; -- NULL = not verified. Never blocks login.
ALTER TABLE jobs ADD COLUMN salary_vnd_min INTEGER;     -- VND/month from salary_text, else conservative JD extraction; NULL = unknown
ALTER TABLE jobs ADD COLUMN salary_vnd_max INTEGER;
ALTER TABLE jobs ADD COLUMN work_mode TEXT;             -- 'onsite'|'hybrid'|'remote'|NULL (same rule as workMode())
ALTER TABLE jobs ADD COLUMN derived_at INTEGER;         -- NULL = the 3 columns above are not computed yet
ALTER TABLE jobs ADD COLUMN enriched_at INTEGER;        -- last detail-page fetch attempt; NULL = never tried
