-- JobPilot Edge — migration 0003: đếm đăng nhập sai theo tài khoản (thay KV `loginfail:*`) — T-42
-- Chỉ có dòng cho tài khoản có thật (email lạ không ghi gì) nên số dòng ≤ số user.
CREATE TABLE login_failures (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_fail_at  INTEGER NOT NULL      -- unix epoch giây; quá 600 giây thì đếm lại từ 1
);
