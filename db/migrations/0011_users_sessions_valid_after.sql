-- 0011: T-22 đổi/đặt lại mật khẩu: session phát trước mốc này (ms) bị huỷ; NULL = chưa từng đổi.
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER;
