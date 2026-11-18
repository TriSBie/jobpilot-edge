import { Hono, type Handler, type MiddlewareHandler } from 'hono';
import { requireUser } from './infra/auth.ts';
import { observe, type AppEnv } from './infra/observe.ts';
import { changePassword, loginOrRestore, logout, register, resetPassword, setPassword } from './routes/auth.ts';
import { handleHealth } from './routes/health.ts';
import { servePublic, validateTry } from './routes/public.ts';
import { handleRum } from './routes/rum.ts';
import { json, legacyHandlers } from './worker.js';

const app = new Hono<AppEnv>({ getPath: (request) => new URL(request.url).pathname });
app.use('*', observe);
app.onError((error) => {
  console.error('request failed', error);
  return json({ error: 'internal_error' }, 500);
});

const fallback: Handler<AppEnv> = (c) => legacyHandlers.fetch(c.req.raw, c.var.observedEnv, c.executionCtx);
app.post('/api/rum', (c) => handleRum(c.req.raw, c.var.observedEnv));
app.all('/api/health', (c, next) => c.req.raw.method === 'OPTIONS'
  ? fallback(c, next)
  : handleHealth(c.var.observedEnv));

// Hono dùng route GET cho HEAD, còn contract legacy chỉ chuyển GET thực sự.
const publicGetOnly: MiddlewareHandler<AppEnv> = (c, next) => c.req.raw.method === 'GET'
  ? next()
  : fallback(c, next);
app.get('/api/public/sample', publicGetOnly, (c) => servePublic(c.req.raw, c.var.observedEnv, c.executionCtx));
app.get('/api/public/try', publicGetOnly, validateTry, (c) => (
  servePublic(c.req.raw, c.var.observedEnv, c.executionCtx, c.req.valid('query'))
));
app.post('/api/auth/register', (c) => register(c.req.raw, c.var.observedEnv));
app.post('/api/auth/login', (c) => loginOrRestore(c.req.raw, c.var.observedEnv, c.req.path));
app.post('/api/auth/restore', (c) => loginOrRestore(c.req.raw, c.var.observedEnv, c.req.path));
app.post('/api/auth/logout', (c) => logout(c.req.raw, c.var.observedEnv));
app.post('/api/auth/set-password', setPassword);
app.post('/api/auth/reset-password', (c) => resetPassword(c.req.raw, c.var.observedEnv));
app.post('/api/auth/change-password', requireUser, (c) => changePassword(c.req.raw, c.var.observedEnv, c.var.user));
app.all('*', fallback);

export { UserHub } from './worker.js';
export default {
  fetch: app.fetch,
  scheduled: legacyHandlers.scheduled,
  queue: legacyHandlers.queue,
  email: legacyHandlers.email,
} satisfies ExportedHandler<Env>;
