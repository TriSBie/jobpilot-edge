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
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
const now = () => Math.floor(Date.now() / 1000);
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
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
}

async function ownsProfile(env, user, profileId) {
  if (!profileId) return false;
  return !!(await env.DB.prepare("SELECT id FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first());
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

async function handleCvText(request, env, user, profileId) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?")
    .bind(profileId, user.id).first();
  if (!profile) return json({ error: "profile_not_found" }, 404);
  const body = await readBody(request);
  const text = (body.text || "").trim();
  if (text.length < 100) return json({ error: "cv_text_too_short" }, 400);
  const filename = body.filename || "cv.txt";
  const r2Key = `cv/${user.id}/${profileId}-${Date.now()}.txt`;
  await env.FILES.put(r2Key, text, { httpMetadata: { contentType: "text/plain" } });
  const fileId = uid();
  await env.DB.prepare(
    "INSERT INTO files (id, user_id, r2_key, kind, filename, size_bytes, created_at) VALUES (?, ?, ?, 'cv', ?, ?, ?)"
  ).bind(fileId, user.id, r2Key, filename, text.length, now()).run();
  await env.DB.prepare("UPDATE profiles SET cv_file_id = ?, updated_at = ? WHERE id = ?")
    .bind(fileId, now(), profileId).run();
  const [catalog, ai] = await Promise.all([
    Promise.resolve(extractSkillsFromText(text)),
    aiExtractSkills(env, text),
  ]);
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
    .replace(/\s+/g, " ").trim();
}
const decodeUnicodeEscapes = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const TECH_EXTRA = new Set(["c++", "c", "c/c++", "oop", "algorithms", "embedded", "agile", "scrum", "jira", "spring", "hibernate", "maven", "gradle", "oracle", "sql server", "mariadb", "cassandra", "hadoop", "spark", "airflow", "testing", "automation test", "manual test"]);
const CATALOG_KEYS = new Set(SKILL_CATALOG.map((s) => s.toLowerCase()));
function filterTechTags(tags) {
  const out = [];
  for (const raw of tags) {
    const tag = canonSkill(decodeUnicodeEscapes(raw));
    if (CATALOG_KEYS.has(tag.toLowerCase()) || TECH_EXTRA.has(tag.toLowerCase())) out.push(tag);
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
    const skills = [...card.matchAll(/class="[^"]*itag[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((mm) => canonSkill(stripTags(mm[1])));
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

// ---------------- jobs: insert + score ----------------
async function upsertJob(env, sourceId, job) {
  const hash = await sha256hex(`${job.title}|${job.company}|${job.url}`.toLowerCase());
  const posted = job.postedAt ? Math.floor(new Date(job.postedAt).getTime() / 1000) : null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO jobs (id, source_id, source_url, title, company, location, salary_text, jd_text, skills, content_hash, posted_at, first_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid(), sourceId, job.url, job.title, job.company || "", job.location || "",
    job.salaryText || null, job.jdText || "", JSON.stringify(job.skills || []),
    hash, posted, now(), now()).run();
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE content_hash = ?").bind(hash).first();
  return row;
}

// Parse lương VNĐ từ salary_text: "25 - 40 triệu" / "30 triệu" / "25 - 40k".
// "Thương lượng", USD và các dạng khác → null (không đoán mò).
function parseSalaryVND(text) {
  if (!text) return null;
  const t = String(text);
  if (/thương lượng|negotiable|competitive|thỏa thuận/i.test(t)) return null;
  let m = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(triệu|tr)\b/i);
  if (m) return { min: Number(m[1]) * 1e6, max: Number(m[2]) * 1e6 };
  m = t.match(/(\d{1,3})\s*(triệu|tr)\b/i);
  if (m) return { min: Number(m[1]) * 1e6, max: Number(m[1]) * 1e6 };
  m = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*k\b/i);
  if (m) return { min: Number(m[1]) * 1e3, max: Number(m[2]) * 1e3 };
  return null;
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
function fitBreakdown(profile, job) {
  const locs = (profile.locations || []).map(normLoc);
  const jobLoc = normLoc(job.location);
  let location = 0, locationWhy = "";
  if (!jobLoc) { location = 4; locationWhy = "Job không ghi địa điểm"; }
  else if (/remote/.test(jobLoc) || locs.some((l) => jobLoc.includes(l) || l.includes(jobLoc))) { location = 8; locationWhy = "Địa điểm khớp với hồ sơ"; }
  else if (locs.some((l) => /remote/.test(l))) { location = 6; locationWhy = "Bạn chấp nhận Remote, job này làm onsite"; }
  else { location = 0; locationWhy = "Địa điểm không khớp với hồ sơ"; }
  const refTs = job.posted_at || job.first_seen_at || now();
  // Tuổi dùng số ngày làm tròn xuống — cùng con số hiển thị "N ngày trước".
  const ageDays = Math.floor((now() - refTs) / 86400);
  const freshness = ageDays <= 3 ? 7 : ageDays <= 7 ? 5 : ageDays <= 14 ? 3 : 1;
  const titleAndJd = `${job.title || ""} ${(job.jd_text || "").slice(0, 500)}`.toLowerCase();
  const seniorish = /(senior|sr\.|lead|principal|staff|manager|architect|trưởng|cao cấp)/.test(titleAndJd);
  const juniorish = /(junior|fresher|intern|thực tập)/.test(titleAndJd);
  const lvl = (profile.level || "").toLowerCase();
  let level = 5, levelWhy = "Cấp bậc phù hợp";
  if (seniorish && /middle|junior|fresher/.test(lvl)) { level = 2; levelWhy = "Job này thiên về senior hơn cấp bậc của bạn"; }
  else if (juniorish && /senior/.test(lvl)) { level = 2; levelWhy = "Job này thiên về junior hơn cấp bậc của bạn"; }
  return { location, locationWhy, freshness, ageDays, level, levelWhy, total: location + freshness + level };
}

function scoreJob(profile, profileSkills, job) {
  const jobSkills = [...new Set([...(job.skills || []), ...extractSkillsFromText(job.jd_text || "")])];
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
  const fit = fitBreakdown(profile, job).total;
  let finalScore = Math.round(((rule + fit) / 70) * 100);
  // Bằng chứng mỏng (job khai < 3 skills) thì không cho lên strong.
  if (jobSkills.length < 3) finalScore = Math.min(finalScore, 69);
  const tier = finalScore >= 75 ? "strong" : finalScore >= 50 ? "partial" : "weak";
  return { rule, semantic: null, finalScore, tier, matched, missing, jobSkills };
}

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
    await env.DB.prepare(
      "INSERT OR IGNORE INTO applications (id, profile_id, job_id, stage, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)"
    ).bind(uid(), p.id, job.id, now(), now()).run();
    if (s.tier === "strong") {
      await env.DB.prepare(
        "INSERT INTO notifications (id, user_id, type, title, body, ref_id, created_at) VALUES (?, ?, 'strong_match', ?, ?, ?, ?)"
      ).bind(uid(), p.user_id, `Strong match ${s.finalScore}%: ${job.title}`, `${job.company} — khớp ${s.matched.join(", ")}`, job.id, now()).run();
      try {
        const stub = env.USER_HUB.get(env.USER_HUB.idFromName(p.user_id));
        await stub.fetch("https://do/broadcast", { method: "POST", body: JSON.stringify({ type: "job.strong", jobId: job.id, title: job.title, score: s.finalScore }) });
      } catch (_) { /* realtime là best-effort */ }
    }
  }
}

// ---------------- ingest ----------------
const DEFAULT_KEYWORDS = ["Java", "Node.js", "Backend", "Spring Boot"];
async function ensureSources(env) {
  for (const type of ["topdev", "itviec"]) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sources (id, type, name, config, is_enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).bind(`src-${type}`, type, type === "topdev" ? "TopDev" : "ITviec",
      JSON.stringify({ keywords: DEFAULT_KEYWORDS }), now()).run();
  }
}
// Cổng liên quan theo tiêu đề: loại tin phi kỹ thuật (HR/Sales/Kế toán...)
// mà tìm kiếm từ khoá của TopDev hay trả lẫn vào.
const TITLE_TECH = /(developer|engineer|backend|back-end|fullstack|full-stack|software|java|node|devops|\bqa\b|tester|data|mobile|android|ios|frontend|front-end|programmer|lập trình|kỹ sư|công nghệ)/i;
const TITLE_BLOCK = /(human resource|\bhr\b|recruit|talent acquisition|sales|marketing|accountant|kế toán|nhân sự|tuyển dụng|business development|customer service|support|administrator|designer|content|seo|admin\b)/i;
function titleGate(title) {
  if (!TITLE_TECH.test(title || "")) return false;
  if (TITLE_BLOCK.test(title || "") && !/(developer|engineer|programmer)/i.test(title)) return false;
  return true;
}

async function runIngestSource(env, sourceType, keyword) {
  const source = await env.DB.prepare("SELECT * FROM sources WHERE type = ?").bind(sourceType).first();
  if (!source) return { error: "source_missing" };
  let jobs = [], status = "ok", error = null;
  try {
    jobs = sourceType === "topdev" ? await fetchTopDev(keyword) : await fetchITviec(keyword);
  } catch (e) {
    status = "error"; error = e.message;
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
async function buildDigest(env, user) {
  const since = now() - 86400;
  const { results: profiles } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? AND is_active = 1").bind(user.id).all();
  const strong = [], followUps = [];
  for (const p of profiles) {
    const { results: sm } = await env.DB.prepare(
      `SELECT j.title, j.company, j.source_url, m.final_score FROM job_matches m JOIN jobs j ON j.id = m.job_id
       WHERE m.profile_id = ? AND m.tier = 'strong' AND j.first_seen_at >= ? ORDER BY m.final_score DESC LIMIT 20`
    ).bind(p.id, since).all();
    strong.push(...sm.map((r) => ({ ...r, profile: p.name })));
    const { results: fu } = await env.DB.prepare(
      `SELECT a.id, a.stage, a.next_follow_up_at, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.profile_id = ? AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= ? AND a.stage IN ('applied','interview') ORDER BY a.next_follow_up_at LIMIT 20`
    ).bind(p.id, now()).all();
    followUps.push(...fu);
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const summary = `${strong.length} strong match mới, ${followUps.length} việc cần follow-up`;
  await env.DB.prepare(
    `INSERT INTO digests (id, user_id, date, summary, status, sent_at) VALUES (?, ?, ?, ?, 'in_app', ?)
     ON CONFLICT(user_id, date) DO UPDATE SET summary = excluded.summary`
  ).bind(uid(), user.id, dateStr, summary, now()).run();
  return { date: dateStr, strong_count: strong.length, strong, follow_ups: followUps, summary };
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
async function loginThrottle(env, email) {
  const v = await env.KV.get(`loginfail:${email}`);
  return v ? parseInt(v, 10) || 0 : 0;
}
async function loginFailed(env, email) {
  const n = (await loginThrottle(env, email)) + 1;
  await env.KV.put(`loginfail:${email}`, String(n), { expirationTtl: 600 });
  return n;
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function passwordError(pw) {
  if (!pw || typeof pw !== "string") return "missing_password";
  if (pw.length < 8) return "password_too_short";
  if (pw.length > 128) return "password_too_long";
  return null;
}

// ---------------- router ----------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/api/health") {
      return json({ ok: true, service: "jobpilot-api", phase: 2, ts: new Date().toISOString(),
        bindings: { DB: !!env.DB, KV: !!env.KV, FILES: !!env.FILES, AI: !!env.AI, EMB: !!env.EMB, EVENTS: !!env.EVENTS } });
    }
    if (path === "/api/realtime") {
      const user = url.searchParams.get("user") || "anonymous";
      return env.USER_HUB.get(env.USER_HUB.idFromName(user)).fetch(request);
    }

    // --- auth: đăng ký / đăng nhập bằng mật khẩu (thay magic-link-lite) ---
    if (path === "/api/auth/register" && request.method === "POST") {
      const body = await readBody(request);
      const email = (body.email || "").trim().toLowerCase();
      const name = (body.name || "").trim();
      if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
      if (name.length < 2 || name.length > 80) return json({ error: "invalid_name" }, 400);
      const pwErr = passwordError(body.password);
      if (pwErr) return json({ error: pwErr }, 400);
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
    if (path === "/api/auth/login" && request.method === "POST") {
      const body = await readBody(request);
      const email = (body.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
      if (!body.password) return json({ error: "missing_password" }, 400);
      if ((await loginThrottle(env, email)) >= 5) return json({ error: "too_many_attempts" }, 429);
      const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
      if (!user) { await loginFailed(env, email); return json({ error: "invalid_credentials" }, 401); }
      if (!user.password_hash) return json({ error: "password_setup_required" }, 403);
      const ok = await verifyPassword(body.password, user.password_salt, user.password_hash);
      if (!ok) { await loginFailed(env, email); return json({ error: "invalid_credentials" }, 401); }
      await env.KV.delete(`loginfail:${email}`);
      return json(await issueSession(env, user));
    }
    if (path === "/api/auth/set-password" && request.method === "POST") {
      return json({ error: "password_setup_disabled" }, 410);
    }

    const user = await getUser(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    // Route /api/admin/* chỉ dành cho tài khoản owner.
    if (path.startsWith("/api/admin/") && user.email !== "tribui.it.work@gmail.com") {
      return json({ error: "forbidden" }, 403);
    }

    if (path === "/api/me") {
      const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
      const profiles = [];
      for (const p of results) profiles.push(await profileWithSkills(env, p));
      return json({ user: { id: user.id, email: user.email, name: user.name }, profiles });
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
        b.level ?? p.level, JSON.stringify(b.locations ?? JSON.parse(p.locations || "[]")),
        b.salary_min ?? p.salary_min, b.public_slug ?? p.public_slug, now(), p.id).run();
      // Level/locations đổi → fit đổi → chấm lại toàn bộ job cho khớp điểm lưu trữ.
      const { results: allJobs } = await env.DB.prepare("SELECT id FROM jobs ORDER BY first_seen_at DESC LIMIT 500").all();
      for (const j of allJobs) await env.Q_SCORE.send({ kind: "score", jobId: j.id });
      const upd = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(p.id).first();
      return json(await profileWithSkills(env, upd));
    }
    const cvMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-text$/);
    if (cvMatch && request.method === "POST") return handleCvText(request, env, user, cvMatch[1]);
    const cvFileMatch = path.match(/^\/api\/profiles\/([^/]+)\/cv-file$/);
    if (cvFileMatch && request.method === "POST") {
      const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(cvFileMatch[1], user.id).first();
      if (!profile) return json({ error: "profile_not_found" }, 404);
      const buf = await request.arrayBuffer();
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
      const { results: allJobs } = await env.DB.prepare("SELECT id FROM jobs ORDER BY first_seen_at DESC LIMIT 500").all();
      for (const j of allJobs) await env.Q_SCORE.send({ kind: "score", jobId: j.id });
      return json(await profileWithSkills(env, profile));
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
        const flags = [];
        const refTs = r.posted_at || r.first_seen_at;
        const ageDays = refTs ? Math.floor((now() - refTs) / 86400) : null;
        if (ageDays !== null && ageDays > 30) flags.push({ type: "stale", label: `Tin cũ ${ageDays} ngày` });
        if ((keyCount.get(normKey(r)) || 0) > 1 && r.first_seen_at !== keyFirst.get(normKey(r))) flags.push({ type: "duplicate", label: "Đăng trùng / đăng lại" });
        if (skillsArr.length > 12) flags.push({ type: "bloated", label: `JD nhồi ${skillsArr.length} kỹ năng` });
        let fit = null, ruleDetail = null;
        const hasMatch = r.final_score !== null && r.final_score !== undefined;
        if (prof && hasMatch) {
          fit = fitBreakdown(prof, { title: r.title, location: r.location, posted_at: r.posted_at, first_seen_at: r.first_seen_at, jd_text: r.jd_text || "" });
          const matched = JSON.parse(r.matched_skills || "[]");
          const missing = JSON.parse(r.missing_skills || "[]");
          let totalW = 0;
          const matchedW = matched.map((s) => { const w = skillW.get(String(s).toLowerCase()) || 3; totalW += w; return { skill: s, weight: w }; });
          const missingW = missing.map((s) => { totalW += 3; return { skill: s, weight: 3 }; });
          const jobSkillCount = new Set([...skillsArr.map((s) => String(s).toLowerCase()), ...extractSkillsFromText(r.jd_text || "").map((s) => s.toLowerCase())]).size;
          ruleDetail = { matched: matchedW, missing: missingW, total_weight: totalW, rule_score: r.rule_score, capped: jobSkillCount < 3 };
        }
        return {
          id: r.id, title: r.title, company: r.company, location: r.location,
          source_url: r.source_url, source: r.source_id, salary_text: r.salary_text,
          skills: skillsArr,
          posted_at: r.posted_at, first_seen_at: r.first_seen_at,
          flags,
          match: hasMatch ? {
            final_score: r.final_score, tier: r.tier, rule_score: r.rule_score,
            matched_skills: JSON.parse(r.matched_skills || "[]"),
            missing_skills: JSON.parse(r.missing_skills || "[]"),
            fit, rule_detail: ruleDetail,
          } : null,
          application: r.app_id ? { id: r.app_id, stage: r.app_stage } : null,
        };
      });
      if (tier) out = out.filter((j) => j.match && j.match.tier === tier);
      if (source) out = out.filter((j) => (j.source || "").includes(source));
      if (q) out = out.filter((j) => `${j.title} ${j.company}`.toLowerCase().includes(q));
      return json(out);
    }
    if (path === "/api/jobs/submit" && request.method === "POST") {
      await ensureSources(env);
      const b = await readBody(request);
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
        job = await upsertJob(env, src?.id || null, {
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
      return json(results.map((r) => ({
        id: r.id, profile_id: r.profile_id, job_id: r.job_id, stage: r.stage,
        note: r.note, applied_at: r.applied_at, next_follow_up_at: r.next_follow_up_at,
        updated_at: r.updated_at,
        job: { id: r.job_id, title: r.title, company: r.company, location: r.location, source_url: r.source_url },
        match: r.final_score !== null && r.final_score !== undefined ? { final_score: r.final_score, tier: r.tier } : null,
      })));
    }
    if (path === "/api/applications" && request.method === "POST") {
      const b = await readBody(request);
      if (!(await ownsProfile(env, user, b.profile_id))) return json({ error: "profile_not_found" }, 404);
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
      const stage = b.stage ?? app.stage;
      const appliedAt = stage === "applied" && !app.applied_at ? now() : app.applied_at;
      await env.DB.prepare("UPDATE applications SET stage = ?, note = ?, next_follow_up_at = ?, applied_at = ?, updated_at = ? WHERE id = ?")
        .bind(stage, b.note ?? app.note, b.next_follow_up_at ?? app.next_follow_up_at, appliedAt, now(), app.id).run();
      await env.DB.prepare("INSERT INTO application_events (id, application_id, type, payload, created_at) VALUES (?, ?, 'stage_changed', ?, ?)")
        .bind(uid(), app.id, JSON.stringify({ from: app.stage, to: stage }), now()).run();
      const upd = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(app.id).first();
      return json(upd);
    }

    // --- ingest admin + digest ---
    if (path === "/api/admin/ingest/run" && request.method === "POST") {
      await ensureSources(env);
      const b = await readBody(request);
      const types = Array.isArray(b.sources) && b.sources.length ? b.sources : ["topdev", "itviec"];
      let queued = 0;
      for (const t of types) {
        const src = await env.DB.prepare("SELECT * FROM sources WHERE type = ?").bind(t).first();
        const keywords = (src && JSON.parse(src.config || "{}").keywords) || DEFAULT_KEYWORDS;
        for (const kw of keywords) { await env.Q_INGEST.send({ kind: "ingest", sourceType: t, keyword: kw }); queued++; }
      }
      return json({ queued });
    }
    if (path === "/api/admin/ingest/status") {
      const { results } = await env.DB.prepare("SELECT type, name, last_run_at, last_status, last_error FROM sources ORDER BY type").all();
      return json(results);
    }
    if (path === "/api/digest/today") {
      return json(await buildDigest(env, user));
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
      const { results } = await env.DB.prepare("SELECT title, location, salary_text FROM jobs WHERE salary_text IS NOT NULL AND salary_text != '' LIMIT 1000").all();
      const vals = [];
      for (const j of results) {
        const title = (j.title || "").toLowerCase();
        if (role && !title.includes(role)) continue;
        if (level && !title.includes(level)) continue;
        if (loc && !(j.location || "").toLowerCase().includes(loc)) continue;
        const p = parseSalaryVND(j.salary_text);
        if (p) vals.push(p);
      }
      const mins = vals.map((v) => v.min).sort((a, b) => a - b);
      const maxs = vals.map((v) => v.max).sort((a, b) => a - b);
      const mids = vals.map((v) => (v.min + v.max) / 2).sort((a, b) => a - b);
      return json({
        count: vals.length, currency: "VND",
        median_min: pct(mins, 0.5), median_max: pct(maxs, 0.5),
        p25_mid: pct(mids, 0.25), median_mid: pct(mids, 0.5), p75_mid: pct(mids, 0.75),
        filters: { role: role || null, level: level || null, location: loc || null },
        note: "Tính từ lương ghi trong tin tuyển hệ thống đã gom; tin 'Thương lượng' không tính. Lọc theo tiêu đề tin tuyển nên chỉ là ước tính.",
      });
    }

    if (path.startsWith("/api/")) return json({ error: "not_found", path }, 404);
    return json({ service: "jobpilot-api", phase: 2 });
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
        } else if (batch.queue === "jobpilot-notify" && body.kind === "digest") {
          const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(body.userId).first();
          if (u) await buildDigest(env, u);
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
      await ensureSources(env);
      const { results } = await env.DB.prepare("SELECT * FROM sources WHERE is_enabled = 1").all();
      for (const src of results) {
        const keywords = JSON.parse(src.config || "{}").keywords || DEFAULT_KEYWORDS;
        for (const kw of keywords) await env.Q_INGEST.send({ kind: "ingest", sourceType: src.type, keyword: kw });
      }
    } else if (event.cron === "0 1 * * *") {
      const { results: users } = await env.DB.prepare("SELECT id FROM users").all();
      for (const u of users) await env.Q_NOTIFY.send({ kind: "digest", userId: u.id });
    }
  },

  async email(message, env, ctx) {
    console.log(`email from ${message.from} subject: ${message.headers.get("subject") || ""}`);
  },
};
