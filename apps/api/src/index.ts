import { Hono } from 'hono';
import legacy from './worker.js';

const app = new Hono<{ Bindings: Env }>();

// T-117b: mọi route còn do Worker cũ xử lý cho tới khi chuyển từng nhóm.
app.all('*', (c) => legacy.fetch(c.req.raw, c.env, c.executionCtx));

export { UserHub } from './worker.js';
export default {
  fetch: app.fetch,
  scheduled: legacy.scheduled,
  queue: legacy.queue,
  email: legacy.email,
} satisfies ExportedHandler<Env>;
