-- JobPilot Edge — migration 0010: job dán tay thuộc riêng người nộp (T-05)
-- NULL = job quét chung từ nguồn; có giá trị = chỉ người này thấy và được chấm điểm.
-- Thứ tự deploy: áp migration này TRƯỚC Worker mới (Worker mới đọc cột submitted_by ở mọi danh sách job).
ALTER TABLE jobs ADD COLUMN submitted_by TEXT REFERENCES users(id);
CREATE INDEX idx_jobs_submitted_by ON jobs(submitted_by, created_at);
