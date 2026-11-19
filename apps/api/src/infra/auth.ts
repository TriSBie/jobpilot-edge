import type { MiddlewareHandler } from 'hono';
import { getUser, json, now } from '../worker.js';
import type { AppEnv, ObservedEnv } from './observe.ts';

export interface AuthUser {
  id: string;
  last_active_day: number | null;
  password_hash: string | null;
  password_salt: string | null;
  deleted_at: number | null;
  // T-117c-me: các cột users mà /api/me đọc (row vẫn là SELECT * FROM users).
  email: string;
  name: string;
  consent_cv_at: number | null;
  ai_opt_out: number;
  telegram_chat_id: string | null;
  jobs_seen_at: number | null;
}
type AuthEnv = AppEnv & { Variables: { user: AuthUser } };

export async function getActiveUser(request: Request, env: ObservedEnv) {
  const user: AuthUser | null = await getUser(request, env);
  if (!user) return null;

  // T-88: ghi ngày hoạt động tối đa 1 lần/ngày/user (chỉ khi khác hôm nay), không ghi mỗi request.
  const today = Math.floor(now() / 86400);
  if (user.last_active_day !== today) {
    await env.DB.prepare("UPDATE users SET last_active_day = ? WHERE id = ?").bind(today, user.id).run();
    user.last_active_day = today;
  }
  return { user, today };
}

export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const activeUser = await getActiveUser(c.req.raw, c.var.observedEnv);
  if (!activeUser) return json({ error: "unauthorized" }, 401);
  c.set('user', activeUser.user);
  await next();
};
