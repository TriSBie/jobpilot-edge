import type { MiddlewareHandler } from 'hono';
import { metric, observeEnv, observedRoute, sha256hex } from '../worker.js';

interface RequestState {
  d1_queries: number;
  cache: 'unknown' | 'hit' | 'miss';
  userId: string | null;
}

export type ObservedEnv = Env & { __trace: RequestState };
export type AppEnv = { Bindings: Env; Variables: { observedEnv: ObservedEnv } };

export async function observeRequest(
  request: Request,
  env: Env,
  run: (env: ObservedEnv) => Promise<Response>,
) {
  const started = Date.now(), state: RequestState = { d1_queries: 0, cache: "unknown", userId: null };
  const observed = observeEnv(env, state) as ObservedEnv;
  const route = observedRoute(new URL(request.url).pathname);
  const response = await run(observed);
  try {
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(request.method) ? request.method : "OTHER";
    const user_hash = state.userId ? await sha256hex(state.userId) : null;
    const ms = Date.now() - started;
    console.log(JSON.stringify({ route, method, status: response.status, ms, d1_queries: state.d1_queries, cache: state.cache, user_hash }));
    metric(observed, "request", route, [ms, response.status]);
  } catch (_) { /* Request telemetry must not change the response. */ }
  return response;
}

// Middleware Hono và entry JS dùng chung wrapper; fallback Hono gọi handler chưa bọc.
export const observe: MiddlewareHandler<AppEnv> = async (c, next) => {
  await observeRequest(c.req.raw, c.env, async (env) => {
    c.set('observedEnv', env);
    await next();
    return c.res;
  });
};
