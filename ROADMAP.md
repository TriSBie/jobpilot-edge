# JobPilot Edge — Roadmap (nguồn kế hoạch duy nhất)

> Cập nhật: 05/11/2026 (mục 6 = backlog tổng hợp + thứ tự làm). File này gộp: kế hoạch gốc `PLAN.md` (mục 10), backlog `worklog/BACKLOG.md`, research người tìm việc 2026–2030 (`worklog/research/2026-10-30_nguoi-tim-viec-2026-2030.md`), rà nguồn job (`worklog/research/2026-10-30_nguon-job-tang-2-3.md`) và lượt nhập vai đánh giá sản phẩm ngày 03/11.
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

## 6. Backlog tổng hợp (05/11/2026) — thứ tự release

Gộp ROADMAP + 3 audit ngày 05/11 (`worklog/research/2026-11-05_ux-activation-audit.md`, `2026-11-05_growth-thu-hut-nguoi-dung.md`, `2026-11-05_tech-seo-perf-share-audit.md`) + review của Codex cùng ngày. Cỡ: S ≤ nửa buổi, M 1–2 buổi, L ≥ 3 buổi. 🔒 = cần anh duyệt (deploy, DB, auth, secret, cấu hình queue).

**Trạng thái theo bằng chứng:** 0.1–0.3 và 1.1/1.2/1.3/1.5 đã live 03/11 (Turnstile dùng test key; cron backup `0 18` chưa đăng ký). 2.1/2.2/2.3/2.4/2.5/2.7/2.8 là **code xong trên `fix/d2-all`, chưa phải sẵn sàng deploy**. `worklog/task_states.md` còn ở 29/10 nên lệch: bước 0 sửa việc này.

Nguyên tắc: làm theo đúng 5 bước dưới đây, bước sau chỉ bắt đầu khi bước trước đạt nghiệm thu. Không duyệt deploy (bước 3) trước khi bước 2 PASS.

### Bước 0 — Đồng bộ trạng thái + chuẩn bị release
| # | Việc | Nghiệm thu |
|---|---|---|
| 0a | Cập nhật `task_states.md` theo bằng chứng (commit, version Worker/Pages live, kết quả kiểm); task mới T-76 → T-92 ghi `proposed` | Mỗi task đã live có version/commit; không còn task live mà ghi `proposed/blocked` |
| 0b | Cấu hình deploy khớp source: binding trong `wrangler.prod.toml` = binding code dùng (DB, KV, R2, 3 queue, DO, AI, Vectorize, vars Telegram/Turnstile); danh sách migration còn thiếu trên D1 prod (dự kiến 0007, 0008) đối chiếu lịch sử migration đã áp dụng, nội dung từng migration và schema/index thực tế; `PRAGMA table_info` riêng lẻ không đủ chứng minh migration đã chạy. Mọi truy vấn D1 production cần anh duyệt riêng; trước đó chỉ đối chiếu file local | Bảng binding/migration đối chiếu trong `worklog/release/d2.md` (T-20) |

### Bước 1 — Gói sửa đúng đắn (B + D đúng đắn), trên `fix/d2-all`
Đúng đắn của dữ liệu/kết quả, đứng trước gói tăng trưởng.

| # | Việc | Nguồn | Cỡ | Nghiệm thu |
|---|---|---|---|---|
| B1 | Nhận diện cấp bậc: tiêu đề nhiều cấp ("Middle/Senior", "Mid/Sr", "Mid - Senior") có cấp của hồ sơ thì **không** lệch; chỉ "lệch cấp" khi tiêu đề/JD rõ ràng chỉ senior/lead/principal mà hồ sơ junior/middle . Hồ sơ senior với job middle không mặc định Bỏ qua. Title/JD mâu thuẫn hoặc không rõ thì ghi chưa đủ bằng chứng, không tự kết luận lệch cấp. Không nới theo ngưỡng điểm. Bỏ qua xếp cuối ở tab Jobs — T-76 | UX #1, Codex; lab: 11/133 tin "lệch cấp" có ghi Middle/Mid | S | Selfcheck: ≥ 6 tiêu đề nhiều cấp → khớp, ≥ 4 tiêu đề lệch thật → Bỏ qua; có case title/JD mâu thuẫn và senior ứng tuyển middle |
| B2 | Khoá vùng ghi trong **tiêu đề** ("U.S. Based…") cũng không khớp khu vực — T-77 | UX #2, `worker.js:651` | S | Selfcheck có case tiêu đề |
| B3 | Chip "Không ghi lương" bỏ khỏi thẻ (chỉ trong giải thích); chip "cũ" chỉ khi "có thể đã gỡ" — T-78 | UX #3 | S | Thẻ không còn chip ở > 50% tin |
| B4 | Sửa câu "CV không gửi đi đâu" (`index.html:1626`) cho khớp hộp đồng ý (`:1768`, CV lưu R2) — T-79 | UX #4 | S | Hai câu cùng nghĩa, vi + en |
| B5 | Lưu kỹ năng xong tự hiện điểm, không phải tải lại — T-80 | UX TTV | S | Playwright: tài khoản mới thấy tin có điểm không reload |
| B6 | Bản tin sáng thêm tối đa 3 tin mới **còn phù hợp** (không khoá vùng, không Bỏ qua, ứng tuyển được); không có thì ghi rõ "Hôm nay không có tin mới phù hợp", không nhồi cho đủ số — T-81 | UX #5, Codex | S | Selfcheck: 0 tin phù hợp → câu "không có"; tin khoá vùng không vào bản tin |
| B7 | OG/Twitter + canonical + hreflang + `og.png`; `robots.txt`, `sitemap.xml` thật; bỏ `hidden` mặc định `#landingView` (`index.html:1302`) — T-82 | Tech #1,2,4 | S | Kiểm lại sau deploy: 2 file trả đúng content-type; HTML không JS có nội dung |
| B8 | Lazy-load pdf.js (320KB) + Turnstile (87KB) — T-83 | Tech #3 | S | **Đo lại cùng điều kiện** (Pixel 5, 1,6 Mbps, CPU 4x): LCP < 2,5s (trước: 2,70s); Turnstile vẫn chạy ở đăng ký/đăng nhập; đọc được PDF thật |
| B9 | Mobile: tab bar nổi che nút "Tạo hồ sơ", toast che nút — T-84 | UX phụ | S | `matrix.cjs` 30/30 + ảnh 390 |
| B10 | `_headers`: HSTS, X-Frame-Options, Permissions-Policy, CSP Report-Only; contrast link footer — T-85 | Tech #4 | S 🔒 | Header có trên preview Pages |
| D1 | `PATCH /applications` validate `stage` (T-17) | ROADMAP 1.6 | S | `stage:"xyz"` → 400 |
| D2 | Không tự xoá kỹ năng cũ khi lưu từ CV; cho xoá cấp bậc/lương/follow-up (T-44, T-43) | 0.6 | S | 4 kỹ năng + tích 2 từ CV → 6 |
| D3 | Brief sáng theo hồ sơ đang chọn (T-09) | 2.6 | S | Đổi hồ sơ → số brief đổi |
| D4 | `titleGate` chặt hơn + lọc tag phi kỹ thuật ITviec (T-07, T-08) | 0.5 | S | Bảng ≥ 15 tiêu đề assert đúng |
| D5 | `digest/today` không ghi DB mỗi lần gọi (T-47) | 1.6 | S | GET 2 lần → 0 lần ghi |
| D6 | DLQ cho 3 queue (T-19): **chốt cấu hình queue với anh trước release** | 1.6 | S 🔒 | Message lỗi rơi vào DLQ trên lab |

