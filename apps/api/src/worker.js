// JobPilot Edge — API Worker (Phase 2: alerts, explain, flags, benchmark)
// Vanilla Workers runtime. Bindings: DB(D1) KV FILES(R2) Q_INGEST Q_SCORE
// Q_NOTIFY USER_HUB(DO) AI EMB(Vectorize) EVENTS(Analytics Engine).

export class UserHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));
      server.send(JSON.stringify({ type: "hub.ready", ts: Date.now() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (new URL(request.url).pathname.endsWith("/broadcast")) {
      const msg = await request.text();
      for (const ws of this.sockets) {
        try { ws.send(msg); } catch (_) { this.sockets.delete(ws); }
      }
      return Response.json({ delivered: this.sockets.size });
    }
    return Response.json({ hub: "ok", connections: this.sockets.size });
  }
}

// ---------------- utils ----------------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept-language",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
// i18n: tiếng Việt là nguồn; chỉ dịch chuỗi trả về client theo Accept-Language.
// ponytail: chỉ có "en"; thêm ngôn ngữ thì đổi EN thành map theo lang.
const EN = {
  "Tin không ghi địa điểm": "Job has no location",
  "Địa điểm khớp với hồ sơ": "Location matches your profile",
  "Bạn chấp nhận Remote, job này làm onsite": "You accept Remote; this job is onsite",
  "Remote nhưng chỉ nhận ứng viên ở %s": "Remote but only hires in %s",
  "Địa điểm không khớp với hồ sơ": "Location does not match your profile",
  "Cấp bậc phù hợp": "Level fits",
  "Tin này thiên về senior hơn cấp bậc của bạn": "This job leans more senior than your level",
  "Tin này thiên về junior hơn cấp bậc của bạn": "This job leans more junior than your level",
  "JD yêu cầu %s năm kinh nghiệm": "JD requires %s years of experience",
  "Tin cũ %s ngày": "Posted %s days ago",
  "Đăng trùng / đăng lại": "Duplicate / reposted",
  "JD nhồi %s kỹ năng": "JD lists %s skills",
  "Có thể đã gỡ": "May be taken down",
  "Đăng lại %s lần": "Reposted (%s)",
  "Treo %s ngày": "Open for %s days",
  "Không ghi lương": "No salary listed",
  "Tin ghi chung Việt Nam": "Listed as Vietnam (no city)",
  "Hồ sơ chưa ghi cấp bậc": "Your profile has no level set",
  "Backend Java · 3 năm · Hồ Chí Minh / Remote": "Backend Java · 3 yrs · Ho Chi Minh City / Remote",
  "%s strong match mới, %s việc cần follow-up": "%s new strong matches, %s items to follow up",
  "Tính từ lương ghi trong tin tuyển hệ thống đã gom; tin 'Thương lượng' không tính. Lọc theo tiêu đề tin tuyển nên chỉ là ước tính.":
    "Computed from salaries stated in collected job posts; 'Negotiable' posts are excluded. Filtered by job title only, so this is an estimate.",
  "Bỏ qua: %s": "Skip: %s",
  "địa điểm không khớp": "location mismatch",
  "cấp bậc lệch": "level mismatch",
  "tin rủi ro cao": "high-risk post",
  "tin đã cũ": "stale post",
  "Khớp đủ để nộp": "Good enough to apply",
  "Nộp nếu bổ sung %s": "Apply if you add %s",
  "Nộp nếu chấp nhận onsite": "Apply if you accept onsite",
  "Diễn đạt lại theo cách JD dùng": "Rephrased using the JD's wording",
};
function tr(lang, vi, ...args) {
  let s = (lang === "en" && EN[vi]) || vi;
  for (const a of args) s = s.replace("%s", () => a);
  return s;
}
// T-65: nhãn khuyến nghị. ponytail: ngưỡng cứng (level<=2, risk>=3, thiếu nặng >=3: weight thiếu hiện cố định 3); chỉnh khi có dữ liệu nộp thật.
function verdictFor(match, fit, flags, risk, lang) {
  const miss = ((match.rule_detail && match.rule_detail.missing) || []).slice().sort((x, y) => y.weight - x.weight);
  let why = null;
  if (fit && fit.location === 0) why = "địa điểm không khớp";
  else if (fit && fit.level <= 2 && match.tier !== "strong") why = "cấp bậc lệch";
  else if (risk >= 3) why = "tin rủi ro cao";
  else if ((flags || []).some((f) => f.type === "stale")) why = "tin đã cũ";
  if (why) return { verdict: "skip", why: tr(lang, "Bỏ qua: %s", tr(lang, why)) };
  if (match.tier === "strong" || (match.tier !== "weak" && miss.filter((m) => m.weight >= 3).length <= 1)) return { verdict: "apply", why: tr(lang, "Khớp đủ để nộp") };
  if (fit && fit.location === 6) return { verdict: "apply_if", why: tr(lang, "Nộp nếu chấp nhận onsite") };
  return { verdict: "apply_if", why: tr(lang, "Nộp nếu bổ sung %s", miss.slice(0, 2).map((m) => m.skill).join(", ")) };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
const now = () => Math.floor(Date.now() / 1000);
// ponytail: 14 ngày cố định cho mọi người dùng; thành cài đặt theo hồ sơ khi có người xin.
const AUTO_CLOSE_DAYS = 14;
// T-45: một giới hạn dùng chung cho danh sách /api/jobs và lượt chấm lại; dọn tin quét không thấy > 30 ngày, mỗi lượt cron tối đa 200 tin.
const JOB_LIST_LIMIT = 300, JOB_RETENTION_DAYS = 30, JOB_CLEAN_BATCH = 200;
const APP_STAGES = ["new", "saved", "applied", "interview", "offer", "rejected", "archived"]; // khớp STAGES của kanban (index.html)
// T-37: vòng phỏng vấn. scheduled_at = 0 nghĩa là chưa hẹn giờ (cột NOT NULL từ 0001).
const IV_KINDS = {
  screen: ["Sàng lọc", ["Đọc lại JD, ghi 3 điểm khớp với kinh nghiệm của mình", "Chuẩn bị phần giới thiệu bản thân 60 giây", "Chốt mức lương mong muốn và ngày có thể bắt đầu", "Chuẩn bị 2 câu hỏi về team và quy trình làm việc"]],
  test: ["Bài test", ["Hỏi rõ thời lượng, hình thức và công cụ được dùng", "Ôn cấu trúc dữ liệu và thuật toán cơ bản", "Kiểm tra máy, mạng, IDE trước giờ làm bài", "Đọc kỹ đề, thử các trường hợp biên trước khi nộp"]],
  technical: ["Phỏng vấn kỹ thuật", ["Ôn lại các dự án trong CV: kiến trúc, vai trò, số liệu", "Ôn các kỹ năng chính trong JD", "Chuẩn bị 1 sự cố đã xử lý: bối cảnh, hành động, kết quả", "Luyện system design ở mức vừa", "Chuẩn bị câu hỏi về stack và cách team review code"]],
  hr: ["Phỏng vấn HR", ["Tìm hiểu văn hoá, sản phẩm và tin gần đây của công ty", "Chuẩn bị ví dụ STAR về làm việc nhóm và xử lý bất đồng", "Chốt mức lương mong muốn và ngày bắt đầu sớm nhất", "Hỏi về đánh giá, đãi ngộ và các vòng tiếp theo"]],
  offer: ["Offer", ["Kiểm tra lương gross/net, thưởng và phụ cấp", "Xem bảo hiểm, ngày phép và thời gian thử việc", "So sánh với offer khác và mức mong muốn", "Hỏi rõ hạn trả lời và ngày bắt đầu"]],
};
const IV_RESULTS = ["pending", "pass", "fail"];
// Kiểm từng trường có mặt trong body; trả { error } hoặc { f } chỉ gồm trường hợp lệ đã chuẩn hoá.
function ivFields(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "invalid_body" };
  const f = {}, str = (v, max, empty) => typeof v === "string" && v.trim().length <= max && (empty || v.trim().length > 0);
  if ("kind" in b) { if (!Object.hasOwn(IV_KINDS, b.kind)) return { error: "invalid_kind" }; f.kind = b.kind; }
  if ("round_label" in b) { if (!str(b.round_label, 80)) return { error: "invalid_round_label" }; f.round_label = b.round_label.trim(); }
  if ("note" in b) { if (b.note !== null && !str(b.note, 2000, true)) return { error: "invalid_note" }; f.note = b.note === null ? null : b.note.trim(); }
  if ("scheduled_at" in b) { if (!Number.isSafeInteger(b.scheduled_at) || b.scheduled_at < 0) return { error: "invalid_scheduled_at" }; f.scheduled_at = b.scheduled_at; }
  if ("result" in b) { if (!IV_RESULTS.includes(b.result)) return { error: "invalid_result" }; f.result = b.result; }
  if ("checklist" in b) {
    const c = b.checklist;
    if (!Array.isArray(c) || c.length > 30 || !c.every((x) => x && str(x.text, 200) && typeof x.done === "boolean")) return { error: "invalid_checklist" };
    f.checklist = JSON.stringify(c.map((x) => ({ text: x.text.trim(), done: x.done })));
  }
  return { f };
}
const ivRow = (r) => r && { ...r, checklist: JSON.parse(r.checklist || "[]") };
const IV_OWNED = "SELECT a.id FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = ?";
// Owner = env.OWNER_EMAIL (secret); thiếu thì không ai là admin.
const isOwner = (env, u) => !!env.OWNER_EMAIL && u.email === env.OWNER_EMAIL;
// T-88: nguồn đăng ký ?ref — chỉ chữ thường/số/_/-, tối đa 40 ký tự, sai thì null.
const cleanRef = (v) => { const r = String(v ?? "").toLowerCase(); return /^[a-z0-9_-]{1,40}$/.test(r) ? r : null; };
const uid = () => crypto.randomUUID();
// Cột JSON mảng trong DB: hỏng hoặc không phải mảng → null (một dòng sai không được làm chết cả lô/route).
const jsonArr = (v) => { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : null; } catch { return null; } };
async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function readBody(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

// ---------------- skills catalog (đồng bộ với Job Watcher đã kiểm chứng) ----------------
const SKILL_CANON = new Map(Object.entries({
  reactjs: "React", "react.js": "React", nodejs: "Node.js", "node js": "Node.js",
  postgresql: "PostgreSQL", postgres: "PostgreSQL", javascript: "JavaScript",
  typescript: "TypeScript", nextjs: "Next.js", "next js": "Next.js",
  vuejs: "Vue.js", vue: "Vue.js", golang: "Go", k8s: "Kubernetes",
  dotnet: ".NET", "asp.net": ".NET", springboot: "Spring Boot",
  "spring boot": "Spring Boot", nestjs: "NestJS", expressjs: "Express",
  "rest api": "REST APIs", restful: "REST APIs", elasticsearch: "Elasticsearch",
  mongodb: "MongoDB", mysql: "MySQL", redis: "Redis", kafka: "Kafka",
  docker: "Docker", python: "Python", java: "Java", php: "PHP", ruby: "Ruby",
  rails: "Rails", django: "Django", flask: "Flask", laravel: "Laravel",
  graphql: "GraphQL", grpc: "gRPC", terraform: "Terraform", jenkins: "Jenkins",
  firebase: "Firebase", supabase: "Supabase", rabbitmq: "RabbitMQ", nginx: "Nginx",
  html: "HTML", css: "CSS", tailwind: "Tailwind", flutter: "Flutter",
  swift: "Swift", kotlin: "Kotlin", android: "Android", ios: "iOS", sql: "SQL",
  nosql: "NoSQL", jest: "Jest", cypress: "Cypress", selenium: "Selenium",
  figma: "Figma", azure: "Azure", gcp: "GCP", aws: "AWS", prisma: "Prisma",
  typeorm: "TypeORM", bullmq: "BullMQ", svelte: "Svelte", express: "Express",
  fastapi: "FastAPI", git: "Git", linux: "Linux",
}));
const canonSkill = (s) => SKILL_CANON.get(s.trim().toLowerCase()) ?? s.trim();

const SKILL_CATALOG = [
  "Java", "Spring Boot", "TypeScript", "JavaScript", "Node.js", "NestJS",
  "Express", "Next.js", "React", "PostgreSQL", "MySQL", "Redis", "Kafka",
  "BullMQ", "Prisma", "TypeORM", "Docker", "AWS", "Microservices",
  "REST APIs", "Python", "Django", "Flask", "FastAPI", "Go", "PHP",
  "Laravel", "C#", ".NET", "Ruby", "Rails", "Angular", "Vue.js", "Nuxt.js",
  "Svelte", "MongoDB", "SQLite", "GraphQL", "gRPC", "Kubernetes", "CI/CD",
  "Git", "Linux", "Firebase", "Supabase", "Elasticsearch", "RabbitMQ",
  "Nginx", "HTML", "CSS", "Tailwind", "Flutter", "React Native", "Swift",
  "Kotlin", "Android", "iOS", "TensorFlow", "PyTorch", "SQL", "NoSQL",
  "Terraform", "Jenkins", "GitHub Actions", "Jest", "Cypress", "Selenium",
  "Figma", "Azure", "GCP",
];
const SKILL_ALIASES = {
  "Node.js": ["nodejs", "node js"], "REST APIs": ["rest api", "restful", "rest apis"],
  "Spring Boot": ["springboot"], "Next.js": ["nextjs"], "Vue.js": ["vuejs", "vue"],
  "Nuxt.js": ["nuxtjs", "nuxt"], "React Native": ["react-native"],
  "CI/CD": ["cicd", "ci cd"], ".NET": ["dotnet", ".net core", "asp.net"],
  "C#": ["csharp", "c sharp"], "GitHub Actions": ["github action"],
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function skillInText(skill, text) {
  const hay = ` ${text.toLowerCase()} `;
  const cands = [skill.toLowerCase(), ...(SKILL_ALIASES[skill] ?? [])];
  return cands.some((c) => new RegExp(`(^|[^a-z0-9+#.])${escapeRe(c)}([^a-z0-9+#]|$)`, "i").test(hay));
}
const extractSkillsFromText = (text) => SKILL_CATALOG.filter((s) => skillInText(s, text || ""));
const CORE_SKILLS = new Set(["Java", "Spring Boot", "Kafka", "PostgreSQL", "Redis", "NestJS", "Node.js", "TypeScript", "Microservices", "Docker"]);

// llama-3.1-8b-instruct bị Cloudflare khai tử 2026-05-30 (lỗi 5028) nên hàm này từng âm thầm trả [].
const CV_SKILL_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
async function aiExtractSkills(env, cvText) {
  try {
    const res = await env.AI.run(CV_SKILL_MODEL, {
      messages: [
        { role: "system", content: "You extract technical skills from a resume. Reply with ONLY a JSON array of skill name strings, no explanation." },
        { role: "user", content: `Resume:\n${cvText.slice(0, 6000)}\n\nList every technical skill, framework, tool and platform mentioned (e.g. "Java", "Spring Boot", "Kafka", "Transactional Outbox"). JSON array only.` },
      ],
      max_tokens: 512,
    });
    const text = typeof res?.response === "string" ? res.response : "";
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return [...new Set(arr.filter((x) => typeof x === "string" && x.length <= 40).map(canonSkill))].slice(0, 60);
  } catch (e) {
    console.log("aiExtractSkills failed:", e.message);
    return [];
  }
}

// ---------------- auth ----------------
async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const v = await env.KV.get(`session:${token}`);
  if (!v) return null;
  const [userId, iat] = v.split("|"); // T-22: "userId|iat(ms)"; giá trị cũ chỉ có userId
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").bind(userId).first();
  if (u && u.sessions_valid_after && !(Number(iat) >= u.sessions_valid_after)) return null; // session cũ / trước mốc đổi mật khẩu
  return u;
}

// locations/target_roles phải là mảng chuỗi ngắn: một dòng sai từng làm cả lô chấm điểm vào DLQ.
const strArr = (v) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && x.length <= 80);
const badProfileArrays = (b) => [b.locations, b.target_roles].some((v) => v != null && !strArr(v));
async function ownsProfile(env, user, profileId) {
  if (!profileId) return false;
  return !!(await env.DB.prepare("SELECT id FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first());
}

async function enqueueProfileRescore(env, profileId) {
  try {
    // T-50: kèm phiên bản hồ sơ (updated_at); scoreBatch bỏ lượt cũ hơn bản hiện tại.
    const row = await env.DB.prepare("SELECT updated_at FROM profiles WHERE id = ?").bind(profileId).first();
    await env.Q_SCORE.send({ kind: "rescore_profile", profileId, v: row && row.updated_at });
    return true;
  } catch (error) {
    console.error("profile rescore enqueue failed", profileId, error);
    return false;
  }
}

// ---------------- profiles & CV ----------------
async function profileWithSkills(env, profile) {
  const { results } = await env.DB.prepare(
    "SELECT skill, weight, source FROM profile_skills WHERE profile_id = ? ORDER BY weight DESC, skill"
  ).bind(profile.id).all();
  return {
    ...profile,
    target_roles: jsonArr(profile.target_roles) || [],
    locations: jsonArr(profile.locations) || [],
    skills: results,
  };
}

const CV_MAX_BYTES = 5242880, CV_MAX_CHARS = 200000; // T-16a
async function handleCvText(request, env, user, profileId) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?")
    .bind(profileId, user.id).first();
  if (!profile) return json({ error: "profile_not_found" }, 404);
  if (!user.consent_cv_at) return json({ error: "cv_consent_required" }, 403); // T-62: lưu CV chỉ sau khi đồng ý, chặn cả ở server
  const body = await readBody(request);
  const text = (body.text || "").trim();
  if (text.length < 100) return json({ error: "cv_text_too_short" }, 400);
  if (text.length > CV_MAX_CHARS) return json({ error: "text_too_long" }, 413);
  const filename = body.filename || "cv.txt";
  const r2Key = `cv/${user.id}/${profileId}-${Date.now()}.txt`;
  await env.FILES.put(r2Key, text, { httpMetadata: { contentType: "text/plain" } });
  const fileId = uid();
  await env.DB.prepare(
    "INSERT INTO files (id, user_id, r2_key, kind, filename, size_bytes, created_at) VALUES (?, ?, ?, 'cv', ?, ?, ?)"
  ).bind(fileId, user.id, r2Key, filename, text.length, now()).run();
  await env.DB.prepare("UPDATE profiles SET cv_file_id = ?, updated_at = ? WHERE id = ?")
    .bind(fileId, now(), profileId).run();
  const catalog = extractSkillsFromText(text);
  const ai = user.ai_opt_out ? [] : await aiExtractSkills(env, text); // T-62: người dùng tắt AI → không gửi CV cho Workers AI
  const merged = [...new Set([...catalog, ...ai])];
  const suggested = merged.map((skill) => ({
    skill,
    weight: CORE_SKILLS.has(skill) ? 5 : 3,
    from_ai: ai.includes(skill),
    from_catalog: catalog.includes(skill),
  })).sort((a, b) => b.weight - a.weight || a.skill.localeCompare(b.skill));
  await env.KV.put(`cvskills:${profileId}`, JSON.stringify(suggested), { expirationTtl: 86400 });
  return json({ file_id: fileId, text_chars: text.length, suggested_skills: suggested });
}

// ---------------- CV suggest (T-28) ----------------
// Gợi ý sửa CV theo JD, CHỈ dùng sự thật đã có trong CV. Guard chạy phía server, không tin prompt.
const CV_SUGGEST_MAX = 8, CV_SUGGEST_DAILY = 15, CV_SUGGEST_TTL = 7 * 86400;
const normWs = (s) => String(s).replace(/\s+/g, " ").trim();
const numsOf = (s) => String(s).match(/\d+(?:[.,]\d+)*/g) || [];
// Chức danh/cấp bậc: không được xuất hiện trong suggested nếu original không có.
const SENIORITY_RE = /(^|[^\p{L}\p{N}])(senior|sr|junior|jr|lead|leads|leader|tech lead|principal|staff|head|manager|managers|management|architect|director|chief|cto|vp|trưởng nhóm|trưởng phòng|trưởng|quản lý|giám đốc|kiến trúc sư)(?=$|[^\p{L}\p{N}])/giu;
const seniorityOf = (s) => new Set([...String(s).matchAll(SENIORITY_RE)].map((m) => m[2].toLowerCase()));
const wordsOf = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// ponytail: n=4 diệt "ownership of production reliability" mà vẫn cho cụm 2-3 từ của JD ("event-driven", "REST APIs"); hạ xuống 3 nếu còn lọt.
const JD_LIFT_N = 4;
const ngrams = (w, n) => { const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" ")); return out; };
// Trả { kept, dropped }. Bỏ gợi ý khi: original không nằm nguyên văn trong CV; thêm skill mà CHÍNH dòng đó không có;
// nhắc skill missing; thêm số CV không có; thêm chức danh/cấp bậc; chép cụm ≥ JD_LIFT_N từ của JD mà CV không có.
function guardSuggestions(raw, cvText, missing, lang, jdText = "") {
  const cv = normWs(cvText), cvNums = new Set(numsOf(cvText));
  const cvGrams = ngrams(wordsOf(cvText), JD_LIFT_N), jdGrams = ngrams(wordsOf(jdText), JD_LIFT_N);
  const kept = []; let dropped = 0;
  for (const x of (Array.isArray(raw) ? raw : []).slice(0, 20)) {
    const original = normWs(x?.original ?? ""), suggested = normWs(x?.suggested ?? "");
    if (!original || !suggested || original === suggested) continue; // không phải gợi ý, không tính là bịa
    const lineSkills = new Set(extractSkillsFromText(original)), lineRanks = seniorityOf(original);
    const ok = original.length >= 10 && suggested.length <= 800 && cv.includes(original)
      && extractSkillsFromText(suggested).every((k) => lineSkills.has(k))
      && !missing.some((m) => skillInText(m, suggested))
      && numsOf(suggested).every((n) => cvNums.has(n))
      && [...seniorityOf(suggested)].every((w) => lineRanks.has(w))
      && ![...ngrams(wordsOf(suggested), JD_LIFT_N)].some((g) => jdGrams.has(g) && !cvGrams.has(g));
    if (!ok) { dropped++; continue; }
    if (kept.length >= CV_SUGGEST_MAX) continue;
    kept.push({ id: `s${kept.length + 1}`, section: normWs(x.section || "").slice(0, 40) || null, original, suggested,
      reason: normWs(x.reason || "").slice(0, 200) || tr(lang, "Diễn đạt lại theo cách JD dùng") });
  }
  return { kept, dropped };
}
async function aiCvSuggest(env, cvText, jd, matched, missing, lang) {
  const res = await env.AI.run(CV_SKILL_MODEL, {
    messages: [
      { role: "system", content: "You improve a resume for one job description WITHOUT inventing anything. Each suggestion rewords ONE line of the resume: only reword the SAME line, reorder it, or tighten it. Keep every tool/technology exactly as in that line; never bring in a tool from another line. Never add a skill, tool, number, year, percentage, team size, employer, achievement, job title or seniority (senior, lead, manager...) that is not already in that line. Do not copy claims or phrases from the job description. Reply with ONLY strict JSON." },
      { role: "user", content: `Resume:\n${cvText.slice(0, 6000)}\n\nJob description:\n${jd.slice(0, 3000)}\n\nSkills the resume already has that the JD wants: ${matched.join(", ") || "none"}\nSkills the resume does NOT have (NEVER mention these): ${missing.join(", ") || "none"}\n\nReturn {"suggestions":[{"section":"Experience|Summary|Skills|Projects","original":"<one line copied EXACTLY from the resume>","suggested":"<the same line reworded, same tools, no new facts>","reason":"<short reason in ${lang === "en" ? "English" : "Vietnamese"}>"}]} with at most ${CV_SUGGEST_MAX} items. JSON only.` },
    ],
    max_tokens: 1500,
  });
  const text = typeof res?.response === "string" ? res.response : JSON.stringify(res?.response ?? "");
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = m ? JSON.parse(m[0]) : null; // ném khi JSON hỏng → caller coi như AI lỗi
  if (!parsed || !Array.isArray(parsed.suggestions)) throw new Error("bad_ai_json");
  return parsed.suggestions;
}
async function handleCvSuggest(request, env, user, profileId, lang) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first();
  if (!profile) return json({ error: "profile_not_found" }, 404);
  const b = await readBody(request);
  if (b.lang === "en" || b.lang === "vi") lang = b.lang;
  const job = typeof b.job_id === "string" && await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND (submitted_by IS NULL OR submitted_by = ?)").bind(b.job_id, user.id).first();
  if (!job) return json({ error: "job_not_found" }, 404);
  const file = profile.cv_file_id && await env.DB.prepare("SELECT r2_key FROM files WHERE id = ? AND user_id = ?").bind(profile.cv_file_id, user.id).first();
  const obj = file && await env.FILES.get(file.r2_key);
  const cvText = obj ? await obj.text() : "";
  if (!cvText.trim()) return json({ error: "no_cv" }, 409);

  const { results: ps } = await env.DB.prepare("SELECT skill, weight FROM profile_skills WHERE profile_id = ? ORDER BY weight DESC, skill").bind(profile.id).all();
  const jdSkills = [...new Set([...JSON.parse(job.skills || "[]").map(canonSkill), ...extractSkillsFromText(jdOf(job))])];
  const have = [...new Set([...ps.map((p) => p.skill), ...extractSkillsFromText(cvText)])];
  const haveLow = new Set(have.map((s) => s.toLowerCase()));
  const matched = jdSkills.filter((s) => haveLow.has(s.toLowerCase()));
  const missing = jdSkills.filter((s) => !haveLow.has(s.toLowerCase()));
  const jdLow = jdSkills.map((s) => s.toLowerCase());
  const rank = (s) => { const i = jdLow.indexOf(s.toLowerCase()); return i < 0 ? 1e6 : i; };
  const skills_text = have.map((s, i) => [s, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]).join(", ");
  const base = { matched, missing, skills_text };
  // T-62: tắt AI → không gửi CV đi. ponytail: không có gợi ý rule-based; thêm khi có mẫu sửa đơn giản đáng tin.
  if (user.ai_opt_out || !env.AI) return json({ ...base, suggestions: [], dropped: 0, ai_used: false });

  const cacheKey = `cvsug:${profile.id}:${job.id}:${profile.cv_file_id}:${lang}`;
  const hit = await env.KV.get(cacheKey);
  if (hit) {
    // Lọc lại theo missing hiện tại: kỹ năng hồ sơ có thể đã đổi sau khi cache.
    const c = JSON.parse(hit), g = guardSuggestions(c.suggestions, cvText, missing, lang, jdOf(job));
    return json({ ...base, suggestions: g.kept, dropped: c.dropped + g.dropped, ai_used: true, cached: true });
  }
  // ponytail: đếm KV không nguyên tử (giống ownBotAttempt), bấm dồn dập có thể lố 1-2 lượt.
  const day = Math.floor(now() / 86400), rlKey = `cvsugrl:${user.id}:${day}`;
  const n = Number((await env.KV.get(rlKey)) || 0);
  if (n >= CV_SUGGEST_DAILY) return json({ error: "rate_limited", retry_after: (day + 1) * 86400 - now() }, 429);
  await env.KV.put(rlKey, String(n + 1), { expirationTtl: 86400 });
  let raw;
  try { raw = await aiCvSuggest(env, cvText, jdOf(job) || job.title || "", matched, missing, lang); }
  catch (e) { console.log("cv-suggest AI failed:", String(e && e.message).slice(0, 80)); return json({ ...base, suggestions: [], dropped: 0, ai_used: false }); }
  const g = guardSuggestions(raw, cvText, missing, lang, jdOf(job));
  await env.KV.put(cacheKey, JSON.stringify({ suggestions: g.kept, dropped: g.dropped }), { expirationTtl: CV_SUGGEST_TTL });
  return json({ ...base, suggestions: g.kept, dropped: g.dropped, ai_used: true });
}

