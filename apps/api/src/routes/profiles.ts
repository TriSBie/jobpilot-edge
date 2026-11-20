// @ts-nocheck
import {
  badProfileArrays, canonSkill, CV_MAX_BYTES, deleteProfileCv, enqueueProfileRescore,
  enqueueProfileScan, handleCvSuggest, handleCvText, json, jsonArr, now, profileWithSkills, readBody, uid,
} from '../worker.js';

export { handleCvText };

export function suggestCv(request, env, user, profileId) {
  const qlang = new URL(request.url).searchParams.get("lang");
  const lang = qlang === "en" || qlang === "vi" ? qlang : /^en/i.test(request.headers.get("accept-language") || "") ? "en" : "vi";
  return handleCvSuggest(request, env, user, profileId, lang);
}

export async function getProfiles(env, user) {
  const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
  const out = [];
  for (const p of results) out.push(await profileWithSkills(env, p));
  return json(out);
}

export async function createProfile(request, env, user) {
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

export async function patchProfile(request, env, user, profileId) {
  const b = await readBody(request);
  if (badProfileArrays(b)) return json({ error: "invalid_profile" }, 400);
  const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first();
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

export async function uploadCvFile(request, env, user, profileId) {
  if (+request.headers.get("content-length") > CV_MAX_BYTES) return json({ error: "file_too_large", max_bytes: CV_MAX_BYTES }, 413);
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first();
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

export async function confirmSkills(request, env, user, profileId) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first();
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

export async function updateSkill(request, env, user, profileId, rawSkill) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first();
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
    try { skill = decodeURIComponent(rawSkill).trim(); } catch (_) { /* %xx hỏng → 400 */ }
    if (!skill) return json({ error: "invalid_skill" }, 400);
    stmts = [env.DB.prepare("DELETE FROM profile_skills WHERE profile_id = ? AND skill = ?").bind(profile.id, skill)];
  }
  stmts.push(env.DB.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").bind(now(), profile.id)); // T-50
  await env.DB.batch(stmts);
  const rescoreQueued = await enqueueProfileRescore(env, profile.id);
  await enqueueProfileScan(env, profile.id);
  return json({ ...(await profileWithSkills(env, profile)), rescore_queued: rescoreQueued });
}

export async function deleteCv(env, user, profileId) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?").bind(profileId, user.id).first();
  if (!profile) return json({ error: "profile_not_found" }, 404);
  return json({ ok: true, deleted_files: await deleteProfileCv(env, profile) });
}
