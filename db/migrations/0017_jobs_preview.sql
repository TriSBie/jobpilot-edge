-- 0017: dữ liệu xem nhanh trên thẻ job (SPEC 12/11 §3A) + chỗ cho toạ độ (§3B). Chỉ ADD COLUMN; chạy tay trên prod (wrangler d1 execute --file), một lần (ALTER không có IF NOT EXISTS).
-- Đảo ngược: không cần hạ — cột thừa vô hại, code cũ không đọc. Nếu bắt buộc: ALTER TABLE jobs DROP COLUMN <tên> cho từng cột dưới (SQLite >= 3.35).
ALTER TABLE jobs ADD COLUMN company_logo_url TEXT;  -- URL CDN nguồn, chỉ https + host trong LOGO_HOSTS, <= 500 ký tự
ALTER TABLE jobs ADD COLUMN address TEXT;           -- địa chỉ văn phòng <= 300 ký tự; '' = đã thử bóc, không có
ALTER TABLE jobs ADD COLUMN benefits TEXT;          -- JSON mảng <= 5 chuỗi (<= 60 ký tự/mục)
ALTER TABLE jobs ADD COLUMN work_mode_src TEXT;     -- 'onsite'|'hybrid'|'remote' do NGUỒN ghi; NULL = nguồn không ghi
ALTER TABLE jobs ADD COLUMN lat REAL;               -- 3B, chưa dùng
ALTER TABLE jobs ADD COLUMN lng REAL;
ALTER TABLE jobs ADD COLUMN geocoded_at INTEGER;    -- 3B: 0 = đã thử, không ra; NULL = chưa thử
