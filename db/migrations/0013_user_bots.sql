-- 0013: bot Telegram riêng từng khách. token_enc = base64(iv12 + AES-GCM(token)), khoá env.TG_TOKEN_KEY, AAD = user_id.
-- bot_id = phần số trước ":" của token; status 'ok' | 'broken'. Prod chạy tay: wrangler d1 execute --file (IF NOT EXISTS nên chạy lại an toàn).
CREATE TABLE IF NOT EXISTS user_bots (
  user_id        TEXT PRIMARY KEY,
  bot_id         TEXT UNIQUE,
  username       TEXT,
  token_enc      TEXT,
  webhook_secret TEXT,
  status         TEXT,
  last_error     TEXT,
  created_at     INTEGER,
  checked_at     INTEGER
);
