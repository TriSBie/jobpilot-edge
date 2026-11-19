import type { AuthUser } from '../infra/auth.ts';
import type { ObservedEnv } from '../infra/observe.ts';
import { CORS, DELETE_GRACE, exportUserData, isOwner, json, now, profileWithSkills, readBody, verifyPassword } from '../worker.js';

// T-117c-me: shape trả về của GET /api/me; không thêm trường bí mật (password_*, telegram_chat_id, token_enc).
interface MeSummary {
  user: {
    id: string;
    email: string;
    name: string;
    is_owner: boolean;
    consent_cv_at: number | null;
    ai_opt_out: 0 | 1;
    telegram_linked: boolean;
    telegram_bot: { username: string; status: string; last_error: string | null } | null;
    unread_count: number;
    has_attention: boolean;
    jobs_seen_at: number | null;
  };
  profiles: unknown[];
}
interface OwnBotRow { username: string; status: string; last_error: string | null }
interface UnreadRow { n: number; a: number }
// readBody nuốt JSON hỏng thành {} → mọi trường đều có thể thiếu hoặc sai kiểu.
interface PatchMeBody { ai_opt_out?: unknown; jobs_seen?: unknown }
interface ConsentBody { kind?: unknown }
interface DeleteMeBody { password?: unknown }
const AI_OPT_OUT_VALUES: unknown[] = [0, 1, true, false];

export async function getMe(env: ObservedEnv, user: AuthUser) {
  const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
  const profiles = [];
  for (const p of results) profiles.push(await profileWithSkills(env, p));
  const ownBot = await env.DB.prepare("SELECT username, status, last_error FROM user_bots WHERE user_id = ?").bind(user.id).first<OwnBotRow>();
  const nf = (await env.DB.prepare("SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM notifications WHERE user_id = ?1 AND is_read = 0 LIMIT 10)) AS n, EXISTS (SELECT 1 FROM notifications WHERE user_id = ?1 AND type = 'bot_broken' AND is_read = 0) AS a").bind(user.id).first<UnreadRow>())!;
  const body: MeSummary = { user: { id: user.id, email: user.email, name: user.name, is_owner: isOwner(env, user),
    consent_cv_at: user.consent_cv_at, ai_opt_out: user.ai_opt_out ? 1 : 0, telegram_linked: !!user.telegram_chat_id,
    telegram_bot: ownBot ? { username: ownBot.username, status: ownBot.status, last_error: ownBot.last_error } : null,
    unread_count: nf.n, has_attention: !!nf.a, jobs_seen_at: user.jobs_seen_at ?? null }, profiles };
  return json(body);
}

export async function recordConsent(request: Request, env: ObservedEnv, user: AuthUser) {
  const b: ConsentBody = await readBody(request);
  if (b.kind !== "cv") return json({ error: "unknown_consent" }, 400);
  const r = (await env.DB.prepare("UPDATE users SET consent_cv_at = COALESCE(consent_cv_at, ?) WHERE id = ? RETURNING consent_cv_at")
    .bind(now(), user.id).first<{ consent_cv_at: number }>())!;
  return json({ consent_cv_at: r.consent_cv_at });
}

export async function patchMe(request: Request, env: ObservedEnv, user: AuthUser) {
  const b: PatchMeBody = await readBody(request);
  if (b.jobs_seen !== undefined && b.jobs_seen !== true) return json({ error: "invalid_jobs_seen" }, 400);
  if ((b.ai_opt_out !== undefined || b.jobs_seen !== true) && !AI_OPT_OUT_VALUES.includes(b.ai_opt_out)) return json({ error: "invalid_ai_opt_out" }, 400);
  const out: { ai_opt_out?: 0 | 1; jobs_seen_at?: number } = {}, stmts: D1PreparedStatement[] = [];
  if (b.ai_opt_out !== undefined) { out.ai_opt_out = b.ai_opt_out ? 1 : 0; stmts.push(env.DB.prepare("UPDATE users SET ai_opt_out = ? WHERE id = ?").bind(out.ai_opt_out, user.id)); }
  if (b.jobs_seen) { out.jobs_seen_at = now(); stmts.push(env.DB.prepare("UPDATE users SET jobs_seen_at = ? WHERE id = ?").bind(out.jobs_seen_at, user.id)); } // giờ do server đặt
  await env.DB.batch(stmts);
  return json(out);
}

export async function deleteMe(request: Request, env: ObservedEnv, user: AuthUser) {
  const b: DeleteMeBody = await readBody(request);
  if (!b.password || !(await verifyPassword(b.password, user.password_salt, user.password_hash))) return json({ error: "invalid_credentials" }, 401);
  await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(now(), user.id).run();
  await env.KV.delete(`session:${request.headers.get("Authorization")!.slice(7)}`);
  return json({ ok: true, restore_until: now() + DELETE_GRACE });
}

export async function exportMe(env: ObservedEnv, user: AuthUser) {
  return new Response(JSON.stringify(await exportUserData(env, user)), {
    headers: { ...CORS, "content-type": "application/json", "content-disposition": `attachment; filename="jobpilot-export-${new Date().toISOString().slice(0, 10)}.json"` },
  });
}