### Bước 2 — Kiểm thử bản tích hợp (lab, fixture hoặc snapshot đã loại PII và bí mật)
Kiểm tra fixture/snapshot trước sử dụng; không nối DB production. Telegram dùng mock, chặn gửi tới dịch vụ thật và kiểm nội dung/đích gửi. Toàn bộ selfcheck + `node --check` · cron + Telegram mock end-to-end · `matrix.cjs` 30/30 · `vi-leak.cjs` 0 rò · đo B8 · tài khoản mới đi hết luồng (đăng ký → hồ sơ → tin có điểm) · bảng verdict trước/sau B1. Kết quả ghi vào `worklog/release/d2.md`. Không PASS thì quay lại bước 1.

### Bước 3 — Duyệt migration + deploy (việc của anh)
| # | Việc | |
|---|---|---|
| A1 | Migration 0007 + 0008 (theo bảng 0b) → Worker → Pages → merge `fix/d2-all` vào `main` + push; kiểm lại trên prod | 🔒 |
| A2 | `wrangler triggers deploy` (cron backup `0 18`) | 🔒 |
| A3 | Telegram: bot BotFather, `wrangler secret put TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, setWebhook | 🔒 |
| A4 | Turnstile thật: site key + `TURNSTILE_SECRET` | 🔒 |
| A5 | Trả lời 4 câu `TONG-HOP` + mục 5 (ToS ITviec/TopDev, luật dữ liệu, ai trả tiền); không chặn deploy nhưng chặn quảng bá (C4/C5) | |

### Bước 4 — Thu hút người dùng (sau khi A1 live)
Đo trước, quảng bá sau.

| # | Việc | Nguồn | Cỡ |
|---|---|---|---|
| C3 | **Làm đầu tiên:** đo funnel + nguồn: `?ref`, 5 chỉ số (kích hoạt, D7/D30, nguồn → tài khoản, bật Telegram, bỏ ở bước CV) — T-88 (gộp T-34) | Growth #2, Codex | M |
| C1 | Dùng thử không cần CV: landing chọn vai trò + kỹ năng → 10 tin đã chấm; "lưu thành hồ sơ" — T-86 | UX + Growth #1 | M |
| C2 | Quét ngay theo `target_roles` khi tạo hồ sơ — T-87 | UX #5 | M |
| C4 | Báo cáo dữ liệu #1 "tin đăng lại / treo lâu" (không quy lỗi công ty cụ thể) → Viblo, 48h sau Voz f91. Chỉ khi C3 live + A5 có câu trả lời ToS — T-89 | Growth #3,4 | M |
| C5 | Kênh Telegram công khai tin đã chấm (tái dùng bot). Cùng điều kiện C4 — T-90 | Growth #5 | S |
| C6 | Link chia sẻ kết quả 1 tin `/s/:id` (OG động, không lộ CV, TTL 30 ngày, `?ref`) — T-91 | Tech #5 | M 🔒 |
| C7 | Badge "tin mới từ lần xem trước" — T-92 | UX | M |

### Để sau
0.4 thêm job bằng link (T-05, migration đổi thành `0009`, chờ review độc lập) · 1.4 đổi mật khẩu (T-22) · làm sạch location HN · đợt 3 (3.1–3.9), đợt 4, mục 4 ở trên · tên miền riêng (niềm tin + email digest T-31) · trang SEO theo ngách sau C4 · trang ngắn cho HR · tự host font · xoá 3 PNG thừa `public/assets/`.

### Mốc thời gian (ước đoán)
Tuần 1: bước 0–2 · tuần 2: bước 3 + C3 · tuần 3–5: C1, C2, rồi C4/C5 · trước Tết 2027: C6/C7 + tên miền, đón mùa nhảy việc sau Tết. Mục tiêu 150–400 tài khoản sau 90 ngày (ước đoán của audit growth, chưa có số so sánh).