// ---------------- privacy (T-62 + T-24) ----------------
const DELETE_GRACE = 7 * 86400;
// Xoá mọi file CV của hồ sơ (text đã trích + PDF gốc đều có key cv/<user>/<profile>-...), gợi ý KV và cv_file_id.
async function deleteProfileCv(env, profile) {
  // instr thay LIKE: mẫu dài hơn 50 ký tự vượt SQLITE_MAX_LIKE_PATTERN_LENGTH của D1
  const prefix = `cv/${profile.user_id}/${profile.id}-`;
  const { results: files } = await env.DB.prepare("SELECT id, r2_key FROM files WHERE user_id = ? AND instr(r2_key, ?) = 1")
    .bind(profile.user_id, prefix).all();
  for (const f of files) await env.FILES.delete(f.r2_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM files WHERE user_id = ? AND instr(r2_key, ?) = 1").bind(profile.user_id, prefix),
    env.DB.prepare("UPDATE profiles SET cv_file_id = NULL, updated_at = ? WHERE id = ?").bind(now(), profile.id),
  ]);
  await env.KV.delete(`cvskills:${profile.id}`);
  return files.length;
}
// Xoá hẳn tài khoản sau thời gian ân hạn: R2 + KV trước, rồi D1 theo thứ tự FK (con trước cha).
async function purgeUser(env, userId) {
  const { results: files } = await env.DB.prepare("SELECT r2_key FROM files WHERE user_id = ?").bind(userId).all();
  for (const f of files) await env.FILES.delete(f.r2_key);
  const { results: profiles } = await env.DB.prepare("SELECT id FROM profiles WHERE user_id = ?").bind(userId).all();
  for (const p of profiles) await env.KV.delete(`cvskills:${p.id}`);
  // Bot riêng: gỡ webhook trước khi xoá dòng (best-effort), để Telegram thôi đẩy tin về.
  const bot = await env.DB.prepare("SELECT token_enc FROM user_bots WHERE user_id = ?").bind(userId).first();
  if (bot && ownBotEnabled(env)) {
    try { await tgApi(env, await tgDecrypt(env, bot.token_enc, userId), "deleteWebhook", {}); } catch (_) { /* best-effort */ }
  }
  const P = "SELECT id FROM profiles WHERE user_id = ?1", A = `SELECT id FROM applications WHERE profile_id IN (${P})`;
  await env.DB.batch([
    `DELETE FROM application_events WHERE application_id IN (${A})`,
    `DELETE FROM interviews WHERE application_id IN (${A})`,
    `DELETE FROM applications WHERE profile_id IN (${P})`,
    `DELETE FROM job_matches WHERE profile_id IN (${P})`,
    `DELETE FROM profile_skills WHERE profile_id IN (${P})`,
    `DELETE FROM prep_items WHERE session_id IN (SELECT id FROM prep_sessions WHERE profile_id IN (${P}))`,
    `DELETE FROM prep_sessions WHERE profile_id IN (${P})`,
    "DELETE FROM profiles WHERE user_id = ?1",
    "DELETE FROM files WHERE user_id = ?1",
    "DELETE FROM digests WHERE user_id = ?1",
    "DELETE FROM notifications WHERE user_id = ?1",
    "DELETE FROM login_failures WHERE user_id = ?1",
    "DELETE FROM user_bots WHERE user_id = ?1",
    // T-05: job dán tay thuộc riêng user; chỉ hồ sơ của chính user (đã xoá ở trên) chấm/gắn được nó.
    "DELETE FROM job_matches WHERE job_id IN (SELECT id FROM jobs WHERE submitted_by = ?1)",
    "DELETE FROM jobs WHERE submitted_by = ?1",
    "DELETE FROM users WHERE id = ?1",
  ].map((sql) => env.DB.prepare(sql).bind(userId)));
}

