# JobPilot Edge — Roadmap (nguồn kế hoạch duy nhất)

> Cập nhật: 03/11/2026. File này gộp: kế hoạch gốc `PLAN.md` (mục 10), backlog `worklog/BACKLOG.md`, research người tìm việc 2026–2030 (`worklog/research/2026-10-30_nguoi-tim-viec-2026-2030.md`), rà nguồn job (`worklog/research/2026-10-30_nguon-job-tang-2-3.md`) và lượt nhập vai đánh giá sản phẩm ngày 03/11.
> Trạng thái từng task vẫn theo `worklog/task_states.md`. Khi hai nơi lệch nhau, task_states là đúng.

## 1. Định vị

**"Ý kiến thứ hai trung thực trước khi bạn bấm Nộp."**
AI đứng về phía ứng viên. ITviec, TopDev, VietnamWorks dùng AI để chấm ứng viên cho HR; JobPilot chấm tin tuyển cho ứng viên, giải thích được, và nói thẳng tin nào nên bỏ qua.

Khách hàng chính: **middle 2–5 năm đang đi làm, tìm việc âm thầm** (persona B trong research). Khách phụ: junior đang chật vật (persona A). Không tối ưu cho senior/AI-cloud (persona C).

Lợi thế không sao chép nhanh được: dữ liệu quét 30 phút/lần cho biết **tin đăng lại bao nhiêu lần, treo bao lâu, công ty nào hay đăng tin ảo**; sau khi có người dùng, kanban cho biết **tỉ lệ phản hồi theo công ty**. Không trang tuyển dụng nào cho ứng viên xem các số này.

## 2. Hiện trạng (production 03/11/2026)

| Chỉ số | Giá trị | Ý nghĩa |
|---|---|---|
| Tài khoản / hồ sơ | 9 / 10 | 7 tài khoản tạo trong tuần 29/10 (người quen thử) |
| Tài khoản đã khai kỹ năng | 3 / 9 | Chỉ 3 người thực sự được chấm điểm |
| Người từng dùng kanban | 2; 5 đơn qua cột "Mới" | Hệ thống tự sinh 1.374 thẻ, người dùng đụng 7 |
| Tin / nguồn | 330 / 6, tất cả `ok` | HN 88, WWR 93, ITviec 60, TopDev 48, Remote OK 33, Remotive 8 |
| Tin có JD | 0 / 330 | Điểm chỉ dựa trên tag kỹ năng |
| Tin có lương | 14 / 330 | Benchmark gần như chỉ dùng bảng tham khảo |
| Tin remote khoá vùng Mỹ/EU/Canada/UK | 60 / 225 | Vẫn được chấm khớp khu vực 8/8 (`worker.js:483`) |
| Từ khoá quét ITviec/TopDev | Java, Node.js, Backend, Spring Boot, cố định | Dev frontend/data/mobile không thấy tin của mình (`worker.js:587`) |

Kết luận: app chưa có điểm giữ chân (không thông báo ngoài app), và có 3 lỗi làm người thạo nghề mất tin điểm ngay (khu vực remote, từ khoá cố định, thẻ kanban tự sinh).

## 3. Lộ trình

Nguyên tắc: mỗi đợt có tiêu chí nghiệm thu đo được trên production; không làm đợt sau khi đợt trước chưa đạt. Deploy, migration, auth: hỏi anh trước từng bước.

### Đợt 0 — Sửa để tin được điểm (1 tuần)

| # | Việc | Backlog | Ở đâu | Nghiệm thu |
|---|---|---|---|---|
| 0.1 | Tin remote khoá vùng (US/EU/Canada/UK only…) không được tính khớp khu vực; chỉ "Anywhere/Worldwide/APAC/Vietnam" hoặc có khu vực hồ sơ mới được 8 | mới: T-60 | `worker.js:483` + selfcheck | 60 tin khoá vùng trên prod tụt điểm khu vực; `score.selfcheck` có case mới |
| 0.2 | Từ khoá quét ITviec/TopDev lấy từ `target_roles` + top kỹ năng của mọi hồ sơ (gộp, dedupe, tối đa ~12), không còn 4 từ cố định | mới: T-61 | `ensureSources`, cron `worker.js:1162` | Hồ sơ "React" thấy tin React trong 1 giờ sau khi lưu |
| 0.3 | Bỏ tự sinh thẻ kanban; thẻ chỉ tạo khi người dùng bấm Lưu/đổi cột. Dọn thẻ `new` chưa đụng tới | T-06 | `worker.js:539`, `:568` | Cột "Mới" trống với tài khoản mới; migration dọn dữ liệu cần anh duyệt |
| 0.4 | Merge bản sửa thêm job bằng link: allowlist host, tin riêng theo người nộp, rate-limit | T-05 | nhánh `task/T-05` + migration 0004 | Review độc lập PASS → migration → Worker |
| 0.5 | `titleGate` chặt hơn (6 loại tiêu đề phi dev đang lọt), lọc tag phi kỹ thuật ITviec | T-07, T-08 | `worker.js:506` | Bảng ≥ 15 tiêu đề assert đúng |
| 0.6 | Bỏ tự động xoá kỹ năng cũ khi lưu từ CV; cho xoá cấp bậc/lương/follow-up | T-44, T-43 | SPA + PATCH | 4 kỹ năng + tích 2 từ CV → có 6 |

