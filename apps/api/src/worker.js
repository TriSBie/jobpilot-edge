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
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
// i18n: tiếng Việt là nguồn; chỉ dịch chuỗi trả về client theo Accept-Language.
// ponytail: chỉ có "en"; thêm ngôn ngữ thì đổi EN thành map theo lang.
const EN = {
  "Job không ghi địa điểm": "Job has no location",
  "Địa điểm khớp với hồ sơ": "Location matches your profile",
  "Bạn chấp nhận Remote, job này làm onsite": "You accept Remote; this job is onsite",
  "Remote nhưng chỉ nhận ứng viên ở %s": "Remote but only hires in %s",
  "Địa điểm không khớp với hồ sơ": "Location does not match your profile",
  "Cấp bậc phù hợp": "Level fits",
  "Job này thiên về senior hơn cấp bậc của bạn": "This job leans more senior than your level",
  "Job này thiên về junior hơn cấp bậc của bạn": "This job leans more junior than your level",
  "JD yêu cầu %s năm kinh nghiệm": "JD requires %s years of experience",
  "Tin cũ %s ngày": "Posted %s days ago",
  "Đăng trùng / đăng lại": "Duplicate / reposted",
  "JD nhồi %s kỹ năng": "JD lists %s skills",
  "Có thể đã gỡ": "May be taken down",
  "Đăng lại %s lần": "Reposted (%s)",
  "Treo %s ngày": "Open for %s days",
  "Không ghi lương": "No salary listed",
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
const APP_STAGES = ["new", "saved", "applied", "interview", "offer", "rejected", "archived"]; // khớp STAGES của kanban (index.html)
const OWNER_EMAIL = "tribui.it.work@gmail.com";
const uid = () => crypto.randomUUID();
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

async function aiExtractSkills(env, cvText) {
  try {
    const res = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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
  const userId = await env.KV.get(`session:${token}`);
  if (!userId) return null;
  return env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").bind(userId).first();
}

async function ownsProfile(env, user, profileId) {
  if (!profileId) return false;
  return !!(await env.DB.prepare("SELECT id FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first());
}

async function enqueueProfileRescore(env, profileId) {
  try {
    await env.Q_SCORE.send({ kind: "rescore_profile", profileId });
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
    target_roles: JSON.parse(profile.target_roles || "[]"),
    locations: JSON.parse(profile.locations || "[]"),
    skills: results,
  };
}

const CV_MAX_BYTES = 5242880, CV_MAX_CHARS = 200000; // T-16a
async function handleCvText(request, env, user, profileId) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?")
    .bind(profileId, user.id).first();
  if (!profile) return json({ error: "profile_not_found" }, 404);
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
    jobs.push({
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
async function fetchRemoteOK() {
  const d = await fetchJSON("https://remoteok.com/api");
  return (Array.isArray(d) ? d : []).filter((j) => j && j.position && j.url).map((j) => ({
    title: j.position, company: j.company || "", location: `Remote (${j.location || "Worldwide"})`,
    url: j.url, postedAt: toISODate(j.date),
    salaryText: j.salary_min && j.salary_max ? `$${Math.round(j.salary_min / 1e3)}k - $${Math.round(j.salary_max / 1e3)}k/năm` : null,
    skills: filterTechTags(j.tags || []),
    jdText: stripTags(j.description || "").slice(0, JD_MAX),
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
async function upsertJob(env, sourceId, job) {
  const hash = await sha256hex(`${job.title}|${job.company}|${job.url}`.toLowerCase());
  const posted = job.postedAt ? Math.floor(new Date(job.postedAt).getTime() / 1000) : null;
  const t = now();
  const existing = await env.DB.prepare("SELECT id FROM jobs WHERE content_hash = ?").bind(hash).first();
  if (existing) {
    // board "làm mới" ngày đăng = đăng lại. ITviec chỉ có nhãn tương đối ("1 month ago") trôi theo ngày quét → không tin posted_at mới của nó.
    // ponytail: ngưỡng 2 ngày lọc trôi 1 ngày/lần quét của nhãn tương đối; nguồn có ngày tuyệt đối mà "làm mới" trong 1 ngày sẽ bị bỏ qua.
    const trust = sourceId === "src-itviec" ? 0 : posted || 0;
    await env.DB.prepare(
      `UPDATE jobs SET last_seen_at = ?, seen_count = seen_count + 1,
         repost_count = repost_count + (CASE WHEN ? >= COALESCE(posted_at,0) + 172800 THEN 1 ELSE 0 END),
         posted_at = MAX(COALESCE(posted_at,0), ?) WHERE content_hash = ?`
    ).bind(t, trust, trust, hash).run();
  } else await env.DB.prepare(
    `INSERT OR IGNORE INTO jobs (id, source_id, source_url, title, company, location, salary_text, jd_text, skills, content_hash, posted_at, first_seen_at, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), sourceId, job.url, job.title, job.company || "", job.location || "",
    job.salaryText || null, job.jdText || "", JSON.stringify(job.skills || []),
    hash, posted, t, t, t).run();
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE content_hash = ?").bind(hash).first();
  // Tin cũ chưa có JD mà feed giờ có → bù JD + skills rồi chấm lại.
  if (row && !jdOf(row) && row.jd_text !== "-" && job.jdText) {
    const skills = [...new Set([...JSON.parse(row.skills || "[]"), ...(job.skills || [])])];
    await env.DB.prepare("UPDATE jobs SET jd_text = ?, skills = ? WHERE id = ?").bind(job.jdText, JSON.stringify(skills), row.id).run();
    row.jd_text = job.jdText; row.skills = JSON.stringify(skills);
    await env.Q_SCORE.send({ kind: "score", jobId: row.id });
  }
  return row;
}

// Bóc JD từ trang chi tiết ITviec/TopDev. Fallback: toàn trang. ponytail: selector đoán theo markup hiện tại; lệch thì rơi về fallback.
function extractJd(html, sourceId) {
  let t = "";
  if (sourceId === "src-topdev") {
    const m = html.match(/\\?"description\\?":\\?"((?:[^"\\]|\\.)*?)\\?"[,}]/);
    if (m) t = stripTags(stripTags(decodeUnicodeEscapes(m[1]).replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\//g, "/")));
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
     WHERE j.jd_text = '' AND j.source_id IN ('src-itviec','src-topdev')
     ORDER BY EXISTS (SELECT 1 FROM job_matches m WHERE m.job_id = j.id AND m.tier IN ('strong','partial')) DESC, j.first_seen_at DESC LIMIT ?`
  ).bind(limit).all();
  let done = 0, failed = 0;
  for (const j of results) {
    let jd = "", gone = false;
    for (let a = 0; a < 2 && !jd && !gone; a++) {
      try { jd = extractJd(await fetchText(j.source_url), j.source_id); } catch (e) { gone = /HTTP (?:404|410)\b/.test(String(e && e.message)); }
    }
    if (!jd) {
      failed++;
      // Chỉ 404/410 mới đánh '-' (tin đã gỡ); lỗi tạm (5xx, timeout, parse rỗng) để '' thử lại lần sau, LIMIT chặn đốt subrequest.
      if (gone) await env.DB.prepare("UPDATE jobs SET jd_text = '-' WHERE id = ?").bind(j.id).run();
      continue;
    }
    const skills = [...new Set([...JSON.parse(j.skills || "[]"), ...extractSkillsFromText(jd)])];
    await env.DB.prepare("UPDATE jobs SET jd_text = ?, skills = ? WHERE id = ?").bind(jd, JSON.stringify(skills), j.id).run();
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
const REGION_LOCK = /(?<!\b(?:help|let|ask|tell|give|show|join|contact|about|with|email|follow|call|text|trust) )\b(?:us|usa|u\.s\.?a?|united states|north america|americas?|canada|latam|eu|europe|emea|uk|germany|berlin|london|cet|est|pst|us timezones?|us hours)(?![a-z])/;
function fitBreakdown(profile, job) {
  const locs = (profile.locations || []).map(normLoc);
  const jobLoc = normLoc(job.location);
  // ponytail: chỉ gỡ "join/contact/about us"; tiêu đề có "us" là đại từ kiểu khác vẫn có thể khớp nhầm khoá vùng.
  const jobLocTitle = `${jobLoc} ${normLoc(job.title)}`;
  let location = 0, locationWhy = "", locationArg;
  if (!jobLoc) { location = 4; locationWhy = "Job không ghi địa điểm"; }
  // Remote khoá vùng (T-60): tên vùng/múi giờ không gồm Việt Nam, so trên chuỗi đã normLoc (lowercase).
  // ponytail: danh sách cứng; thiếu vùng thì thêm vào đây, đổi sang bảng vùng khi nguồn mới ghi kiểu khác.
  // T-77: tiêu đề cũng có thể ghi khoá vùng ("U.S. Based Remote Contractor"), xét chung với địa điểm.
  else if (/remote/.test(jobLocTitle) && REGION_LOCK.test(jobLocTitle) && !/\b(?:vietnam|viet nam|apac|asia|anywhere|worldwide|global)\b/.test(jobLocTitle)) {
    location = 0; locationWhy = "Remote nhưng chỉ nhận ứng viên ở %s";
    locationArg = (REGION_LOCK.test(jobLoc) ? (String(job.location).match(/\(([^)]*)\)/) || [, job.location])[1] : jobLocTitle.match(REGION_LOCK)[0]).trim().slice(0, 40); // HN hay nhét cả câu vào ngoặc
  }
  else if (/remote/.test(jobLoc) || locs.some((l) => jobLoc.includes(l) || l.includes(jobLoc))) { location = 8; locationWhy = "Địa điểm khớp với hồ sơ"; }
  else if (locs.some((l) => /remote/.test(l))) { location = 6; locationWhy = "Bạn chấp nhận Remote, job này làm onsite"; }
  else { location = 0; locationWhy = "Địa điểm không khớp với hồ sơ"; }
  const refTs = job.posted_at || job.first_seen_at || now();
  // Tuổi dùng số ngày làm tròn xuống — cùng con số hiển thị "N ngày trước".
  const ageDays = Math.floor((now() - refTs) / 86400);
  const freshness = ageDays <= 3 ? 7 : ageDays <= 7 ? 5 : ageDays <= 14 ? 3 : 1;
  const titleAndJd = `${job.title || ""} ${jdOf(job).slice(0, 500)}`.toLowerCase();
  const seniorish = /(senior|\bsr\b|lead|principal|staff|manager|architect|expert|trưởng|cao cấp)/.test(titleAndJd);
  const juniorish = /(junior|fresher|intern|thực tập)/.test(titleAndJd);
  const lvl = (profile.level || "").toLowerCase();
  // T-76: tin ghi nhiều cấp ("Mid/Sr", "Expert/Senior/Middle") mà có cấp của hồ sơ thì không lệch.
  const mentionsMine = /middle/.test(lvl) ? /\b(?:middle|mid|intermediate)\b/.test(titleAndJd)
    : /junior|fresher/.test(lvl) ? /\b(?:junior|jr|fresher|intern)\b|thực tập/.test(titleAndJd)
    : /senior/.test(lvl) ? seniorish : false;
  let level = 5, levelWhy = "Cấp bậc phù hợp";
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
  else if (seniorish && /middle|junior|fresher/.test(lvl) && !mentionsMine) { level = 2; levelWhy = "Job này thiên về senior hơn cấp bậc của bạn"; }
  else if (juniorish && /senior/.test(lvl) && !mentionsMine) { level = 2; levelWhy = "Job này thiên về junior hơn cấp bậc của bạn"; }
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
  if (fb.level < 5 || fb.location === 0) finalScore = Math.min(finalScore, 74);
  const tier = finalScore >= 75 ? "strong" : finalScore >= 50 ? "partial" : "weak";
  return { rule, semantic: null, finalScore, tier, matched, missing, jobSkills };
}

// ---------------- Telegram (T-63) ----------------
const APP_URL = "https://jobpilot-edge.pages.dev";
const tgEsc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tgLink = (url, text) => url ? `<a href="${tgEsc(url).replace(/"/g, "&quot;")}">${tgEsc(text)}</a>` : tgEsc(text);
async function tgSend(env, chatId, html) {
  if (!env.TELEGRAM_BOT_TOKEN) { console.log("telegram: thiếu TELEGRAM_BOT_TOKEN, bỏ qua"); return false; }
  try {
    const r = await fetch((env.TELEGRAM_API_BASE || "https://api.telegram.org") + "/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.log("telegram: sendMessage", r.status);
    return r.ok;
  } catch (e) { console.log("telegram: sendMessage lỗi", e.message); return false; }
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

async function scoreJobForAllProfiles(env, job) {
  const { results: profiles } = await env.DB.prepare("SELECT * FROM profiles WHERE is_active = 1").all();
  for (const p of profiles) {
    const { results: skills } = await env.DB.prepare("SELECT skill, weight FROM profile_skills WHERE profile_id = ?").bind(p.id).all();
    if (!skills.length) continue;
    const profile = { ...p, locations: JSON.parse(p.locations || "[]") };
    const s = scoreJob(profile, skills, job);
    await env.DB.prepare(
      `INSERT INTO job_matches (job_id, profile_id, rule_score, semantic_score, final_score, tier, matched_skills, missing_skills, scored_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, profile_id) DO UPDATE SET rule_score=excluded.rule_score, final_score=excluded.final_score, tier=excluded.tier, matched_skills=excluded.matched_skills, missing_skills=excluded.missing_skills, scored_at=excluded.scored_at`
    ).bind(job.id, p.id, s.rule, s.finalScore, s.tier, JSON.stringify(s.matched), JSON.stringify(s.missing), now()).run();
    if (s.tier === "strong") {
      await env.DB.prepare(
        "INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at) SELECT ?, ?, 'strong_match', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ? AND type = 'strong_match' AND ref_id = ?)"
      ).bind(uid(), p.user_id, `Strong match ${s.finalScore}%: ${job.title}`, `${job.company} — khớp ${s.matched.join(", ")}`, job.id, now(), p.user_id, job.id).run();
      try {
        const stub = env.USER_HUB.get(env.USER_HUB.idFromName(p.user_id));
        await stub.fetch("https://do/broadcast", { method: "POST", body: JSON.stringify({ type: "job.strong", jobId: job.id, title: job.title, score: s.finalScore }) });
      } catch (_) { /* realtime là best-effort */ }
      try { // báo ngay qua Telegram: tối đa 1 tin/giờ/người, không gửi giờ yên lặng
        const u = await env.DB.prepare("SELECT telegram_chat_id FROM users WHERE id = ?").bind(p.user_id).first();
        if (u && u.telegram_chat_id && !tgQuiet(env) && !(await env.KV.get("tgburst:" + p.user_id))) {
          await env.KV.put("tgburst:" + p.user_id, "1", { expirationTtl: 3600 });
          await tgSend(env, u.telegram_chat_id, `1 tin khớp mạnh mới: ${tgLink(job.source_url, job.title)} — ${tgEsc(job.company)} (${Math.round(s.finalScore)})`);
        }
      } catch (e) { console.log("telegram burst lỗi", e.message); }
    }
  }
}

async function rescoreProfile(env, profileId) {
  const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND is_active = 1").bind(profileId).first();
  if (!p) return;
  const { results: skills } = await env.DB.prepare("SELECT skill, weight FROM profile_skills WHERE profile_id = ?").bind(p.id).all();
  if (!skills.length) return;
  const { results: jobs } = await env.DB.prepare("SELECT * FROM jobs ORDER BY first_seen_at DESC LIMIT 500").all();
  const profile = { ...p, locations: JSON.parse(p.locations || "[]") };
  for (let i = 0; i < jobs.length; i += 50) {
    const stmts = [], broadcasts = [];
    for (const job of jobs.slice(i, i + 50)) {
      job.skills = JSON.parse(job.skills || "[]");
      const s = scoreJob(profile, skills, job);
      stmts.push(env.DB.prepare(`INSERT INTO job_matches (job_id, profile_id, rule_score, semantic_score, final_score, tier, matched_skills, missing_skills, scored_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?) ON CONFLICT(job_id, profile_id) DO UPDATE SET rule_score=excluded.rule_score, final_score=excluded.final_score, tier=excluded.tier, matched_skills=excluded.matched_skills, missing_skills=excluded.missing_skills, scored_at=excluded.scored_at`)
        .bind(job.id, p.id, s.rule, s.finalScore, s.tier, JSON.stringify(s.matched), JSON.stringify(s.missing), now()));
      if (s.tier === "strong") {
        stmts.push(env.DB.prepare("INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at) SELECT ?, ?, 'strong_match', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ? AND type = 'strong_match' AND ref_id = ?)")
          .bind(uid(), p.user_id, `Strong match ${s.finalScore}%: ${job.title}`, `${job.company} — khớp ${s.matched.join(", ")}`, job.id, now(), p.user_id, job.id));
        broadcasts.push({ type: "job.strong", jobId: job.id, title: job.title, score: s.finalScore });
      }
    }
    await env.DB.batch(stmts);
    for (const event of broadcasts) {
      try {
        const stub = env.USER_HUB.get(env.USER_HUB.idFromName(p.user_id));
        await stub.fetch("https://do/broadcast", { method: "POST", body: JSON.stringify(event) });
      } catch (_) { /* realtime là best-effort */ }
    }
  }
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
      for (const kw of [...JSON.parse(r.target_roles || "[]"), ...JSON.parse(r.top || "[]")]) {
        const k = String(kw).trim(), low = k.toLowerCase();
        if (k.length <= 2 || seen.has(low) || GENERIC_KEYWORDS.has(low)) continue;
        seen.add(low); out.push(k);
        if (out.length >= 12) return out;
      }
    }
  } catch (e) { console.log("ingestKeywords fallback:", e.message); }
  return out;
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
const TITLE_BLOCK = /(human resource|\bhr\b|recruit|talent acquisition|sales|marketing|accountant|kế toán|nhân sự|tuyển dụng|business development|customer service|support|administrator|designer|content|seo|admin\b)/i;
// T-07: nhóm này chặn kể cả khi có "engineer" (Sales Engineer, Engineering Manager, Data Entry...).
const TITLE_HARD_BLOCK = /(\bsales\b|pre-?sales|\bsupport\b|\bcontent\b|\bmanager\b|data entry)/i;
function titleGate(title) {
  if (!TITLE_TECH.test(title || "") || TITLE_HARD_BLOCK.test(title || "")) return false;
  if (TITLE_BLOCK.test(title || "") && !/\b(?:developer|engineer|programmer)\b/i.test(title)) return false;
  return true;
}

async function runIngestSource(env, sourceType, keyword) {
  const source = await env.DB.prepare("SELECT * FROM sources WHERE type = ?").bind(sourceType).first();
  if (!source) return { error: "source_missing" };
  let jobs = [], status = "ok", error = null;
  try {
    jobs = REMOTE_FETCHERS[sourceType] ? await REMOTE_FETCHERS[sourceType]()
      : sourceType === "topdev" ? await fetchTopDev(keyword) : await fetchITviec(keyword);
  } catch (e) {
    // ITviec trả 404 cho slug không có tin: coi là 0 tin, không phải lỗi nguồn (T-49 một phần).
    if (e.message !== "HTTP 404" || REMOTE_FETCHERS[sourceType]) { status = "error"; error = e.message; }
  }
  const rawCount = jobs.length;
  jobs = jobs.filter((j) => titleGate(j.title));
  let created = 0;
  for (const j of jobs) {
    const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM jobs WHERE source_url = ?").bind(j.url).first();
    const row = await upsertJob(env, source.id, j);
    if (row && before.c === 0) { created++; await env.Q_SCORE.send({ kind: "score", jobId: row.id }); }
  }
  await env.DB.prepare("UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?")
    .bind(now(), status, error, source.id).run();
  return { fetched: jobs.length, raw: rawCount, created, status, error };
}

// ---------------- digest ----------------
// persist=true chỉ từ cron/consumer; GET không ghi DB (T-47). profileId=null: gộp mọi hồ sơ.
async function buildDigest(env, user, lang = "vi", profileId = null, persist = false) {
  const since = now() - 86400;
  const { results: profiles } = profileId
    ? await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? AND is_active = 1 AND id = ?").bind(user.id, profileId).all()
    : await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? AND is_active = 1").bind(user.id).all();
  const strong = [], followUps = [], fresh = [];
  for (const p of profiles) {
    const { results: sm } = await env.DB.prepare(
      `SELECT j.title, j.company, j.source_url, m.final_score FROM job_matches m JOIN jobs j ON j.id = m.job_id
       WHERE m.profile_id = ? AND m.tier = 'strong' AND j.first_seen_at >= ? ORDER BY m.final_score DESC LIMIT 20`
    ).bind(p.id, since).all();
    strong.push(...sm.map((r) => ({ ...r, profile: p.name })));
    // B6: tin mới còn phù hợp (verdict != skip, không khoá vùng/stale), dùng đúng verdictFor/postingFlags/fitBreakdown như /api/jobs.
    const { results: cand } = await env.DB.prepare(
      `SELECT j.*, m.final_score, m.tier, m.missing_skills FROM job_matches m JOIN jobs j ON j.id = m.job_id
       WHERE m.profile_id = ? AND m.tier = 'partial' AND j.first_seen_at >= ? ORDER BY m.final_score DESC LIMIT 30`
    ).bind(p.id, since).all();
    const prof = { ...p, locations: JSON.parse(p.locations || "[]") };
    for (const r of cand) {
      const fit = fitBreakdown(prof, { title: r.title, location: r.location, posted_at: r.posted_at, first_seen_at: r.first_seen_at, jd_text: jdOf(r) });
      const flags = postingFlags(r, now(), lang);
      const missing = JSON.parse(r.missing_skills || "[]").map((s) => ({ skill: s, weight: 3 }));
      const v = verdictFor({ tier: r.tier, rule_detail: { missing } }, fit, flags, flags.filter((f) => f.type !== "duplicate").length, lang);
      if (v.verdict === "skip" || fit.location === 0 || flags.some((f) => f.type === "stale")) continue;
      fresh.push({ title: r.title, company: r.company, source_url: r.source_url, final_score: r.final_score, verdict: v.verdict, profile: p.name });
    }
    const { results: fu } = await env.DB.prepare(
      `SELECT a.id, a.stage, a.next_follow_up_at, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.profile_id = ? AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= ? AND a.stage IN ('applied','interview') ORDER BY a.next_follow_up_at LIMIT 20`
    ).bind(p.id, now()).all();
    followUps.push(...fu);
  }
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
  await env.KV.put(`session:${token}`, user.id, { expirationTtl: 2592000 });
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
  const applications = await byUser("SELECT a.* FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = ? ORDER BY a.created_at");
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

// ---------------- router ----------------
export default {
  async fetch(request, env, ctx) {
    try {
    const url = new URL(request.url);
    const path = url.pathname;
    const lang = /^en/i.test(request.headers.get("accept-language") || "") ? "en" : "vi";
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/api/health") {
      return json({ ok: true, service: "jobpilot-api", phase: 2, ts: new Date().toISOString(),
        bindings: { DB: !!env.DB, KV: !!env.KV, FILES: !!env.FILES, AI: !!env.AI, EMB: !!env.EMB, EVENTS: !!env.EVENTS } });
    }

    // Landing: job THẬT vừa quét chấm cho một hồ sơ mẫu cố định. Chỉ lấy link quét chuẩn của
    // ITviec/TopDev (không bao giờ là job dán tay), chỉ đọc, chỉ trả trường công khai; cache 5 phút.
    if (path === "/api/public/sample" && request.method === "GET") {
      const SCRAPED = "(source_url LIKE 'https://itviec.com/it-jobs/%' OR source_url LIKE 'https://topdev.vn/detail-jobs/%')";
      const { results } = await env.DB.prepare(
        `SELECT id, title, company, location, source_id, source_url, salary_text, skills, posted_at, first_seen_at, last_seen_at, repost_count
         FROM jobs WHERE ${SCRAPED} ORDER BY COALESCE(last_seen_at, first_seen_at) DESC LIMIT 60`
      ).all();
      const sampleProfile = { level: "middle", locations: ["Hồ Chí Minh", "Remote"] };
      const sampleSkills = [
        { skill: "Java", weight: 5 }, { skill: "Spring Boot", weight: 5 }, { skill: "PostgreSQL", weight: 3 },
        { skill: "Docker", weight: 3 }, { skill: "REST APIs", weight: 3 }, { skill: "Git", weight: 2 },
      ];
      // Lọc chặt hơn titleGate: "kỹ sư"/"công nghệ" cho lọt cả tin xây dựng (T-07 chưa sửa).
      const DEV_TITLE = /(developer|engineer|backend|back-end|fullstack|full-stack|software|programmer|lập trình|devops|frontend|front-end)/i;
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
          rule: Math.round(s.rule * 10) / 10, fit: { location: f.location, freshness: f.freshness, level: f.level },
          matched: s.matched, missing: s.missing.slice(0, 6), capped: s.jobSkills.length < 3,
          flags, verdict: v.verdict, verdict_why: v.why,
        };
      }).filter((x) => x.matched.length > 0 && DEV_TITLE.test(x.title))
        // Ưu tiên tin đúng cấp bậc hồ sơ mẫu, rồi mới tới điểm (chỉ là thứ tự hiển thị).
        .sort((a, b) => ((a.verdict === "skip") - (b.verdict === "skip")) || (b.fit.level - a.fit.level) || (b.score - a.score));
      const stats = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM jobs WHERE ${SCRAPED}) AS jobs,
                (SELECT COUNT(*) FROM jobs WHERE ${SCRAPED} AND first_seen_at > ?) AS new_24h,
                (SELECT MAX(last_run_at) FROM sources) AS last_scan`
      ).bind(now() - 86400).first();
      const res = json({
        profile: { label: tr(lang, "Backend Java · 3 năm · Hồ Chí Minh / Remote"), skills: sampleSkills },
        jobs: scored.slice(0, 5), stats,
      });
      res.headers.set("cache-control", "public, max-age=300");
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
        "INSERT INTO users (id, email, name, timezone, digest_email, created_at, password_hash, password_salt, password_set_at) VALUES (?, ?, ?, 'Asia/Saigon', ?, ?, ?, ?, ?)"
      ).bind(id, email, name, email, now(), rec.hash, rec.salt, now()).run();
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

    // Webhook Telegram: không Bearer, xác thực bằng secret header; luôn 200 sau khi qua kiểm tra.
    if (path === "/api/telegram/webhook" && request.method === "POST") {
      if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "telegram_not_configured" }, 503);
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
      try {
        const m = (await readBody(request)).message || {};
        const chatId = m.chat && m.chat.id != null ? String(m.chat.id) : "";
        const text = String(m.text || "").trim();
        const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9]{8})$/);
        if (chatId && start) {
          const uidLinked = await env.KV.get(`tglink:${start[1]}`); // mã sống 900s trong KV (T-99), hết hạn là null
          const u = uidLinked ? await env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL").bind(uidLinked).first() : null;
          if (u) {
            await env.KV.delete(`tglink:${start[1]}`);
            await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, telegram_linked_at = ?, telegram_link_code = NULL WHERE id = ?").bind(chatId, now(), u.id).run();
            await tgSend(env, chatId, `Đã gắn JobPilot với tài khoản ${tgEsc(maskEmail(u.email))}. Bạn sẽ nhận 1 bản tin mỗi sáng và báo ngay khi có tin khớp mạnh. / Linked: one digest each morning plus instant strong matches.`);
          } else await tgSend(env, chatId, "Mã không đúng hoặc đã dùng. / Invalid or used code.");
        } else if (chatId && /^\/stop(?:@\w+)?$/.test(text)) {
          await env.DB.prepare("UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?").bind(chatId).run();
          await tgSend(env, chatId, "Đã tắt thông báo JobPilot. / JobPilot notifications turned off.");
        }
      } catch (e) { console.log("telegram webhook lỗi", e.message); }
      return json({ ok: true });
    }

    const user = await getUser(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    if (path === "/api/realtime") {
      return env.USER_HUB.get(env.USER_HUB.idFromName(user.id)).fetch(request);
    }

    // Route /api/admin/* chỉ dành cho tài khoản owner.
    if (path.startsWith("/api/admin/") && user.email !== OWNER_EMAIL) {
      return json({ error: "forbidden" }, 403);
    }

    if (path === "/api/me" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
      const profiles = [];
      for (const p of results) profiles.push(await profileWithSkills(env, p));
      return json({ user: { id: user.id, email: user.email, name: user.name, is_owner: user.email === OWNER_EMAIL,
        consent_cv_at: user.consent_cv_at, ai_opt_out: user.ai_opt_out ? 1 : 0, telegram_linked: !!user.telegram_chat_id }, profiles });
    }
    if (path === "/api/admin/quota") {
      const out = {};
      const list = await env.KV.list({ prefix: "quota:" });
      for (const k of list.keys) out[k.name] = await env.KV.get(k.name);
      return json({ quota: out });
    }

    // --- profiles ---
    if (path === "/api/profiles" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
      const out = [];
      for (const p of results) out.push(await profileWithSkills(env, p));
      return json(out);
    }
    if (path === "/api/profiles" && request.method === "POST") {
      const b = await readBody(request);
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO profiles (id, user_id, name, target_roles, level, locations, salary_min, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).bind(id, user.id, b.name || "Hồ sơ mới", JSON.stringify(b.target_roles || []), b.level || null,
        JSON.stringify(b.locations || []), b.salary_min || null, now(), now()).run();
      const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(id).first();
      return json(await profileWithSkills(env, p), 201);
    }
    const profMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
    if (profMatch && request.method === "PATCH") {
      const b = await readBody(request);
      const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profMatch[1], user.id).first();
      if (!p) return json({ error: "profile_not_found" }, 404);
      await env.DB.prepare(
        "UPDATE profiles SET name = ?, target_roles = ?, level = ?, locations = ?, salary_min = ?, public_slug = ?, updated_at = ? WHERE id = ?"
      ).bind(b.name ?? p.name, JSON.stringify(b.target_roles ?? JSON.parse(p.target_roles || "[]")),
        "level" in b ? (b.level || null) : p.level, JSON.stringify(b.locations ?? JSON.parse(p.locations || "[]")),
        "salary_min" in b ? (b.salary_min || null) : p.salary_min, b.public_slug ?? p.public_slug, now(), p.id).run();
      // Level/locations đổi → fit đổi → chấm lại toàn bộ job cho khớp điểm lưu trữ.
      const rescoreQueued = await enqueueProfileRescore(env, p.id);
      const upd = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(p.id).first();
      return json({ ...(await profileWithSkills(env, upd)), rescore_queued: rescoreQueued });
    }
    const cvMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-text$/);
    if (cvMatch && request.method === "POST") return handleCvText(request, env, user, cvMatch[1]);
    const cvFileMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-file$/);
    if (cvFileMatch && request.method === "POST") {
      if (+request.headers.get("content-length") > CV_MAX_BYTES) return json({ error: "file_too_large", max_bytes: CV_MAX_BYTES }, 413);
      const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(cvFileMatch[1], user.id).first();
      if (!profile) return json({ error: "profile_not_found" }, 404);
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
      await env.DB.batch(stmts);
      // chấm lại toàn bộ job hiện có cho profile này
      const rescoreQueued = await enqueueProfileRescore(env, profile.id);
      return json({ ...(await profileWithSkills(env, profile)), rescore_queued: rescoreQueued });
    }

    // --- jobs ---
    if (path === "/api/jobs" && request.method === "GET") {
      const profileId = url.searchParams.get("profile_id");
      if (profileId && !(await ownsProfile(env, user, profileId))) return json({ error: "profile_not_found" }, 404);
      const tier = url.searchParams.get("tier");
      const source = url.searchParams.get("source");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      let rows;
      if (profileId) {
        const { results } = await env.DB.prepare(
          `SELECT j.*, m.final_score, m.tier, m.matched_skills, m.missing_skills, m.rule_score,
                  a.id AS app_id, a.stage AS app_stage
           FROM jobs j LEFT JOIN job_matches m ON m.job_id = j.id AND m.profile_id = ?
           LEFT JOIN applications a ON a.job_id = j.id AND a.profile_id = ?
           ORDER BY COALESCE(m.final_score, 0) DESC, j.first_seen_at DESC LIMIT 300`
        ).bind(profileId, profileId).all();
        rows = results;
      } else {
        const { results } = await env.DB.prepare("SELECT j.*, NULL AS app_id, NULL AS app_stage FROM jobs j ORDER BY j.first_seen_at DESC LIMIT 300").all();
        rows = results;
      }
      // Phase 2 — flags + giải thích điểm (tính trực tiếp, không cần chấm lại)
      let prof = null; const skillW = new Map();
      if (profileId) {
        const prow = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(profileId).first();
        if (prow) {
          prof = { ...prow, locations: JSON.parse(prow.locations || "[]") };
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
      let out = rows.map((r) => {
        const skillsArr = JSON.parse(r.skills || "[]");
        const flags = postingFlags({ ...r, skillCount: skillsArr.length, dup: (keyCount.get(normKey(r)) || 0) > 1 && r.first_seen_at !== keyFirst.get(normKey(r)) }, now(), lang);
        const risk = flags.filter((f) => f.type !== "duplicate").length;
        let fit = null, ruleDetail = null;
        const hasMatch = r.final_score !== null && r.final_score !== undefined;
        if (prof && hasMatch) {
          fit = fitBreakdown(prof, { title: r.title, location: r.location, posted_at: r.posted_at, first_seen_at: r.first_seen_at, jd_text: jdOf(r) });
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
        return {
          id: r.id, title: r.title, company: r.company, location: r.location,
          source_url: r.source_url, source: r.source_id, salary_text: r.salary_text,
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
      if (tier) out = out.filter((j) => j.match && j.match.tier === tier);
      if (source) out = out.filter((j) => (j.source || "").includes(source));
      if (q) out = out.filter((j) => `${j.title} ${j.company}`.toLowerCase().includes(q));
      return json(out);
    }
    if (path === "/api/jobs/submit" && request.method === "POST") {
      const b = await readBody(request);
      if (!(await verifyTurnstile(env, b.turnstile_token, request.headers.get("cf-connecting-ip")))) return json({ error: "turnstile_failed" }, 403);
      await ensureSources(env);
      let job = null;
      if (b.url) {
        const sourceType = /topdev/.test(b.url) ? "topdev" : /itviec/.test(b.url) ? "itviec" : "manual";
        const src = await env.DB.prepare("SELECT * FROM sources WHERE type = ?").bind(sourceType === "manual" ? "topdev" : sourceType).first();
        let jdText = b.jd_text || "", title = b.title || "", company = b.company || "";
        if (!jdText) {
          try {
            const html = await fetchText(b.url);
            jdText = stripTags(html).slice(0, 8000);
            const tm = html.match(/<title>([^<]+)<\/title>/i);
            if (!title && tm) title = tm[1].split("|")[0].split(" - ")[0].trim();
          } catch (e) { /* giữ jd rỗng nếu fetch lỗi */ }
        }
        job = await upsertJob(env, sourceType === "manual" ? null : src?.id || null, {
          title: title || "Job không tiêu đề", company, location: b.location || "",
          url: b.url, jdText, skills: extractSkillsFromText(jdText),
          postedAt: null, salaryText: b.salary_text || null,
        });
      } else if (b.title) {
        job = await upsertJob(env, null, {
          title: b.title, company: b.company || "", location: b.location || "",
          url: b.source_url || `manual://${await sha256hex(b.title + (b.company || ""))}`,
          jdText: b.jd_text || "", skills: extractSkillsFromText(b.jd_text || ""),
          postedAt: null, salaryText: b.salary_text || null,
        });
      }
      if (!job) return json({ error: "nothing_to_submit" }, 400);
      await env.Q_SCORE.send({ kind: "score", jobId: job.id });
      return json({ job: { id: job.id, title: job.title, company: job.company }, created: true }, 201);
    }
    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === "GET") {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobMatch[1]).first();
      if (!job) return json({ error: "job_not_found" }, 404);
      const { results: matches } = await env.DB.prepare("SELECT m.* FROM job_matches m JOIN profiles p ON p.id = m.profile_id WHERE m.job_id = ? AND p.user_id = ?").bind(job.id, user.id).all();
      return json({ ...job, skills: JSON.parse(job.skills || "[]"), matches });
    }

    // --- applications (kanban) ---
    if (path === "/api/applications" && request.method === "GET") {
      const profileId = url.searchParams.get("profile_id");
      if (!profileId) return json({ error: "profile_id_required" }, 400);
      if (!(await ownsProfile(env, user, profileId))) return json({ error: "profile_not_found" }, 404);
      const sql = profileId
        ? `SELECT a.*, j.title, j.company, j.location, j.source_url, m.final_score, m.tier
           FROM applications a JOIN jobs j ON j.id = a.job_id
           LEFT JOIN job_matches m ON m.job_id = a.job_id AND m.profile_id = a.profile_id
           WHERE a.profile_id = ? ORDER BY a.updated_at DESC LIMIT 500`
        : `SELECT a.*, j.title, j.company, j.location, j.source_url, m.final_score, m.tier
           FROM applications a JOIN jobs j ON j.id = a.job_id
           LEFT JOIN job_matches m ON m.job_id = a.job_id AND m.profile_id = a.profile_id
           ORDER BY a.updated_at DESC LIMIT 500`;
      const { results } = profileId ? await env.DB.prepare(sql).bind(profileId).all() : await env.DB.prepare(sql).all();
      const t = now(), W = 7 * 86400;
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
      }));
      // Mặc định trả mảng như trước (SPA cũ/Worker cũ lệch phiên bản vẫn chạy); ?stats=1 mới bọc {items, stats}.
      return json(url.searchParams.get("stats") === "1" ? { items, stats } : items);
    }
    if (path === "/api/applications" && request.method === "POST") {
      const b = await readBody(request);
      if (!(await ownsProfile(env, user, b.profile_id))) return json({ error: "profile_not_found" }, 404);
      if (b.stage !== undefined && !APP_STAGES.includes(b.stage)) return json({ error: "invalid_stage" }, 400);
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO applications (id, profile_id, job_id, stage, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, job_id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at"
      ).bind(id, b.profile_id, b.job_id, b.stage || "new", b.note || null, now(), now()).run();
      const row = await env.DB.prepare("SELECT * FROM applications WHERE profile_id = ? AND job_id = ?").bind(b.profile_id, b.job_id).first();
      return json(row, 201);
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
      return json(upd);
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
      if (!env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "telegram_not_configured" }, 503);
      const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", rnd = crypto.getRandomValues(new Uint8Array(8));
      const code = [...rnd].map((b) => a[b % a.length]).join("");
      await env.KV.put(`tglink:${code}`, user.id, { expirationTtl: 900 });
      await env.DB.prepare("UPDATE users SET telegram_link_code = NULL WHERE id = ?").bind(user.id).run(); // dọn mã cũ còn sót trong cột
      const bot = env.TELEGRAM_BOT_USERNAME || "";
      return json({ code, bot, deeplink: `https://t.me/${bot}?start=${code}` });
    }
    if (path === "/api/me/telegram" && request.method === "DELETE") {
      await env.DB.prepare("UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = ?").bind(user.id).run();
      return json({ ok: true });
    }
    if (path === "/api/me" && request.method === "PATCH") {
      const b = await readBody(request);
      if (![0, 1, true, false].includes(b.ai_opt_out)) return json({ error: "invalid_ai_opt_out" }, 400);
      await env.DB.prepare("UPDATE users SET ai_opt_out = ? WHERE id = ?").bind(b.ai_opt_out ? 1 : 0, user.id).run();
      return json({ ai_opt_out: b.ai_opt_out ? 1 : 0 });
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
    if (path === "/api/notifications") {
      const { results } = await env.DB.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all();
      return json(results);
    }

    // Phase 2 — benchmark lương từ tin tuyển hệ thống đã gom (chỉ VNĐ).
    if (path === "/api/benchmark" && request.method === "GET") {
      const role = (url.searchParams.get("role") || "").toLowerCase().trim();
      const level = (url.searchParams.get("level") || "").toLowerCase().trim();
      const loc = (url.searchParams.get("location") || "").toLowerCase().trim();
      const { results } = await env.DB.prepare("SELECT j.title, j.location, j.salary_text, s.type AS src FROM jobs j LEFT JOIN sources s ON s.id = j.source_id WHERE j.salary_text IS NOT NULL AND j.salary_text != '' LIMIT 1000").all();
      const vals = [], sources = {}; let vnd = 0, usd = 0;
      for (const j of results) {
        const title = (j.title || "").toLowerCase();
        if (role && !title.includes(role)) continue;
        if (level && !title.includes(level)) continue;
        if (loc && !(j.location || "").toLowerCase().includes(loc)) continue;
        const p = parseSalary(j.salary_text);
        if (!p) continue;
        vals.push(monthlyVND(p));
        p.currency === "USD" ? usd++ : vnd++;
        sources[j.src || "other"] = (sources[j.src || "other"] || 0) + 1;
      }
      const mins = vals.map((v) => v.min).sort((a, b) => a - b);
      const maxs = vals.map((v) => v.max).sort((a, b) => a - b);
      const mids = vals.map((v) => (v.min + v.max) / 2).sort((a, b) => a - b);
      return json({
        count: vals.length, currency: "VND", period: "month", usd_vnd: USD_VND,
        samples_vnd: vnd, samples_usd: usd, sources,
        median_min: pct(mins, 0.5), median_max: pct(maxs, 0.5),
        p25_mid: pct(mids, 0.25), median_mid: pct(mids, 0.5), p75_mid: pct(mids, 0.75),
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
    for (const msg of batch.messages) {
      const body = msg.body || {};
      try {
        if (batch.queue === "jobpilot-ingest" && body.kind === "ingest") {
          const r = await runIngestSource(env, body.sourceType, body.keyword);
          console.log(`ingest ${body.sourceType}/${body.keyword}:`, JSON.stringify(r));
        } else if (batch.queue === "jobpilot-score" && body.kind === "score") {
          const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(body.jobId).first();
          if (job) {
            job.skills = JSON.parse(job.skills || "[]");
            await scoreJobForAllProfiles(env, job);
          }
        } else if (batch.queue === "jobpilot-score" && body.kind === "rescore_profile") {
          await rescoreProfile(env, body.profileId);
        } else if (batch.queue === "jobpilot-notify" && body.kind === "digest") {
          const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(body.userId).first();
          if (u) {
            const digest = await buildDigest(env, u, "vi", null, true);
            const msg = u.telegram_chat_id && formatDigestTg(digest);
            if (msg) await tgSend(env, u.telegram_chat_id, msg);
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
      // Purge (nghĩa vụ xoá dữ liệu) trước enrichJd (tốn subrequest, có thể chạm trần) — S2 review 05/11.
      const { results: gone } = await env.DB.prepare("SELECT id FROM users WHERE deleted_at < ?").bind(now() - DELETE_GRACE).all();
      for (const u of gone) { await purgeUser(env, u.id); console.log("purged user", u.id); }
      try { await enrichJd(env, 8); } catch (e) { console.log("enrichJd error", e.message); }
    } else if (event.cron === "0 1 * * *") {
      const { results: users } = await env.DB.prepare("SELECT id FROM users WHERE deleted_at IS NULL").all();
      for (const u of users) await env.Q_NOTIFY.send({ kind: "digest", userId: u.id });
    } else if (event.cron === "0 18 * * *") {
      const m = await backupToR2(env);
      console.log("backup", m.date, "subrequests", m.subrequests, "errors", JSON.stringify(m.errors));
    }
  },

  async email(message, env, ctx) {
    console.log(`email from ${message.from} subject: ${message.headers.get("subject") || ""}`);
  },
};
