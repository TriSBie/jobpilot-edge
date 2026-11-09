-- 0012: đo funnel closed beta (T-88): nguồn ?ref (first-touch) + ngày hoạt động gần nhất (số ngày UTC, tối đa 1 ghi/ngày/user).
ALTER TABLE users ADD COLUMN ref_source TEXT;
ALTER TABLE users ADD COLUMN last_active_day INTEGER;
