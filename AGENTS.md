# AGENTS.md — JobPilot Edge

Hướng dẫn cho AI agent (Codex, Claude, Cursor…) làm việc trong repo này. Repo **public**: không ghi email, account ID, token, đường dẫn máy cá nhân vào đây. Vận hành production (deploy, migration, secret) nằm ở `RUNBOOK.md` trong repo/thư mục vận hành riêng của owner, không nằm ở repo này.

## Repo gồm gì

| Đường dẫn | Nội dung |
|---|---|
| `apps/api/src/index.ts` | Entry TypeScript/Hono; chuyển tiếp fetch, queue, scheduled và email tới worker.js; tái xuất UserHub |
| `apps/api/src/worker.js` | Logic legacy còn nguyên; selfcheck đọc source vẫn dùng file này trong giai đoạn chuyển route |
| `apps/web/public/index.html` | Toàn bộ SPA, một file (~4.5k dòng): landing + app, tiếng Việt là nguồn, tiếng Anh qua `t()` / `data-en` |
| `db/migrations/NNNN_*.sql` | Schema D1 (SQLite), áp theo thứ tự số |
| `apps/api/test/*.selfcheck.cjs` | Selfcheck chạy handler thật trên SQLite trong RAM (`node:sqlite`) |
| `apps/web/test/i18n.selfcheck.cjs` | Kiểm khoá tiếng Anh |
| `apps/api/wrangler.toml.example` | Mẫu cấu hình: phải khai báo mọi `env.X` mà worker.js dùng (selfcheck `wrangler-config` bắt lệch) |
| `PLAN.md`, `ROADMAP.md` | Kế hoạch, định vị sản phẩm |

Node >=22.23.4 là mức đã kiểm chứng với selfcheck node:sqlite; Node 22.13 tuy mở module mặc định nhưng chưa chạy được các câu bind của test hiện tại. npm, TypeScript và Hono đã có ở gốc. Dependency pin trong package.json và package-lock.json. Dùng `npm ci`, sau đó `npm run check`. Không tự thêm framework hoặc dependency ngoài task được duyệt.

## Chạy kiểm tra (bắt buộc trước khi commit)

```bash
npm ci
npm run check
```

- `score`, `verdict`, `weekstats` **bắt buộc** truyền đường dẫn `worker.js` làm tham số (không có tham số là lỗi `path undefined`, không phải lỗi code).
- `tools/check.mjs` chạy selfcheck source trên `API_ENTRY` (mặc định worker.js). Contract selfcheck riêng bundle và chạy entry index.ts. Không bỏ contract này khi legacy tests vẫn còn xanh.
- `npm run typegen` sinh worker-configuration.d.ts từ template; `npm run build:api` tạo bundle local vào .test-build/api. `tools/wrangler.mjs` tạo config TOML tạm, không cần config production.
- `d1-budget` kiểm ngân sách D1 gói Free: **≤ 40 truy vấn mỗi lần chạy** queue/cron (một `DB.batch()` tính là 1). Code mới trong queue/cron phải gộp batch.
- Selfcheck mới: chép khung của `submit-privacy.selfcheck.cjs` (DB RAM đủ migration, `worker.fetch`/`worker.queue`/`worker.scheduled` thật, mock `fetch` ngoài). Chứng minh nó **fail trên base** và pass trên bản sửa.
- Có `PRAGMA foreign_keys = ON` trong test khi đụng tới xoá dữ liệu.

## Chạy local (lab)

`wrangler dev --local` với một bản copy của `apps/api/wrangler.toml.example`: đổi `main` sang đường dẫn tuyệt đối tới `worker.js`, `database_id` giả bất kỳ, `--persist-to <thư mục state riêng>` (hai `wrangler dev` dùng chung một thư mục state → `SQLITE_BUSY`). Áp lần lượt mọi file `db/migrations/*.sql` bằng `wrangler d1 execute <db> --local --persist-to <state> --file …`. SPA: phục vụ `apps/web/public` bằng một static server và thay `API_BASE` (`https://jobpilot-api…workers.dev`) bằng URL lab.

- Binding `AI` luôn gọi Workers AI thật kể cả `--local`, **tiêu chung quota 10.000 neurons/ngày với production**. Đừng chạy vòng lặp gọi AI trong lab.
- Turnstile: site key thật chỉ nhận domain production; lab không có `TURNSTILE_SECRET` thì server bỏ qua kiểm tra (có log `WARN turnstile`).

