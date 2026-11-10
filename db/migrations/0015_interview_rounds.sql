-- 0015: vòng phỏng vấn (roadmap 3.4 / T-37). Chỉ thêm cột + index; chạy tay trên prod (wrangler d1 execute --file). ALTER không có IF NOT EXISTS: chỉ chạy một lần.
-- scheduled_at vẫn NOT NULL: 0 = chưa hẹn giờ (không rebuild bảng).
ALTER TABLE interviews ADD COLUMN kind TEXT;                         -- screen|test|technical|hr|offer (NULL = hàng cũ)
ALTER TABLE interviews ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'; -- JSON [{text, done}]
-- danh sách kanban + route theo đơn tra theo application_id; trước đây chỉ có index theo scheduled_at
CREATE INDEX IF NOT EXISTS idx_interviews_app ON interviews(application_id, scheduled_at);
