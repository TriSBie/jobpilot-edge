import { Hono, type Handler, type MiddlewareHandler } from 'hono';
import { requireUser } from './infra/auth.ts';
import { observe, type AppEnv } from './infra/observe.ts';
import { changePassword, loginOrRestore, logout, register, resetPassword, setPassword } from './routes/auth.ts';
import { handleHealth } from './routes/health.ts';
import { deleteMe, exportMe, getMe, patchMe, recordConsent } from './routes/me.ts';
import {
  confirmSkills, createProfile, deleteCv, getProfiles, handleCvText, patchProfile, suggestCv, updateSkill, uploadCvFile,
} from './routes/profiles.ts';
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
// T-117c-me: chỉ đúng method cũ; HEAD/method khác đi fallback (401 không token, 404 có token). Không wildcard /api/me/*.
app.get('/api/me', publicGetOnly, requireUser, (c) => getMe(c.var.observedEnv, c.var.user));
app.patch('/api/me', requireUser, (c) => patchMe(c.req.raw, c.var.observedEnv, c.var.user));
app.delete('/api/me', requireUser, (c) => deleteMe(c.req.raw, c.var.observedEnv, c.var.user));
app.post('/api/me/consent', requireUser, (c) => recordConsent(c.req.raw, c.var.observedEnv, c.var.user));
app.get('/api/me/export', publicGetOnly, requireUser, (c) => exportMe(c.var.observedEnv, c.var.user));
// Index dùng pathname thô; HonoRequest.param() sẽ giải mã percent-encoding.
const rawProfileId = (path: string) => path.split('/')[3];
app.get('/api/profiles', publicGetOnly, requireUser, (c) => getProfiles(c.var.observedEnv, c.var.user));
app.post('/api/profiles', requireUser, (c) => createProfile(c.req.raw, c.var.observedEnv, c.var.user));
app.patch('/api/profiles/:id', requireUser, (c) => patchProfile(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path)));
app.post('/api/profiles/:id/cv-text', requireUser, (c) => handleCvText(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path)));
app.post('/api/profiles/:id/cv-suggest', requireUser, (c) => suggestCv(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path)));
app.post('/api/profiles/:id/cv-file', requireUser, (c) => uploadCvFile(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path)));
app.post('/api/profiles/:id/skills/confirm', requireUser, (c) => confirmSkills(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path)));
app.post('/api/profiles/:id/skills', requireUser, (c) => updateSkill(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path), ''));
app.delete('/api/profiles/:id/skills/:skill', requireUser, (c) => updateSkill(c.req.raw, c.var.observedEnv, c.var.user, rawProfileId(c.req.path), c.req.path.split('/')[5]));
app.delete('/api/profiles/:id/cv', requireUser, (c) => deleteCv(c.var.observedEnv, c.var.user, rawProfileId(c.req.path)));
app.all('*', fallback);

export { UserHub } from './worker.js';
export default {
  fetch: app.fetch,
  scheduled: legacyHandlers.scheduled,
  queue: legacyHandlers.queue,
  email: legacyHandlers.email,
} satisfies ExportedHandler<Env>;
