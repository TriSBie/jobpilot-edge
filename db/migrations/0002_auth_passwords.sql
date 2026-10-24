-- JobPilot Edge — migration 0002: mật khẩu cho tài khoản (register/login)
-- Tài khoản cũ (tạo bằng magic-link-lite) có password_hash = NULL → đi luồng "đặt mật khẩu lần đầu" (claim).
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_set_at INTEGER;
