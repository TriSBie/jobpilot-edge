# DESIGN.md — JobPilot Edge

Một file duy nhất: `apps/web/public/index.html`. Token nằm ở `:root` (sáng) và `html[data-theme="dark"]` (tối). Mặc định theo `prefers-color-scheme`, người dùng đổi bằng nút ☾/☀ (lưu `jp_theme`).

## Màu

| Token | Sáng | Tối | Dùng cho |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#08090A` | nền trang |
| `--surface` | `#FFFFFF` | `#0F1011` | thẻ, khung |
| `--raised` | `#FAFAFA` | `#16171A` | toast, panel nổi |
| `--ink` / `--text` | `#0A0A0A` | `#F7F8F8` | chữ chính |
| `--mute` / `--muted` | `#60646C` | `#8A8F98` | chữ phụ (≥ 4.5:1 trên `--bg`) |
| `--faint` | `#6B6F76` | `#787C84` | chữ nhỏ mờ nhất còn đạt AA |
| `--line` / `--line-strong` | `rgba(0,0,0,.08/.14)` | `rgba(255,255,255,.08/.14)` | viền |
| `--brand` | `#4F5BD5` | `#7C8CFF` | màu nhấn duy nhất: link, nút chính, focus, `::selection` |
| `--pop` | `#D43A3A` | `#F87171` | lỗi, cảnh báo, badge chưa đọc |
| `--mint` / `--mint-ink` | `#E6F4EC` / `#17663F` | `rgba(76,183,130,.14)` / `#7FD1A6` | khớp mạnh, thành công |
| `--sun` / `--sun-ink` | `#FAF0DA` / `#7A5200` | `rgba(212,164,85,.14)` / `#E2B96F` | khớp một phần, cần chú ý |

Quy tắc: chữ thường ≥ 4.5:1, chữ lớn ≥ 3:1, kiểm ở cả hai theme. Không dùng màu để mang nghĩa một mình; trạng thái luôn có chữ hoặc icon đi kèm.

## Chữ

| Vai trò | Font | Vì sao |
|---|---|---|
| Tiêu đề h1, h2 landing, logo (`--f-display`) | **Be Vietnam Pro** 600/700 | Vẽ cho tiếng Việt: dấu chồng (ể, ặ, ỗ) cân, không dính dòng trên ở cỡ lớn. Cho landing một giọng riêng thay vì Inter mọi nơi. |
| Thân bài, UI app (`--f-body`, `--f-head`) | **Inter** 400–700 | Giữ có chủ đích: dấu tiếng Việt rõ ở 13–16px, số và chữ đều đặn ở bảng dày đặc, đã cache sẵn trên nhiều máy. `impeccable` báo `overused-font` cho Inter; đây là lựa chọn đã cân nhắc, không sửa. |
| Điểm số, số liệu, mã (`--f-mono`) | **JetBrains Mono** 500/600 | Số rộng bằng nhau, điểm không nhảy khi thay đổi. |

Tải từ Google Fonts không chặn render (`media="print" onload` + `<noscript>`), `display=swap`. Cỡ chữ: `--fs-1..5` = 13/16/20/26/44px; tiêu đề landing dùng `clamp()`. `text-wrap:balance` cho tiêu đề, `pretty` cho đoạn văn.

## Hình khối

- Bo góc: `--r-sm 8px` (input, nút nhỏ), `--r-md 10px` (thẻ), `--r-lg 12px` (khung lớn), `--r-pill` (chip, nút tròn).
- Viền 1px (`--bw`), bóng gần như không có: `--soft` cho nổi nhẹ, `--pop-shadow` chỉ cho popover/palette.
- Vùng chạm tối thiểu `--tap 44px`. Focus: `--focus` = vòng 2px `--brand` cách 2px, luôn hiện khi dùng bàn phím.

## Chuyển động

- Thời lượng: `--dur-press 120ms`, `--dur-fast 160ms`, `--dur-hover 240ms`, `--dur-view 280ms`, `--dur-card 320ms`. Easing `--ease-out` cho vào, `--ease-inout` cho đổi chỗ.
- Chỉ animate `opacity` và `transform`. Không animate layout.
- Landing: một hiệu ứng hiện dần duy nhất bằng CSS `animation-timeline:view()` (không JS, không IntersectionObserver). Nền theo con trỏ và cuộn mượt chỉ bật trên máy có chuột.
- `prefers-reduced-motion: reduce`: tắt mọi animation và cuộn mượt, nền đứng yên.

## Những thứ không dùng

- Eyebrow (chữ nhỏ in hoa phía trên tiêu đề), dải "đang theo dõi…", chữ gradient.
- Emoji làm icon trong UI: dùng SVG sprite (stroke 2.5, `currentColor`).
- `backdrop-filter` trừ palette ⌘K và thanh tab dưới đáy di động.
- Marquee, thanh tiến độ cuộn, nút "hút" chuột, spotlight theo từng thẻ, lưới nền trang trí, reveal từng phần tử bằng JS.
- Mọi khối đều "h2 căn giữa + lede + lưới": xen khối lệch trái/chia đôi (`.sg-left`, `.sg-split`).
- Câu quảng cáo không kiểm chứng được; số liệu trên trang phải khớp code (6 nguồn, 30 phút, công thức /70).

## Kiểm tra trước khi merge

`DO_NOT_TRACK=1 npx -y impeccable detect --json <url>` (exit 2 = có phát hiện). Mục tiêu: 0, trừ `overused-font`. Quét trên file tĩnh sẽ báo `low-contrast` giả vì trộn màu của hai theme; quét URL là kết quả đúng.