## Quy ước code

- **Line ending:** repo lưu **LF**, máy owner dùng `core.autocrlf=true` nên file làm việc là **CRLF**. Commit bình thường. **Không** dùng `git -c core.autocrlf=false`: blob CRLF làm diff phình cả file (đã xảy ra, +6k dòng). Script sửa file phải giữ nguyên line ending đang có; kiểm `git diff --stat` trước khi commit.
- **Diff nhỏ nhất**, đúng pattern sẵn có: `json()`, `readBody()`, `uid()`, `now()` (giây), `dbBatch()`, `IN_JSON`, `verifyPassword`/`makePasswordRecord`, `ownsProfile`. Không tách file, không thêm abstraction.
- **Comment ngắn, tiếng Việt**, chỉ ghi lý do. Ghi ID task khi sửa theo backlog (`// T-xx: …`).
- **Migration:** số tiếp theo sau số lớn nhất trong `db/migrations/` (hiện tới `0012`). Nhiều nhánh song song → hẹn trước số cho từng nhánh. Chỉ `ALTER TABLE ADD COLUMN` / `CREATE INDEX` kiểu thêm; code cũ phải chạy được với schema mới (deploy migration **trước** Worker).
- **Biến môi trường mới** (`env.X`): thêm vào `wrangler.toml.example`. Công tắc ghi/xoá dữ liệu người dùng mặc định **tắt** (`"0"`), giống `AUTO_CLOSE_ENABLED`, `JOB_CLEANUP_ENABLED`.
- **SPA i18n:** mọi chuỗi tiếng Việt mới cần bản tiếng Anh: `t("câu vi")` + mục trong từ điển `EN`, hoặc thuộc tính `data-en` / `data-en-placeholder|title|aria-label`. Sửa câu tiếng Việt thì sửa luôn khoá EN (không thì EN âm thầm rơi về tiếng Việt). Mã lỗi API hiển thị cho người dùng → thêm vào `AUTH_ERR`.
- **SPA:** mobile 390px không tràn ngang; input có `<label>`; link từ dữ liệu ngoài phải `https:` (dùng `esc()` cho HTML, không chèn chuỗi thô vào `href`).

## Ranh giới bảo mật / riêng tư

- **Dữ liệu người dùng là riêng tư.** Job dán tay (`jobs.submitted_by`) chỉ người nộp thấy/chấm/gắn Kanban; mọi SQL mới đọc `jobs` phải lọc `submitted_by IS NULL OR submitted_by = ?` (hoặc chỉ job chung cho chỗ công khai). Route công khai (`/api/public/*`) chỉ trả trường công khai, validate kiểu allow-list, có cache, không ghi DB.
- **Không tải URL tuỳ ý** từ server: chỉ host trong `SUBMIT_FETCH_HOSTS`, `https`, không port, không theo redirect.
- Dữ liệu mới về người dùng phải nằm trong export (`/api/me/export`) và bị xoá trong `purgeUser` (thứ tự con trước cha vì FK), và được nêu ở trang chính sách dữ liệu trong `index.html`.
- Không thêm tracker, script bên thứ ba, cookie quảng cáo.

## Quy trình task

Backlog, trạng thái task, handoff và quy trình review nằm trong thư mục vận hành của owner (`worklog/`, không public). Nếu owner đưa bạn một task:

1. Làm trên nhánh `task/T-xx` từ `main` mới nhất; một task một nhánh.
2. **Gate 1:** tái hiện lỗi trên code hiện tại trước khi sửa (backlog có thể lệch số dòng: tìm theo tên hàm).
3. Sửa + selfcheck (fail trên base, pass trên bản sửa) + chạy toàn bộ selfcheck.
4. Commit với message kiểu `fix(api): … (T-xx)`; ghi handoff theo mẫu owner đưa (output gốc, không diễn giải).
5. **Không** push lên `main`, **không** deploy, **không** chạy `wrangler … --remote`, `d1 execute --remote`, `secret`, `versions`, `pages deploy`; **không** gọi API production bằng tài khoản thật. Mấy việc đó là của owner (xem `RUNBOOK.md` của owner).
6. Reviewer là một phiên/model khác, chỉ đọc + tự chạy lại kiểm chứng, không sửa code.
