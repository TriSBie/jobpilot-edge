-- Rủi ro tin ảo (T-64): lịch sử quét mỗi tin.
ALTER TABLE jobs ADD COLUMN last_seen_at INTEGER;
ALTER TABLE jobs ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN repost_count INTEGER NOT NULL DEFAULT 0;
-- Mốc = lúc migrate (không phải first_seen_at): nếu không, mọi tin >48h bị gắn "có thể đã gỡ" ngay khi deploy.
UPDATE jobs SET last_seen_at = unixepoch() WHERE last_seen_at IS NULL;