### Đợt 1 — Quyền riêng tư và an toàn tối thiểu (1 tuần, trước khi mời người lạ)

| # | Việc | Backlog | Nghiệm thu |
|---|---|---|---|
| 1.1 | Màn hình đồng ý trước khi tải CV (lưu ở đâu, AI đọc gì), nút xoá CV, nút xoá tài khoản, công tắc "tự nhập kỹ năng, không dùng AI", trang chính sách dữ liệu | T-24 + mới: T-62 | Luật 91/2025 + NĐ 356 yêu cầu thông báo, giải thích, quyền từ chối xử lý tự động |
| 1.2 | Đăng xuất thu hồi session; giới hạn kích thước CV (≤ 5 MB) và rate-limit đăng ký | T-15, T-16 | Token cũ → 401; file 6 MB → 413; spam đăng ký → 429 |
| 1.3 | Turnstile cho đăng ký / đăng nhập / thêm job | T-23 | Register không token → 403 |
| 1.4 | Quên / đổi mật khẩu (qua email sau khi có domain; tạm thời đổi mật khẩu khi đã đăng nhập) | T-22 | Mật khẩu cũ + session cũ hết hiệu lực |
| 1.5 | Backup D1 → R2 hằng ngày; export dữ liệu theo user (phục vụ 1.1) | T-25 | Có file backup sau 1 chu kỳ |
| 1.6 | Dead-letter queue; `PATCH /applications` validate `stage`; `digest/today` không ghi DB mỗi lần gọi | T-19, T-17, T-47 | Message lỗi rơi vào DLQ |

> **Cập nhật 03/11/2026 theo nghiên cứu thị trường** (`worklog/research/2026-11-03_TONG-HOP-thi-truong-va-feature.md`): "AI quét + chấm khớp + sửa CV" đã có ≥ 5 đối thủ VN (JoFi, UpNow, Luminpath, TalentFlux, VibeApply) và ~10 sản phẩm Product Hunt; TopCV bán lẻ match score. Khác biệt còn mở của JobPilot: lịch sử quét (tin đăng lại, treo lâu, làm mới giả), tỉ lệ phản hồi theo công ty, không auto-apply / không bịa CV, benchmark lương thật, alert Telegram. Vì vậy **đợt 2 đổi thứ tự: 2.3 → 2.2 → 2.1 → 2.4 → 2.5**, thêm 2.7 sửa benchmark và 2.8 landing. Kiểm kê code: 22 feature đầy đủ, 6 nửa vời, 10 chỉ backend; 3 "feature giả" phải lấp trước khi nói chuyện HR: chấm không JD, benchmark 14/167 tin có lương, brief sáng chỉ ghi DB.

### Đợt 2 — Lý do quay lại mỗi ngày (2 tuần) — thứ tự mới: 2.3, 2.2, 2.1, 2.4, 2.5, 2.6, 2.7, 2.8

