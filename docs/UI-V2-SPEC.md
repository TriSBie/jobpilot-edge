# JobPilot Edge — UI v2 Design Spec

Nguồn cảm hứng: linear.app + resend.com (nghiên cứu trực tiếp 24/10/2026).
Hướng chọn: **khung Linear** (tối giản, hairline, mật độ kiểu product) + **điểm nhấn Resend** (gradient/glow chỉ ở "magic moments"). Giữ accent cam thương hiệu của Trí, thay cho tím của Linear.

## Công thức chung của cả hai trang (rút ra từ nghiên cứu)
1. Nền đen gần tuyệt đối (#08090a–#0a0a0a); bề mặt phân tách bằng **viền 1px trắng 8–12% opacity + highlight mép trên**, KHÔNG dùng bóng đổ lớn.
2. **Serif display (Didone) cho headline + sans grotesque (Inter) cho UI** — cặp font là tín hiệu "premium dev-tool" 2026.
3. Phân cấp chữ bằng **màu trắng → xám** và tracking âm, không bằng độ đậm.
4. Nút **pill 999px**; primary trắng/đen hoặc nền mờ + viền sáng.
5. Màu accent/gradient dùng như **dấu câu**: mỗi màn hình 1 khoảnh khắc màu (Resend), còn lại đơn sắc (Linear).
6. Motif **bàn phím / command palette (Cmd+K)** xuyên suốt.
7. Nhịp dọc thoáng; sản phẩm thật là hình ảnh chính, đóng khung hairline + fade mép.

## Tokens v2
- `--bg: #08090a` (bỏ #0b0e14 hơi xanh của v1) · surface: `rgba(255,255,255,.03)` / `.05` theo tầng
- `--line: rgba(255,255,255,.08)`; panel thêm `box-shadow: inset 0 1px 0 rgba(255,255,255,.06)`
- Text: `#f7f8f8` / `rgba(247,248,248,.62)` / `rgba(247,248,248,.42)`
- Accent: `#f6821f` (cam) — chỉ cho: vòng điểm strong, CTA chính, glow digest. Gradient "magic": `#f6821f → #ffb347` (cam→hổ phách, đúng brand)
- Font: **Inter** (UI, qua Google Fonts) + **Instrument Serif** (display: headline, số liệu lớn) — chữ serif italic chen giữa câu cho 1-2 điểm nhấn kiểu Resend
- Radius: card 16px, panel lớn 20px, chip/pill 999px; bỏ shadow nặng của v1

## Áp dụng theo khu vực
**App shell:** thanh điều hướng trái mảnh (logo + 3 mục + hồ sơ ở đáy) kiểu Linear product thay cho tab ngang; trên mobile thu thành top bar. Tiêu đề trang hai tông: chữ trắng + phần tiếp nối xám (vd "Việc làm — *59 job đang mở*").
**Đăng nhập:** căn giữa kiểu Resend: medallion logo phát sáng cam nhẹ, headline serif hai tông "Săn việc, *có hệ thống.*", nút pill.
**Digest strip → "Morning brief":** panel gradient mép cam, số strong match lớn bằng serif (count-up khi tải), follow-up liệt kê dạng changelog rows (ngày nhỏ caps xám + nội dung).
**Danh sách job:** chuyển từ card rời sang **hàng kiểu Linear issue list**: dày đặc, hover sáng viền, vòng điểm thu nhỏ có stroke gradient khi strong; chip skill = pill nhỏ có chấm màu; chip thiếu = xám mờ thay vì hổ phách gắt.
**Kanban:** cột ngăn bằng hairline dọc, thẻ radius 14 + highlight mép trên, header cột dạng pill nhỏ có số đếm; kéo-thả giữ nguyên cơ chế nút ◀ ▶ + thêm kéo chuột nếu kịp.
**Command palette Cmd+K:** tìm job, nhảy tab, "Quét job mới", chuyển hồ sơ — motif chữ ký của Linear, chi phí làm thấp trong SPA.
**Motion:** reveal so le (stagger fade+slide 8px) khi danh sách tải; transition 150–200ms; tôn trọng `prefers-reduced-motion`; skeleton xám khi loading thay spinner.
**Trạng thái sức khoẻ nguồn** (ingest status): hàng "● Systems" nhỏ ở chân sidebar như pill trạng thái của Resend.

## Ngoài phạm vi v2
Không đổi API, không đổi logic chấm điểm, không thêm trang landing marketing. Đây là reskin + nâng cấp tương tác trên cùng SPA 1 file.
