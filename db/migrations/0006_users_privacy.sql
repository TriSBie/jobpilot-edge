-- 0006: quyền riêng tư (ROADMAP 1.1, T-62 + T-24): đồng ý tải CV, tắt AI, đánh dấu xoá tài khoản (xoá hẳn sau 7 ngày bởi cron */30).
ALTER TABLE users ADD COLUMN consent_cv_at INTEGER;
ALTER TABLE users ADD COLUMN ai_opt_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