// ---------------- fetchers (port từ Job Watcher đã kiểm chứng) ----------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function fetchText(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}
// T-05: job dán tay chỉ tải trang từ site tuyển dụng đã biết, qua https, không theo redirect sang host khác,
// đọc tối đa 1 MB. Host khác vẫn lưu link nhưng không tải (Worker không thành proxy đọc URL tuỳ ý).
const SUBMIT_FETCH_HOSTS = new Set(["itviec.com", "topdev.vn", "www.topdev.vn"]);
function submitFetchAllowed(raw) {
  try { const u = new URL(raw); return u.protocol === "https:" && u.port === "" && SUBMIT_FETCH_HOSTS.has(u.hostname); } catch (_) { return false; }
}
async function fetchSubmittedPage(raw) {
  if (!submitFetchAllowed(raw)) return null;
  const res = await fetch(raw, {
    headers: { "User-Agent": UA, "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader(), dec = new TextDecoder();
  let html = "", bytes = 0;
  while (bytes < 1_000_000) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength; html += dec.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch (_) { /* đã đọc đủ */ }
  return html;
}
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) // &#x2F; (HN)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
}
const decodeUnicodeEscapes = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
// ---- Xem nhanh thẻ job (SPEC 12/11 §3A): logo, địa chỉ, phúc lợi, chế độ làm việc do nguồn ghi ----
// Logo chỉ hot-link CDN của nguồn đã biết (không tải về R2). Thêm host ở đây thì thêm cả vào img-src của apps/web/public/_headers.
const LOGO_HOSTS = new Set(["itviec.com", "assets.saramin.vn"]);
function safeLogo(u) {
  if (typeof u !== "string" || u.length > 500) return null;
  try { const x = new URL(u); return x.protocol === "https:" && LOGO_HOSTS.has(x.hostname) && !x.username && !x.password ? x.href : null; } catch (_) { return null; }
}
// &agrave; &ecirc; … (TopDev mã hoá chữ Việt bằng entity có tên) → dấu tổ hợp rồi NFC; stripTags lo phần còn lại.
const VI_ENT = { grave: "\u0300", acute: "\u0301", circ: "\u0302", tilde: "\u0303" };
const decodeViEntities = (s) => s.replace(/&([aeiouyAEIOUY])(grave|acute|circ|tilde);/g, (_, c, k) => c + VI_ENT[k]).normalize("NFC");
const parseBenefits = (v) => { try { const b = JSON.parse(v || "[]"); return Array.isArray(b) ? b.filter((x) => typeof x === "string") : []; } catch (_) { return []; } };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const BENEFITS_MAX = 5, BENEFIT_LEN = 60;
function benefitList(html) {
  const out = [...String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(decodeViEntities(m[1]))).filter(Boolean).slice(0, BENEFITS_MAX).map((t) => clip(t, BENEFIT_LEN));
  return out.length ? JSON.stringify(out) : null;
}
// ponytail: chỉ gặp "Trực tiếp" trên TopDev (khảo sát 12/11); các nhãn khác đoán theo từ khoá, lạ thì null (rơi về heuristic workMode).
function topdevMode(s) {
  if (!s) return null;
  if (/hybrid|linh hoạt|kết hợp/i.test(s)) return "hybrid";
  if (/remote|từ xa/i.test(s)) return "remote";
  return /trực tiếp|tại văn phòng|onsite|at office/i.test(s) ? "onsite" : null;
}
// TopDev (Next RSC): benefits_original[0].value là "$3e" trỏ tới đoạn "3e:T<len>," mà nội dung HTML nằm ở push([1,"…"]) kế tiếp.
// ponytail: đoán theo cách Next.js tách chunk hiện tại; lệch thì null.
function topdevBenefits(seg, flat) {
  const m = seg.match(/"benefits_original":\[\{[^}]*?"value":"(\$?)([^"]*)"/);
  if (!m) return null;
  if (!m[1]) return benefitList(decodeUnicodeEscapes(m[2]));
  const at = flat.indexOf(`${m[2]}:T`);
  const st = at < 0 ? -1 : flat.indexOf('push([1,"', at);
  if (st < 0 || st - at > 300) return null;
  const end = flat.indexOf('"])', st + 9);
  return benefitList(decodeUnicodeEscapes(flat.slice(st + 9, end < 0 ? st + 6000 : Math.min(end, st + 6000))));
}
// ITviec trang chi tiết (enrichJd đã tải sẵn, 0 request thêm): JSON-LD JobPosting → logo + địa chỉ; nhãn đầu trang → chế độ; "Top 3 reasons" → phúc lợi.
// ponytail: regex theo markup 12/11; nhãn chế độ chỉ tìm trước <section job-content> để không dính thẻ "việc làm liên quan" cuối trang.
function extractPreview(html, sourceId) {
  const out = { logo: null, address: null, benefits: null, mode: null };
  if (sourceId !== "src-itviec" || !html) return out;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!/JobPosting/.test(m[1])) continue;
    let j; try { j = JSON.parse(m[1]); } catch (_) { continue; }
    if (!j || j["@type"] !== "JobPosting") continue;
    const org = j.hiringOrganization || {};
    out.logo = safeLogo(typeof org.logo === "string" ? org.logo : org.logo && org.logo.url);
    const loc = [].concat(j.jobLocation || [])[0];
    const a = loc && loc.address;
    if (a && typeof a === "object") out.address = clip([a.streetAddress, a.addressLocality, a.addressRegion].filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).join(", "), 300) || null;
    break;
  }
  if (!out.logo) { const m = html.match(/<img[^>]*class=['"][^'"]*employer-logo[^'"]*['"][^>]*data-src=['"]([^'"]+)['"]/i); if (m) out.logo = safeLogo(m[1]); }
  const cut = html.search(/<section[^>]*job-content/i);
  const head = cut > 0 ? html.slice(0, cut) : html;
  const mm = head.match(/>\s*(At office|Hybrid|Remote)\s*</);
  if (mm) out.mode = { "At office": "onsite", Hybrid: "hybrid", Remote: "remote" }[mm[1]];
  const r = html.match(/<h2[^>]*>\s*Top 3 reasons to join us\s*<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (r) out.benefits = benefitList(r[1]);
  return out;
}
const TECH_EXTRA = new Set(["c++", "c", "c/c++", "oop", "algorithms", "embedded", "agile", "scrum", "jira", "spring", "hibernate", "maven", "gradle", "oracle", "sql server", "mariadb", "cassandra", "hadoop", "spark", "airflow", "testing", "automation test", "manual test"]);
const CATALOG_BY_LOWER = new Map(SKILL_CATALOG.map((s) => [s.toLowerCase(), s])); // "react" → "React" (tag chữ thường của RemoteOK/Remotive)
function filterTechTags(tags) {
  const out = [];
  for (const raw of tags) {
    const tag = canonSkill(decodeUnicodeEscapes(raw));
    const key = tag.toLowerCase();
    if (CATALOG_BY_LOWER.has(key)) out.push(CATALOG_BY_LOWER.get(key));
    else if (TECH_EXTRA.has(key)) out.push(tag);
  }
  return [...new Set(out)];
}

function slugifyKeyword(kw) {
  return kw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d")
    .replace(/\./g, "") // T-49: "Node.js" → nodejs (ITviec: node-js = 404)
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function relativePostedToISO(text) {
  const m = (text || "").match(/(\d+)\s*(minute|hour|day|week|month)s?\s*ago/i);
  if (!m) return null;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()];
  return new Date(Date.now() - parseInt(m[1], 10) * unit).toISOString().slice(0, 10);
}
const NON_TECH_TAG = /^(?:english|japanese|korean|chinese|german|french|vietnamese|teamwork|communication|team ?work|problem[- ]solving|leadership|time management|creativity|critical thinking|presentation|negotiation|self[- ]motivated|english speaking)$/i;
async function fetchITviec(keyword, location = "Ho Chi Minh") {
  const locSlug = /hà nội|ha noi/i.test(location) ? "ha-noi" : /đà nẵng|da nang/i.test(location) ? "da-nang" : "ho-chi-minh-hcm";
  const url = `https://itviec.com/it-jobs/${slugifyKeyword(keyword)}/${locSlug}`;
  const html = await fetchText(url);
  const parts = html.split("data-search--job-selection-job-slug-value='").slice(1);
  const jobs = [];
  for (const part of parts) {
    const slug = part.slice(0, part.indexOf("'"));
    if (!slug) continue;
    const card = part.slice(0, 9000);
    const titleM = card.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    let company = "";
    for (const am of card.matchAll(/<a[^>]*href="\/companies\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
      const t = stripTags(am[1]);
      if (t) { company = t; break; }
    }
    const postedM = card.match(/Posted\s*([^<]+)/i);
    // T-08: blocklist (không whitelist: whitelist làm job <3 skill, bị chặn trần 69).
    const skills = [...card.matchAll(/class="[^"]*itag[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((mm) => canonSkill(stripTags(mm[1]))).filter((s) => !NON_TECH_TAG.test(s));
    const cityM = card.match(/(Ho Chi Minh|Ha Noi|Da Nang|Can Tho|Binh Duong|Dong Nai|Hai Phong|Remote)/i);
    const salM = card.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*triệu/i);
    jobs.push({
      title: stripTags(titleM[1]), company,
      location: cityM ? cityM[1] : location,
      url: `https://itviec.com/it-jobs/${slug}`,
      postedAt: postedM ? relativePostedToISO(postedM[1]) : null,
      salaryText: salM ? `${salM[1]} - ${salM[2]} triệu` : null,
      skills: [...new Set(skills)],
    });
  }
  return jobs;
}

function parseDMY(s) {
  const m = (s || "").match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
async function fetchTopDev(keyword) {
  const html = await fetchText(`https://topdev.vn/jobs/search?keyword=${encodeURIComponent(keyword)}`);
  const flat = html.split('\\"').join('"');
  const jobs = [];
  const re = /\{"id":(\d{5,}),"title":"([^"]+)"/g;
  let m;
  while ((m = re.exec(flat)) !== null) {
    const id = m[1];
    const rest = flat.slice(m.index + 10);
    const nextJob = rest.search(/\{"id":\d{5,},"title":"/);
    const segEnd = nextJob >= 0 ? m.index + 10 + nextJob : m.index + 12000;
    const seg = flat.slice(m.index, Math.min(segEnd, m.index + 12000));
    const companyM = seg.match(/"company":\{"id":\d+,"display_name":"([^"]+)"/);
    const slugM = seg.match(/"job_url":"[^"]*","slug":"([^"]+)"/);
    const publishedM = seg.match(/"published":\{"date":"([0-9-]+)"/);
    const skills = new Set();
    for (const sm of seg.matchAll(/"skills_arr":\[([^\]]*)\]/g)) {
      for (const q of sm[1].matchAll(/"([^"]+)"/g)) skills.add(q[1]);
    }
    const locM = seg.match(/"address_short_region_list":"([^"]+)"/);
    const tdMin = seg.match(/"salary_min"\s*:\s*(\d{3,})/);
    const tdMax = seg.match(/"salary_max"\s*:\s*(\d{3,})/);
    const tdTxt = seg.match(/"salary"\s*:\s*"([^"]+)"/);
    let tdSalary = null;
    if (tdMin && tdMax && Number(tdMin[1]) >= 1e6 && Number(tdMax[1]) <= 5e8) {
      tdSalary = `${Math.round(Number(tdMin[1]) / 1e6)} - ${Math.round(Number(tdMax[1]) / 1e6)} triệu`;
    } else if (tdTxt && !/thương lượng|negotiable/i.test(tdTxt[1])) {
      tdSalary = decodeUnicodeEscapes(tdTxt[1]);
    }
    // ponytail: tin mà "company" là tham chiếu RSC ("$33:0:props…") không có image_logo trong seg → logo null (cùng chỗ company đang rỗng từ trước).
    const logoM = seg.match(/"image_logo":"([^"]+)"/);
    const addrM = seg.match(/"full_addresses":\["((?:[^"\\]|\\.)*)"/);
    const typeM = seg.match(/"job_types_str":"([^"]*)"/);
    jobs.push({
      logo: logoM ? safeLogo(decodeUnicodeEscapes(logoM[1]).replace(/\\\//g, "/")) : null,
      address: addrM ? clip(decodeUnicodeEscapes(addrM[1]).trim(), 300) || null : null,
      workModeSrc: topdevMode(typeM ? decodeUnicodeEscapes(typeM[1]) : ""),
      benefits: topdevBenefits(seg, flat),
      title: decodeUnicodeEscapes(m[2]),
      company: companyM ? decodeUnicodeEscapes(companyM[1]) : "",
      location: locM ? decodeUnicodeEscapes(locM[1]) : "Vietnam",
      url: `https://topdev.vn/detail-jobs/${slugM ? slugM[1] : ""}-${id}`,
      postedAt: publishedM ? parseDMY(publishedM[1]) : null,
      salaryText: tdSalary,
      skills: filterTechTags([...skills]),
    });
    re.lastIndex = m.index + 100;
  }
  return jobs;
}

// ---------------- Tầng 1: nguồn remote công khai, không key, không scrape ----------------
// WWR RSS (5 feed programming/devops, 1 tin có thể nằm nhiều feed → dedupe theo link),
// Remotive API (keyless), RemoteOK API (cần User-Agent; phần tử đầu là thông báo pháp lý,
// ToS yêu cầu link ngược về remoteok.com — thẻ job đã link thẳng source_url).
// Skill lấy bằng catalog từ mô tả (WWR/Remotive) hoặc tags (RemoteOK), nên nhiều tin < 3 skill → trần 69.
const REMOTE_UA = "JobPilotEdge/1.0 (+https://jobpilot-edge.pages.dev)";
const WWR_FEEDS = ["remote-programming-jobs", "remote-full-stack-programming-jobs", "remote-back-end-programming-jobs", "remote-front-end-programming-jobs", "remote-devops-sysadmin-jobs"];
async function fetchJSON(url, timeoutMs = 20000) {
  const res = await fetch(url, { headers: { "User-Agent": REMOTE_UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
const JD_MAX = 8000;
const jdOf = (row) => (row && row.jd_text && row.jd_text !== "-" ? row.jd_text : ""); // '-' = đã thử fetch, không có JD
const xmlTag = (s, tag) => { const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ""; };
const toISODate = (s) => { const t = Date.parse(s || ""); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };
async function fetchWWR() {
  const seen = new Set(), jobs = [];
  for (const feed of WWR_FEEDS) {
    const res = await fetch(`https://weworkremotely.com/categories/${feed}.rss`, { headers: { "User-Agent": REMOTE_UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${feed}`);
    const xml = await res.text();
    for (const item of xml.split("<item>").slice(1)) {
      const link = xmlTag(item, "link");
      if (!link || seen.has(link)) continue;
      seen.add(link);
      const rawTitle = stripTags(xmlTag(item, "title"));          // "Company: Title"
      const i = rawTitle.indexOf(": ");
      const desc = stripTags(stripTags(xmlTag(item, "description"))); // entity-escaped HTML → 2 lượt
      jobs.push({
        title: i > 0 ? rawTitle.slice(i + 2) : rawTitle, company: i > 0 ? rawTitle.slice(0, i) : "",
        location: `Remote (${xmlTag(item, "region") || "Anywhere"})`, url: link,
        postedAt: toISODate(xmlTag(item, "pubDate")), salaryText: null,
        skills: extractSkillsFromText(desc), jdText: desc.slice(0, JD_MAX),
      });
    }
  }
  return jobs;
}
async function fetchRemotive() {
  const d = await fetchJSON("https://remotive.com/api/remote-jobs?category=software-dev&limit=200");
  return (d.jobs || []).map((j) => ({
    title: j.title, company: j.company_name, location: `Remote (${j.candidate_required_location || "Worldwide"})`,
    url: j.url, postedAt: toISODate(j.publication_date), salaryText: j.salary || null,
    skills: [...new Set([...filterTechTags(j.tags || []), ...extractSkillsFromText(stripTags(j.description || ""))])],
    jdText: stripTags(j.description || "").slice(0, JD_MAX),
  }));
}
// A8: RemoteOK trả UTF-8 bị giải mã latin1 ("â\u0080\u0094" thay "—"): ghép lại byte rồi giải UTF-8; chuỗi đã có ký tự >0xFF thì giữ nguyên.
function fixMojibake(s) {
  if (typeof s !== "string" || !/[ÃÂâ][\x80-\xBF]/.test(s) || /[^\x00-\xFF]/.test(s)) return s;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0))); } catch { return s; }
}
async function fetchRemoteOK() {
  const d = await fetchJSON("https://remoteok.com/api");
  return (Array.isArray(d) ? d : []).filter((j) => j && j.position && j.url).map((j) => ({
    title: fixMojibake(j.position), company: fixMojibake(j.company || ""), location: `Remote (${j.location || "Worldwide"})`,
    url: j.url, postedAt: toISODate(j.date),
    salaryText: j.salary_min && j.salary_max ? `$${Math.round(j.salary_min / 1e3)}k - $${Math.round(j.salary_max / 1e3)}k/năm` : null,
    skills: filterTechTags(j.tags || []),
    jdText: stripTags(fixMojibake(j.description || "")).slice(0, JD_MAX),
  }));
}
// HN "Ask HN: Who is hiring?" (thread tháng) qua Algolia API keyless. Mỗi comment gốc là 1 tin,
// dòng đầu theo quy ước "Công ty | Vai trò | Nơi | ...". Chỉ lấy tin có vai trò dev và ghi REMOTE
// (tin onsite ở Mỹ/EU vô nghĩa với dev Việt). Không có URL riêng → link tới comment.
const HN_DEV = /(engineer|developer|backend|back-end|full.?stack|software|devops|\bsre\b|frontend|front-end|programmer|\bswe\b)/i;
async function fetchHN() {
  const s = await fetchJSON("https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN%3A%20Who%20is%20hiring%3F%22&tags=story,author_whoishiring&hitsPerPage=1");
  const story = (s.hits || [])[0];
  if (!story) throw new Error("no whoishiring thread");
  const it = await fetchJSON(`https://hn.algolia.com/api/v1/items/${story.objectID}`, 30000);
  const jobs = [];
  for (const c of it.children || []) {
    if (!c.text) continue;
    const text = stripTags(String(c.text).replace(/<p>/g, "\n"));
    const first = text.split("\n")[0];
    const parts = first.split(/\s*\|\s*/).map((p) => p.replace(/https?:\/\/\S+/g, "").trim()).filter(Boolean);
    if (parts.length < 2 || !/\bremote\b/i.test(first)) continue;
    // vai trò: phần ngắn có từ khoá dev (phần dài là mô tả công ty lẫn vào dòng đầu)
    const role = parts.slice(1).find((p) => p.length <= 90 && HN_DEV.test(p));
    if (!role) continue;
    const loc = parts.slice(1).find((p) => /\bremote\b/i.test(p)) || "Remote";
    const skills = extractSkillsFromText(text);
    if (!skills.length) continue; // không có tech nào trong catalog → không chấm được, bỏ
    jobs.push({
      title: role, company: parts[0].replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 80),
      location: /^remote/i.test(loc) ? loc.slice(0, 60) : `Remote (${loc.slice(0, 50)})`,
      url: `https://news.ycombinator.com/item?id=${c.id}`, postedAt: toISODate(c.created_at), salaryText: null,
      skills, jdText: text.slice(0, JD_MAX),
    });
  }
  return jobs;
}
const REMOTE_FETCHERS = { wwr: fetchWWR, remotive: fetchRemotive, remoteok: fetchRemoteOK, hn: fetchHN };
const REMOTE_NAMES = { wwr: "We Work Remotely", remotive: "Remotive", remoteok: "Remote OK", hn: "HN Who's Hiring" };

// ---------------- jobs: insert + score ----------------
// D1 Free: 50 truy vấn/lần chạy Worker; 1 env.DB.batch() = 1 truy vấn (developers.cloudflare.com/d1/platform/limits).
// Danh sách vào IN qua json_each(?) = 1 tham số bind, không chạm trần 100 tham số/câu.
const IN_JSON = "(SELECT value FROM json_each(?))";
// ponytail: 1000 câu/batch là trần tự đặt (docs có ví dụ 2000 câu); vượt thì thêm 1 truy vấn mỗi 1000 câu.
const BATCH_MAX = 1000;
async function dbBatch(env, stmts) {
  for (let i = 0; i < stmts.length; i += BATCH_MAX) await env.DB.batch(stmts.slice(i, i + BATCH_MAX));
}
async function sendScores(env, jobIds) {
  const msgs = [...jobIds].map((jobId) => ({ body: { kind: "score", jobId } }));
  for (let i = 0; i < msgs.length; i += 100) await env.Q_SCORE.sendBatch(msgs.slice(i, i + 100)); // trần 100 tin/sendBatch
}
// Upsert nhiều tin: 1 truy vấn đọc (batch 2 SELECT), trả câu ghi để người gọi gom vào 1 batch.
// Tin trùng trong cùng lô xử lý tuần tự như vòng lặp cũ: lần sau thành UPDATE, không tính created.
// ponytail: id INSERT sinh trước; nếu luồng khác chèn cùng content_hash giữa đọc và ghi, id trả về không tồn tại (consumer score bỏ qua).
async function planUpsertJobs(env, items) {
  if (!items.length) return { stmts: [], out: [], toScore: new Set() };
  for (const it of items) it.hash = await sha256hex(`${it.job.title}|${it.job.company}|${it.job.url}`.toLowerCase() + (it.submittedBy ? `|user:${it.submittedBy}` : ""));
  const [{ results: known }, { results: urls }] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM jobs WHERE content_hash IN ${IN_JSON}`).bind(JSON.stringify(items.map((i) => i.hash))),
    env.DB.prepare(`SELECT DISTINCT source_url FROM jobs WHERE submitted_by IS NULL AND source_url IN ${IN_JSON}`).bind(JSON.stringify(items.map((i) => i.job.url))),
  ]);
  const rows = new Map(known.map((r) => [r.content_hash, { ...r }])), seenUrl = new Set(urls.map((r) => r.source_url));
  const t = now(), stmts = [], out = [], toScore = new Set();
  for (const { sourceId, job, hash, submittedBy = null } of items) {
    const posted = job.postedAt ? Math.floor(new Date(job.postedAt).getTime() / 1000) : null;
    const created = !seenUrl.has(job.url);
    seenUrl.add(job.url);
    let row = rows.get(hash);
    if (row) {
      // board "làm mới" ngày đăng = đăng lại. ITviec chỉ có nhãn tương đối ("1 month ago") trôi theo ngày quét → không tin posted_at mới của nó.
      // ponytail: ngưỡng 2 ngày lọc trôi 1 ngày/lần quét của nhãn tương đối; nguồn có ngày tuyệt đối mà "làm mới" trong 1 ngày sẽ bị bỏ qua.
      const trust = sourceId === "src-itviec" ? 0 : posted || 0;
      stmts.push(env.DB.prepare(
        `UPDATE jobs SET last_seen_at = ?, seen_count = seen_count + 1,
           repost_count = repost_count + (CASE WHEN ? >= COALESCE(posted_at,0) + 172800 THEN 1 ELSE 0 END),
           posted_at = MAX(COALESCE(posted_at,0), ?),
           company_logo_url = COALESCE(?, company_logo_url), address = COALESCE(?, address), benefits = COALESCE(?, benefits), work_mode_src = COALESCE(?, work_mode_src)
         WHERE content_hash = ?`
      ).bind(t, trust, trust, job.logo ?? null, job.address ?? null, job.benefits ?? null, job.workModeSrc ?? null, hash));
    } else {
      row = { id: uid(), source_id: sourceId, source_url: job.url, title: job.title, company: job.company || "", location: job.location || "",
        salary_text: job.salaryText || null, jd_text: job.jdText || "", skills: JSON.stringify(job.skills || []), content_hash: hash, posted_at: posted, first_seen_at: t, submitted_by: submittedBy };
      rows.set(hash, row);
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO jobs (id, source_id, source_url, title, company, location, salary_text, jd_text, skills, content_hash, posted_at, first_seen_at, last_seen_at, created_at, submitted_by,
           company_logo_url, address, benefits, work_mode_src)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(row.id, sourceId, job.url, job.title, row.company, row.location, row.salary_text, row.jd_text, row.skills, hash, posted, t, t, t, submittedBy,
        job.logo ?? null, job.address ?? null, job.benefits ?? null, job.workModeSrc ?? null));
    }
    // Tin cũ chưa có JD mà feed giờ có → bù JD + skills rồi chấm lại.
    if (!jdOf(row) && row.jd_text !== "-" && job.jdText) {
      row.skills = JSON.stringify([...new Set([...JSON.parse(row.skills || "[]"), ...(job.skills || [])])]);
      row.jd_text = job.jdText;
      stmts.push(env.DB.prepare("UPDATE jobs SET jd_text = ?, skills = ? WHERE id = ?").bind(row.jd_text, row.skills, row.id));
      toScore.add(row.id);
    }
    if (created) toScore.add(row.id);
    out.push({ ...row, created });
  }
  return { stmts, out, toScore };
}
// Một tin (route submit): 2 truy vấn. Người gọi tự gửi score như trước.
async function upsertJob(env, sourceId, job, submittedBy = null) {
  const plan = await planUpsertJobs(env, [{ sourceId, job, submittedBy }]);
  await dbBatch(env, plan.stmts);
  return plan.out[0];
}

// Bóc JD từ trang chi tiết ITviec/TopDev. Fallback: toàn trang. ponytail: selector đoán theo markup hiện tại; lệch thì rơi về fallback.
function extractJd(html, sourceId) {
  let t = "";
  if (sourceId === "src-topdev") {
    const m = html.match(/\\?"description\\?":\\?"((?:[^"\\]|\\.)*?)\\?"[,}]/);
    if (m) t = stripTags(stripTags(decodeUnicodeEscapes(m[1]).replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\//g, "/")));
  }
  // A1: ITviec bọc JD trong <section class='job-content'>: cắt tới </section>, không thì "việc làm liên quan" cuối trang lọt vào skill.
  if (t.length < 200) {
    const m = html.match(/<section[^>]*(?:job-content|job-description|jd-content)[^>]*>/i);
    if (m) { // đếm <section> lồng bên trong để dừng đúng </section> của chính khối JD
      const re = /<(\/?)section\b[^>]*>/gi; re.lastIndex = m.index + m[0].length;
      for (let depth = 1, x; (x = re.exec(html)); ) if ((depth += x[1] ? -1 : 1) === 0) { t = stripTags(html.slice(m.index + m[0].length, x.index)); break; }
    }
  }
  if (t.length < 200) {
    const m = html.match(/<(div|section)[^>]*(?:job-content|job-description|jd-content)[^>]*>([\s\S]*)/i);
    if (m) t = stripTags(m[2]);
  }
  if (t.length < 200) { const i = html.search(/Mô tả công việc|Job description/i); if (i >= 0) t = stripTags(html.slice(i)); }
  if (t.length < 200) t = stripTags(html);
  return t.slice(0, JD_MAX);
}
async function enrichJd(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.source_id, j.source_url, j.skills FROM jobs j
     WHERE j.jd_text = '' AND j.submitted_by IS NULL AND j.source_id IN ('src-itviec','src-topdev')
     ORDER BY EXISTS (SELECT 1 FROM job_matches m WHERE m.job_id = j.id AND m.tier IN ('strong','partial')) DESC, j.first_seen_at DESC LIMIT ?`
  ).bind(limit).all();
  let done = 0, failed = 0;
  for (const j of results) {
    let jd = "", gone = false, pv = extractPreview("", j.source_id);
    for (let a = 0; a < 2 && !jd && !gone; a++) {
      try { const html = await fetchText(j.source_url); jd = extractJd(html, j.source_id); pv = extractPreview(html, j.source_id); } catch (e) { gone = /HTTP (?:404|410)\b/.test(String(e && e.message)); }
    }
    if (!jd) {
      failed++;
      // Chỉ 404/410 mới đánh '-' (tin đã gỡ); lỗi tạm (5xx, timeout, parse rỗng) để '' thử lại lần sau, LIMIT chặn đốt subrequest.
      if (gone) await env.DB.prepare("UPDATE jobs SET jd_text = '-' WHERE id = ?").bind(j.id).run();
      continue;
    }
    const skills = [...new Set([...JSON.parse(j.skills || "[]"), ...extractSkillsFromText(jd)])];
    await env.DB.prepare("UPDATE jobs SET jd_text = ?, skills = ?, company_logo_url = COALESCE(?, company_logo_url), address = COALESCE(?, address), benefits = COALESCE(?, benefits), work_mode_src = COALESCE(?, work_mode_src) WHERE id = ?")
      .bind(jd, JSON.stringify(skills), pv.logo, pv.address, pv.benefits, pv.mode, j.id).run();
    await env.Q_SCORE.send({ kind: "score", jobId: j.id });
    done++;
  }
  const r = { done, failed, skipped: limit - results.length };
  console.log("enrichJd", r);
  return r;
}

const USD_VND = 25500; // 03/11/2026
// Parse lương → {min, max, currency, period} | null. "Thương lượng" và dạng lạ → null (không đoán mò).
function parseSalary(text) {
  if (!text) return null;
  let t = String(text);
  if (/thương lượng|thoả thuận|thỏa thuận|negotiable|competitive|per task|per hour|per day|\/h\b|\/hr\b|\/hour\b|\/day\b|€|£|\beur\b|\bgbp\b/i.test(t)) return null;
  t = t.replace(/\+\s*(?:\d+\s*%|equity|bonus)[^\n]*/gi, ""); // bỏ "+ 20% bonus", "+ equity" trước khi bắt số
  if (/\$|usd/i.test(t)) {
    const nums = [...t.matchAll(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k)?\b/gi)]
      .map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1e3 : 1)).slice(0, 2);
    if (!nums.length || !nums[0]) return null;
    const max = nums[1] || nums[0];
    const period = /năm|year|yr|annual|\/y\b/i.test(t) ? "year" : /month|tháng|\/mo\b/i.test(t) ? "month" : max >= 30000 ? "year" : "month";
    return { min: nums[0], max, currency: "USD", period };
  }
  let m = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(triệu|tr)\b/i);
  if (m) return { min: Number(m[1]) * 1e6, max: Number(m[2]) * 1e6, currency: "VND", period: "month" };
  m = t.match(/(\d{1,3})\s*(triệu|tr)\b/i);
  if (m) return { min: Number(m[1]) * 1e6, max: Number(m[1]) * 1e6, currency: "VND", period: "month" };
  m = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*k\b/i);
  if (m) return { min: Number(m[1]) * 1e3, max: Number(m[2]) * 1e3, currency: "VND", period: "month" };
  return null;
}
// Quy về VNĐ/tháng.
function monthlyVND(p) {
  const f = (p.currency === "USD" ? USD_VND : 1) / (p.period === "year" ? 12 : 1);
  return { min: p.min * f, max: p.max * f };
}
// /api/jobs: lương VNĐ/tháng (cùng parser + tỉ giá với benchmark) và hình thức làm việc, suy ra lúc đọc.
// ponytail: tính lúc đọc trên ≤ JOB_LIST_LIMIT tin; khi danh sách lớn hơn, lưu thành cột bằng migration và lọc trong SQL.
function salaryVND(text) {
  const p = parseSalary(text);
  if (!p) return { min: null, max: null };
  const v = monthlyVND(p);
  return { min: Math.round(v.min), max: Math.round(v.max) };
}
const VN_CITY_RE = /\b(?:ho chi minh|hcmc?|hn|sai gon|saigon|ha noi|hanoi|da nang|hai phong|can tho|binh duong|dong nai|bac ninh|hue|nha trang)\b/;
// Nguồn chỉ đăng tin remote (HN đã lọc REMOTE lúc quét): mặc định remote, trừ khi ghi hybrid.
const REMOTE_SOURCES = new Set(["src-wwr", "src-remotive", "src-remoteok", "src-hn"]);
const HYBRID_RE = /\bhybrid\b|linh hoat/, REMOTE_RE = /\bremote\b(?! sensing)|tu xa|work from home|\bwfh\b|worldwide|anywhere/;
// ponytail: đoán theo từ khoá; JD chỉ dùng cho hybrid ở tin VN (JD hay nhắc "remote" kiểu 'không remote'). Sai nhiều thì cho AI gắn nhãn lúc quét.
function workMode(location, title, jd, sourceId, src = null) {
  if (src === "onsite" || src === "hybrid" || src === "remote") return src; // nhãn nguồn là sự thật, heuristic chỉ là fallback (§3A)
  const lt = normLoc(`${location || ""} ${title || ""}`), j = normLoc(String(jd || "").slice(0, 600));
  if (HYBRID_RE.test(lt) || HYBRID_RE.test(j)) return "hybrid";
  if (REMOTE_SOURCES.has(sourceId) || REMOTE_RE.test(lt)) return "remote";
  if (VN_CITY_RE.test(normLoc(location))) return "onsite";
  return REMOTE_RE.test(j) ? "remote" : null;
}
// Cờ rủi ro tin ảo từ lịch sử quét. row: posted_at, first_seen_at, last_seen_at, repost_count, salary_text, skillCount, dup.
function postingFlags(row, nowTs, lang) {
  const flags = [];
  const lastSeen = row.last_seen_at || row.first_seen_at || nowTs;
  const manual = row.source_id === null || String(row.source_url || "").startsWith("manual://"); // tin dán tay không được quét lại
  const gone = !manual && lastSeen < nowTs - 48 * 3600;
  const refTs = row.posted_at || row.first_seen_at;
  const ageDays = refTs ? Math.floor((nowTs - refTs) / 86400) : null;
  if (gone) flags.push({ type: "stale", label: tr(lang, "Có thể đã gỡ") });
  else if (ageDays !== null && ageDays > 30) flags.push({ type: "stale", label: tr(lang, "Tin cũ %s ngày", ageDays) });
  if (row.dup) flags.push({ type: "duplicate", label: tr(lang, "Đăng trùng / đăng lại") });
  if ((row.repost_count || 0) >= 1) flags.push({ type: "reposted", label: tr(lang, "Đăng lại %s lần", row.repost_count) });
  const open = row.first_seen_at ? Math.floor((nowTs - row.first_seen_at) / 86400) : 0;
  if (open >= 21 && !gone) flags.push({ type: "long_open", label: tr(lang, "Treo %s ngày", open) });
  const sal = String(row.salary_text || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").toLowerCase();
  if (!sal.trim() || /thoa thuan|thuong luong|negotiable/.test(sal)) flags.push({ type: "salary_hidden", label: tr(lang, "Không ghi lương") });
  if ((row.skillCount || 0) > 12) flags.push({ type: "bloated", label: tr(lang, "JD nhồi %s kỹ năng", row.skillCount) });
  return flags;
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// Fit (0..20): location 8, freshness 7, level 5 — tách riêng để /api/jobs
// giải thích được điểm khớp mà không cần chấm lại toàn bộ.
// So khớp địa điểm không phân biệt dấu tiếng Việt: "Hồ Chí Minh" = "Ho Chi Minh".
function normLoc(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
}
const REGION_LOCK = /(?<!\b(?:help|let|ask|tell|give|show|join|contact|about|with|email|follow|call|text|trust) )\b(?:us|usa|u\.s\.?a?|united states|north america|americas?|canada|latam|eu|europe|european|eea|chau au|emea|uk|germany|berlin|london|cet|est|pst|us timezones?|us hours)(?![a-z])/;
const JD_REGION_LOCK = /\b(?:(?:only|exclusively) (?:hiring |accepting |open to )?(?:candidates )?(?:in|from) (?:the )?(?:us|usa|u\.s\.?a?|united states|north america|canada|latam|eu|europe|eea|emea|uk|united kingdom|chau au|chau my|my)(?![a-z])|(?:must|need to|required to) (?:be )?(?:based|located|living|residing|reside) in (?:the )?(?:us|usa|u\.s\.?a?|united states|north america|canada|latam|eu|europe|eea|emea|uk|united kingdom|chau au|chau my|my)(?![a-z])|(?:the )?(?:us|usa|u\.s\.?a?|united states|north america|canada|latam|eu|europe|eea|emea|uk|united kingdom|chau au|chau my|my)[ -](?:only|based candidates only|residents only)\b|chi nhan (?:ung vien )?(?:o|tai|tu) (?:the )?(?:us|usa|u\.s\.?a?|united states|north america|canada|latam|eu|europe|eea|emea|uk|united kingdom|chau au|chau my|my)(?![a-z]))/;
function fitBreakdown(profile, job) {
  const locs = (profile.locations || []).map(normLoc);
  const jobLoc = normLoc(job.location);
  // ponytail: chỉ gỡ "join/contact/about us"; tiêu đề có "us" là đại từ kiểu khác vẫn có thể khớp nhầm khoá vùng.
  const jobLocTitle = `${jobLoc} ${normLoc(job.title)}`;
  let location = 0, locationWhy = "", locationArg;
  const jdLock = /remote/.test(jobLocTitle) ? normLoc(jdOf(job).slice(0, 3000)).replace(/\s+/g, " ").match(JD_REGION_LOCK) : null;
  if (!jobLoc) { location = 4; locationWhy = "Tin không ghi địa điểm"; }
  // Remote khoá vùng (T-60): tên vùng/múi giờ không gồm Việt Nam, so trên chuỗi đã normLoc (lowercase).
  // ponytail: danh sách cứng; thiếu vùng thì thêm vào đây, đổi sang bảng vùng khi nguồn mới ghi kiểu khác.
  // T-77: tiêu đề cũng có thể ghi khoá vùng ("U.S. Based Remote Contractor"), xét chung với địa điểm.
  // Khoá vùng hay nằm trong JD ("Europe only", "must be based in the EU"): chỉ bắt câu có "only/based/located" để không khoá nhầm tin nhắc tên vùng.
  else if (/remote/.test(jobLocTitle) && (REGION_LOCK.test(jobLocTitle) || jdLock) && !/\b(?:vietnam|viet nam|apac|asia|anywhere|worldwide|global)\b/.test(jobLocTitle)) {
    location = 0; locationWhy = "Remote nhưng chỉ nhận ứng viên ở %s";
    locationArg = (REGION_LOCK.test(jobLoc) ? (String(job.location).match(/\(([^)]*)\)/) || [, job.location])[1] : (jobLocTitle.match(REGION_LOCK) || jdLock)[0]).trim().slice(0, 40); // HN hay nhét cả câu vào ngoặc
  }
  else if (/remote/.test(jobLoc) || locs.some((l) => jobLoc.includes(l) || l.includes(jobLoc))) { location = 8; locationWhy = "Địa điểm khớp với hồ sơ"; }
  // A4: TopDev không ghi thành phố → "Vietnam"; hồ sơ ở thành phố VN thì chỉ khớp một phần, không phải lệch.
  else if (/^viet ?nam$/.test(jobLoc.trim()) && locs.some((l) => VN_CITY_RE.test(l))) { location = 5; locationWhy = "Tin ghi chung Việt Nam"; }
  else if (locs.some((l) => /remote/.test(l))) { location = 6; locationWhy = "Bạn chấp nhận Remote, job này làm onsite"; }
  else { location = 0; locationWhy = "Địa điểm không khớp với hồ sơ"; }
  const refTs = job.posted_at || job.first_seen_at || now();
  // Tuổi dùng số ngày làm tròn xuống — cùng con số hiển thị "N ngày trước".
  const ageDays = Math.floor((now() - refTs) / 86400);
  const freshness = ageDays <= 3 ? 7 : ageDays <= 7 ? 5 : ageDays <= 14 ? 3 : 1;
  const titleAndJd = `${job.title || ""} ${jdOf(job).slice(0, 500)}`.toLowerCase();
  const seniorish = /(senior|\bsr\b|lead|principal|staff|manager|architect|expert|trưởng|cao cấp)/.test(titleAndJd);
  const juniorish = /(junior|fresher|intern|thực tập)/.test(titleAndJd);
  const lvl = String(profile.level || "").toLowerCase().trim().replace(/^mid$/, "middle");
  // T-76: tin ghi nhiều cấp ("Mid/Sr", "Expert/Senior/Middle") mà có cấp của hồ sơ thì không lệch.
  const mentionsMine = /middle/.test(lvl) ? /\b(?:middle|mid|intermediate)\b/.test(titleAndJd)
    : /junior|fresher/.test(lvl) ? /\b(?:junior|jr|fresher|intern)\b|thực tập/.test(titleAndJd)
    : /senior/.test(lvl) ? seniorish : false;
  // A3: hồ sơ chưa ghi cấp bậc = chưa biết (4), không coi là khớp (5).
  let level = lvl ? 5 : 4, levelWhy = lvl ? "Cấp bậc phù hợp" : "Hồ sơ chưa ghi cấp bậc";
  // Số năm kinh nghiệm JD đòi (lấy cận dưới của khoảng; lấy max các lần nhắc).
  let years = 0;
  for (const re of [/(\d{1,2})\s*(?:[-–]\s*\d{1,2}\s*)?\+?\s*(?:years?|yrs?|năm)[^.\n]{0,25}?(?:experience|kinh nghiệm)/gi,
    /(?:experience|kinh nghiệm)[^.\n]{0,20}?(\d{1,2})\s*(?:[-–]\s*\d{1,2}\s*)?\+?\s*(?:years?|yrs?|năm)/gi,
    /(?:từ|at least|minimum|tối thiểu)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|năm)/gi])
    for (const m of jdOf(job).slice(0, 2000).matchAll(re)) {
      const ctx = jdOf(job).slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      // ponytail: ngữ cảnh ±40 ký tự + trần 15 năm; "20 years" giới thiệu công ty bị loại.
      if (Number(m[1]) <= 15 && /experience|kinh nghiệm|yêu cầu|required|minimum|at least|tối thiểu|ít nhất/i.test(ctx)) years = Math.max(years, Number(m[1]));
    }
  const tooJunior = years >= (/middle/.test(lvl) ? 7 : 4) && /junior|fresher|middle/.test(lvl);
  let levelArg;
  if (tooJunior) { level = 2; levelWhy = "JD yêu cầu %s năm kinh nghiệm"; levelArg = years; }
  else if (seniorish && /middle|junior|fresher/.test(lvl) && !mentionsMine) { level = 2; levelWhy = "Tin này thiên về senior hơn cấp bậc của bạn"; }
  else if (juniorish && /senior/.test(lvl) && !mentionsMine) { level = 2; levelWhy = "Tin này thiên về junior hơn cấp bậc của bạn"; }
  return { location, locationWhy, locationArg, levelArg, freshness, ageDays, level, levelWhy, total: location + freshness + level };
}

function scoreJob(profile, profileSkills, job) {
  const jobSkills = [...new Set([...(job.skills || []), ...extractSkillsFromText(jdOf(job))])];
  const profileByKey = new Map(profileSkills.map((ps) => [ps.skill.toLowerCase(), ps]));
  // Mẫu số = tổng trọng số các skill JOB yêu cầu (skill có trong profile lấy
  // trọng số của profile, skill lạ tính 3) — "bạn đáp ứng bao nhiêu % yêu cầu
  // của job", đúng cách các nền tảng match vẫn tính.
  let jobTotalW = 0, matchedW = 0;
  const matched = [], missing = [];
  for (const js of jobSkills) {
    const ps = profileByKey.get(js.toLowerCase());
    const w = ps ? ps.weight : 3;
    jobTotalW += w;
    if (ps) { matchedW += ps.weight; matched.push(ps.skill); }
    else missing.push(js);
  }
  const rule = jobSkills.length ? (matchedW / jobTotalW) * 50 : 10;
  const fb = fitBreakdown(profile, job);
  let finalScore = Math.round(((rule + fb.total) / 70) * 100);
  // Bằng chứng mỏng (job khai < 3 skills) thì không cho lên strong.
  if (jobSkills.length < 3) finalScore = Math.min(finalScore, 69);
  // Lệch cấp bậc hoặc khác khu vực thì không cho lên strong, dù kỹ năng khớp hết (T-46).
  if (fb.level <= 2 || fb.location === 0) finalScore = Math.min(finalScore, 74);
  const tier = finalScore >= 75 ? "strong" : finalScore >= 50 ? "partial" : "weak";
  return { rule, semantic: null, finalScore, tier, matched, missing, jobSkills };
}

// ---------------- Telegram (T-63) ----------------
const APP_URL = "https://jobpilot-edge.pages.dev";
const tgEsc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tgLink = (url, text) => url ? `<a href="${tgEsc(url).replace(/"/g, "&quot;")}">${tgEsc(text)}</a>` : tgEsc(text);
// Trả mã HTTP của Telegram (200 = gửi được), 0 khi thiếu token hoặc lỗi mạng. Không log URL (chứa token).
async function tgSend(env, chatId, html, token = env.TELEGRAM_BOT_TOKEN) {
  if (!token) { console.log("telegram: thiếu TELEGRAM_BOT_TOKEN, bỏ qua"); return 0; }
  try {
    const r = await fetch((env.TELEGRAM_API_BASE || "https://api.telegram.org") + "/bot" + token + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.log("telegram: sendMessage", r.status);
    return r.status;
  } catch (e) { console.log("telegram: sendMessage lỗi", e.message); return 0; }
}
// Gọi Bot API bất kỳ (getMe, setWebhook…), trả JSON của Telegram; mạng lỗi thì ném.
async function tgApi(env, token, method, body) {
  const r = await fetch((env.TELEGRAM_API_BASE || "https://api.telegram.org") + "/bot" + token + "/" + method, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  return r.json().catch(() => ({ ok: false }));
}
// Giờ yên lặng 22:00-07:00 VN (UTC+7); TELEGRAM_QUIET_OVERRIDE=1 bỏ qua (lab).
function tgQuiet(env, ms = Date.now()) {
  if (env.TELEGRAM_QUIET_OVERRIDE === "1") return false;
  const h = new Date(ms + 7 * 3600 * 1000).getUTCHours();
  return h >= 22 || h < 7;
}
// Hàm thuần: bản tin ngày → HTML Telegram; null nếu không có gì để báo.
function formatDigestTg(d) {
  const strong = d.strong || [], fu = d.follow_ups || [], fresh = d.fresh || [];
  if (!strong.length && !fu.length && !fresh.length) return null;
  const [, mm, dd] = String(d.date).split("-");
  const out = [`<b>JobPilot, ${dd}/${mm}</b>`];
  if (strong.length) {
    out.push("", `${strong.length} tin khớp mạnh mới`);
    for (const r of strong.slice(0, 5)) out.push(`• ${tgLink(r.source_url, r.title)} — ${tgEsc(r.company)} (${Math.round(r.final_score)})`);
  }
  if (fresh.length) {
    out.push("", `${fresh.length} tin mới phù hợp`);
    for (const r of fresh) out.push(`• ${tgLink(r.source_url, r.title)} — ${tgEsc(r.company)} (${Math.round(r.final_score)})`);
  } else if (!strong.length) out.push("", "Hôm nay không có tin mới phù hợp");
  if (fu.length) {
    out.push("", `${fu.length} việc cần follow-up`);
    for (const r of fu.slice(0, 3)) out.push(`• ${tgEsc(r.title)} — ${tgEsc(r.company)}`);
  }
  out.push("", `Mở JobPilot: ${APP_URL}`);
  return out.join("\n");
}
const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, "$1***$2");

// ---------------- bot Telegram riêng từng khách ----------------
// Token mã hoá AES-GCM bằng env.TG_TOKEN_KEY (base64 32 byte), AAD = user_id, lưu base64(iv12 + ciphertext).
// Không bao giờ log token hay URL chứa token.
const TG_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const OWN_BOT_TRIES = 10; // PUT + check chung, mỗi giờ mỗi người
const tgB64 = (u8) => btoa(String.fromCharCode(...u8));
const tgUnb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function ownBotEnabled(env) {
  try { return tgUnb64(env.TG_TOKEN_KEY || "").length === 32; } catch (_) { return false; }
}
const tgKey = (env) => crypto.subtle.importKey("raw", tgUnb64(env.TG_TOKEN_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
async function tgEncrypt(env, token, userId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) }, await tgKey(env), new TextEncoder().encode(token)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return tgB64(out);
}
async function tgDecrypt(env, enc, userId) {
  const raw = tgUnb64(enc);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(userId) }, await tgKey(env), raw.slice(12)));
}
// Thông báo trong app: ghi SAU khi gửi, lỗi chỉ log, không bao giờ ném vào queue handler (ném = retry = gửi Telegram trùng).
async function notifWrite(fn) {
  try { await fn(); } catch (e) { console.log("notif write", e.message); }
}
// Bot riêng hỏng: 1 dòng bot_broken chưa đọc là đủ, không chèn trùng.
const notifyBotBroken = (env, userId, code) => notifWrite(() => env.DB.prepare(
  "INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at) SELECT ?2, ?1, 'bot_broken', 'Bot @' || COALESCE(username, '') || ' ngừng hoạt động', ?3, NULL, ?4 FROM user_bots WHERE user_id = ?1 AND NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ?1 AND type = 'bot_broken' AND is_read = 0)"
).bind(userId, uid(), code, now()).run());
// Gửi bằng bot riêng nếu có token_enc (dòng status 'ok'), không thì bot chung. Giải mã lỗi → 'broken'/key_changed, không gửi. 401 = khách đã thu hồi token → 'broken'.
async function tgSendFor(env, userId, chatId, html, tokenEnc) {
  let token = null;
  if (tokenEnc) {
    // Khoá đổi/mất: chat này gắn với bot riêng, không gửi lén qua bot chung; đánh dấu broken để khách gắn lại.
    try { token = await tgDecrypt(env, tokenEnc, userId); } catch (_) {
      console.log("telegram: giải mã token bot riêng lỗi", userId);
      await env.DB.prepare("UPDATE user_bots SET status = 'broken', last_error = 'key_changed', checked_at = ? WHERE user_id = ?").bind(now(), userId).run();
      await notifyBotBroken(env, userId, "key_changed");
      return 0;
    }
  }
  const st = await tgSend(env, chatId, html, token || env.TELEGRAM_BOT_TOKEN);
  if (token && st === 401) {
    await env.DB.prepare("UPDATE user_bots SET status = 'broken', last_error = 'token_revoked', checked_at = ? WHERE user_id = ?").bind(now(), userId).run();
    await notifyBotBroken(env, userId, "token_revoked");
  }
  return st;
}
// ponytail: đếm trên KV không nguyên tử, vài lần vượt khi bấm dồn dập là chấp nhận được; cần chặt thì chuyển sang bảng D1 như register_attempts.
async function ownBotAttempt(env, userId) {
  const k = `tgbotrl:${userId}:${Math.floor(now() / 3600)}`;
  const n = Number((await env.KV.get(k)) || 0) + 1;
  if (n > OWN_BOT_TRIES) return false;
  await env.KV.put(k, String(n), { expirationTtl: 3600 });
  return true;
}
async function ownBotView(env, userId) {
  const r = await env.DB.prepare("SELECT username, status, last_error, checked_at FROM user_bots WHERE user_id = ?").bind(userId).first();
  return r ? { configured: true, bot_username: r.username, status: r.status, last_error: r.last_error, checked_at: r.checked_at }
    : { configured: false, bot_username: null, status: null, last_error: null, checked_at: null };
}
// /start <mã> và /stop, dùng cho cả bot chung (ownerId null) và bot riêng (chỉ chủ bot gắn được); send trả lời bằng đúng bot nhận tin.
async function tgHandleUpdate(env, update, send, ownerId = null) {
  const m = update.message || {};
  const chatId = m.chat && m.chat.id != null ? String(m.chat.id) : "";
  const text = String(m.text || "").trim();
  const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9]{8})$/);
  if (chatId && start) {
    const uidLinked = await env.KV.get(`tglink:${start[1]}`); // mã sống 900s trong KV (T-99), hết hạn là null
    const u = uidLinked && (!ownerId || uidLinked === ownerId)
      ? await env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL").bind(uidLinked).first() : null;
    if (u) {
      await env.KV.delete(`tglink:${start[1]}`);
      await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, telegram_linked_at = ?, telegram_link_code = NULL WHERE id = ?").bind(chatId, now(), u.id).run();
      await send(chatId, `Đã gắn JobPilot với tài khoản ${tgEsc(maskEmail(u.email))}. Bạn sẽ nhận 1 bản tin mỗi sáng và báo ngay khi có tin khớp mạnh. / Linked: one digest each morning plus instant strong matches.`);
    } else await send(chatId, "Mã không đúng hoặc đã dùng. / Invalid or used code.");
  } else if (chatId && /^\/stop(?:@\w+)?$/.test(text)) {
    // Bot chung không gỡ người đang nhận qua bot riêng; bot riêng chỉ gỡ chủ bot.
    await (ownerId
      ? env.DB.prepare("UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND id = ?").bind(chatId, ownerId)
      : env.DB.prepare("UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND id NOT IN (SELECT user_id FROM user_bots WHERE status = 'ok')").bind(chatId)).run();
    await send(chatId, "Đã tắt thông báo JobPilot. / JobPilot notifications turned off.");
  }
}

