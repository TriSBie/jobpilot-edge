-- 0014: thông báo trong app. Chỉ thêm cột; chạy tay trên prod (wrangler d1 execute --file). ALTER không có IF NOT EXISTS: chỉ chạy một lần.
ALTER TABLE notifications ADD COLUMN tg_status TEXT;  -- 'sent' | 'failed' | NULL (= chỉ trong app)
ALTER TABLE notifications ADD COLUMN tg_at INTEGER;
ALTER TABLE users ADD COLUMN jobs_seen_at INTEGER;
-- tránh "79 chưa đọc" ngày đầu
UPDATE notifications SET is_read = 1 WHERE created_at < CAST(strftime('%s','now') AS INTEGER) - 7*86400;
