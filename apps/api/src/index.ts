import { Hono, type Handler } from 'hono';
import { observe, type AppEnv } from './infra/observe.ts';
import { servePublic } from './routes/public.ts';
import { json, legacyHandlers } from './worker.js';

const app = new Hono<AppEnv>({ getPath: (request) => new URL(request.url).pathname });
app.use('*', observe);
app.onError((error) => {
  console.error('request failed', error);
  return json({ error: 'internal_error' }, 500);
});

const fallback: Handler<AppEnv> = (c) => legacyHandlers.fetch(c.req.raw, c.var.observedEnv, c.executionCtx);
const publicRoute: Handler<AppEnv> = (c, next) => c.req.raw.method === 'GET'
  ? servePublic(c.req.raw, c.var.observedEnv, c.executionCtx)
  : fallback(c, next);
app.get('/api/public/sample', publicRoute);
app.get('/api/public/try', publicRoute);
app.all('*', fallback);

export { UserHub } from './worker.js';
export default {
  fetch: app.fetch,
  scheduled: legacyHandlers.scheduled,
  queue: legacyHandlers.queue,
  email: legacyHandlers.email,
} satisfies ExportedHandler<Env>;