const MATCH_UPSERT = `INSERT INTO job_matches (job_id, profile_id, rule_score, semantic_score, final_score, tier, matched_skills, missing_skills, scored_at)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  ON CONFLICT(job_id, profile_id) DO UPDATE SET rule_score=excluded.rule_score, final_score=excluded.final_score, tier=excluded.tier, matched_skills=excluded.matched_skills, missing_skills=excluded.missing_skills, scored_at=excluded.scored_at`;
// Khử trùng theo (người dùng, tin): các câu trong batch chạy tuần tự nên NOT EXISTS thấy cả dòng vừa chèn cùng lô.
// T-37: nhắc trong app (không Telegram). Mỗi (user, type, ref_id) chỉ một lần, như NOTIFY_STRONG. 1 batch = 1 truy vấn D1.
const OWNER_OF_APP = "JOIN profiles p ON p.id = a.profile_id JOIN users u ON u.id = p.user_id AND u.deleted_at IS NULL JOIN jobs j ON j.id = a.job_id";
const NOTIFY_DUE = [
  // vòng phỏng vấn trong ≤ 24h tới (scheduled_at = 0 là chưa hẹn, bị loại vì > now)
  `INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at)
   SELECT lower(hex(randomblob(16))), p.user_id, 'interview', 'Sắp phỏng vấn: ' || i.round_label || ' — ' || j.company, j.title, i.id, ?1
   FROM interviews i JOIN applications a ON a.id = i.application_id ${OWNER_OF_APP}
   WHERE i.scheduled_at > ?1 AND i.scheduled_at <= ?1 + 86400
     AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.type = 'interview' AND n.ref_id = i.id)`,
  // follow-up đến hạn, mỗi đơn một lần
  `INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at)
   SELECT lower(hex(randomblob(16))), p.user_id, 'follow_up', 'Đến hẹn follow-up: ' || j.company, j.title, a.id, ?1
   FROM applications a ${OWNER_OF_APP}
   WHERE a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= ?1 AND a.stage IN ('applied','interview')
     AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.type = 'follow_up' AND n.ref_id = a.id)`,
];
const NOTIFY_STRONG = "INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at) SELECT ?, ?, 'strong_match', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ? AND type = 'strong_match' AND ref_id = ?)";
// Một lô queue score = 1 lần chạy Worker: 1 batch đọc (tin, hồ sơ, skills [+ 500 tin mới nhất nếu có rescore]),
// chấm trong JS, ghi bằng batch, ≤ 1 SELECT users cho Telegram → 3 truy vấn, không tăng theo số hồ sơ hay số tin.
async function scoreBatch(env, jobIds, rescoreIds, ver = new Map()) {
  if (!jobIds.length && !rescoreIds.length) return;
  const reads = [
    env.DB.prepare(`SELECT * FROM jobs WHERE id IN ${IN_JSON}`).bind(JSON.stringify(jobIds)),
    env.DB.prepare("SELECT * FROM profiles WHERE is_active = 1"),
    env.DB.prepare("SELECT s.profile_id, s.skill, s.weight FROM profile_skills s JOIN profiles p ON p.id = s.profile_id WHERE p.is_active = 1"),
  ];
  if (rescoreIds.length) reads.push(env.DB.prepare(`SELECT * FROM jobs WHERE submitted_by IS NULL ORDER BY first_seen_at DESC LIMIT ${JOB_LIST_LIMIT}`)); // review T-103 L2: job dán tay chấm riêng khi nộp
  const [{ results: jobRows }, { results: profRows }, { results: skillRows }, recent] = await env.DB.batch(reads);
  const skillsOf = new Map();
  for (const r of skillRows) {
    if (!skillsOf.has(r.profile_id)) skillsOf.set(r.profile_id, []);
    skillsOf.get(r.profile_id).push({ skill: r.skill, weight: r.weight });
  }
  // Hồ sơ không có skill thì bỏ qua, như cũ.
  // Một dòng JSON hỏng chỉ bỏ đúng tin đó, không kéo cả lô vào DLQ (lỗi ở đây = retryAll cả lô).
  const profiles = new Map(profRows.filter((p) => skillsOf.has(p.id)).map((p) => [p.id, { ...p, locations: jsonArr(p.locations) || [] }]));
  const parse = (j) => { const skills = jsonArr(j.skills); if (!skills) console.log("score: bỏ qua tin skills hỏng", j.id); return skills && { ...j, skills }; };
  const byId = new Map(jobRows.map((j) => [j.id, parse(j)]).filter(([, j]) => j));
  const pairs = [];
  for (const id of jobIds) if (byId.has(id)) for (const p of profiles.values()) pairs.push({ job: byId.get(id), p, alert: true });
  const recentJobs = recent ? recent.results.map(parse).filter(Boolean) : [];
  // T-50: hồ sơ đã sửa sau lúc xếp message → có message mới hơn đang chờ, bỏ lượt cũ (không thêm truy vấn).
  for (const id of rescoreIds) if (profiles.has(id) && !(ver.get(id) < profiles.get(id).updated_at)) for (const job of recentJobs) pairs.push({ job, p: profiles.get(id), alert: false });

  const stmts = [], strong = [];
  for (const x of pairs) {
    if (x.job.submitted_by && x.job.submitted_by !== x.p.user_id) continue; // T-05: job dán tay chỉ chấm cho người nộp
    const { job, p } = x, s = (x.s = scoreJob(p, skillsOf.get(p.id), job));
    stmts.push(env.DB.prepare(MATCH_UPSERT).bind(job.id, p.id, s.rule, s.finalScore, s.tier, JSON.stringify(s.matched), JSON.stringify(s.missing), now()));
    if (s.tier !== "strong") continue;
    stmts.push(env.DB.prepare(NOTIFY_STRONG).bind(uid(), p.user_id, `Strong match ${s.finalScore}%: ${job.title}`, `${job.company} — khớp ${s.matched.join(", ")}`, job.id, now(), p.user_id, job.id));
    strong.push(x);
  }
  await dbBatch(env, stmts);
  for (const { job, p, s } of strong) {
    try {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(p.user_id));
      await stub.fetch("https://do/broadcast", { method: "POST", body: JSON.stringify({ type: "job.strong", jobId: job.id, title: job.title, score: s.finalScore }) });
    } catch (_) { /* realtime là best-effort */ }
  }
  // Báo ngay qua Telegram (chỉ tin mới chấm, rescore không báo — như cũ): tối đa 1 tin/giờ/người, không gửi giờ yên lặng.
  const alerts = strong.filter((x) => x.alert);
  if (!alerts.length || tgQuiet(env)) return;
  let chat;
  try {
    const { results } = await env.DB.prepare(`SELECT u.id, u.telegram_chat_id, b.token_enc FROM users u LEFT JOIN user_bots b ON b.user_id = u.id AND b.status = 'ok' WHERE u.id IN ${IN_JSON}`).bind(JSON.stringify([...new Set(alerts.map((x) => x.p.user_id))])).all();
    chat = new Map(results.map((u) => [u.id, u]));
  } catch (e) { console.log("telegram burst lỗi", e.message); return; }
  const tgMarks = []; // trạng thái gửi, ghi gộp 1 batch SAU vòng gửi (1 truy vấn/lần chạy, giữ ngân sách D1)
  for (const { job, p, s } of alerts) {
    const { telegram_chat_id: chatId, token_enc: tokenEnc } = chat.get(p.user_id) || {};
    chat.delete(p.user_id); // tin sau của cùng người trong lô đã vướng tgburst, như vòng lặp cũ
    if (!chatId) continue;
    try {
      if (await env.KV.get("tgburst:" + p.user_id)) continue;
      await env.KV.put("tgburst:" + p.user_id, "1", { expirationTtl: 3600 });
      const st = await tgSendFor(env, p.user_id, chatId, `1 tin khớp mạnh mới: ${tgLink(job.source_url, job.title)} — ${tgEsc(job.company)} (${Math.round(s.finalScore)})`, tokenEnc);
      tgMarks.push(env.DB.prepare("UPDATE notifications SET tg_status = ?, tg_at = ? WHERE user_id = ? AND type = 'strong_match' AND ref_id = ?")
        .bind(st >= 200 && st < 300 ? "sent" : "failed", now(), p.user_id, job.id));
    } catch (e) { console.log("telegram burst lỗi", e.message); }
  }
  if (tgMarks.length) await notifWrite(() => env.DB.batch(tgMarks));
}

// ---------------- ingest ----------------
const DEFAULT_KEYWORDS = ["Java", "Node.js", "Backend", "Spring Boot"];
// Kỹ năng quá chung, quét ra toàn tin nhiễu.
const GENERIC_KEYWORDS = new Set(["git", "rest apis", "rest api", "english", "agile", "scrum", "sql", "linux", "jira", "oop", "html", "css"]);
// Từ khoá quét ITviec/TopDev: DEFAULT_KEYWORDS làm nền + target_roles + 2 kỹ năng nặng nhất
// của mỗi hồ sơ đang hoạt động; tối đa 12. DB lỗi → chỉ DEFAULT_KEYWORDS.
async function ingestKeywords(env) {
  const out = [...DEFAULT_KEYWORDS], seen = new Set(out.map((k) => k.toLowerCase()));
  try {
    const { results } = await env.DB.prepare(
      "SELECT p.target_roles, (SELECT json_group_array(skill) FROM (SELECT skill FROM profile_skills WHERE profile_id = p.id ORDER BY weight DESC, skill LIMIT 2)) AS top FROM profiles p WHERE p.is_active = 1"
    ).all();
    for (const r of results) {
      for (const kw of [...(jsonArr(r.target_roles) || []), ...(jsonArr(r.top) || [])]) {
        const k = String(kw).trim(), low = k.toLowerCase();
        if (k.length <= 2 || seen.has(low) || GENERIC_KEYWORDS.has(low)) continue;
        seen.add(low); out.push(k);
        if (out.length >= 12) return out;
      }
    }
  } catch (e) { console.log("ingestKeywords fallback:", e.message); }
  return out;
}
// T-87: hồ sơ mới/đổi vai trò/kỹ năng → quét ngay từ khoá của hồ sơ đó (cùng cách suy ra như ingestKeywords),
// bỏ từ khoá nền, tối đa 3, mỗi từ khoá 1 lần/6 giờ (KV) để lưu liên tục không dồn queue. Không bao giờ ném lỗi.
async function enqueueProfileScan(env, profileId) {
  try {
    const r = await env.DB.prepare(
      "SELECT p.target_roles, (SELECT json_group_array(skill) FROM (SELECT skill FROM profile_skills WHERE profile_id = p.id ORDER BY weight DESC, skill LIMIT 2)) AS top FROM profiles p WHERE p.id = ? AND p.is_active = 1"
    ).bind(profileId).first();
    if (!r) return 0;
    const base = new Set(DEFAULT_KEYWORDS.map((k) => k.toLowerCase())), picked = [];
    for (const kw of [...(jsonArr(r.target_roles) || []), ...(jsonArr(r.top) || [])]) {
      const k = String(kw).trim(), low = k.toLowerCase();
      if (k.length <= 2 || base.has(low) || GENERIC_KEYWORDS.has(low)) continue;
      base.add(low);
      if (await env.KV.get("scankw:" + low)) continue;
      picked.push(k);
      if (picked.length >= 3) break;
    }
    for (const k of picked) {
      await env.KV.put("scankw:" + k.toLowerCase(), "1", { expirationTtl: 21600 });
      for (const sourceType of ["itviec", "topdev"]) await env.Q_INGEST.send({ kind: "ingest", sourceType, keyword: k });
    }
    return picked.length;
  } catch (e) { console.log("enqueueProfileScan lỗi:", e.message); return 0; }
}
async function ensureSources(env) {
  for (const type of ["topdev", "itviec"]) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sources (id, type, name, config, is_enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).bind(`src-${type}`, type, type === "topdev" ? "TopDev" : "ITviec",
      JSON.stringify({ keywords: DEFAULT_KEYWORDS }), now()).run();
  }
  // Nguồn remote không có keyword: 1 message ingest mỗi lượt cron.
  for (const type of Object.keys(REMOTE_FETCHERS)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sources (id, type, name, config, is_enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).bind(`src-${type}`, type, REMOTE_NAMES[type], JSON.stringify({ keywords: ["*"] }), now()).run();
  }
}
// Cổng liên quan theo tiêu đề: loại tin phi kỹ thuật (HR/Sales/Kế toán...)
// mà tìm kiếm từ khoá của TopDev hay trả lẫn vào.
const TITLE_TECH = /(developer|engineer|backend|back-end|fullstack|full-stack|software|java|node|devops|\bqa\b|tester|data|mobile|android|ios|frontend|front-end|programmer|lập trình|kỹ sư|công nghệ)/i;
// A2: tin ngành khác dùng chữ "kỹ sư" (xây dựng, cơ điện, SMT...), chỉ chặn khi tiêu đề không có từ IT mạnh.
// ponytail: hai danh sách cứng; ngành mới lọt (hoặc tin IT bị chặn) thì thêm từ vào.
const TITLE_IT_STRONG = /(developer|software|programmer|lập trình|phần mềm|dữ liệu|cloud|bảo mật|an toàn thông tin|kiểm thử|brse|\berp\b|\bmes\b|devops|data|backend|back-end|frontend|front-end|fullstack|full-stack|mobile|\bqa\b|tester|\bai\b|embedded)/i;
const TITLE_NON_IT = /(cấp thoát nước|\bsmt\b|năng lượng|điện nhẹ|xây dựng|cơ khí|cơ điện|thi công|kết cấu|\bqs\b|shop ?drawing|dây chuyền|sản xuất)/i;
const TITLE_BLOCK = /(human resource|\bhr\b|recruit|talent acquisition|sales|marketing|accountant|kế toán|nhân sự|tuyển dụng|business development|customer service|support|administrator|designer|content|seo|admin\b)/i;
// T-07: nhóm này chặn kể cả khi có "engineer" (Sales Engineer, Engineering Manager, Data Entry...).
const TITLE_HARD_BLOCK = /(\bsales\b|pre-?sales|\bsupport\b|\bcontent\b|\bmanager\b|data entry)/i;
function titleGate(title) {
  if (!TITLE_TECH.test(title || "") || TITLE_HARD_BLOCK.test(title || "") || (TITLE_NON_IT.test(title || "") && !TITLE_IT_STRONG.test(title || ""))) return false;
  if (TITLE_BLOCK.test(title || "") && !/\b(?:developer|engineer|programmer)\b/i.test(title)) return false;
  return true;
}

// 3 truy vấn D1/tin nhắn bất kể số tin nguồn trả về: SELECT nguồn, batch đọc trùng, batch ghi (gồm UPDATE sources).
async function runIngestSource(env, sourceType, keyword) {
  const source = await env.DB.prepare("SELECT * FROM sources WHERE type = ?").bind(sourceType).first();
  if (!source) return { error: "source_missing" };
  let jobs = [], status = "ok", error = null;
  try {
    jobs = REMOTE_FETCHERS[sourceType] ? await REMOTE_FETCHERS[sourceType]()
      : sourceType === "topdev" ? await fetchTopDev(keyword) : await fetchITviec(keyword);
  } catch (e) {
    // T-49: keyword lỗi không đè 'ok' của keyword khác vừa xong (<20 phút, cùng lượt cron); chỉ khi mọi keyword lỗi mới ra 'error'.
    // ITviec trả 404 cho slug không có tin: coi là 0 tin, không phải lỗi nguồn (T-49 một phần).
    if (e.message !== "HTTP 404" || REMOTE_FETCHERS[sourceType]) { status = "error"; error = e.message; }
  }
  const rawCount = jobs.length;
  jobs = jobs.filter((j) => titleGate(j.title));
  const plan = await planUpsertJobs(env, jobs.map((job) => ({ sourceId: source.id, job })));
  plan.stmts.push(env.DB.prepare("UPDATE sources SET last_run_at = ?, last_status = CASE WHEN ? = 'error' AND last_status = 'ok' AND last_run_at > ? THEN 'ok' ELSE ? END, last_error = ? WHERE id = ?")
    .bind(now(), status, now() - 1200, status, error, source.id));
  await dbBatch(env, plan.stmts);
  await sendScores(env, plan.toScore);
  return { fetched: jobs.length, raw: rawCount, created: plan.out.filter((r) => r.created).length, status, error };
}

