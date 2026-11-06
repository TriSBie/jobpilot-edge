-- 0009: index cho tra trùng theo source_url (ingest). Thiếu index này mỗi lần tra quét cả bảng jobs,
-- đốt hết 5 triệu hàng đọc/ngày của gói Free (06/11/2026). IF NOT EXISTS: chạy lại an toàn.
CREATE INDEX IF NOT EXISTS idx_jobs_source_url ON jobs(source_url);
