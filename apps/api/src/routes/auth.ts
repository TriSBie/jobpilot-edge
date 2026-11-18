import { z } from 'zod';
import type { AuthUser } from '../infra/auth.ts';
import type { ObservedEnv } from '../infra/observe.ts';
import {
  DELETE_GRACE, EMAIL_RE, cleanRef, issueSession, json, loginAttemptAllowed, makePasswordRecord, now,
  passwordError, readBody, registerAttemptAllowed, uid, verifyPassword, verifyTurnstile,
} from '../worker.js';

interface LoginBody {
  turnstile_token?: unknown;
  email?: string;
  password?: unknown;
}

interface RegisterBody extends LoginBody {
  name?: string;
  ref?: unknown;
}

interface NewPasswordBody {
  new_password?: unknown;
}

const authString = z.string();

export async function register(request: Request, env: ObservedEnv) {
  const body: RegisterBody = await readBody(request);
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

export async function loginOrRestore(request: Request, env: ObservedEnv, path: string) {
  const body: LoginBody = await readBody(request);
  if (!(await verifyTurnstile(env, body.turnstile_token, request.headers.get("cf-connecting-ip")))) return json({ error: "turnstile_failed" }, 403);
  const email = (body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  if (!body.password) return json({ error: "missing_password" }, 400);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<AuthUser>();
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

// T-15: thu hồi session
export async function logout(request: Request, env: ObservedEnv) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!token) return json({ error: "unauthorized" }, 401);
  await env.KV.delete(`session:${token}`);
  return json({ ok: true });
}

export function setPassword() {
  return json({ error: "password_setup_disabled" }, 410);
}

// T-22: token 1 lần do owner phát
export async function resetPassword(request: Request, env: ObservedEnv) {
  const body: NewPasswordBody & { token?: unknown } = await readBody(request);
  const pwErr = passwordError(body.new_password);
  if (pwErr) return json({ error: pwErr }, 400);
  const parsedToken = authString.safeParse(body.token);
  const tk = parsedToken.success ? parsedToken.data : "";
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

// T-22
export async function changePassword(request: Request, env: ObservedEnv, user: AuthUser) {
  const b: NewPasswordBody & { current_password?: unknown } = await readBody(request);
  const pwErr = passwordError(b.new_password);
  if (pwErr) return json({ error: pwErr }, 400);
  const current = authString.safeParse(b.current_password);
  if (!current.success || !current.data || !user.password_hash) return json({ error: "invalid_credentials" }, 401);
  if (!(await loginAttemptAllowed(env, user.id))) return json({ error: "too_many_attempts" }, 429);
  if (!(await verifyPassword(current.data, user.password_salt, user.password_hash))) return json({ error: "invalid_credentials" }, 401);
  const rec = await makePasswordRecord(b.new_password);
  const t0 = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, sessions_valid_after = ? WHERE id = ?").bind(rec.hash, rec.salt, now(), t0, user.id),
    env.DB.prepare("DELETE FROM login_failures WHERE user_id = ?").bind(user.id),
  ]);
  await env.KV.delete(`session:${request.headers.get("Authorization")!.slice(7)}`);
  return json(await issueSession(env, user)); // token mới (iat >= mốc) để người gọi vẫn đăng nhập
}