// ---------------- digest ----------------
// persist=true chỉ từ cron/consumer; GET không ghi DB (T-47). profileId=null: gộp mọi hồ sơ.
async function buildDigest(env, user, lang = "vi", profileId = null, persist = false) {
  const since = now() - 86400;
  const { results: profiles } = profileId
    ? await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? AND is_active = 1 AND id = ?").bind(user.id, profileId).all()
    : await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? AND is_active = 1").bind(user.id).all();
  const strong = [], followUps = [], fresh = [];
  const res = profiles.length ? await env.DB.batch(profiles.flatMap((p) => [
    env.DB.prepare(
      `SELECT j.title, j.company, j.source_url, m.final_score FROM job_matches m JOIN jobs j ON j.id = m.job_id
       WHERE m.profile_id = ? AND m.tier = 'strong' AND j.first_seen_at >= ? ORDER BY m.final_score DESC LIMIT 20`
    ).bind(p.id, since),
    env.DB.prepare(
      `SELECT j.*, m.final_score, m.tier, m.missing_skills FROM job_matches m JOIN jobs j ON j.id = m.job_id
       WHERE m.profile_id = ? AND m.tier = 'partial' AND j.first_seen_at >= ? ORDER BY m.final_score DESC LIMIT 30`
    ).bind(p.id, since),
    env.DB.prepare(
      `SELECT a.id, a.stage, a.next_follow_up_at, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.profile_id = ? AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= ? AND a.stage IN ('applied','interview') ORDER BY a.next_follow_up_at LIMIT 20`
    ).bind(p.id, now()),
  ])) : [];
  profiles.forEach((p, i) => {
    const [{ results: sm }, { results: cand }, { results: fu }] = res.slice(3 * i, 3 * i + 3);
    strong.push(...sm.map((r) => ({ ...r, profile: p.name })));
    // B6: tin mới còn phù hợp (verdict != skip, không khoá vùng/stale), dùng đúng verdictFor/postingFlags/fitBreakdown như /api/jobs.
    const prof = { ...p, locations: jsonArr(p.locations) || [] };
    for (const r of cand) {
      const fit = fitBreakdown(prof, { title: r.title, location: r.location, posted_at: r.posted_at, first_seen_at: r.first_seen_at, jd_text: jdOf(r) });
      const flags = postingFlags(r, now(), lang);
      const missing = JSON.parse(r.missing_skills || "[]").map((s) => ({ skill: s, weight: 3 }));
      const v = verdictFor({ tier: r.tier, rule_detail: { missing } }, fit, flags, flags.filter((f) => f.type !== "duplicate").length, lang);
      if (v.verdict === "skip" || fit.location === 0 || flags.some((f) => f.type === "stale")) continue;
      fresh.push({ title: r.title, company: r.company, source_url: r.source_url, final_score: r.final_score, verdict: v.verdict, profile: p.name });
    }
    followUps.push(...fu);
  });
  const dateStr = new Date().toISOString().slice(0, 10);
  const summary = `${strong.length} strong match mới, ${followUps.length} việc cần follow-up`;
  if (persist) await env.DB.prepare(
    `INSERT INTO digests (id, user_id, date, summary, status, sent_at) VALUES (?, ?, ?, ?, 'in_app', ?)
     ON CONFLICT(user_id, date) DO UPDATE SET summary = excluded.summary`
  ).bind(uid(), user.id, dateStr, summary, now()).run();
  fresh.sort((a, b) => b.final_score - a.final_score);
  fresh.length = Math.min(fresh.length, 3);
  // DB luôn lưu vi; chỉ bản trả về theo Accept-Language.
  return { date: dateStr, strong_count: strong.length, strong, follow_ups: followUps, fresh,
    summary: tr(lang, "%s strong match mới, %s việc cần follow-up", strong.length, followUps.length) };
}

