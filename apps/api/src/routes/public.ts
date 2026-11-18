// @ts-nocheck
import { canonSkill, fitBreakdown, json, now, postingFlags, scoreJob, SKILL_CATALOG, titleGate, tr, verdictFor } from '../worker.js';

export async function servePublic(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const qlang = url.searchParams.get("lang");
  const lang = qlang === "en" || qlang === "vi" ? qlang : /^en/i.test(request.headers.get("accept-language") || "") ? "en" : "vi";
  // Landing: job THẬT vừa quét chấm cho một hồ sơ mẫu cố định. Chỉ lấy link quét chuẩn của
  // ITviec/TopDev (không bao giờ là job dán tay), chỉ đọc, chỉ trả trường công khai; cache 5 phút.
  // /api/public/try: cùng đường chấm, hồ sơ do khách chọn (allow-list chặt), top 10, cache theo tham số đã chuẩn hoá.
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
    if (env.__trace) env.__trace.cache = hit ? "hit" : "miss";
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