| # | Việc | Backlog | Nghiệm thu |
|---|---|---|---|
| 2.1 | **Bot Telegram**: 1 bản tin/ngày (giờ yên lặng, tiêu đề trung tính) + báo ngay khi có tin khớp mạnh. Chạy trên Worker sẵn có, không cần domain. Người dùng gắn bằng mã /start | mới: T-63 | ≥ 50% tài khoản có kỹ năng bật Telegram; mở link từ bot ≥ 1 lần/tuần |
| 2.2 | **Lấy JD** cho tin từ mức "một phần" trở lên (fetch trang chi tiết, 1 request/tin, giới hạn theo quota); đọc số năm kinh nghiệm, yêu cầu tiếng Anh, cấp bậc thật | T-30 (phần không cần Browser Rendering) | ≥ 70% tin partial+ có `jd_text`; điểm cấp bậc dùng JD |
| 2.3 | **Điểm "rủi ro tin ảo"** từ lịch sử quét: số lần đăng lại, số ngày treo, lương "thỏa thuận"; chip + giải thích | mới: T-64 | Dùng `first_seen_at`, `content_hash`; hiện trên thẻ và trong "Vì sao điểm này?" |
| 2.4 | **Khuyến nghị kèm điểm**: "Nên nộp" / "Nộp nếu bổ sung X" / "Bỏ qua" + 1 dòng lý do; sửa câu "trên tổng trọng số" | mới: T-65, T-13 | Mỗi thẻ có 1 trong 3 nhãn |
| 2.5 | **Thống kê tuần** trên kanban ("nộp 5, qua 1 vòng, 2 im lặng"); tự chuyển đơn im lặng > 14 ngày sang "đóng mềm" | mới: T-66 | Dữ liệu kanban sẵn có |
| 2.6 | Morning brief theo hồ sơ đang chọn | T-09 | Đổi hồ sơ → số brief đổi |
| 2.7 | **Sửa benchmark cho thật**: parse lương USD từ Remote OK/Remotive/HN, quy đổi, hiện "n mẫu, nguồn", ẩn số khi n < 5; landing không hứa "từ tin đang tuyển" khi n nhỏ | mới: T-72 | Benchmark hiện số thật với ≥ 5 mẫu cho backend/frontend; không còn bảng tĩnh khi đủ mẫu |
| 2.8 | **Landing nói đúng**: 6 nguồn, bỏ "xuất: sắp có", thêm 3 cam kết niềm tin (không chia sẻ CV, xoá 1 nút, nhà tuyển dụng thật không thu phí), nói rõ "không auto-apply, không bịa CV" | mới: T-73 | Mọi câu trên landing kiểm được trên app (T-38) |

### Đợt 3 — Tạo khác biệt (sau khi đợt 2 có số liệu)

| # | Việc | Backlog |
|---|---|---|
| 3.1 | Gợi ý sửa CV theo JD, dạng so sánh, chỉ dùng thông tin có trong CV, người dùng duyệt từng dòng; xuất danh sách kỹ năng để dán vào ITviec/TopDev/LinkedIn | T-28 (đổi phạm vi) |
| 3.2 | Benchmark lương gắn vào từng tin không ghi lương, ghi rõ nguồn và độ lệch mẫu; câu hỏi Gross/Net | mới: T-67 |
| 3.3 | Chấm thêm tiếng Anh/Nhật, loại công ty (outsourcing / product / khách nước ngoài) | mới: T-68 |
| 3.4 | Kanban theo vòng phỏng vấn (sàng lọc, test, technical, offer) + checklist; lịch phỏng vấn | T-37 |
| 3.5 | Cờ lừa đảo cho link dán tay (đòi phí, chỉ liên hệ Zalo/Telegram) + câu "Nhà tuyển dụng thật không thu phí" | mới: T-69 |
| 3.6 | Thêm kịch bản đàm phán "giữ thể diện": nhắc lại sau khi chờ lâu, từ chối offer | mới: T-70 |
| 3.7 | Nguồn hợp lệ thêm: Greenhouse/Lever theo danh sách công ty anh đưa; VietnamDevs nếu anh duyệt scrape; bookmarklet "lưu job 1 click" (không extension, lấy LinkedIn hợp lệ) | từ research nguồn |
| 3.8 | **"JD lint" miễn phí cho HR**: dán JD → % hồ sơ mẫu junior/middle/senior khớp, kỹ năng đòi quá nhiều, lương dưới trung vị. Dùng `scoreJob()` thuần, không đụng dữ liệu user, không bán gì → không chạm giấy phép dịch vụ việc làm. Cửa vào HR và lead cho đợt 4 | mới: T-74 |
| 3.9 | **Chuẩn bị cohort mode** (đường B2B thử trước, R3): bảng `orgs`, `org_members`, role coach/học viên; consent "cho [trung tâm] xem tiến độ"; chỉ làm khi có 1 trung tâm đồng ý pilot | mới: T-75 |

### Đợt 4 — Khi có người dùng ổn định (≥ 30 tài khoản hoạt động)

- Nâng Workers Paid ($5/tháng); domain riêng → email digest (T-31), Email Routing (T-32), Cloudflare Access cho `/admin` (T-35).
- Analytics Engine + funnel `/admin` (T-34); cảnh báo quota + trang trạng thái (T-36).
- Luyện phỏng vấn theo JD (T-29); số liệu ẩn danh tỉ lệ phản hồi theo công ty (người dùng chọn tham gia); theo dõi liên hệ/referral; lộ trình kỹ năng cho junior.
- Nối hoặc gỡ: realtime hub, notifications, Vectorize (T-11); AI Gateway (T-27); trang hồ sơ public (T-33).

