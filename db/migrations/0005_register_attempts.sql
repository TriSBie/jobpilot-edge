-- JobPilot Edge — migration 0005: đếm đăng ký theo IP mỗi giờ (T-16b). Cron */30 xoá dòng hour < hiện tại - 2.
CREATE TABLE register_attempts (
  ip     TEXT    NOT NULL,
  hour   INTEGER NOT NULL,   -- floor(unix_epoch / 3600)
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, hour)
);
