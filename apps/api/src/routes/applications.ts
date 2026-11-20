// @ts-nocheck — T-117c-applications: commit di chuyển, thêm kiểu ở commit kế tiếp.
import {
  APP_STAGES, AUTO_CLOSE_DAYS, IV_KINDS, IV_OWNED, ivFields, ivRow,
  json, noAdminNote, now, ownsProfile, readBody, uid,
} from '../worker.js';

export async function getApplications(url, env, user) {
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

export async function createApplication(request, env, user) {
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
export async function quickApply(request, env, user) {
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

export async function patchApplication(request, env, user, applicationId) {
  const b = await readBody(request);
  const app = await env.DB.prepare("SELECT a.* FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE a.id = ? AND p.user_id = ?").bind(applicationId, user.id).first();
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
export async function handleApplicationInterviews(request, env, user, applicationId) {
  const app = await env.DB.prepare("SELECT a.id, a.stage FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE a.id = ? AND p.user_id = ?").bind(applicationId, user.id).first();
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

export async function handleInterview(request, env, user, interviewId) {
  const iv = await env.DB.prepare(`SELECT id FROM interviews WHERE id = ? AND application_id IN (${IV_OWNED})`).bind(interviewId, user.id).first();
  if (!iv) return json({ error: "interview_not_found" }, 404);
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM interviews WHERE id = ?").bind(iv.id).run();
    return json({ ok: true });
  }
  // T-121: PATCH interview giữ 400 cho JSON hợp lệ nhưng không phải object.
  const { error, f } = ivFields(await request.json().catch(() => ({})));
  if (error) return json({ error }, 400);
  const keys = Object.keys(f); // chỉ khoá đã qua ivFields (whitelist), an toàn để ghép tên cột
  const row = keys.length
    ? await env.DB.prepare(`UPDATE interviews SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`).bind(...keys.map((k) => f[k]), iv.id).first()
    : await env.DB.prepare("SELECT * FROM interviews WHERE id = ?").bind(iv.id).first();
  return json(ivRow(row));
}