### Không làm
- Tự nộp đơn (auto-apply) — lời chê số 1 trên Product Hunt (25–40% đơn fail im lặng, recruiter coi là spam). Scrape LinkedIn, Facebook, Wellfound, aggregator. Review công ty dạng tự do. AI viết lại CV bịa kinh nghiệm. Thông báo dày hơn 1 bản tin/ngày. Cover letter AI (dev VN ít dùng, rủi ro bịa). **Đăng tin / CV search / bán hồ sơ cho HR** (cần giấy phép + ký quỹ 300tr theo Luật Việc làm 2025 + NĐ 352; mâu thuẫn "không chia sẻ CV với nhà tuyển dụng" trên landing; JoFi/UpNow đã chiếm). Gói trả phí tự gia hạn theo tuần (nguồn khiếu nại số 1 trên PH).

### Hướng B2B (khi đến đợt 4), theo rủi ro tăng dần
1. **Cohort mode cho bootcamp/trung tâm có cam kết việc làm** (CoderSchool, MindX, Rikkei, FUNiX…): 150–300k/học viên/khoá hoặc 3–5tr/cohort; tận dụng kanban + chấm điểm; không chuyển dữ liệu ra ngoài. KPI 3 tháng: 2 pilot free + 1 trả tiền, ≥ 30 học viên active.
2. **Báo cáo tổng hợp ẩn danh thị trường dev VN** (kỹ năng thiếu, lương, tin treo theo công ty; k ≥ 10/ô): 2–5tr/bản quý, chủ yếu tạo uy tín.
3. **Reverse marketplace nhẹ** ("mời phỏng vấn có lương trước"): chỉ khi ≥ 2.000 dev active, ≥ 300 opt-in, đã có tư vấn luật.

## 4. Việc kỹ thuật nền (làm xen kẽ, không chặn đợt)

| Việc | Backlog |
|---|---|
| Deploy tái lập được từ repo: `wrangler.toml.example` khớp code; dựng lại cấu hình binding (bản ở `D:\research\jp-deploy` đã mất 03/11) | T-20 |
| Đưa `worklog/` vào git hoặc nơi lưu ổn định | mới |
| Script kiểm layout + rò chữ tiếng Việt (bản cũ đã mất) đưa vào `apps/web/test/` | T-21 |
| Logo `logo-chrome-mark.png` vào git; landing mobile 390 kiểm lại | T-51, T-52 |
| ITviec keyword "Node.js" 404; `last_status` bị ghi đè; dọn job > 30 ngày | T-49, T-45 |
| Chấm lại song song ghi đè; pill chấm lại dừng sớm | T-50, T-12 |

## 5. Trước khi ra thị trường thật — câu hỏi phải trả lời

1. **Pháp lý nguồn ITviec/TopDev.** Chưa đọc ToS hai bên. Phải đọc, hoặc xin hợp tác, trước khi quảng bá công khai. Song song: tăng tỉ trọng nguồn hợp lệ (HN, WWR, Remotive, Greenhouse/Lever) và "lưu job 1 click".
2. **Luật dữ liệu cá nhân VN** (Luật 91/2025, NĐ 356): đồng ý, giải thích xử lý tự động, quyền từ chối, xoá dữ liệu; Cloudflare xử lý ngoài VN → có thể cần hồ sơ chuyển dữ liệu. Hỏi người hiểu luật.
3. **Ai trả tiền?** Ba hướng: freemium (thông báo miễn phí, sửa CV + prep trả phí); bán cho bootcamp/trường; thu từ nhà tuyển dụng (mâu thuẫn định vị). Phỏng vấn 10–20 người dùng thật trước khi chọn.
4. **Kênh tiếp cận**: Voz, nhóm IT Facebook, Viblo, kênh Telegram tin đã chấm (vừa là sản phẩm vừa là kênh).
5. **Số liệu phải đo từ bây giờ**: tỉ lệ kích hoạt (hồ sơ ≥ 3 kỹ năng, hiện 3/9), người quay lại hằng tuần, đơn nộp từ JobPilot, tỉ lệ được phản hồi.

## 6. Thứ tự làm ngay (đề xuất)

1. Đợt 0.1 → 0.3 (3 việc làm mất tin điểm nhanh nhất): ~2 buổi, deploy 1 lần.
2. Đợt 0.4 (T-05) sau khi có review độc lập.
3. Đợt 1.1 + 1.2 trước khi mời thêm người lạ.
4. Đợt 2.1 (Telegram) là tính năng đầu tiên tạo thói quen quay lại; làm ngay sau đợt 1.