// ---------------- auth: mật khẩu (PBKDF2-SHA256, WebCrypto) ----------------
const PBKDF2_ITER = 100000;
function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}
async function makePasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { salt: b64encode(salt), hash: b64encode(hash) };
}
async function verifyPassword(password, saltB64, hashB64) {
  const computed = await pbkdf2(password, b64decode(saltB64));
  const expected = b64decode(hashB64);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expected[i];
  return diff === 0;
}
async function issueSession(env, user) {
  const token = randomToken();
  await env.KV.put(`session:${token}`, `${user.id}|${Date.now()}`, { expirationTtl: 2592000 });
  return { token, user: { id: user.id, email: user.email, name: user.name } };
}
// Giới hạn đăng nhập sai bằng D1 (không dùng KV: Free chỉ 1.000 lượt ghi/ngày, email lạ từng đốt hết).
// Chỉ có dòng cho tài khoản có thật. Mỗi lượt thử "giữ chỗ" TRƯỚC khi băm mật khẩu bằng một câu upsert
// nguyên tử: các request song song nhận số đếm khác nhau nên không vượt được MAX (đọc-rồi-ghi thì vượt được).
// fail_count dừng ở MAX+1 và last_fail_at đứng yên khi đã bị khoá, nên kẻ tấn công không kéo dài được khoá.
const LOGIN_FAIL_MAX = 5, LOGIN_FAIL_WINDOW = 600;
async function loginAttemptAllowed(env, userId) {
  const r = await env.DB.prepare(
    `INSERT INTO login_failures (user_id, fail_count, last_fail_at) VALUES (?1, 1, ?2)
     ON CONFLICT(user_id) DO UPDATE SET
       fail_count = CASE WHEN ?2 - last_fail_at > ?3 THEN 1 WHEN fail_count > ?4 THEN fail_count ELSE fail_count + 1 END,
       last_fail_at = CASE WHEN ?2 - last_fail_at > ?3 THEN ?2 WHEN fail_count > ?4 THEN last_fail_at ELSE ?2 END
     RETURNING fail_count`
  ).bind(userId, now(), LOGIN_FAIL_WINDOW, LOGIN_FAIL_MAX).first();
  return r.fail_count <= LOGIN_FAIL_MAX;
}
// Cloudflare Turnstile. Không có TURNSTILE_SECRET (lab/dev, hoặc chưa `wrangler secret put`) thì bỏ qua và cảnh báo.
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) { console.log("WARN turnstile: thiếu env.TURNSTILE_SECRET, bỏ qua kiểm tra"); return true; }
  if (!token || typeof token !== "string") return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return !!(await r.json()).success;
  } catch (_) { return false; }
}
// Giới hạn đăng ký theo IP, 5 lần/giờ (T-16b), cùng kiểu upsert nguyên tử; count dừng ở MAX+1. Cron */30 dọn dòng cũ.
const REGISTER_MAX = 5;
async function registerAttemptAllowed(env, ip, hour) {
  const r = await env.DB.prepare(
    `INSERT INTO register_attempts (ip, hour, count) VALUES (?1, ?2, 1)
     ON CONFLICT(ip, hour) DO UPDATE SET count = CASE WHEN count > ?3 THEN count ELSE count + 1 END
     RETURNING count`
  ).bind(ip, hour, REGISTER_MAX).first();
  return r.count <= REGISTER_MAX;
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function passwordError(pw) {
  if (!pw || typeof pw !== "string") return "missing_password";
  if (pw.length < 8) return "password_too_short";
  if (pw.length > 128) return "password_too_long";
  return null;
}

// ---------------- backup D1 → R2 + export theo user (T-25) ----------------
// Mỗi bảng 1 file NDJSON gzip tại backups/YYYY-MM-DD/<bảng>.ndjson.gz; giữ BACKUP_KEEP ngày.
const BACKUP_TABLES = ["users", "profiles", "profile_skills", "sources", "jobs", "job_matches", "applications", "application_events",
  "interviews", "prep_sessions", "prep_items", "files", "digests", "notifications", "login_failures"];
const BACKUP_KEEP = 14;
const BACKUP_PAGE = 500;
function toNdjson(rows) {
  return rows.map((r) => JSON.stringify(r) + "\n").join("");
}
// prefixes: "backups/YYYY-MM-DD/" (kể cả hôm nay) → các thư mục ngày cũ hơn `keep` ngày gần nhất.
function staleBackupDays(prefixes, keep) {
  return prefixes.filter((p) => /^backups\/\d{4}-\d{2}-\d{2}\/$/.test(p)).sort().reverse().slice(keep);
}
const gzip = (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
async function backupToR2(env) {
  const day = new Date().toISOString().slice(0, 10);
  const m = { date: day, started_at: new Date().toISOString(), tables: {}, errors: {}, deleted: [], subrequests: 0 };
  for (const t of BACKUP_TABLES) {
    try {
      const rows = [];
      for (let off = 0; ; off += BACKUP_PAGE) {
        m.subrequests++;
        const { results } = await env.DB.prepare(`SELECT * FROM ${t} LIMIT ${BACKUP_PAGE} OFFSET ?`).bind(off).all();
        if (t === "users") results.forEach((r) => { delete r.telegram_link_code; });
        rows.push(...results);
        if (results.length < BACKUP_PAGE) break;
      }
      const body = await gzip(toNdjson(rows));
      m.subrequests++;
      await env.FILES.put(`backups/${day}/${t}.ndjson.gz`, body, {
        httpMetadata: { contentType: "application/gzip" }, customMetadata: { rows: String(rows.length) },
      });
      m.tables[t] = { rows: rows.length, bytes: body.byteLength };
    } catch (e) {
      m.errors[t] = e.message;
    }
  }
  try {
    m.subrequests++;
    const list = await env.FILES.list({ prefix: "backups/", delimiter: "/" });
    for (const p of staleBackupDays(list.delimitedPrefixes, BACKUP_KEEP)) {
      m.subrequests += 2;
      const { objects } = await env.FILES.list({ prefix: p });
      await env.FILES.delete(objects.map((o) => o.key));
      m.deleted.push(p);
    }
  } catch (e) {
    m.errors._cleanup = e.message;
  }
  m.finished_at = new Date().toISOString();
  m.subrequests++;
  await env.FILES.put(`backups/${day}/manifest.json`, JSON.stringify(m), { httpMetadata: { contentType: "application/json" } });
  return m;
}
async function listBackupManifests(env) {
  const list = await env.FILES.list({ prefix: "backups/", delimiter: "/" });
  const days = list.delimitedPrefixes.sort().reverse().slice(0, BACKUP_KEEP);
  const out = [];
  for (const p of days) {
    const obj = await env.FILES.get(`${p}manifest.json`);
    out.push({ date: p.slice(8, 18), ...(obj ? await obj.json() : { error: "manifest_missing" }) });
  }
  return out;
}
async function exportUserData(env, user) {
  const u = { ...user };
  delete u.password_hash;
  delete u.password_salt;
  delete u.telegram_link_code;
  const byUser = (sql) => env.DB.prepare(sql).bind(user.id).all().then((r) => r.results);
  const { results: profileRows } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
  const profiles = [];
  for (const p of profileRows) profiles.push(await profileWithSkills(env, p));
  const applications = await byUser("SELECT a.* FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = ? ORDER BY a.created_at").then((l) => l.map(noAdminNote));
  const events = await byUser("SELECT e.* FROM application_events e JOIN applications a ON a.id = e.application_id JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = ? ORDER BY e.created_at");
  for (const a of applications) a.events = events.filter((e) => e.application_id === a.id);
  return {
    user: u,
    profiles,
    applications,
    interviews: await byUser("SELECT i.* FROM interviews i JOIN applications a ON a.id = i.application_id JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = ? ORDER BY i.scheduled_at"),
    files: await byUser("SELECT id, kind, filename, size_bytes, created_at FROM files WHERE user_id = ? ORDER BY created_at"),
    digests: await byUser("SELECT * FROM digests WHERE user_id = ? ORDER BY date"),
    notifications: await byUser("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at"),
    exported_at: new Date().toISOString(),
  };
}

// ---------------- admin CRM (SPEC 12/11 §3D) ----------------
// Gọi sau gate isOwner. Mỗi route ≤ 2 query D1; không trả password_hash/salt, token Telegram/bot, nội dung CV.
// Phân trang keyset: ?limit (1..50, mặc định 20) & ?cursor (next_cursor của trang trước) — ổn định khi có hàng mới chèn vào.
// ponytail: thứ tự cố định (mới nhất trước) vì cursor gắn với cột sort; cần sort khác thì thêm cặp (cột, cursor) riêng.
// admin_note là ghi chú nội bộ của owner: route người dùng trả SELECT * applications phải lọc qua đây.
const noAdminNote = (r) => { if (!r) return r; const { admin_note, ...rest } = r; return rest; };
const ADMIN_LIMIT_MAX = 50, ADMIN_NOTE_MAX = 2000;
const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
const parseJ = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
// ponytail: flag lọc bằng SQL chỉ có reposted/stale (xấp xỉ postingFlags); cờ khác vẫn trả trong items[].flags nhưng chưa lọc được.
const ADMIN_JOB_FLAGS = {
  reposted: "j.repost_count >= 1",
  stale: "((j.source_id IS NOT NULL AND j.source_url NOT LIKE 'manual://%' AND COALESCE(j.last_seen_at, j.first_seen_at) < ?) OR COALESCE(j.posted_at, j.first_seen_at) < ?)",
};
async function adminCrm(env, request, url, path, lang) {
  const sp = url.searchParams, t = now();
  const GET = request.method === "GET";
  if (GET) console.log("admin", path);
  const page = (sortCol) => {
    const limit = Math.min(Math.max(parseInt(sp.get("limit"), 10) || 20, 1), ADMIN_LIMIT_MAX);
    const c = sp.get("cursor");
    if (!c) return { limit, cur: null };
    const m = /^(\d{1,12}):([\w-]{1,64})$/.exec(c);
    return m ? { limit, cur: { sql: `(${sortCol}, ${sortCol.split(".")[0]}.id) < (?, ?)`, args: [Number(m[1]), m[2]] } } : { error: true };
  };
  const done = (rows, limit, key) => {
    const more = rows.length > limit, items = rows.slice(0, limit), last = items[items.length - 1];
    return { items, next_cursor: more && last ? `${last[key] ?? 0}:${last.id}` : null };
  };
  const q = (sp.get("q") || "").trim().slice(0, 100) || null;
  let m;

  if (path === "/api/admin/overview" && GET) {
    const today = Math.floor(t / 86400);
    const [a, s] = await Promise.all([
      env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users_total,
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at >= ?1) AS users_7d,
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND last_active_day >= ?2) AS active_7d,
        (SELECT json_group_object(stage, n) FROM (SELECT stage, COUNT(*) AS n FROM applications GROUP BY stage)) AS by_stage,
        (SELECT COUNT(*) FROM applications WHERE applied_at >= ?1) AS applied_7d,
        (SELECT COUNT(*) FROM interviews WHERE scheduled_at >= ?3) AS interviews_upcoming,
        (SELECT COUNT(*) FROM jobs) AS jobs_total,
        (SELECT COUNT(*) FROM jobs WHERE first_seen_at >= ?4) AS jobs_24h,
        (SELECT json_group_array(json_object('id', id, 'type', type, 'created_at', created_at, 'application_id', application_id, 'user_email', email, 'job_title', title)) FROM
          (SELECT e.id, e.type, e.created_at, e.application_id, u.email, j.title FROM application_events e JOIN applications ap ON ap.id = e.application_id
           JOIN profiles p ON p.id = ap.profile_id JOIN users u ON u.id = p.user_id JOIN jobs j ON j.id = ap.job_id ORDER BY e.created_at DESC LIMIT 20)) AS recent_events`)
        .bind(t - 7 * 86400, today - 6, t, t - 86400).first(),
      env.DB.prepare("SELECT id, type, name, is_enabled, last_run_at, last_status, last_error FROM sources ORDER BY type").all(),
    ]);
    const quota = {};
    const ql = await env.KV.list({ prefix: "quota:" });
    for (const k of ql.keys) quota[k.name] = await env.KV.get(k.name);
    let backups_last = null;
    try {
      const day = (await env.FILES.list({ prefix: "backups/", delimiter: "/" })).delimitedPrefixes.sort().pop();
      const obj = day && (await env.FILES.get(`${day}manifest.json`));
      if (day) backups_last = { date: day.slice(8, 18), ...(obj ? await obj.json() : { error: "manifest_missing" }) };
    } catch (_) { backups_last = null; }
    const st = parseJ(a.by_stage, {});
    return json({ users_total: a.users_total, users_7d: a.users_7d, active_7d: a.active_7d,
      applications_by_stage: Object.fromEntries(APP_STAGES.map((k) => [k, st[k] || 0])), applied_7d: a.applied_7d,
      interviews_upcoming: a.interviews_upcoming, jobs_total: a.jobs_total, jobs_24h: a.jobs_24h,
      sources: s.results, quota, backups_last, recent_events: parseJ(a.recent_events, []) });
  }

  if (path === "/api/admin/applications" && GET) {
    const pg = page("a.updated_at");
    if (pg.error) return json({ error: "invalid_cursor" }, 400);
    const stage = sp.get("stage") || sp.get("status");
    if (stage && !APP_STAGES.includes(stage)) return json({ error: "invalid_stage" }, 400);
    const w = [], args = [];
    if (stage) { w.push("a.stage = ?"); args.push(stage); }
    if (sp.get("user_id")) { w.push("u.id = ?"); args.push(sp.get("user_id").slice(0, 64)); }
    if (q) { w.push("(u.email LIKE ? ESCAPE '\\' OR j.title LIKE ? ESCAPE '\\' OR j.company LIKE ? ESCAPE '\\')"); args.push(likeArg(q), likeArg(q), likeArg(q)); }
    const from = "FROM applications a JOIN profiles p ON p.id = a.profile_id JOIN users u ON u.id = p.user_id JOIN jobs j ON j.id = a.job_id";
    const where = (extra) => { const all = extra ? [...w, extra] : w; return all.length ? " WHERE " + all.join(" AND ") : ""; };
    const [rows, cnt] = await Promise.all([
      env.DB.prepare(`SELECT a.id, a.stage, a.applied_at, a.next_follow_up_at, a.updated_at, a.admin_note,
          u.id AS user_id, u.email, u.name AS user_name, p.id AS profile_id, p.name AS profile_name, p.level,
          j.id AS job_id, j.title, j.company, j.location, j.source_id, j.source_url, j.company_logo_url, substr(j.jd_text, 1, 600) AS jd_head,
          (SELECT COUNT(*) FROM application_events e WHERE e.application_id = a.id) AS events_count,
          (SELECT json_object('type', e.type, 'created_at', e.created_at) FROM application_events e WHERE e.application_id = a.id ORDER BY e.created_at DESC LIMIT 1) AS last_event,
          (SELECT json_object('done', COALESCE(SUM(i.result IN ('pass','fail')), 0), 'total', COUNT(*)) FROM interviews i WHERE i.application_id = a.id) AS rounds
        ${from}${where(pg.cur && pg.cur.sql)} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`).bind(...args, ...(pg.cur ? pg.cur.args : []), pg.limit + 1).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n ${from}${where()}`).bind(...args).first(),
    ]);
    const out = done(rows.results, pg.limit, "updated_at");
    return json({ items: out.items.map((r) => ({ id: r.id, stage: r.stage, applied_at: r.applied_at, next_follow_up_at: r.next_follow_up_at, updated_at: r.updated_at,
      admin_note: r.admin_note, user: { id: r.user_id, email: r.email, name: r.user_name }, profile: { id: r.profile_id, name: r.profile_name, level: r.level },
      job: { id: r.job_id, title: r.title, company: r.company, location: r.location, source: r.source_id, source_url: r.source_url,
        work_mode: workMode(r.location, r.title, r.jd_head, r.source_id), company_logo_url: safeLogo(r.company_logo_url) },
      events_count: r.events_count, last_event: parseJ(r.last_event, null), rounds: parseJ(r.rounds, { done: 0, total: 0 }) })),
      total: cnt.n, next_cursor: out.next_cursor });
  }

  if ((m = /^\/api\/admin\/applications\/([\w-]{1,64})$/.exec(path))) {
    const id = m[1];
    if (request.method === "PATCH") {
      const b = await readBody(request);
      if (!b || typeof b !== "object" || !("admin_note" in b)) return json({ error: "admin_note_required" }, 400);
      const note = b.admin_note;
      if (note !== null && typeof note !== "string") return json({ error: "invalid_admin_note" }, 400);
      if (note && note.length > ADMIN_NOTE_MAX) return json({ error: "admin_note_too_long", max: ADMIN_NOTE_MAX }, 400);
      // không đổi stage / updated_at: ghi chú nội bộ không được xáo thứ tự kanban của người dùng
      const r = await env.DB.prepare("UPDATE applications SET admin_note = ? WHERE id = ? RETURNING id, stage, updated_at, admin_note").bind(note && note.trim() ? note : null, id).first();
      return r ? json(r) : json({ error: "application_not_found" }, 404);
    }
    if (!GET) return null;
    const r = await env.DB.prepare(`SELECT a.id, a.stage, a.note, a.admin_note, a.applied_at, a.next_follow_up_at, a.created_at, a.updated_at,
        json_object('id', u.id, 'email', u.email, 'name', u.name) AS user, json_object('id', p.id, 'name', p.name, 'level', p.level) AS profile,
        json_object('id', j.id, 'title', j.title, 'company', j.company, 'location', j.location, 'source', j.source_id, 'source_url', j.source_url, 'salary_text', j.salary_text) AS job,
        (SELECT json_group_array(json_object('id', id, 'type', type, 'payload', CASE WHEN json_valid(payload) THEN json(payload) END, 'created_at', created_at)) FROM
          (SELECT * FROM application_events WHERE application_id = a.id ORDER BY created_at, id)) AS events,
        (SELECT json_group_array(json_object('id', id, 'kind', kind, 'round_label', round_label, 'scheduled_at', scheduled_at, 'interviewer', interviewer,
            'result', result, 'note', note, 'checklist', CASE WHEN json_valid(checklist) THEN json(checklist) END, 'created_at', created_at)) FROM
          (SELECT * FROM interviews WHERE application_id = a.id ORDER BY scheduled_at = 0, scheduled_at, created_at)) AS interviews
      FROM applications a JOIN profiles p ON p.id = a.profile_id JOIN users u ON u.id = p.user_id JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`).bind(id).first();
    if (!r) return json({ error: "application_not_found" }, 404);
    for (const k of ["user", "profile", "job", "events", "interviews"]) r[k] = parseJ(r[k], k === "events" || k === "interviews" ? [] : null);
    return json(r);
  }

  if (path === "/api/admin/users" && GET) {
    const pg = page("u.created_at");
    if (pg.error) return json({ error: "invalid_cursor" }, 400);
    const w = [], args = [];
    if (q) { w.push("(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')"); args.push(likeArg(q), likeArg(q)); }
    const where = (extra) => { const all = extra ? [...w, extra] : w; return all.length ? " WHERE " + all.join(" AND ") : ""; };
    const [rows, cnt] = await Promise.all([
      env.DB.prepare(`SELECT u.id, u.email, u.name, u.created_at, u.last_active_day, u.ref_source, u.consent_cv_at, u.ai_opt_out,
          u.telegram_chat_id IS NOT NULL AS telegram_linked, u.deleted_at,
          (SELECT COUNT(*) FROM profiles p WHERE p.user_id = u.id) AS profiles_count,
          (SELECT COUNT(*) FROM profile_skills s JOIN profiles p ON p.id = s.profile_id WHERE p.user_id = u.id) AS skills_count,
          (SELECT COUNT(*) FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = u.id) AS applications_count,
          (SELECT COUNT(*) FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = u.id AND a.applied_at IS NOT NULL) AS applied_count
        FROM users u${where(pg.cur && pg.cur.sql)} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`).bind(...args, ...(pg.cur ? pg.cur.args : []), pg.limit + 1).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users u${where()}`).bind(...args).first(),
    ]);
    const out = done(rows.results, pg.limit, "created_at");
    return json({ items: out.items.map((r) => ({ ...r, ai_opt_out: r.ai_opt_out ? 1 : 0, telegram_linked: !!r.telegram_linked })), total: cnt.n, next_cursor: out.next_cursor });
  }

  if ((m = /^\/api\/admin\/users\/([\w-]{1,64})$/.exec(path)) && GET) {
    const r = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.created_at, u.last_active_day, u.ref_source, u.consent_cv_at, u.ai_opt_out,
        u.telegram_chat_id IS NOT NULL AS telegram_linked, u.digest_hour, u.deleted_at,
        (SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'level', p.level, 'target_roles', CASE WHEN json_valid(p.target_roles) THEN json(p.target_roles) END, 'locations', CASE WHEN json_valid(p.locations) THEN json(p.locations) END,
            'salary_min', p.salary_min, 'is_active', p.is_active, 'has_cv', json(CASE WHEN p.cv_file_id IS NOT NULL THEN 'true' ELSE 'false' END), 'public_slug', p.public_slug, 'created_at', p.created_at,
            'skills', (SELECT json_group_array(json_object('skill', s.skill, 'weight', s.weight, 'source', s.source)) FROM profile_skills s WHERE s.profile_id = p.id)))
          FROM profiles p WHERE p.user_id = u.id) AS profiles,
        (SELECT json_group_array(json_object('id', id, 'stage', stage, 'applied_at', applied_at, 'updated_at', updated_at, 'job', json_object('id', job_id, 'title', title, 'company', company))) FROM
          (SELECT a.id, a.stage, a.applied_at, a.updated_at, j.id AS job_id, j.title, j.company FROM applications a JOIN profiles p ON p.id = a.profile_id JOIN jobs j ON j.id = a.job_id
           WHERE p.user_id = u.id ORDER BY a.updated_at DESC LIMIT 20)) AS applications,
        (SELECT json_group_array(json_object('id', id, 'application_id', application_id, 'type', type, 'payload', CASE WHEN json_valid(payload) THEN json(payload) END, 'created_at', created_at)) FROM
          (SELECT e.* FROM application_events e JOIN applications a ON a.id = e.application_id JOIN profiles p ON p.id = a.profile_id
           WHERE p.user_id = u.id ORDER BY e.created_at DESC LIMIT 20)) AS events
      FROM users u WHERE u.id = ?`).bind(m[1]).first();
    if (!r) return json({ error: "user_not_found" }, 404);
    for (const k of ["profiles", "applications", "events"]) r[k] = parseJ(r[k], []);
    return json({ ...r, ai_opt_out: r.ai_opt_out ? 1 : 0, telegram_linked: !!r.telegram_linked });
  }

  if (path === "/api/admin/jobs" && GET) {
    const pg = page("j.first_seen_at");
    if (pg.error) return json({ error: "invalid_cursor" }, 400);
    const flag = sp.get("flag");
    if (flag && !ADMIN_JOB_FLAGS[flag]) return json({ error: "invalid_flag", allowed: Object.keys(ADMIN_JOB_FLAGS) }, 400);
    const w = [], args = [];
    if (sp.get("source")) { w.push("j.source_id = ?"); args.push(sp.get("source").slice(0, 64)); }
    if (q) { w.push("(j.title LIKE ? ESCAPE '\\' OR j.company LIKE ? ESCAPE '\\')"); args.push(likeArg(q), likeArg(q)); }
    if (flag) { w.push(ADMIN_JOB_FLAGS[flag]); if (flag === "stale") args.push(t - 48 * 3600, t - 30 * 86400); }
    const where = (extra) => { const all = extra ? [...w, extra] : w; return all.length ? " WHERE " + all.join(" AND ") : ""; };
    const [rows, cnt] = await Promise.all([
      env.DB.prepare(`SELECT j.id, j.title, j.company, j.location, j.source_id, j.source_url, j.salary_text, j.posted_at, j.first_seen_at, j.last_seen_at,
          j.seen_count, j.repost_count, CASE WHEN json_valid(j.skills) THEN json_array_length(j.skills) END AS skill_count, substr(j.jd_text, 1, 600) AS jd_head, length(j.jd_text) AS jd_len,
          (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications_count,
          (SELECT COUNT(*) FROM job_matches mm WHERE mm.job_id = j.id AND mm.tier = 'strong') AS strong_count
        FROM jobs j${where(pg.cur && pg.cur.sql)} ORDER BY j.first_seen_at DESC, j.id DESC LIMIT ?`).bind(...args, ...(pg.cur ? pg.cur.args : []), pg.limit + 1).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs j${where()}`).bind(...args).first(),
    ]);
    const out = done(rows.results, pg.limit, "first_seen_at");
    return json({ items: out.items.map((r) => ({ id: r.id, title: r.title, company: r.company, location: r.location, source: r.source_id, source_url: r.source_url,
      salary_text: r.salary_text, posted_at: r.posted_at, first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, seen_count: r.seen_count, repost_count: r.repost_count,
      jd_len: r.jd_len, work_mode: workMode(r.location, r.title, r.jd_head, r.source_id),
      flags: postingFlags({ ...r, skillCount: r.skill_count }, t, lang).map((f) => f.type),
      applications_count: r.applications_count, strong_count: r.strong_count })), total: cnt.n, next_cursor: out.next_cursor });
  }
  return null;
}

// ---------------- router ----------------
export default {
  async fetch(request, env, ctx) {
    try {
    const url = new URL(request.url);
    const path = url.pathname;
    const qlang = url.searchParams.get("lang"); // A9: web gửi ?lang để cache không trộn VI/EN
    const lang = qlang === "en" || qlang === "vi" ? qlang : /^en/i.test(request.headers.get("accept-language") || "") ? "en" : "vi";
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/api/health") {
      return json({ ok: true, service: "jobpilot-api", phase: 2, ts: new Date().toISOString(),
        bindings: { DB: !!env.DB, KV: !!env.KV, FILES: !!env.FILES, AI: !!env.AI, EMB: !!env.EMB, EVENTS: !!env.EVENTS } });
    }

    // Landing: job THẬT vừa quét chấm cho một hồ sơ mẫu cố định. Chỉ lấy link quét chuẩn của
    // ITviec/TopDev (không bao giờ là job dán tay), chỉ đọc, chỉ trả trường công khai; cache 5 phút.
    // /api/public/try: cùng đường chấm, hồ sơ do khách chọn (allow-list chặt), top 10, cache theo tham số đã chuẩn hoá.
    if ((path === "/api/public/sample" || path === "/api/public/try") && request.method === "GET") {
      const isTry = path === "/api/public/try";
      let tryP = null, cacheKey = null;
      if (isTry) {
        const skills = [...new Set((url.searchParams.get("skills") || "").split(",").map((x) => x.trim()).filter(Boolean).map(canonSkill))];
        const level = url.searchParams.get("level") || "middle", location = url.searchParams.get("location") || "Hồ Chí Minh";
        if (!skills.length || skills.length > 8 || skills.some((x) => !SKILL_CATALOG.includes(x))) return json({ error: "invalid_skills" }, 400);
        if (!["fresher", "junior", "middle", "senior"].includes(level)) return json({ error: "invalid_level" }, 400);
        if (!["Hồ Chí Minh", "Hà Nội", "Đà Nẵng", "Remote"].includes(location)) return json({ error: "invalid_location" }, 400);
        tryP = { skills: skills.sort(), level, location };
        cacheKey = new Request("https://cache.jobpilot.internal/try?" + new URLSearchParams({ s: tryP.skills.join(","), l: level, c: location, lang }));
        const hit = typeof caches !== "undefined" ? await caches.default.match(cacheKey) : null;
        if (hit) return hit;
      }
      const SCRAPED = "submitted_by IS NULL AND (source_url LIKE 'https://itviec.com/it-jobs/%' OR source_url LIKE 'https://topdev.vn/detail-jobs/%')";
      const { results } = await env.DB.prepare(
        `SELECT id, title, company, location, source_id, source_url, salary_text, skills, posted_at, first_seen_at, last_seen_at, repost_count
         FROM jobs WHERE ${SCRAPED} ORDER BY COALESCE(last_seen_at, first_seen_at) DESC LIMIT ${isTry ? 150 : 60}`
      ).all();
      const sampleProfile = isTry ? { level: tryP.level, locations: [tryP.location] } : { level: "middle", locations: ["Hồ Chí Minh", "Remote"] };
      const sampleSkills = isTry ? tryP.skills.map((skill) => ({ skill, weight: 4 })) : [
        { skill: "Java", weight: 5 }, { skill: "Spring Boot", weight: 5 }, { skill: "PostgreSQL", weight: 3 },
        { skill: "Docker", weight: 3 }, { skill: "REST APIs", weight: 3 }, { skill: "Git", weight: 2 },
      ];
      const scored = results.map((j) => {
        const job = { ...j, skills: JSON.parse(j.skills || "[]"), jd_text: "" };
        const s = scoreJob(sampleProfile, sampleSkills, job);
        const f = fitBreakdown(sampleProfile, job);
        // Landing thấy đúng thứ app thấy: cờ tín hiệu + nhãn khuyến nghị (dùng cùng hàm, không tính riêng).
        const flags = postingFlags(j, now(), lang);
        const risk = flags.filter((x) => x.type !== "duplicate").length;
        const v = verdictFor({ tier: s.tier, rule_detail: { missing: s.missing.map((m) => (typeof m === "string" ? { skill: m, weight: 3 } : m)) } }, f, flags, risk, lang);
        return {
          title: j.title, company: j.company, location: j.location, source: j.source_id, url: j.source_url,
          salary: j.salary_text, age_days: f.ageDays, score: s.finalScore, tier: s.tier,
          rule: Math.round(s.rule * 10) / 10, fit: { location: f.location, freshness: f.freshness, level: f.level, location_why: tr(lang, f.locationWhy, f.locationArg), level_why: tr(lang, f.levelWhy, f.levelArg) },
          matched: s.matched, missing: s.missing.slice(0, 6), capped: s.jobSkills.length < 3,
          flags, verdict: v.verdict, verdict_why: v.why,
        };
      }).filter((x) => x.matched.length > 0 && titleGate(x.title))
        // Ưu tiên tin đúng cấp bậc hồ sơ mẫu, rồi mới tới điểm (chỉ là thứ tự hiển thị).
        .sort((a, b) => ((a.verdict === "skip") - (b.verdict === "skip")) || (b.fit.level - a.fit.level) || (b.score - a.score));
      const stats = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM jobs WHERE ${SCRAPED}) AS jobs,
                (SELECT COUNT(*) FROM jobs WHERE ${SCRAPED} AND first_seen_at > ?) AS new_24h,
                (SELECT MAX(last_run_at) FROM sources) AS last_scan`
      ).bind(now() - 86400).first();
      const res = json({
        profile: isTry ? { level: tryP.level, location: tryP.location, skills: sampleSkills }
          : { label: tr(lang, "Backend Java · 3 năm · Hồ Chí Minh / Remote"), skills: sampleSkills },
        jobs: scored.slice(0, isTry ? 10 : 5), stats,
      });
      res.headers.set("cache-control", "public, max-age=300");
      res.headers.set("vary", "Accept-Language");
      if (isTry && typeof caches !== "undefined") (ctx && ctx.waitUntil(caches.default.put(cacheKey, res.clone())));
      return res;
    }

    // --- auth: đăng ký / đăng nhập bằng mật khẩu (thay magic-link-lite) ---
    if (path === "/api/auth/register" && request.method === "POST") {
      const body = await readBody(request);
      if (!(await verifyTurnstile(env, body.turnstile_token, request.headers.get("cf-connecting-ip")))) return json({ error: "turnstile_failed" }, 403);
      const email = (body.email || "").trim().toLowerCase();
      const name = (body.name || "").trim();
      if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
      if (name.length < 2 || name.length > 80) return json({ error: "invalid_name" }, 400);
      const pwErr = passwordError(body.password);
      if (pwErr) return json({ error: pwErr }, 400);
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      if (!(await registerAttemptAllowed(env, ip, Math.floor(now() / 3600)))) return json({ error: "too_many_registrations" }, 429); // trước khi băm
      const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (existing) return json({ error: "email_taken" }, 409);
      const rec = await makePasswordRecord(body.password);
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO users (id, email, name, timezone, digest_email, created_at, password_hash, password_salt, password_set_at, ref_source, last_active_day) VALUES (?, ?, ?, 'Asia/Saigon', ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, email, name, email, now(), rec.hash, rec.salt, now(), cleanRef(body.ref), Math.floor(now() / 86400)).run();
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      return json(await issueSession(env, user), 201);
    }
    if ((path === "/api/auth/login" || path === "/api/auth/restore") && request.method === "POST") {
      const body = await readBody(request);
      if (!(await verifyTurnstile(env, body.turnstile_token, request.headers.get("cf-connecting-ip")))) return json({ error: "turnstile_failed" }, 403);
      const email = (body.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
      if (!body.password) return json({ error: "missing_password" }, 400);
      const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
      if (!user) return json({ error: "invalid_credentials" }, 401); // email lạ: không ghi gì
      if (!user.password_hash) return json({ error: "password_setup_required" }, 403);
      if (!(await loginAttemptAllowed(env, user.id))) return json({ error: "too_many_attempts" }, 429); // trước khi băm: bị khoá thì không tốn CPU
      const ok = await verifyPassword(body.password, user.password_salt, user.password_hash);
      if (!ok) return json({ error: "invalid_credentials" }, 401);
      await env.DB.prepare("DELETE FROM login_failures WHERE user_id = ?").bind(user.id).run();
      if (path === "/api/auth/restore") { // T-24: khôi phục trong 7 ngày kể từ khi đánh dấu xoá
        if (!user.deleted_at) return json({ error: "not_deleted" }, 400);
        if (now() > user.deleted_at + DELETE_GRACE) return json({ error: "restore_expired" }, 410);
        await env.DB.prepare("UPDATE users SET deleted_at = NULL WHERE id = ?").bind(user.id).run();
      } else if (user.deleted_at) {
        return json({ error: "account_deleted", restore_until: user.deleted_at + DELETE_GRACE }, 403);
      }
      return json(await issueSession(env, user));
    }
    if (path === "/api/auth/logout" && request.method === "POST") { // T-15: thu hồi session
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
      if (!token) return json({ error: "unauthorized" }, 401);
      await env.KV.delete(`session:${token}`);
      return json({ ok: true });
    }
    if (path === "/api/auth/set-password" && request.method === "POST") {
      return json({ error: "password_setup_disabled" }, 410);
    }
    if (path === "/api/auth/reset-password" && request.method === "POST") { // T-22: token 1 lần do owner phát
      const body = await readBody(request);
      const pwErr = passwordError(body.new_password);
      if (pwErr) return json({ error: pwErr }, 400);
      const tk = typeof body.token === "string" ? body.token : "";
      const userId = tk ? await env.KV.get(`pwreset:${tk}`) : null;
      if (!userId) return json({ error: "invalid_reset_token" }, 400);
      await env.KV.delete(`pwreset:${tk}`); // xoá trước khi đổi: dùng 1 lần
      const rec = await makePasswordRecord(body.new_password);
      const r = await env.DB.prepare(
        "UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, sessions_valid_after = ? WHERE id = ? AND deleted_at IS NULL"
      ).bind(rec.hash, rec.salt, now(), Date.now(), userId).run();
      if (r.meta && r.meta.changes === 0) return json({ error: "invalid_reset_token" }, 400);
      await env.DB.prepare("DELETE FROM login_failures WHERE user_id = ?").bind(userId).run();
      return json({ ok: true });
    }

    // Webhook Telegram: không Bearer, xác thực bằng secret header; luôn 200 sau khi qua kiểm tra.
    if (path === "/api/telegram/webhook" && request.method === "POST") {
      if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "telegram_not_configured" }, 503);
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
      try { await tgHandleUpdate(env, await readBody(request), (c, t) => tgSend(env, c, t)); }
      catch (e) { console.log("telegram webhook lỗi", e.message); }
      return json({ ok: true });
    }
    // Webhook bot riêng: khoá theo bot_id trong path, secret riêng từng dòng user_bots.
    const ownHook = path.match(/^\/api\/telegram\/webhook\/(\d{6,12})$/);
    if (ownHook && request.method === "POST") {
      if (!ownBotEnabled(env)) return json({ error: "own_bot_disabled" }, 503);
      const row = await env.DB.prepare("SELECT user_id, token_enc, webhook_secret FROM user_bots WHERE bot_id = ?").bind(ownHook[1]).first();
      if (!row || !row.webhook_secret || request.headers.get("x-telegram-bot-api-secret-token") !== row.webhook_secret) return json({ error: "forbidden" }, 403);
      try { await tgHandleUpdate(env, await readBody(request), (c, t) => tgSendFor(env, row.user_id, c, t, row.token_enc), row.user_id); }
      catch (e) { console.log("telegram webhook bot riêng lỗi", e.message); }
      return json({ ok: true });
    }

    const user = await getUser(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    // T-88: ghi ngày hoạt động tối đa 1 lần/ngày/user (chỉ khi khác hôm nay), không ghi mỗi request.
    const today = Math.floor(now() / 86400);
    if (user.last_active_day !== today) {
      await env.DB.prepare("UPDATE users SET last_active_day = ? WHERE id = ?").bind(today, user.id).run();
      user.last_active_day = today;
    }

    if (path === "/api/realtime") {
      return env.USER_HUB.get(env.USER_HUB.idFromName(user.id)).fetch(request);
    }

    // Route /api/admin/* chỉ dành cho tài khoản owner.
    if (path.startsWith("/api/admin/") && !isOwner(env, user)) {
      return json({ error: "forbidden" }, 403);
    }

    if (path === "/api/me" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
      const profiles = [];
      for (const p of results) profiles.push(await profileWithSkills(env, p));
      const ownBot = await env.DB.prepare("SELECT username, status, last_error FROM user_bots WHERE user_id = ?").bind(user.id).first();
      const nf = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM notifications WHERE user_id = ?1 AND is_read = 0 LIMIT 10)) AS n, EXISTS (SELECT 1 FROM notifications WHERE user_id = ?1 AND type = 'bot_broken' AND is_read = 0) AS a").bind(user.id).first();
      return json({ user: { id: user.id, email: user.email, name: user.name, is_owner: isOwner(env, user),
        consent_cv_at: user.consent_cv_at, ai_opt_out: user.ai_opt_out ? 1 : 0, telegram_linked: !!user.telegram_chat_id,
        telegram_bot: ownBot ? { username: ownBot.username, status: ownBot.status, last_error: ownBot.last_error } : null,
        unread_count: nf.n, has_attention: !!nf.a, jobs_seen_at: user.jobs_seen_at ?? null }, profiles });
    }
    if (path === "/api/auth/change-password" && request.method === "POST") { // T-22
      const b = await readBody(request);
      const pwErr = passwordError(b.new_password);
      if (pwErr) return json({ error: pwErr }, 400);
      if (!b.current_password || typeof b.current_password !== "string" || !user.password_hash) return json({ error: "invalid_credentials" }, 401);
      if (!(await loginAttemptAllowed(env, user.id))) return json({ error: "too_many_attempts" }, 429);
      if (!(await verifyPassword(b.current_password, user.password_salt, user.password_hash))) return json({ error: "invalid_credentials" }, 401);
      const rec = await makePasswordRecord(b.new_password);
      const t0 = Date.now();
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, sessions_valid_after = ? WHERE id = ?").bind(rec.hash, rec.salt, now(), t0, user.id),
        env.DB.prepare("DELETE FROM login_failures WHERE user_id = ?").bind(user.id),
      ]);
      await env.KV.delete(`session:${request.headers.get("Authorization").slice(7)}`);
      return json(await issueSession(env, user)); // token mới (iat >= mốc) để người gọi vẫn đăng nhập
    }
    if (path === "/api/admin/password-reset" && request.method === "POST") { // T-22: owner gửi link thủ công (chưa có email)
      const email = ((await readBody(request)).email || "").trim().toLowerCase();
      const target = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL").bind(email).first();
      if (!target) return json({ error: "account_not_found" }, 404);
      const token = randomToken();
      await env.KV.put(`pwreset:${token}`, target.id, { expirationTtl: 1800 });
      return json({ link: `https://jobpilot-edge.pages.dev/?reset=${token}`, expires_in: 1800 });
    }
    // T-88: funnel closed beta, chỉ số tổng hợp theo nguồn × tuần đăng ký (không email/id). 1 query D1.
    if (path === "/api/admin/funnel" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT COALESCE(ref_source, 'direct') AS ref, strftime('%Y-W%W', created_at, 'unixepoch') AS week,
          COUNT(*) AS signups,
          SUM(EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id AND (SELECT COUNT(*) FROM profile_skills s WHERE s.profile_id = p.id) >= 3)) AS activated,
          SUM(consent_cv_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.user_id = u.id AND f.kind = 'cv')) AS cv_dropout,
          SUM(EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM profiles p JOIN profile_skills s ON s.profile_id = p.id WHERE p.user_id = u.id)) AS profile_no_skills,
          SUM(telegram_chat_id IS NOT NULL) AS telegram_linked,
          SUM(created_at / 86400 + 7 <= ?1) AS d7_eligible, SUM(created_at / 86400 + 7 <= ?1 AND last_active_day >= created_at / 86400 + 7) AS d7_retained,
          SUM(created_at / 86400 + 30 <= ?1) AS d30_eligible, SUM(created_at / 86400 + 30 <= ?1 AND last_active_day >= created_at / 86400 + 30) AS d30_retained,
          SUM(EXISTS (SELECT 1 FROM application_events e JOIN applications a ON a.id = e.application_id JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = u.id AND e.type = 'quick_apply_open')) AS quick_open,
          SUM(EXISTS (SELECT 1 FROM application_events e JOIN applications a ON a.id = e.application_id JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = u.id AND e.type = 'stage_changed' AND json_extract(e.payload, '$.via') = 'quick_apply')) AS quick_applied
        FROM users u WHERE deleted_at IS NULL GROUP BY ref, week ORDER BY week DESC, ref`).bind(today).all();
      return json({ today, rows: results });
    }
    if (path === "/api/admin/quota") {
      const out = {};
      const list = await env.KV.list({ prefix: "quota:" });
      for (const k of list.keys) out[k.name] = await env.KV.get(k.name);
      return json({ quota: out });
    }
    if (path.startsWith("/api/admin/")) { const r = await adminCrm(env, request, url, path, lang); if (r) return r; }

    // --- profiles ---
    if (path === "/api/profiles" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
      const out = [];
      for (const p of results) out.push(await profileWithSkills(env, p));
      return json(out);
    }
    if (path === "/api/profiles" && request.method === "POST") {
      const b = await readBody(request);
      if (badProfileArrays(b)) return json({ error: "invalid_profile" }, 400);
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO profiles (id, user_id, name, target_roles, level, locations, salary_min, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).bind(id, user.id, b.name || "Hồ sơ mới", JSON.stringify(b.target_roles || []), b.level || null,
        JSON.stringify(b.locations || []), b.salary_min || null, now(), now()).run();
      const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(id).first();
      await enqueueProfileScan(env, id);
      return json(await profileWithSkills(env, p), 201);
    }
    const profMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
    if (profMatch && request.method === "PATCH") {
      const b = await readBody(request);
      if (badProfileArrays(b)) return json({ error: "invalid_profile" }, 400);
      const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profMatch[1], user.id).first();
      if (!p) return json({ error: "profile_not_found" }, 404);
      await env.DB.prepare(
        "UPDATE profiles SET name = ?, target_roles = ?, level = ?, locations = ?, salary_min = ?, updated_at = ? WHERE id = ?"
      ).bind(b.name ?? p.name, JSON.stringify(b.target_roles ?? (jsonArr(p.target_roles) || [])),
        "level" in b ? (b.level || null) : p.level, JSON.stringify(b.locations ?? (jsonArr(p.locations) || [])),
        "salary_min" in b ? (b.salary_min || null) : p.salary_min, now(), p.id).run();
      // Level/locations đổi → fit đổi → chấm lại toàn bộ job cho khớp điểm lưu trữ.
      const rescoreQueued = await enqueueProfileRescore(env, p.id);
      if ("target_roles" in b) await enqueueProfileScan(env, p.id);
      const upd = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(p.id).first();
      return json({ ...(await profileWithSkills(env, upd)), rescore_queued: rescoreQueued });
    }
    const cvMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-text$/);
    if (cvMatch && request.method === "POST") return handleCvText(request, env, user, cvMatch[1]);
    const sugMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-suggest$/);
    if (sugMatch && request.method === "POST") return handleCvSuggest(request, env, user, sugMatch[1], lang);
    const cvFileMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-file$/);
    if (cvFileMatch && request.method === "POST") {
      if (+request.headers.get("content-length") > CV_MAX_BYTES) return json({ error: "file_too_large", max_bytes: CV_MAX_BYTES }, 413);
      const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(cvFileMatch[1], user.id).first();
      if (!profile) return json({ error: "profile_not_found" }, 404);
      if (!user.consent_cv_at) return json({ error: "cv_consent_required" }, 403);
      const buf = await request.arrayBuffer();
      if (buf.byteLength > CV_MAX_BYTES) return json({ error: "file_too_large", max_bytes: CV_MAX_BYTES }, 413); // client có thể bỏ header
      const filename = request.headers.get("x-filename") || "cv.pdf";
      const r2Key = `cv/${user.id}/${profile.id}-original-${Date.now()}.pdf`;
      await env.FILES.put(r2Key, buf, { httpMetadata: { contentType: "application/pdf" } });
      const fileId = uid();
      await env.DB.prepare("INSERT INTO files (id, user_id, r2_key, kind, filename, size_bytes, created_at) VALUES (?, ?, ?, 'cv', ?, ?, ?)")
        .bind(fileId, user.id, r2Key, filename, buf.byteLength, now()).run();
      return json({ file_id: fileId, size_bytes: buf.byteLength });
    }
    const skillsMatch = path.match(/^\/api\/profiles\/([^/]+)\/skills\/confirm$/);
    if (skillsMatch && request.method === "POST") {
      const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(skillsMatch[1], user.id).first();
      if (!profile) return json({ error: "profile_not_found" }, 404);
      const b = await readBody(request);
      const skills = Array.isArray(b.skills) ? b.skills : [];
      const stmts = [env.DB.prepare("DELETE FROM profile_skills WHERE profile_id = ?").bind(profile.id)];
      for (const s of skills) {
        if (!s.skill) continue;
        stmts.push(env.DB.prepare("INSERT INTO profile_skills (profile_id, skill, weight, source) VALUES (?, ?, ?, ?)")
          .bind(profile.id, canonSkill(String(s.skill)), Math.min(5, Math.max(1, s.weight || 3)), s.source || "cv"));
      }
      stmts.push(env.DB.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").bind(now(), profile.id)); // T-50: đổi kỹ năng = phiên bản mới
      await env.DB.batch(stmts);
      // chấm lại toàn bộ job hiện có cho profile này
      const rescoreQueued = await enqueueProfileRescore(env, profile.id);
      await enqueueProfileScan(env, profile.id);
      return json({ ...(await profileWithSkills(env, profile)), rescore_queued: rescoreQueued });
    }
    // Sửa từng kỹ năng (thêm/đổi trọng số/xoá): không ghi đè cả danh sách, nên client giữ bản cũ cũng không làm mất kỹ năng khác.
    const oneSkill = path.match(/^\/api\/profiles\/([^/]+)\/skills(?:\/([^/]+))?$/);
    if (oneSkill && (request.method === "POST" && !oneSkill[2] || request.method === "DELETE" && oneSkill[2])) {
      const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(oneSkill[1], user.id).first();
      if (!profile) return json({ error: "profile_not_found" }, 404);
      let stmts;
      if (request.method === "POST") {
        const b = await readBody(request);
        const skill = typeof b?.skill === "string" ? canonSkill(b.skill) : "";
        if (!skill || skill.length > 100) return json({ error: "invalid_skill" }, 400);
        const weight = Math.min(5, Math.max(1, Math.round(Number(b.weight)) || 3));
        stmts = [ // PK (profile_id, skill) phân biệt hoa thường: bỏ bản khác hoa thường trước (client cũ cũng lọc như vậy)
          env.DB.prepare("DELETE FROM profile_skills WHERE profile_id = ? AND lower(skill) = lower(?) AND skill <> ?").bind(profile.id, skill, skill),
          env.DB.prepare("INSERT INTO profile_skills (profile_id, skill, weight, source) VALUES (?, ?, ?, 'manual') ON CONFLICT(profile_id, skill) DO UPDATE SET weight = excluded.weight")
            .bind(profile.id, skill, weight),
        ];
      } else {
        let skill = "";
        try { skill = decodeURIComponent(oneSkill[2]).trim(); } catch (_) { /* %xx hỏng → 400 */ }
        if (!skill) return json({ error: "invalid_skill" }, 400);
        stmts = [env.DB.prepare("DELETE FROM profile_skills WHERE profile_id = ? AND skill = ?").bind(profile.id, skill)];
      }
      stmts.push(env.DB.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").bind(now(), profile.id)); // T-50
      await env.DB.batch(stmts);
      const rescoreQueued = await enqueueProfileRescore(env, profile.id);
      await enqueueProfileScan(env, profile.id);
      return json({ ...(await profileWithSkills(env, profile)), rescore_queued: rescoreQueued });
    }

    // --- jobs ---
    if (path === "/api/jobs" && request.method === "GET") {
      const profileId = url.searchParams.get("profile_id");
      if (profileId && !(await ownsProfile(env, user, profileId))) return json({ error: "profile_not_found" }, 404);
      const tier = url.searchParams.get("tier");
      const source = url.searchParams.get("source");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      // Phân trang: có ?limit hoặc ?offset → trả { items, total, offset, limit, next_offset }; không có → mảng như cũ (client cũ vẫn chạy).
      // ponytail: offset trên ≤ JOB_LIST_LIMIT tin đã xếp hạng; đổi sang cursor (score,id) khi danh sách vượt trần này.
      const ql = url.searchParams.get("limit"), qo = url.searchParams.get("offset");
      const paged = ql !== null || qo !== null;
      const limit = ql === null ? 50 : Number(ql), offset = qo === null ? 0 : Number(qo);
      if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100) || !(Number.isInteger(offset) && offset >= 0)) return json({ error: "invalid_query" }, 400);
      const MODES = ["remote", "hybrid", "onsite"];
      const qm = url.searchParams.get("mode"), qs = url.searchParams.get("min_salary"), qh = url.searchParams.get("has_salary");
      const modes = qm === null ? null : qm.split(",").map((x) => x.trim()).filter(Boolean);
      const minSalary = qs === null ? null : Number(qs);
      if ((modes && (!modes.length || modes.some((x) => !MODES.includes(x)))) || (qs !== null && !/^\d{1,4}$/.test(qs)) || (qh !== null && qh !== "1" && qh !== "0")) return json({ error: "invalid_query" }, 400);
      const cols = paged ? "j.id, j.source_id, j.source_url, j.title, j.company, j.location, j.salary_text, j.skills, j.posted_at, j.first_seen_at, j.last_seen_at, j.repost_count, j.company_logo_url, j.address, j.benefits, j.work_mode_src, substr(j.jd_text, 1, 600) AS jd_head" : "j.*";
      let rows;
      if (profileId) {
        const { results } = await env.DB.prepare(
          `SELECT ${cols}, m.final_score, m.tier, m.matched_skills, m.missing_skills, m.rule_score,
                  a.id AS app_id, a.stage AS app_stage
           FROM jobs j LEFT JOIN job_matches m ON m.job_id = j.id AND m.profile_id = ?
           LEFT JOIN applications a ON a.job_id = j.id AND a.profile_id = ?
           WHERE j.submitted_by IS NULL OR j.submitted_by = ?
           ORDER BY COALESCE(m.final_score, 0) DESC, j.first_seen_at DESC LIMIT ${JOB_LIST_LIMIT}`
        ).bind(profileId, profileId, user.id).all();
        rows = results;
      } else {
        const { results } = await env.DB.prepare(`SELECT ${cols}, NULL AS app_id, NULL AS app_stage FROM jobs j WHERE j.submitted_by IS NULL OR j.submitted_by = ? ORDER BY j.first_seen_at DESC LIMIT ${JOB_LIST_LIMIT}`).bind(user.id).all();
        rows = results;
      }
      // Phase 2 — flags + giải thích điểm (tính trực tiếp, không cần chấm lại)
      let prof = null; const skillW = new Map();
      if (profileId) {
        const prow = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(profileId).first();
        if (prow) {
          prof = { ...prow, locations: jsonArr(prow.locations) || [] };
          const { results: sk } = await env.DB.prepare("SELECT skill, weight FROM profile_skills WHERE profile_id = ?").bind(profileId).all();
          sk.forEach((s) => skillW.set(String(s.skill).toLowerCase(), s.weight));
        }
      }
      const normKey = (r) => `${String(r.company || "").toLowerCase().replace(/\s+/g, " ").trim()}|${String(r.title || "").toLowerCase().replace(/[^a-z0-9à-ỹ\s]/gi, "").replace(/\s+/g, " ").trim()}`;
      const keyCount = new Map(), keyFirst = new Map();
      for (const r of rows) {
        const k = normKey(r);
        keyCount.set(k, (keyCount.get(k) || 0) + 1);
        if (!keyFirst.has(k) || (r.first_seen_at || 0) < keyFirst.get(k)) keyFirst.set(k, r.first_seen_at || 0);
      }
      // Lọc trước khi tính giải thích điểm: chỉ tin được trả mới cần JD và fitBreakdown.
      if (tier) rows = rows.filter((r) => r.final_score !== null && r.final_score !== undefined && r.tier === tier);
      if (source) rows = rows.filter((r) => (r.source_id || "").includes(source));
      if (q) rows = rows.filter((r) => `${r.title} ${r.company}`.toLowerCase().includes(q));
      rows = rows.map((r) => { const sv = salaryVND(r.salary_text); return { ...r, salary_vnd_min: sv.min, salary_vnd_max: sv.max, work_mode: workMode(r.location, r.title, r.jd_head ?? r.jd_text, r.source_id, r.work_mode_src) }; });
      if (modes) rows = rows.filter((r) => modes.includes(r.work_mode));
      if (qh === "1") rows = rows.filter((r) => r.salary_vnd_max !== null);
      if (minSalary !== null) rows = rows.filter((r) => r.salary_vnd_max === null || r.salary_vnd_max >= minSalary * 1e6);
      const explain = (r) => {
        const skillsArr = JSON.parse(r.skills || "[]");
        const flags = postingFlags({ ...r, skillCount: skillsArr.length, dup: (keyCount.get(normKey(r)) || 0) > 1 && r.first_seen_at !== keyFirst.get(normKey(r)) }, now(), lang);
        const risk = flags.filter((f) => f.type !== "duplicate").length;
        let fit = null, ruleDetail = null;
        const hasMatch = r.final_score !== null && r.final_score !== undefined;
        if (prof && hasMatch) {
          fit = fitBreakdown(prof, { title: r.title, location: r.location, posted_at: r.posted_at, first_seen_at: r.first_seen_at, jd_text: jdOf(r) || r.jd_head || "" });
          fit.locationWhy = tr(lang, fit.locationWhy, fit.locationArg); fit.levelWhy = tr(lang, fit.levelWhy, fit.levelArg);
          const matched = JSON.parse(r.matched_skills || "[]");
          const missing = JSON.parse(r.missing_skills || "[]");
          let totalW = 0;
          const matchedW = matched.map((s) => { const w = skillW.get(String(s).toLowerCase()) || 3; totalW += w; return { skill: s, weight: w }; });
          const missingW = missing.map((s) => { totalW += 3; return { skill: s, weight: 3 }; });
          const jobSkillCount = new Set([...skillsArr.map((s) => String(s).toLowerCase()), ...extractSkillsFromText(jdOf(r)).map((s) => s.toLowerCase())]).size;
          ruleDetail = { matched: matchedW, missing: missingW, total_weight: totalW, rule_score: r.rule_score, capped: jobSkillCount < 3 };
        }
        const vd = hasMatch ? verdictFor({ tier: r.tier, rule_detail: ruleDetail }, fit, flags, risk, lang) : null;
        return { skillsArr, flags, risk, fit, ruleDetail, hasMatch, vd };
      };
      // A4: tin "skip" xếp sau apply/apply_if, trước tin chưa chấm (sort ổn định, giữ thứ tự điểm trong mỗi nhóm), trước khi phân trang.
      // Nhãn tính ở JS (cần fitBreakdown) nên không làm bằng ORDER BY. ponytail: bản phân trang xét trên jd_head 600 ký tự;
      // khoá vùng nằm sâu hơn trong JD thì nhãn trang có thể là skip mà vẫn đứng trên. Lưu verdict vào job_matches khi chấm nếu cần chặt.
      const explained = new Map(); // N1: dùng lại ở out; bản phân trang tính lại cho tin trong trang vì vừa nạp jd_text đầy đủ
      if (prof) rows = rows.map((r) => { const e = explain(r); explained.set(r.id, e); const v = e.vd; return [r, !v ? 2 : v.verdict === "skip" ? 1 : 0]; }).sort((a, b) => a[1] - b[1]).map((x) => x[0]); // tin chưa chấm vẫn cuối
      const total = rows.length;
      if (paged) {
        rows = rows.slice(offset, offset + limit);
        if (rows.length) { // jd_text là cột nặng nhất: chỉ đọc cho tin trong trang
          const { results: jds } = await env.DB.prepare(`SELECT id, jd_text FROM jobs WHERE id IN (${rows.map(() => "?").join(",")})`).bind(...rows.map((r) => r.id)).all();
          const jdMap = new Map(jds.map((x) => [x.id, x.jd_text]));
          rows = rows.map((r) => ({ ...r, jd_text: jdMap.get(r.id) ?? null }));
        }
      }
      const out = rows.map((r) => {
        const { skillsArr, flags, risk, fit, ruleDetail, hasMatch, vd } = (!paged && explained.get(r.id)) || explain(r);
        return {
          id: r.id, title: r.title, company: r.company, location: r.location,
          source_url: r.source_url, source: r.source_id, salary_text: r.salary_text,
          salary_vnd_min: r.salary_vnd_min, salary_vnd_max: r.salary_vnd_max, work_mode: r.work_mode,
          work_mode_source: r.work_mode ? (r.work_mode === r.work_mode_src ? "source" : "inferred") : null,
          company_logo_url: safeLogo(r.company_logo_url), address: r.address || null, benefits: parseBenefits(r.benefits),
          skills: skillsArr, jd_len: jdOf(r).length,
          posted_at: r.posted_at, first_seen_at: r.first_seen_at,
          flags, risk,
          match: hasMatch ? {
            final_score: r.final_score, tier: r.tier, rule_score: r.rule_score,
            matched_skills: JSON.parse(r.matched_skills || "[]"),
            missing_skills: JSON.parse(r.missing_skills || "[]"),
            fit, rule_detail: ruleDetail,
          } : null,
          application: r.app_id ? { id: r.app_id, stage: r.app_stage } : null,
          verdict: vd ? vd.verdict : null, verdict_why: vd ? vd.why : null,
        };
      });
      if (!paged) return json(out);
      return json({ items: out, total, offset, limit, next_offset: offset + out.length < total ? offset + out.length : null });
    }
    if (path === "/api/jobs/submit" && request.method === "POST") {
      const b = await readBody(request);
      const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
      const isHttpUrl = (v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch (_) { return false; } };
      const link = str(b.url, 2000), srcLink = str(b.source_url, 2000);
      if (link && !isHttpUrl(link)) return json({ error: "invalid_url" }, 400);
      if (srcLink && !isHttpUrl(srcLink)) return json({ error: "invalid_url" }, 400);
      if (!link && !str(b.title, 300)) return json({ error: "nothing_to_submit" }, 400);
      if (!(await verifyTurnstile(env, b.turnstile_token, request.headers.get("cf-connecting-ip")))) return json({ error: "turnstile_failed" }, 403);
      // T-05: 20 job dán tay / giờ / người, đếm trên D1.
      const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM jobs WHERE submitted_by = ? AND created_at > ?")
        .bind(user.id, now() - 3600).first();
      if (recent.c >= 20) return json({ error: "too_many_submissions" }, 429);
      // Review T-103 (M1): dán lại cùng link/tiêu đề → trả dòng cũ, không fetch, không chấm lại.
      const dupUrl = link || srcLink || `manual://${await sha256hex(str(b.title, 300) + str(b.company, 200))}`;
      const dup = await env.DB.prepare("SELECT id, title, company FROM jobs WHERE submitted_by = ? AND source_url = ?").bind(user.id, dupUrl).first();
      if (dup) return json({ job: dup, created: false });
      await ensureSources(env);
      let job = null;
      if (link) {
        const host = new URL(link).hostname;
        const sourceType = /(^|\.)topdev\.vn$/.test(host) ? "topdev" : /(^|\.)itviec\.com$/.test(host) ? "itviec" : "manual";
        const src = await env.DB.prepare("SELECT * FROM sources WHERE type = ?").bind(sourceType === "manual" ? "topdev" : sourceType).first();
        let jdText = str(b.jd_text, 8000), title = str(b.title, 300), company = str(b.company, 200);
        if (!jdText) {
          try {
            const html = await fetchSubmittedPage(link);
            if (html) {
              jdText = stripTags(html).slice(0, 8000);
              const tm = html.match(/<title>([^<]+)<\/title>/i);
              if (!title && tm) title = tm[1].split("|")[0].split(" - ")[0].trim().slice(0, 300);
            }
          } catch (e) { /* giữ jd rỗng nếu fetch lỗi */ }
        }
        job = await upsertJob(env, sourceType === "manual" ? null : src?.id || null, {
          title: title || "Tin không tiêu đề", company, location: str(b.location, 200),
          url: link, jdText, skills: extractSkillsFromText(jdText),
          postedAt: null, salaryText: str(b.salary_text, 100) || null,
        }, user.id);
      } else {
        const title = str(b.title, 300), company = str(b.company, 200), jdText = str(b.jd_text, 8000);
        job = await upsertJob(env, null, {
          title, company, location: str(b.location, 200),
          url: srcLink || `manual://${await sha256hex(title + company)}`,
          jdText, skills: extractSkillsFromText(jdText),
          postedAt: null, salaryText: str(b.salary_text, 100) || null,
        }, user.id);
      }
      if (!job) return json({ error: "nothing_to_submit" }, 400);
      await env.Q_SCORE.send({ kind: "score", jobId: job.id });
      return json({ job: { id: job.id, title: job.title, company: job.company }, created: true }, 201);
    }
    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === "GET") {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND (submitted_by IS NULL OR submitted_by = ?)").bind(jobMatch[1], user.id).first();
      if (!job) return json({ error: "job_not_found" }, 404);
      const { results: matches } = await env.DB.prepare("SELECT m.* FROM job_matches m JOIN profiles p ON p.id = m.profile_id WHERE m.job_id = ? AND p.user_id = ?").bind(job.id, user.id).all();
      return json({ ...job, skills: JSON.parse(job.skills || "[]"), matches });
    }

    // --- applications (kanban) ---
    if (path === "/api/applications" && request.method === "GET") {
      const profileId = url.searchParams.get("profile_id");
      if (!profileId) return json({ error: "profile_id_required" }, 400);
      if (!(await ownsProfile(env, user, profileId))) return json({ error: "profile_not_found" }, 404);
      // T-37: vòng phỏng vấn gói trong cùng 1 truy vấn (subquery theo idx_interviews_app, không N+1).
      const sql = `SELECT a.*, j.title, j.company, j.location, j.source_url, m.final_score, m.tier,
             (SELECT json_object('id', i.id, 'kind', i.kind, 'round_label', i.round_label, 'scheduled_at', i.scheduled_at) FROM interviews i
               WHERE i.application_id = a.id AND i.scheduled_at > ? ORDER BY i.scheduled_at LIMIT 1) AS next_iv,
             (SELECT json_object('done', COALESCE(SUM(i.result IN ('pass','fail')), 0), 'total', COUNT(*)) FROM interviews i WHERE i.application_id = a.id) AS rounds
           FROM applications a JOIN jobs j ON j.id = a.job_id
           LEFT JOIN job_matches m ON m.job_id = a.job_id AND m.profile_id = a.profile_id
           WHERE a.profile_id = ? ORDER BY a.updated_at DESC LIMIT 500`;
      const t = now(), W = 7 * 86400;
      const { results } = await env.DB.prepare(sql).bind(t, profileId).all();
      const cnt = (st, a, b) => `SUM(CASE WHEN stage = '${st}' AND updated_at >= ${a} AND updated_at < ${b} THEN 1 ELSE 0 END)`;
      const range = (a, b) => `SELECT ${cnt("applied", a, b)} AS applied, ${cnt("interview", a, b)} AS interview, ${cnt("offer", a, b)} AS offer, ${cnt("rejected", a, b)} AS rejected FROM applications WHERE profile_id = ?`;
      const [cur, prev, sil] = await Promise.all([
        env.DB.prepare(range(t - W, t + 1)).bind(profileId).first(),
        env.DB.prepare(range(t - 2 * W, t - W)).bind(profileId).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE profile_id = ? AND stage IN ('applied','interview') AND updated_at < ?").bind(profileId, t - AUTO_CLOSE_DAYS * 86400).first(),
      ]);
      const z = (o) => ({ applied: o?.applied || 0, interview: o?.interview || 0, offer: o?.offer || 0, rejected: o?.rejected || 0 });
      const stats = { ...z(cur), silent_14d: sil?.n || 0, prev: z(prev) };
      const items = results.map((r) => ({
        id: r.id, profile_id: r.profile_id, job_id: r.job_id, stage: r.stage,
        note: r.note, applied_at: r.applied_at, next_follow_up_at: r.next_follow_up_at,
        updated_at: r.updated_at,
        job: { id: r.job_id, title: r.title, company: r.company, location: r.location, source_url: r.source_url },
        match: r.final_score !== null && r.final_score !== undefined ? { final_score: r.final_score, tier: r.tier } : null,
        next_interview: r.next_iv ? JSON.parse(r.next_iv) : null,
        rounds: r.rounds ? JSON.parse(r.rounds) : { done: 0, total: 0 },
      }));
      // Mặc định trả mảng như trước (SPA cũ/Worker cũ lệch phiên bản vẫn chạy); ?stats=1 mới bọc {items, stats}.
      return json(url.searchParams.get("stats") === "1" ? { items, stats } : items);
    }
    if (path === "/api/applications" && request.method === "POST") {
      const b = await readBody(request);
      if (!(await ownsProfile(env, user, b.profile_id))) return json({ error: "profile_not_found" }, 404);
      if (b.stage !== undefined && !APP_STAGES.includes(b.stage)) return json({ error: "invalid_stage" }, 400);
      const visible = await env.DB.prepare("SELECT id FROM jobs WHERE id = ? AND (submitted_by IS NULL OR submitted_by = ?)").bind(b.job_id, user.id).first();
      if (!visible) return json({ error: "job_not_found" }, 404);
      const id = uid(), t = now(), stage = b.stage || "new";
      // Đơn đã có (client cũ/2 tab) mà stage đổi: ghi event trước khi UPSERT đổi stage.
      const res = await env.DB.batch([
        env.DB.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) SELECT ?, id, 'stage_changed', json_object('from', stage, 'to', ?), ? FROM applications WHERE profile_id = ? AND job_id = ? AND stage != ?")
          .bind(uid(), stage, t, b.profile_id, b.job_id, stage),
        env.DB.prepare(
          "INSERT INTO applications (id, profile_id, job_id, stage, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, job_id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at"
        ).bind(id, b.profile_id, b.job_id, stage, b.note || null, t, t),
        env.DB.prepare("SELECT * FROM applications WHERE profile_id = ? AND job_id = ?").bind(b.profile_id, b.job_id),
      ]);
      return json(noAdminNote(res[2].results[0]), 201);
    }
    // Nộp nhanh: JobPilot không nộp hộ. "open" = người dùng mở trang ứng tuyển thật (lưu 'saved' nếu chưa có, không đổi stage cũ);
    // "applied" = người dùng xác nhận đã nộp: chỉ nâng new/saved/chưa có lên 'applied', không hạ stage cao hơn. 1 batch D1.
    if (path === "/api/applications/quick" && request.method === "POST") {
      const b = await readBody(request);
      if (!(await ownsProfile(env, user, b.profile_id))) return json({ error: "profile_not_found" }, 404);
      const visible = await env.DB.prepare("SELECT id FROM jobs WHERE id = ? AND (submitted_by IS NULL OR submitted_by = ?)").bind(b.job_id, user.id).first();
      if (!visible) return json({ error: "job_not_found" }, 404);
      if (b.action !== "open" && b.action !== "applied") return json({ error: "invalid_action" }, 400);
      const id = uid(), t = now(), key = [b.profile_id, b.job_id];
      const ins = (stage) => env.DB.prepare("INSERT INTO applications (id, profile_id, job_id, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, job_id) DO NOTHING").bind(id, ...key, stage, t, t);
      const sel = env.DB.prepare("SELECT * FROM applications WHERE profile_id = ? AND job_id = ?").bind(...key);
      const stmts = b.action === "open" ? [ins("saved"),
        env.DB.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) SELECT ?, id, 'quick_apply_open', '{}', ? FROM applications WHERE profile_id = ? AND job_id = ?").bind(uid(), t, ...key),
        sel] : [ins("new"),
        // Event chèn trước UPDATE vì UPDATE đổi stage; from = null khi hàng vừa được tạo (trước đó chưa có).
        env.DB.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) SELECT ?, id, 'stage_changed', json_object('from', CASE WHEN id = ? THEN NULL ELSE stage END, 'to', 'applied', 'via', 'quick_apply'), ? FROM applications WHERE profile_id = ? AND job_id = ? AND stage IN ('new','saved')").bind(uid(), id, t, ...key),
        env.DB.prepare("UPDATE applications SET stage = 'applied', applied_at = COALESCE(applied_at, ?), next_follow_up_at = COALESCE(next_follow_up_at, ?), updated_at = ? WHERE profile_id = ? AND job_id = ? AND stage IN ('new','saved')").bind(t, t + 7 * 86400, t, ...key),
        sel];
      const res = await env.DB.batch(stmts);
      return json(noAdminNote(res[res.length - 1].results[0]));
    }
    const appMatch = path.match(/^\/api\/applications\/([^/]+)$/);
    if (appMatch && request.method === "PATCH") {
      const b = await readBody(request);
      const app = await env.DB.prepare("SELECT a.* FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE a.id = ? AND p.user_id = ?").bind(appMatch[1], user.id).first();
      if (!app) return json({ error: "application_not_found" }, 404);
      if (b.stage !== undefined && !APP_STAGES.includes(b.stage)) return json({ error: "invalid_stage" }, 400);
      const stage = b.stage ?? app.stage;
      const appliedAt = stage === "applied" && !app.applied_at ? now() : app.applied_at;
      await env.DB.prepare("UPDATE applications SET stage = ?, note = ?, next_follow_up_at = ?, applied_at = ?, updated_at = ? WHERE id = ?")
        .bind(stage, b.note ?? app.note, "next_follow_up_at" in b ? (b.next_follow_up_at || null) : app.next_follow_up_at, appliedAt, now(), app.id).run();
      await env.DB.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) VALUES (?, ?, 'stage_changed', ?, ?)")
        .bind(uid(), app.id, JSON.stringify({ from: app.stage, to: stage }), now()).run();
      const upd = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(app.id).first();
      return json(noAdminNote(upd));
    }

    // --- vòng phỏng vấn (T-37). Sở hữu: interview → application → profile → user; sai chủ = 404. ---
    const ivAppMatch = path.match(/^\/api\/applications\/([^/]+)\/interviews$/);
    if (ivAppMatch && (request.method === "GET" || request.method === "POST")) {
      const app = await env.DB.prepare("SELECT a.id, a.stage FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE a.id = ? AND p.user_id = ?").bind(ivAppMatch[1], user.id).first();
      if (!app) return json({ error: "application_not_found" }, 404);
      if (request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM interviews WHERE application_id = ? ORDER BY scheduled_at = 0, scheduled_at, created_at").bind(app.id).all();
        return json(results.map(ivRow));
      }
      const b = await readBody(request);
      if (!b || typeof b !== "object" || !("kind" in b)) return json({ error: "invalid_kind" }, 400);
      for (const k of ["result", "checklist"]) delete b[k]; // POST tạo vòng mới: luôn pending + checklist mặc định
      const { error, f } = ivFields(b);
      if (error) return json({ error }, 400);
      const id = uid(), t = now();
      const res = await env.DB.batch([
        env.DB.prepare("INSERT INTO interviews (id, application_id, kind, round_label, scheduled_at, result, note, checklist, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
          .bind(id, app.id, f.kind, f.round_label || IV_KINDS[f.kind][0], f.scheduled_at || 0, f.note || null, JSON.stringify(IV_KINDS[f.kind][1].map((text) => ({ text, done: false }))), t),
        // Event chèn trước UPDATE vì UPDATE đổi stage. Chỉ nâng new/saved/applied, không bao giờ hạ.
        env.DB.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) SELECT ?, id, 'stage_changed', json_object('from', stage, 'to', 'interview', 'via', 'interview_added'), ? FROM applications WHERE id = ? AND stage IN ('new','saved','applied')").bind(uid(), t, app.id),
        env.DB.prepare("UPDATE applications SET stage = 'interview', updated_at = ? WHERE id = ? AND stage IN ('new','saved','applied')").bind(t, app.id),
        env.DB.prepare("SELECT * FROM interviews WHERE id = ?").bind(id),
      ]);
      return json(ivRow(res[3].results[0]), 201);
    }
    const ivMatch = path.match(/^\/api\/interviews\/([^/]+)$/);
    if (ivMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      const iv = await env.DB.prepare(`SELECT id FROM interviews WHERE id = ? AND application_id IN (${IV_OWNED})`).bind(ivMatch[1], user.id).first();
      if (!iv) return json({ error: "interview_not_found" }, 404);
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM interviews WHERE id = ?").bind(iv.id).run();
        return json({ ok: true });
      }
      const { error, f } = ivFields(await readBody(request));
      if (error) return json({ error }, 400);
      const keys = Object.keys(f); // chỉ khoá đã qua ivFields (whitelist), an toàn để ghép tên cột
      const row = keys.length
        ? await env.DB.prepare(`UPDATE interviews SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`).bind(...keys.map((k) => f[k]), iv.id).first()
        : await env.DB.prepare("SELECT * FROM interviews WHERE id = ?").bind(iv.id).first();
      return json(ivRow(row));
    }

    // --- privacy (T-62 + T-24): đồng ý tải CV, tắt AI, xoá CV, xoá tài khoản ---
    if (path === "/api/me/consent" && request.method === "POST") {
      const b = await readBody(request);
      if (b.kind !== "cv") return json({ error: "unknown_consent" }, 400);
      const r = await env.DB.prepare("UPDATE users SET consent_cv_at = COALESCE(consent_cv_at, ?) WHERE id = ? RETURNING consent_cv_at")
        .bind(now(), user.id).first();
      return json({ consent_cv_at: r.consent_cv_at });
    }
    if (path === "/api/me/telegram/link" && request.method === "POST") {
      // Bot riêng đang ok → deeplink tới bot đó, không cần cấu hình bot chung.
      const own = ownBotEnabled(env) ? await env.DB.prepare("SELECT username FROM user_bots WHERE user_id = ? AND status = 'ok'").bind(user.id).first() : null;
      if (!own && (!env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_WEBHOOK_SECRET)) return json({ error: "telegram_not_configured" }, 503);
      const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", rnd = crypto.getRandomValues(new Uint8Array(8));
      const code = [...rnd].map((b) => a[b % a.length]).join("");
      await env.KV.put(`tglink:${code}`, user.id, { expirationTtl: 900 });
      await env.DB.prepare("UPDATE users SET telegram_link_code = NULL WHERE id = ?").bind(user.id).run(); // dọn mã cũ còn sót trong cột
      const bot = own ? own.username : env.TELEGRAM_BOT_USERNAME || "";
      return json({ code, bot, deeplink: `https://t.me/${bot}?start=${code}` });
    }
    // Bot Telegram riêng: GET xem, PUT gắn/đổi token, POST check kiểm lại, DELETE gỡ. Không bao giờ trả token.
    if (path === "/api/me/telegram/bot" || path === "/api/me/telegram/bot/check") {
      const isCheck = path.endsWith("/check");
      const allowed = isCheck ? ["POST"] : ["GET", "PUT", "DELETE"];
      if (allowed.includes(request.method)) {
        if (!ownBotEnabled(env)) return json({ error: "own_bot_disabled" }, 503);
        if (request.method === "GET") return json(await ownBotView(env, user.id));
        if (request.method === "DELETE") {
          const row = await env.DB.prepare("SELECT token_enc FROM user_bots WHERE user_id = ?").bind(user.id).first();
          if (row) {
            try { await tgApi(env, await tgDecrypt(env, row.token_enc, user.id), "deleteWebhook", {}); } catch (_) { /* best-effort */ }
          }
          await env.DB.batch([
            env.DB.prepare("DELETE FROM user_bots WHERE user_id = ?").bind(user.id),
            env.DB.prepare("UPDATE users SET telegram_chat_id = NULL WHERE id = ?").bind(user.id),
          ]);
          return json({ ok: true });
        }
        if (!(await ownBotAttempt(env, user.id))) return json({ error: "too_many_attempts" }, 429);
        if (isCheck) {
          const row = await env.DB.prepare("SELECT * FROM user_bots WHERE user_id = ?").bind(user.id).first();
          if (!row) return json({ error: "own_bot_not_configured" }, 404);
          let status = "ok", lastError = null;
          try {
            const token = await tgDecrypt(env, row.token_enc, user.id);
            const me = await tgApi(env, token, "getMe");
            if (!me.ok) { status = "broken"; lastError = "token_revoked"; }
            else {
              const info = await tgApi(env, token, "getWebhookInfo");
              const want = `${url.origin}/api/telegram/webhook/${row.bot_id}`;
              if (!info.ok || info.result.url !== want) { status = "broken"; lastError = "webhook_mismatch"; }
              else if (info.result.last_error_message) lastError = String(info.result.last_error_message).slice(0, 200);
            }
          } catch (e) { status = "broken"; lastError = "check_failed"; }
          await env.DB.prepare("UPDATE user_bots SET status = ?, last_error = ?, checked_at = ? WHERE user_id = ?").bind(status, lastError, now(), user.id).run();
          return json(await ownBotView(env, user.id));
        }
        // PUT {token}
        const token = String((await readBody(request)).token || "").trim();
        if (!TG_TOKEN_RE.test(token)) return json({ error: "invalid_token_format" }, 400);
        const me = await tgApi(env, token, "getMe").catch(() => ({ ok: false }));
        if (!me.ok || !me.result || !me.result.username) return json({ error: "token_rejected" }, 400);
        const botId = token.split(":")[0];
        const owner = await env.DB.prepare("SELECT user_id FROM user_bots WHERE bot_id = ?").bind(botId).first();
        if (owner && owner.user_id !== user.id) return json({ error: "bot_in_use" }, 409);
        const secret = randomToken().slice(0, 32);
        const hook = `${url.origin}/api/telegram/webhook/${botId}`;
        const set = await tgApi(env, token, "setWebhook", { url: hook, secret_token: secret, allowed_updates: ["message"] }).catch(() => ({ ok: false }));
        const info = set.ok ? await tgApi(env, token, "getWebhookInfo").catch(() => ({ ok: false })) : { ok: false };
        if (!info.ok || !info.result || info.result.url !== hook) return json({ error: "webhook_failed" }, 400);
        const prev = await env.DB.prepare("SELECT bot_id FROM user_bots WHERE user_id = ?").bind(user.id).first();
        const stmts = [env.DB.prepare(
          `INSERT INTO user_bots (user_id, bot_id, username, token_enc, webhook_secret, status, last_error, created_at, checked_at) VALUES (?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET bot_id = excluded.bot_id, username = excluded.username, token_enc = excluded.token_enc,
             webhook_secret = excluded.webhook_secret, status = 'ok', last_error = NULL, checked_at = excluded.checked_at`
        ).bind(user.id, botId, me.result.username, await tgEncrypt(env, token, user.id), secret, now(), now())];
        // Đổi sang bot khác (hoặc lần đầu chuyển từ bot chung): chat cũ không nhận được từ bot mới → phải /start lại.
        if (!prev || prev.bot_id !== botId) stmts.push(env.DB.prepare("UPDATE users SET telegram_chat_id = NULL WHERE id = ?").bind(user.id));
        try { await env.DB.batch(stmts); } catch (e) {
          if (!/UNIQUE/i.test(String(e && e.message))) throw e;
          // Hai người PUT cùng token đồng thời: người thua nhận 409, nhưng setWebhook của họ đã ghi đè secret của chủ bot
          // → đặt lại webhook bằng secret đang lưu của chủ bot; không được thì đánh dấu broken để chủ bot bấm Kiểm tra lại.
          const win = await env.DB.prepare("SELECT user_id, webhook_secret FROM user_bots WHERE bot_id = ?").bind(botId).first();
          if (win) {
            const re = await tgApi(env, token, "setWebhook", { url: hook, secret_token: win.webhook_secret, allowed_updates: ["message"] }).catch(() => ({ ok: false }));
            if (!re.ok) await env.DB.prepare("UPDATE user_bots SET status = 'broken', last_error = 'webhook_mismatch' WHERE user_id = ?").bind(win.user_id).run();
          }
          return json({ error: "bot_in_use" }, 409);
        }
        return json({ ok: true, bot_username: me.result.username });
      }
    }
    if (path === "/api/me/telegram" && request.method === "DELETE") {
      await env.DB.prepare("UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = ?").bind(user.id).run();
      return json({ ok: true });
    }
    if (path === "/api/me" && request.method === "PATCH") {
      const b = await readBody(request);
      if (b.jobs_seen !== undefined && b.jobs_seen !== true) return json({ error: "invalid_jobs_seen" }, 400);
      if ((b.ai_opt_out !== undefined || b.jobs_seen !== true) && ![0, 1, true, false].includes(b.ai_opt_out)) return json({ error: "invalid_ai_opt_out" }, 400);
      const out = {}, stmts = [];
      if (b.ai_opt_out !== undefined) { out.ai_opt_out = b.ai_opt_out ? 1 : 0; stmts.push(env.DB.prepare("UPDATE users SET ai_opt_out = ? WHERE id = ?").bind(out.ai_opt_out, user.id)); }
      if (b.jobs_seen) { out.jobs_seen_at = now(); stmts.push(env.DB.prepare("UPDATE users SET jobs_seen_at = ? WHERE id = ?").bind(out.jobs_seen_at, user.id)); } // giờ do server đặt
      await env.DB.batch(stmts);
      return json(out);
    }
    if (path === "/api/me" && request.method === "DELETE") {
      const b = await readBody(request);
      if (!b.password || !(await verifyPassword(b.password, user.password_salt, user.password_hash))) return json({ error: "invalid_credentials" }, 401);
      await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(now(), user.id).run();
      await env.KV.delete(`session:${request.headers.get("Authorization").slice(7)}`);
      return json({ ok: true, restore_until: now() + DELETE_GRACE });
    }
    const cvDelMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv$/);
    if (cvDelMatch && request.method === "DELETE") {
      const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(cvDelMatch[1], user.id).first();
      if (!profile) return json({ error: "profile_not_found" }, 404);
      return json({ ok: true, deleted_files: await deleteProfileCv(env, profile) });
    }

    // --- ingest admin + digest ---
    if (path === "/api/admin/jd/enrich" && request.method === "POST") {
      const b = await readBody(request);
      return json(await enrichJd(env, Math.min(Math.max(Number(b.limit) || 8, 1), 20)));
    }
    if (path === "/api/admin/ingest/run" && request.method === "POST") {
      await ensureSources(env);
      const b = await readBody(request);
      const types = Array.isArray(b.sources) && b.sources.length ? b.sources : ["topdev", "itviec", ...Object.keys(REMOTE_FETCHERS)];
      let queued = 0;
      const keywords = await ingestKeywords(env);
      for (const t of types) {
        for (const kw of REMOTE_FETCHERS[t] ? ["*"] : keywords) { await env.Q_INGEST.send({ kind: "ingest", sourceType: t, keyword: kw }); queued++; }
      }
      return json({ queued });
    }
    if (path === "/api/admin/ingest/status") {
      const { results } = await env.DB.prepare("SELECT type, name, last_run_at, last_status, last_error FROM sources ORDER BY type").all();
      return json(results);
    }

    // --- export theo user + backup admin (T-25) ---
    if (path === "/api/me/export" && request.method === "GET") {
      return new Response(JSON.stringify(await exportUserData(env, user)), {
        headers: { ...CORS, "content-type": "application/json", "content-disposition": `attachment; filename="jobpilot-export-${new Date().toISOString().slice(0, 10)}.json"` },
      });
    }
    if (path === "/api/admin/backups" && request.method === "GET") {
      return json(await listBackupManifests(env));
    }
    if (path === "/api/admin/backups/run" && request.method === "POST") {
      return json(await backupToR2(env));
    }

    if (path === "/api/digest/today") {
      const pid = url.searchParams.get("profile_id");
      if (pid && !(await ownsProfile(env, user, pid))) return json({ error: "profile_not_found" }, 404);
      return json(await buildDigest(env, user, lang, pid || null));
    }
    if (path === "/api/notifications/read" && request.method === "POST") {
      const b = await readBody(request);
      const ids = b && Array.isArray(b.ids) && b.ids.length >= 1 && b.ids.length <= 50 && b.ids.every((x) => typeof x === "string" && x.length <= 64) ? b.ids : null;
      if (!ids && !(b && b.all === true)) return json({ error: "invalid_body" }, 400);
      const [, { results: [c] }] = await env.DB.batch([
        ids ? env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN ${IN_JSON}`).bind(user.id, JSON.stringify(ids))
          : env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0").bind(user.id),
        env.DB.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM notifications WHERE user_id = ? AND is_read = 0 LIMIT 10)").bind(user.id),
      ]);
      return json({ ok: true, unread_count: c.n });
    }
    if (path === "/api/notifications") {
      // Không tham số = như cũ (50 mới nhất). ponytail: con trỏ chỉ theo created_at, dòng trùng giây ở mép trang có thể sót; cần chặt thì thêm id vào con trỏ.
      const qb = url.searchParams.get("before"), ql = url.searchParams.get("limit");
      const before = qb === null ? null : Number(qb), limit = ql === null ? 50 : Number(ql);
      if ((before !== null && !(Number.isInteger(before) && before > 0)) || !(Number.isInteger(limit) && limit >= 1 && limit <= 50)) return json({ error: "invalid_query" }, 400);
      const { results } = await env.DB.prepare(`SELECT * FROM notifications WHERE user_id = ?${before !== null ? " AND created_at < ?" : ""}${url.searchParams.get("unread") === "1" ? " AND is_read = 0" : ""} ORDER BY created_at DESC LIMIT ${limit}`)
        .bind(...(before !== null ? [user.id, before] : [user.id])).all();
      return json(results);
    }

    // Phase 2 — benchmark lương từ tin tuyển hệ thống đã gom: số chính chỉ VNĐ, USD tách riêng trong `usd`.
    if (path === "/api/benchmark" && request.method === "GET") {
      const role = (url.searchParams.get("role") || "").toLowerCase().trim();
      const level = (url.searchParams.get("level") || "").toLowerCase().trim();
      const loc = (url.searchParams.get("location") || "").toLowerCase().trim();
      const { results } = await env.DB.prepare("SELECT j.title, j.location, j.salary_text, s.type AS src FROM jobs j LEFT JOIN sources s ON s.id = j.source_id WHERE j.submitted_by IS NULL AND j.salary_text IS NOT NULL AND j.salary_text != '' LIMIT 1000").all();
      // VNĐ và USD tách riêng: tin remote USD lương cao hơn hẳn, gộp vào sẽ kéo trung vị mặc định lên.
      const vals = [], usdVals = [], sources = {};
      for (const j of results) {
        const title = (j.title || "").toLowerCase();
        if (role && !title.includes(role)) continue;
        if (level && !title.includes(level)) continue;
        if (loc && !(j.location || "").toLowerCase().includes(loc)) continue;
        const p = parseSalary(j.salary_text);
        if (!p) continue;
        const f = p.period === "year" ? 12 : 1;
        if (p.currency === "USD") usdVals.push({ min: p.min / f, max: p.max / f });
        else vals.push(monthlyVND(p));
        sources[j.src || "other"] = (sources[j.src || "other"] || 0) + 1;
      }
      const stats = (vs) => {
        const srt = (f) => vs.map(f).sort((a, b) => a - b), mids = srt((v) => (v.min + v.max) / 2);
        if (vs.length < 5) return { count: vs.length, median_min: null, median_max: null, p25_mid: null, median_mid: null, p75_mid: null }; // A7: <5 mẫu không ra trung vị
        return { count: vs.length, median_min: pct(srt((v) => v.min), 0.5), median_max: pct(srt((v) => v.max), 0.5), p25_mid: pct(mids, 0.25), median_mid: pct(mids, 0.5), p75_mid: pct(mids, 0.75) };
      };
      return json({
        ...stats(vals), currency: "VND", period: "month", usd_vnd: USD_VND,
        samples_vnd: vals.length, samples_usd: usdVals.length, sources,
        usd: { ...stats(usdVals), currency: "USD", period: "month" },
        filters: { role: role || null, level: level || null, location: loc || null },
        note: tr(lang, "Tính từ lương ghi trong tin tuyển hệ thống đã gom; tin 'Thương lượng' không tính. Lọc theo tiêu đề tin tuyển nên chỉ là ước tính."),
      });
    }

    if (path.startsWith("/api/")) return json({ error: "not_found", path }, 404);
    return json({ service: "jobpilot-api", phase: 2 });
    } catch (error) {
      console.error("request failed", error);
      return json({ error: "internal_error" }, 500);
    }
  },

  async queue(batch, env, ctx) {
    // Score: chấm cả lô một lần (D1 ≤ 50 truy vấn/lần chạy ở gói Free). Lỗi → thử lại cả lô; ghi là upsert nên lặp lại an toàn.
    if (batch.queue === "jobpilot-score") {
      const ids = (kind, key) => [...new Set(batch.messages.filter((m) => (m.body || {}).kind === kind).map((m) => m.body[key]))];
      try {
        const ver = new Map();
        for (const m of batch.messages) { const b = m.body || {}; if (b.kind === "rescore_profile") ver.set(b.profileId, Math.max(ver.get(b.profileId) ?? 0, b.v ?? Infinity)); }
        await scoreBatch(env, ids("score", "jobId"), ids("rescore_profile", "profileId"), ver);
        batch.ackAll();
      } catch (e) {
        console.log("queue handler error:", batch.queue, e.message);
        batch.retryAll();
      }
      return;
    }
    for (const msg of batch.messages) {
      const body = msg.body || {};
      try {
        if (batch.queue === "jobpilot-ingest" && body.kind === "ingest") {
          const r = await runIngestSource(env, body.sourceType, body.keyword);
          console.log(`ingest ${body.sourceType}/${body.keyword}:`, JSON.stringify(r));
        } else if (batch.queue === "jobpilot-notify" && body.kind === "digest") {
          const u = await env.DB.prepare("SELECT u.*, b.token_enc AS own_token_enc FROM users u LEFT JOIN user_bots b ON b.user_id = u.id AND b.status = 'ok' WHERE u.id = ?").bind(body.userId).first();
          if (u) {
            const digest = await buildDigest(env, u, "vi", null, true);
            const msg = u.telegram_chat_id && formatDigestTg(digest);
            const st = msg ? await tgSendFor(env, u.id, u.telegram_chat_id, msg, u.own_token_enc) : null;
            const n = (digest.strong || []).length + (digest.fresh || []).length;
            if (n) await notifWrite(() => env.DB.batch([
              env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = 'digest' AND is_read = 0").bind(u.id),
              env.DB.prepare("INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at, tg_status, tg_at) VALUES (?, ?, 'digest', ?, NULL, NULL, ?, ?, ?)")
                .bind(uid(), u.id, `Bản tin sáng: ${n} tin khớp`, now(), st === null ? null : st >= 200 && st < 300 ? "sent" : "failed", st === null ? null : now()),
            ]));
          }
        }
        msg.ack();
      } catch (e) {
        console.log("queue handler error:", batch.queue, e.message);
        msg.retry();
      }
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/30 * * * *") {
      await env.DB.prepare("DELETE FROM register_attempts WHERE hour < ?").bind(Math.floor(now() / 3600) - 2).run();
      await ensureSources(env);
      const { results } = await env.DB.prepare("SELECT * FROM sources WHERE is_enabled = 1").all();
      const keywords = await ingestKeywords(env);
      for (const src of results) {
        for (const kw of REMOTE_FETCHERS[src.type] ? ["*"] : keywords) await env.Q_INGEST.send({ kind: "ingest", sourceType: src.type, keyword: kw });
      }
      // Đóng mềm: đơn im lặng quá AUTO_CLOSE_DAYS. Event chèn trước UPDATE vì UPDATE đổi stage.
      // Mặc định TẮT trên prod (ghi tự động lên dữ liệu người dùng); owner bật bằng var AUTO_CLOSE_ENABLED="1" sau khi xem số đếm.
      if (env.AUTO_CLOSE_ENABLED === "1") {
        const cutoff = now() - AUTO_CLOSE_DAYS * 86400, tn = now();
        // Không đóng đơn người dùng còn hẹn follow-up trong tương lai (S1 review 05/11).
        const silent = "stage IN ('applied','interview') AND updated_at < ? AND (next_follow_up_at IS NULL OR next_follow_up_at < ?)";
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO application_events (id, application_id, type, payload, created_at) SELECT lower(hex(randomblob(16))), id, 'stage_changed', json_object('from', stage, 'to', 'archived', 'auto', 1), ? FROM applications WHERE ${silent}`).bind(tn, cutoff, tn),
          env.DB.prepare(`UPDATE applications SET stage = 'archived', note = COALESCE(note, '') || ' [tự đóng: im lặng 14 ngày]', updated_at = ? WHERE ${silent}`).bind(tn, cutoff, tn),
        ]);
      }
      try { await env.DB.batch(NOTIFY_DUE.map((q) => env.DB.prepare(q).bind(now()))); } catch (e) { console.log("notify due error", e.message); }
      // Purge (nghĩa vụ xoá dữ liệu) trước enrichJd (tốn subrequest, có thể chạm trần) — S2 review 05/11.
      const { results: gone } = await env.DB.prepare("SELECT id FROM users WHERE deleted_at < ?").bind(now() - DELETE_GRACE).all();
      for (const u of gone) { await purgeUser(env, u.id); console.log("purged user", u.id); }
      // T-45: xoá tin cũ không được đơn/phiên luyện nào tham chiếu; match xoá trước (FK). ORDER BY id để 2 câu cùng chọn một tập.
      // Mặc định TẮT trên prod (xoá dữ liệu); owner bật bằng var JOB_CLEANUP_ENABLED="1" sau khi xem số đếm.
      if (env.JOB_CLEANUP_ENABLED === "1") try {
        const old = `SELECT id FROM jobs WHERE COALESCE(last_seen_at, first_seen_at) < ? AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id)
          AND NOT EXISTS (SELECT 1 FROM prep_sessions s WHERE s.job_id = jobs.id) ORDER BY id LIMIT ${JOB_CLEAN_BATCH}`;
        const cut = now() - JOB_RETENTION_DAYS * 86400;
        await env.DB.batch([env.DB.prepare(`DELETE FROM job_matches WHERE job_id IN (${old})`).bind(cut), env.DB.prepare(`DELETE FROM jobs WHERE id IN (${old})`).bind(cut)]);
      } catch (e) { console.log("cleanup jobs error", e.message); }
      try { await enrichJd(env, 8); } catch (e) { console.log("enrichJd error", e.message); }
    } else if (event.cron === "0 1 * * *") {
      const { results: users } = await env.DB.prepare("SELECT id FROM users WHERE deleted_at IS NULL").all();
      for (const u of users) await env.Q_NOTIFY.send({ kind: "digest", userId: u.id });
    } else if (event.cron === "0 18 * * *") {
      const m = await backupToR2(env);
      console.log("backup", m.date, "subrequests", m.subrequests, "errors", JSON.stringify(m.errors));
      try { await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(now() - 90 * 86400).run(); } catch (e) { console.log("notif cleanup error", e.message); }
    }
  },

  async email(message, env, ctx) {
    console.log(`email from ${message.from} subject: ${message.headers.get("subject") || ""}`);
  },
};
