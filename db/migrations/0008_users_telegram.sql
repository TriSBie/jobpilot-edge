-- 0008: bot Telegram (ROADMAP 2.1, T-63): gắn chat, mã gắn 1 lần, giờ bản tin.
ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN telegram_link_code TEXT;
ALTER TABLE users ADD COLUMN telegram_linked_at INTEGER;
ALTER TABLE users ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 8;
