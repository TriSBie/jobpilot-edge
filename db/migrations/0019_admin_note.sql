-- 0019: ghi chú nội bộ của owner trên đơn ứng tuyển (SPEC 12/11 §3D, PATCH /api/admin/applications/:id). Chỉ thêm cột; chạy tay trên prod (wrangler d1 execute --file). ALTER không có IF NOT EXISTS: chỉ chạy một lần.
-- Không bao giờ trả cho người dùng thường (chỉ route /api/admin/*). Tối đa 2000 ký tự, kiểm ở Worker.
-- Đảo ngược: ALTER TABLE applications DROP COLUMN admin_note; (không cột nào khác phụ thuộc; mất ghi chú nội bộ đã ghi)
ALTER TABLE applications ADD COLUMN admin_note TEXT;
