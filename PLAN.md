# JobPilot Edge — Kế hoạch chi tiết

- **Trạng thái:** ĐÃ ĐƯỢT — duyệt ngày 23/10/2026
- **Chủ dự án:** Bùi Đức Trí (người dùng đầu tiên + builder)
- **Quan hệ với hệ cũ:** JobPilot Edge là thế hệ sản phẩm của Job Watcher (bản cá nhân + bản MVP). Không đụng vào bản cá nhân đang chạy; dữ liệu cũ được migrate qua Hyperdrive khi Phase 1 sẵn sàng.
- **Mục tiêu kép:** (1) công cụ săn việc thật cho Trí và bạn — thay quy trình tay; (2) case study kiến trúc "almost-all-Cloudflare" phục vụ phỏng vấn backend.

---

## 1. Sản phẩm

### Vấn đề
Job backend ở Việt Nam nằm rải ở ITviec, TopDev, LinkedIn và các trang công ty. Việc quét tay + chấm khớp CV–JD bằng mắt + nhớ lịch follow-up tốn thời gian và dễ bỏ sót job mạnh. Các ghi chú luyện phỏng vấn (Kafka, Java/Spring) lại nằm ở hệ khác, không nối được với từng JD cụ thể.

### Người dùng
- **P0:** Trí — backend engineer, đang tìm việc, profile sẵn có từ Job Watcher.
- **P1:** Người bạn đang tìm việc (đang chờ CV) — multi-profile ngay từ schema.
- **P2 (sau):** Dev Việt tìm việc backend — mở public khi P0/P1 đã dùng ổn định 2–4 tuần.

### Giá trị cốt lõi
1. Job mới từ nhiều nguồn về **một inbox duy nhất**, đã dedupe.
2. Mỗi job có **điểm match có giải thích**: khớp skill nào, thiếu skill nào, nên làm gì tiếp.
3. Pipeline ứng tuyển kiểu kanban có **nhắc follow-up tự động**.
4. **Luyện phỏng vấn theo từng JD**, truy vấn từ kho kiến thức của chính người dùng.

### Không làm (non-goals)
- Không scrape LinkedIn cho bản sản phẩm (ToS). LinkedIn chỉ qua: link user dán, email alert user forward, hoặc agent cá nhân chạy bằng phiên của chính user.
- Không auto-apply hộ ở MVP.
- Không thay thế VPS/Railway cho các hệ khác (Gomly giữ nguyên lộ trình riêng).

---

## 2. Nguyên tắc hạ tầng

1. **Cloudflare-first:** mọi thành phần có đối tác Cloudflare thì dùng Cloudflare.
2. **Free-tier-first:** chi phí mục tiêu $0 cho tới khi vượt quota thật. Quota được coi là ngân sách thiết kế, có dashboard theo dõi và cảnh báo 70%/90%.
3. **Việc nặng không chạy trong request:** ingest, chấm điểm, sinh nội dung AI đều qua Queues/Workflows.
4. **AI là lớp cuối, không phải lớp đầu:** lọc bằng rule rẻ trước, cache kết quả, chỉ gọi AI cho job có tiềm năng.
5. **Mọi tích hợp đều có fallback:** AI Search lỗi → tìm keyword trên D1; Browser Run hết quota → fetch HTML thường; Vectorize lỗi → rule score vẫn chạy.

---

## 3. Độ phủ Cloudflare — 26/28 nhóm service

Mẫu số = 28 nhóm service thuộc diện edge/developer/AI/Zero Trust mà một SaaS web app có thể dùng thật. Dùng **26**, cố tình bỏ **Containers** (bắt buộc Workers Paid) và **Stream** (phí lưu/phát video; R2 + Realtime thay thế).

