# Signal UI — shipped interface (Oct 2026)

JobPilot Edge's current interface, restyled in steps 1–6 (+ P0 usability,
step 2b review fixes, 6b) and live on production since 29 Oct 2026.
Supersedes `UI-V2-SPEC.md` (Linear × Resend) for the shipped app; that spec
is kept as history. The app is still a single file: `apps/web/public/index.html`
(inline style + script; external links only for fonts and the PDF.js CDN).

## Design tokens

```css
:root{
  --bg:#F4F2FF; --surface:#FFFFFF; --ink:#1B1B2F; --mute:#6B6B85;
  --line:#E4E1F6; --brand:#2D4BFF; --brand-ink:#FFFFFF;
  --pop:#FF5C7A; --pop-ink:#1B1B2F; --mint:#2EC8A6; --mint-ink:#0D2F27;
  --sun:#FFC83D; --sun-ink:#2A2200;
  --strong:var(--mint); --partial:var(--sun); --weak:#C9C7DB;
  --shadow:var(--ink);
  --r-lg:22px; --r-md:14px; --r-sm:10px; --r-pill:999px;
  --bw:2px; --off:6px;
  --f-head:"Unbounded",system-ui,sans-serif;
  --f-body:"Manrope",system-ui,sans-serif;
  --fs-1:13px; --fs-2:16px; --fs-3:20px; --fs-4:26px; --fs-5:44px;
  --tap:44px; --gap:12px; --pad:18px; --focus:0 0 0 3px #FFC83D;
}
html[data-theme="dark"]{
  --bg:#15152A; --surface:#1E1E36; --ink:#F3F2FF; --mute:#A3A2C2;
  --line:#2E2E4D; --brand:#6D84FF; --brand-ink:#15152A;
  --pop:#FF7A92; --pop-ink:#15152A; --weak:#3B3B5C; --shadow:#6D84FF;
}
```

Theme is `html[data-theme]` + `localStorage jp_theme`; first visit follows the
OS preference. Buttons are 44px pills with a 2px ink border and a
`translate(2px,2px)` press; `:focus-visible` uses the sun focus ring.

## Shell

- One column: `.app` (max-width 1120px), a `.topbar` (logo "JobPilot *Edge*",
  profile select, ⌘K button, theme toggle, logout) and a `.tabbar-row` with
  the 3 tabs (Việc làm / Kanban / Hồ sơ). **There is no sidebar.**
- Mobile (≤640px): the tab bar becomes a fixed bottom pill bar (ink
  background, active tab in brand blue, pop badge for the attention count);
  page bottom padding leaves room for it. All taps are 44px except spec-sized
  chips (32px) and Kanban move buttons (32px circles).

## Jobs tab

- Cards (`.card`): 2px ink border, hard shadow `6px 6px 0 var(--shadow)`,
  84×84 score circle (brand = strong, sun = partial, muted = weak/unscored)
  with the tier in a pill below, title, meta line, source + matched/missing
  skill chips + flag chips, stage select, and an expandable `.why` panel
  (rule / location / freshness / level / final, with reason strings
  unchanged from the API).
- P0 usability: a `.jobsum` strip above the list (tier counts, top-3 missing
  skills, newest date), first 20 jobs rendered + "Xem thêm" (+20 per click),
  skill chips beyond 5 collapse behind a "+N" button.
- Filters: source select, "Ẩn tin có cờ" checkbox, search input, a rescoring
  pill, and "Quét job mới". The alert strip (`.alert`, sun background) above
  the list summarises the first 2 attention items + "Mở Kanban".
- Feedback: `.toast` (ink background, 4s auto-hide, close button; bottom-right
  on desktop, above the tab bar on mobile) and a rescoring pill that polls
  `/api/jobs?profile_id=` every 10s (up to 120s) but only when the save
  actually queued a rescore (`rescore_queued`), including the CV-skills path.

## Kanban tab

- Flat columns (`.kanban` / `.kcol`, 230px, horizontal scroll; mobile 85vw +
  scroll-snap) and flat cards (`.kcard`, 2px ink border, no shadow).
- **Cards move with ◀ ▶ buttons, not drag & drop** (drag & drop is not
  implemented; the buttons call the same `moveApplication` PATCH).
- The "Mới" column shows the first 20 cards + a one-way "xem thêm" expand
  when it holds more.
- Attention cards get a sun warning border + a due line ("Quá hạn {date}" /
  "Im lặng {N} ngày"); the same `.alert` strip as the Jobs tab sits above
  the board, with per-application buttons (Đã follow-up / Nhắc sau 3 ngày /
  Lưu trữ).

## Profile tab

- Three flat cards: Thông tin, Kỹ năng, Benchmark.
- Locations: 4 preset chips (Hồ Chí Minh, Hà Nội, Đà Nẵng, Remote) +
  previously stored locations become chips; chips store exact accented
  strings, so "Hồ Chí Minh" scores location 8/8 on matching jobs. A free-text
  input below the chips accepts additional locations (comma-separated);
  entries matching a chip by accent-insensitive comparison reuse that chip's
  exact string instead of duplicating it.
- Skills: 5 tappable weight bars per skill (manual add uses the same bars,
  default 3); changes POST the full list to `/skills/confirm`.
- Benchmark: `.tile` cards with Unbounded 28px brand numbers, Vietnamese
  comma decimals ("37,8tr"), reference tiles labelled "median tham khảo",
  and a dashed source note (ITviec/TopDev 2025–2026 secondary summaries —
  verify against the original PDF before official use).

## Branches & deploys

- `signal` branch = step-by-step history (steps 1–6, P0, 2b, 6b, plus the
  parallel PC line's step 5/6 and the revert that chose them).
- `main` = release. The Signal build reached main as commit `7deb9d96`
  (29 Oct 2026) and production in the same step.
- The Pages project has **no Git connection**: merging to main never
  auto-deploys. Production is deployed with the Cloudflare API (Direct
  Upload); the preview project is `jobpilot-edge-signal`. The Worker is
  never deployed from `signal` — production runs main's Worker.
- Landing + login/register screens are out of the restyle scope except for
  receiving the new tokens. API, scoring logic, and business text
  (stage names, score-reason strings) were not changed by the restyle.
