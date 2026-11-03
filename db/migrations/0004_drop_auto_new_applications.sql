-- 0004: xoá thẻ kanban "Mới" do Worker tự sinh khi chấm điểm (ROADMAP 0.3 / T-06).
-- Chỉ xoá thẻ chưa ai đụng: stage = new, không có application_events, note IS NULL.
-- Prod (snapshot 2026-11-03): 1.374 thẻ new, 7 đã đụng -> dự kiến xoá ~1.367.
-- Đếm trước khi xoá:
--   SELECT COUNT(*) FROM applications a WHERE a.stage = 'new' AND a.note IS NULL
--     AND NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = a.id);
DELETE FROM applications
WHERE stage = 'new' AND note IS NULL
  AND NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = applications.id);