| # | Service | Vai trò | Phase |
|---|---|---|---|
| 1 | DNS / CDN / WAF / SSL | Lớp edge khi có domain; trước mắt dùng `pages.dev` | 0/3 |
| 2 | Pages (+ Functions) | Frontend, trang profile public, form/OG endpoints | 0 |
| 3 | Workers + Cron Triggers | API lõi; cron quét job 30 phút/lần | 0 |
| 4 | D1 | Database quan hệ chính | 0 |
| 5 | KV | Cache, session, cờ tính năng, bộ đếm quota, rate limit | 0 |
| 6 | R2 | CV, cover letter, snapshot JD, export/backup | 0 |
| 7 | Queues | Hàng đợi ingest / dedupe / score / notify | 0 |
| 8 | Workflows | Pipeline dài: fetch → dedupe → score → digest | 1 |
| 9 | Durable Objects | Hub realtime theo user (WebSocket): job mới, kanban sync | 3 |
| 10 | Hyperdrive | Đọc/migrate dữ liệu Neon của Job Watcher cũ | 1 |
| 11 | Workers AI | Trích skills, tóm tắt JD, giải thích match, sinh câu hỏi PV | 1–2 |
| 12 | Vectorize | Embedding CV/JD, match ngữ nghĩa + dedupe lớp 2 | 2 |
| 13 | AI Gateway | Cổng duy nhất cho mọi call AI: log, cache, rate limit | 2 |
| 14 | AI Search | Tìm kiếm trên kho ghi chú phỏng vấn của user | 2 |
| 15 | Browser Run | Fallback đọc JD cần JS + chụp snapshot (quota rất nhỏ) | 2 |
| 16 | Images | Tối ưu logo công ty, ảnh OG (transformations) | 1 |
| 17 | Realtime SFU/TURN | Phòng mock interview với bạn/mentor | 4 (theo nhu cầu) |
| 18 | Email Routing | Nhận job alert forward vào `jobs@<domain>` → Worker parse | 3 |
| 19 | Email Sending | Digest sáng; gửi địa chỉ đã verify = free | 1 |
| 20 | Turnstile | Chống spam form submit-job / liên hệ public | 3 |
| 21 | Web Analytics | Traffic trang public | 0 |
| 22 | Analytics Engine | Event sản phẩm: ingest, strong_match, applied, prep_done | 3 |
| 23 | Zaraz | Nạp GA/PostHog server-side khi cần đo sâu | 3 |
| 24 | Observability (Logs/Traces) | Debug pipeline, truy vết lỗi ingest | 0 |
| 25 | Access | Khóa `/admin` + ops dashboard sau đăng nhập | 0 |
| 26 | Tunnel | Agent ingest trên PC của user gọi về an toàn, không mở port | 3 |

---

## 4. Kiến trúc

### Thành phần
- **Web (Pages):** Next.js hoặc Astro tĩnh + islands cho kanban/prep; gọi API qua `api.` subdomain hoặc route `/api` ủy quyền sang Worker.
- **API (Workers, Hono):** REST + WebSocket upgrade tới Durable Object; auth bằng magic link email (MVP) → Access cho admin.
- **Ingest Workers:** fetcher theo nguồn (ITviec, TopDev, RSS, trang công ty), chạy trong Queue consumer + Workflow steps.
- **AI layer:** mọi call qua AI Gateway; model mặc định của Workers AI (LLM tầm trung cho tóm tắt/giải thích, model embedding BGE cho Vectorize).
- **DO hub:** mỗi user một Durable Object (`UserHub`), giữ kết nối WebSocket, phát sự kiện `job.new`, `application.moved`, `digest.ready`, `prep.done`.

### Luồng dữ liệu chính
1. **Ingest:** Cron 30' → enqueue `ingest.source` → fetch → chuẩn hoá → ghi `jobs` (dedupe lớp 1: `content_hash`) → enqueue `score.job`.
2. **Score:** rule score (skills/location/level) → nếu ≥ ngưỡng sơ bộ: embedding JD (cache theo `content_hash`) → cosine với embedding profile (Vectorize) → điểm cuối → nếu strong: Workers AI viết giải thích (cache vĩnh viễn theo cặp job/profile) → lưu `job_matches` → đẩy realtime + đưa vào digest.
3. **Digest:** Workflow 7:00 hằng ngày tổng hợp strong matches + việc follow-up đến hạn → Email Sending (địa chỉ đã verify) + thông báo DO.
4. **Prep:** user chọn job → AI Search truy vấn kho ghi chú (R2 + index) theo skills của JD → Workers AI sinh bộ câu hỏi/flashcards/checklist → lưu `prep_sessions`/`prep_items`.
5. **Public:** trang profile `/p/<slug>` trên Pages; form liên hệ qua Pages Function + Turnstile → Queue → email cho user.

---

## 5. Mô hình dữ liệu (D1)

File SQL đầy đủ: `db/migrations/0001_init.sql`. Các bảng chính:

| Bảng | Nội dung |
|---|---|
| `users` | Tài khoản (email, tên, timezone, verified email đích gửi digest) |
| `profiles` | Hồ sơ tìm việc theo user: vai trò mục tiêu, level, khu vực, lương kỳ vọng, slug public |
| `profile_skills` | Skills của profile (tên chuẩn hoá, trọng số, nguồn: CV/tay) |
| `sources` | Nguồn job (loại, URL, cấu hình fetch, trạng thái sức khoẻ, lần quét cuối) |
| `jobs` | Job đã chuẩn hoá: title, company, location, JD text, URL, `content_hash` UNIQUE, ngày đăng, hạn |
| `job_matches` | Điểm theo cặp job×profile: rule_score, semantic_score, final_score, matched/missing skills (JSON), AI explanation, trạng thái strong/partial/weak |
| `applications` | Kanban: cột (new/saved/applied/interview/offer/rejected/archived), ngày apply, next_follow_up_at, ghi chú |
| `application_events` | Nhật ký thay đổi của application |
| `interviews` | Buổi phỏng vấn: vòng, thời gian, người PV, kết quả |
| `prep_sessions` / `prep_items` | Buổi luyện theo job + từng câu hỏi/flashcard, trạng thái đã thuộc |
| `files` | Metadata file trên R2 (CV, cover letter, snapshot) |
| `digests` | Digest đã gửi (ngày, nội dung tóm tắt, trạng thái gửi) |
| `notifications` | Thông báo in-app (đồng bộ với DO hub) |

KV keys: `cache:jobs:<profileId>` (TTL 5'), `quota:<service>:<yyyy-mm-dd>` (bộ đếm), `ratelimit:<ip>`, `flag:<name>`.

---

## 6. API (Workers — Hono)

**Profile & auth**
- `POST /api/auth/magic-link` · `GET /api/me`
- `POST /api/profiles` · `GET/PATCH /api/profiles/:id`
- `POST /api/profiles/:id/cv` (upload → R2 → Queue trích skills) · `POST /api/profiles/:id/skills/confirm`

**Jobs & matches**
- `GET /api/jobs?profileId=&minScore=&source=&q=` (đọc từ KV cache khi nóng)
- `POST /api/jobs/submit` (dán link/tay — Turnstile) · `POST /api/jobs/:id/rescore`
- `GET /api/jobs/:id` (chi tiết + match breakdown)

**Applications**
- `POST /api/applications` · `PATCH /api/applications/:id` (đổi cột/ghi chú/follow-up)
- `GET /api/applications?profileId=` · `POST /api/applications/:id/cover-letter` (AI → R2)

**Interviews & prep**
- `POST /api/interviews` · `GET /api/interviews?upcoming=1`
- `POST /api/prep` (tạo session theo job) · `GET /api/prep/:id` · `PATCH /api/prep/items/:id`

**Files & public**
- `GET /api/files/:id/url` (presigned/serve qua Worker) · `GET /p/:slug` (Pages)
- `POST /api/public/contact` (Pages Function → Turnstile → Queue)

**Ops (Access bảo vệ)**
- `GET /api/admin/health` (nguồn job, hàng đợi, quota) · `POST /api/admin/ingest/run` · `GET /api/admin/quota`
- WebSocket: `GET /api/realtime` (upgrade → UserHub DO)
- Email handler: Worker `email()` cho Email Routing (parse alert → tạo job)

---

## 7. Thiết kế AI

**Công thức điểm (final_score 0–100):**
- Rule score (50): tỉ lệ skills bắt buộc khớp × trọng số + khớp location/level.
- Semantic score (30): cosine embedding JD ↔ profile (CV + skills + mục tiêu).
- Freshness/fit (20): độ mới của tin, khớp lương/khu vực, trừ điểm JD thiếu thông tin.
- **AI explanation** không tham gia tính điểm — chỉ diễn giải 2 lớp điểm trên + đề xuất hành động. Nhờ vậy điểm ổn định, rẻ và kiểm chứng được.

**Tiết kiệm quota AI:**
- Embedding tính 1 lần theo `content_hash`, lưu Vectorize + đánh dấu trong D1.
- Giải thích AI chỉ sinh cho job qua ngưỡng sơ bộ; cache vĩnh viễn theo (job, profile).
- AI Gateway bật cache cho prompt lặp; mọi call gắn metadata `feature` để xem chi phí theo tính năng.
- Model nhỏ cho trích xuất/tóm tắt; model lớn chỉ cho prep phỏng vấn.

---

## 8. Ngân sách quota (free tier) & guardrail

| Service | Hạn mức free | Ngân sách thiết kế | Khi vượt |
|---|---|---|---|
| Workers | 100.000 req/ngày, 10 ms CPU/req | ≤ 30.000 req/ngày (cron + API + functions) | Cache KV mạnh hơn; cân nhắc Paid $5 |
| D1 | 5M rows read + 100k rows write/ngày, 5 GB | ≤ 1M read/ngày (index đầy đủ, cấm full-scan) | Tối ưu query; Paid khi sản phẩm mở public |
| KV | 100k read, 1k write/ngày, 1 GB | Write ≤ 500/ngày (gộp batch) | Chuyển cache nóng sang Cache API |
| R2 | 10 GB-month, 1M Class A, 10M Class B/tháng | ≤ 2 GB năm đầu | Xoá snapshot JD sau 90 ngày |
| Queues | 10.000 ops/ngày (1 msg ≈ 3 ops) | ≤ 3.000 msg/ngày | Gộp message theo nguồn |
| Workflows | 3.000 steps/ngày | 2 pipeline/ngày × ~200 steps | Chia nhỏ digest theo profile |
| Durable Objects | 100k req/ngày, 13.000 GB-s/ngày | Hub ngủ khi không có kết nối (hibernation) | — |
| Workers AI | 10.000 Neurons/ngày | ≤ 6.000/ngày (lọc rule trước) | Hàng đợi AI xử lý sang ngày sau |
| Browser Run | 10 phút/ngày, 3 browser | ≤ 5 phút/ngày, chỉ fallback | Fetch thường + snapshot để sau |
| Images | 5.000 transformations/tháng | Logo công ty cache theo domain | Dùng ảnh gốc |
| Realtime | 1.000 GB egress/tháng đầu free | Chỉ mock interview khi cần | Tắt tính năng khi gần hết |
| Zaraz | 1M events/tháng | Chỉ event trang public | Tắt Zaraz, giữ Web Analytics |
| Email Sending | Free tới địa chỉ đã verify | Digest 1 email/user/ngày | Paid khi gửi đại trà |

Bộ đếm quota ghi vào KV mỗi ngày; `/admin/quota` hiển thị % đã dùng; cảnh báo ở 70% và 90%.

---

## 9. Bảo mật & tuân thủ

- `/admin` và ops API đứng sau **Cloudflare Access** (login email của Trí); API người dùng dùng magic link + session trong KV (TTL ngắn, xoay vòng).
- Mọi form public có **Turnstile** + rate limit theo IP trong KV.
- Secrets (API keys nguồn job, SMTP/API email) để trong Workers Secrets / Secrets Store — không commit, không ghi log.
- **Chính sách nguồn job:** nguồn public/API/RSS + link user dán + email user forward. Agent cá nhân qua Tunnel chỉ chạy cho tài khoản của chính Trí, không nằm trong bản sản phẩm.
- Dữ liệu CV là dữ liệu cá nhân: file trên R2 để private, chỉ truy cập qua Worker sau auth; có nút xoá toàn bộ dữ liệu theo user.

---

## 10. Kế hoạch triển khai theo phase

### Phase 0 — Móng (2–3 buổi)
- [x] Tài liệu plan + schema + wrangler mẫu (repo này)
- [x] Quyền token: KV, Queues, Vectorize, Workers Scripts, Pages — đã kiểm chứng bằng API thật (23/10)
- [x] Quyền token D1 — đã bổ sung (24/10, qua dashboard: token "ai-agents" đủ 9 permissions)
- [x] Tạo tài nguyên: KV `jobpilot-kv`, Queues ×3 (+ consumers gắn vào worker), Vectorize `jobpilot-emb` 768 chiều cosine
- [x] Tạo D1 `jobpilot` + nạp migration 0001 (14 bảng, verify qua API) · Analytics Engine đã bật + gắn binding EVENTS
- [x] Tạo R2 `jobpilot-files` (user đã Activate R2 bằng thẻ của mình 24/10, $0 due) — **PHASE 0 HOÀN TẤT 24/10: worker /api/health đủ 10/10 bindings true**
- [x] Worker API skeleton deploy tại `jobpilot-api.tribui-it-work.workers.dev` — `/api/health` OK, bindings DB/KV/Queues/DO/AI/Vectorize/Analytics Engine đều true (chỉ FILES chờ R2); Workers Logs (observability) đã bật
- [x] Pages project `jobpilot-edge` (jobpilot-edge.pages.dev) với trang placeholder
- [ ] Access khóa `/admin` (làm cùng đợt bật Zero Trust ở Phase 3 hoặc khi có trang admin thật)
- [ ] Web Analytics cho Pages (token thiếu scope RUM — gộp vào lần sửa token sau; không chặn Phase 1)
- **Nghiệm thu:** deploy 1 lệnh từ repo; `/api/admin/health` trả OK sau Access; quota dashboard đọc được số thật.

### Phase 1 — MVP cho chính Trí (5–7 buổi) — BUILD XONG 24/10, đang nghiệm thu sử dụng
- [x] Import CV: SPA trích text PDF ở client (PDF.js) → API lưu R2 → Workers AI + catalog trích skills → màn hình duyệt → confirm (đã chạy thật với CV của Trí: 25 skills)
- [x] Fetcher ITviec + TopDev (port từ Job Watcher) chạy trong Queue consumer trên Cloudflare edge + dán link/tay qua `/api/jobs/submit`; dedupe theo content_hash; **cổng lọc tiêu đề** loại tin phi kỹ thuật
- [x] Chấm rule score (công thức đã sửa: mẫu số = skill job yêu cầu; bằng chứng < 3 skills thì chặn không lên strong) — kết quả chạy thật: 59 job, 12 strong / 27 partial / 20 weak
- [x] Kanban 7 cột (applications tự tạo khi có match, kéo qua nút/API PATCH + event log); drawer chi tiết job qua API
- [x] Digest: cron 01:00 UTC (08:00 ICT) dựng digest trong app (bảng digests + `/api/digest/today`); **kênh email chờ domain** (Phase 3) — Email Sending cần domain đã verify
- [ ] Migrate dữ liệu Job Watcher cũ qua Hyperdrive — HOÃN: ingest mới đã phủ nhu cầu; làm khi cần đối chiếu lịch sử
- [x] Auth MVP: magic-link-lite (nhập email → session token 30 ngày ở KV); auth cứng (Access/Google) để Phase 3 cùng domain
- **Nghiệm thu:** Trí dùng JobPilot thay Job Watcher để săn việc 3 ngày liên tiếp không thiếu tính năng lõi; digest đúng giờ 3/3 ngày.
- **UI v2 (24/10, đã LIVE):** reskin theo spec `docs/UI-V2-SPEC.md` (khung Linear + điểm nhấn Resend) — nền #08090a, hairline thay shadow, Inter + Instrument Serif, sidebar trái, Morning brief gradient viền + số serif count-up, job rows kiểu issue-list (vòng điểm strong phát sáng cam), Cmd+K palette + phím tắt 1/2/3 + "/" tìm nhanh, skeleton loading, reveal so le; sửa luôn form hồ sơ dùng PATCH thật. Đã kiểm chứng bằng trình duyệt thật: login, 59 job render đủ, kanban 7 cột, hồ sơ + skills, palette — không lỗi hình ảnh.

### Phase 2 — AI (4–5 buổi)
- [ ] Vectorize: embedding profile + JD, semantic score vào công thức điểm
- [ ] AI Gateway: route mọi call AI, bật cache + xem log theo feature
- [ ] AI explanation cho strong match (cache vĩnh viễn)
- [ ] AI Search: index kho ghi chú Kafka/Java/Spring; tính năng Prep theo job (câu hỏi + flashcards)
- [ ] Browser Run fallback cho JD cần JS + snapshot lưu R2
- **Nghiệm thu:** mỗi strong match có giải thích + skills thiếu; tạo được 1 bộ prep hoàn chỉnh từ 1 JD thật; chi phí AI ≤ 6.000 Neurons/ngày.

### Phase 3 — Realtime & kênh vào (3–4 buổi)
- [ ] Durable Objects UserHub: job mới + kanban sync realtime qua WebSocket
- [ ] Email Routing: forward alert vào `jobs@<domain>` → parse thành job (cần domain — xem mục 11)
- [ ] Form submit-job public + Turnstile; trang profile public `/p/<slug>`
- [ ] Analytics Engine events + Zaraz cho trang public; dashboard funnel trong `/admin`
- [ ] Tunnel agent trên PC của Trí (ingest bằng phiên cá nhân, phạm vi cá nhân)
- **Nghiệm thu:** job mới hiện trên UI ≤ 5 giây sau khi ingest xong, không refresh; email forward thành job đúng ≥ 90% mẫu thử.

### Phase 4 — Cứng cáp & mở rộng (khi có user thứ 2+)
- [ ] Onboarding cho người bạn (multi-profile đã có trong schema)
- [ ] Cảnh báo quota tự động qua email/DO; trang trạng thái hệ thống
- [ ] Backup định kỳ D1 → R2; export toàn bộ dữ liệu theo user
- [ ] Đánh giá Workers Paid ($5) khi quota free chạm 70% đều đặn
- [ ] Realtime mock-interview room nếu có nhu cầu thật từ user
- **Nghiệm thu:** user thứ 2 dùng độc lập hoàn toàn; chi phí vẫn $0 hoặc có quyết định Paid bằng số liệu.

---

## 11. Việc cần Trí làm (gộp 1 lần, khi bắt đầu Phase 0)

1. **Edit API token Cloudflare hiện tại**, thêm các quyền Account sau (token giữ nguyên giá trị, không cần dán lại):
   - Workers Scripts: Edit · Workers KV Storage: Edit · D1: Edit · Workers R2 Storage: Edit
   - Queues: Edit · Vectorize: Edit · Workers AI: Read (hoặc Edit nếu có) · AI Gateway: Edit
   - (Access/Tunnel và Email Routing làm ở Phase 3, cấp quyền Zero Trust sau.)
2. **Quyết định domain** (Phase 3 mới cần): mua `krissbui.dev` hoặc 1 domain riêng cho sản phẩm (vd `jobpilot.vn`/`jobpilot.dev`) để bật Email Routing + trang public đẹp. Chưa mua vẫn chạy full Phase 0–2 trên `pages.dev`/`workers.dev`.

---

## 12. Rủi ro & phương án

| Rủi ro | Ảnh hưởng | Phương án |
|---|---|---|
| Nguồn job đổi cấu trúc trang | Ingest gãy từng nguồn | Health check theo nguồn trong `/admin`; gãy 1 nguồn không chặn nguồn khác; snapshot JD để debug |
| Quota free bị chặn cứng khi vượt | Tính năng dừng tới 00:00 UTC | Ngân sách mục 8 + bộ đếm KV + cảnh báo 70/90%; việc AI dồn sang hôm sau |
| Workers AI sai lệch khi trích skills | Điểm match nhiễu | User duyệt skills sau import; rule score là gốc, AI chỉ bổ trợ |
| D1 single-thread mỗi DB | Nghẽn khi nhiều user ghi | MVP 1 DB dùng batch + index; lớn hơn thì tách DB theo user (đúng thiết kế D1) |
| Email vào spam/quota gửi | Digest không tới | Digest đồng thời hiện in-app (DO + notifications), email chỉ là 1 kênh |
| Cloudflare đổi giá/quota | Kế hoạch lệch | Lớp trừu tượng mỏng quanh từng service; rà soát quota mỗi phase |

## 13. Tiêu chí thành công

- **Chi phí:** $0 hạ tầng cho tới khi có quyết định Paid dựa trên số liệu quota.
- **Tốc độ:** strong match tới tay user ≤ 15 phút từ khi hệ thống quét thấy tin.
- **Hiệu quả săn việc:** theo dõi theo tuần — số strong match, tỉ lệ apply, số buổi prep trước phỏng vấn (Analytics Engine).
- **Độ tin cậy:** digest đúng hạn ≥ 95% số ngày; ingest thành công ≥ 95% lượt quét theo nguồn.
- **Giá trị portfolio:** 1 bản kiến trúc + 1 bài viết kỹ thuật “xây SaaS săn việc bằng 26 dịch vụ Cloudflare” từ chính số liệu vận hành thật.

## 14. Quyết định đã chốt / còn mở

**Đã chốt:** tên JobPilot Edge · Cloudflare-first, free-first · không scrape LinkedIn cho sản phẩm · multi-profile từ schema · AI không tính điểm, chỉ giải thích · Containers/Stream không dùng ở MVP.
**Còn mở:** mua domain nào & khi nào (Phase 3) · auth cho user public ở P2 (magic link vs Google OAuth) · có mở đăng ký public hay chỉ invite.
