// T-117c-profiles: two synthetic users, local D1/KV/R2/queues and a fake AI binding.
const assert = require('node:assert/strict');

module.exports = async function runProfilesContract(worker, setup, fixed) {
  const { db, env, kv, points, ctx } = setup();
  const original = { log: console.log, uuid: crypto.randomUUID };
  const logs = [], requests = {}, files = new Map(), r2 = [], scores = [], scans = [], ai = [];
  const base = '/api/profiles';
  const cv = 'Java and PostgreSQL experience. '.repeat(12);
  let seq = 0;
  console.log = (...args) => logs.push(args.join(' '));
  crypto.randomUUID = () => 'profiles-fixture-' + (++seq);
  try {
    const request = async (name, method, path, status, { token = 'tok', body, raw, headers = {}, error } = {}) => {
      const h = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.2', ...headers };
      if (token) h.authorization = 'Bearer ' + token;
      const start = logs.length, pointStart = points.length;
      const response = await worker.fetch(new Request('https://api.test' + path, {
        method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      }), env, ctx);
      assert.equal(response.status, status, name);
      const text = await response.text();
      if (method === 'HEAD') assert.equal(text, '', name + ' body');
      const data = text ? JSON.parse(text) : null;
      if (error) assert.equal(data.error, error, name + ' error');
      const requestLogs = logs.slice(start).flatMap(line => {
        try { const log = JSON.parse(line); return Object.hasOwn(log, 'd1_queries') ? [log] : []; }
        catch { return []; }
      });
      const requestPoints = points.slice(pointStart).filter(point => point.blobs[0] === 'request');
      assert.equal(requestLogs.length, 1, name + ' log count');
      assert.equal(requestPoints.length, 1, name + ' request metric count');
      requests[name] = { response: { status, headers: [...response.headers].sort(), body: text }, logs: requestLogs, points: points.slice(pointStart), cacheKeys: [] };
      return data;
    };

    const list = await request('profiles original list', 'GET', base, 200);
    assert.deepEqual(list.map(p => p.id), ['p']);
    const t = fixed / 1000;
    const seedProfile = db.prepare('INSERT INTO profiles(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)');
    seedProfile.run('other', 'owner', 'Other fixture', t, t);
    seedProfile.run('raw%2Fid', 'u', 'Encoded id fixture', t, t);
    const others = () => db.prepare("SELECT * FROM profiles WHERE id='other'").get();
    const otherBefore = { ...others() };
    const listOther = await request('profiles owner list', 'GET', base, 200, { token: 'owner' });
    assert.deepEqual(listOther.map(p => p.id), ['other']);
    env.Q_SCORE = { send: async msg => scores.push(msg) };
    env.Q_INGEST = { send: async msg => scans.push(msg) };
    env.FILES = {
      put: async (key, value, options) => {
        const size = typeof value === 'string' ? value.length : value.byteLength;
        r2.push({ put: key, size, contentType: options.httpMetadata.contentType });
        files.set(key, { text: typeof value === 'string' ? value : null });
      },
      get: async key => files.has(key) ? { text: async () => files.get(key).text ?? '' } : null,
      delete: async key => { r2.push({ delete: key }); files.delete(key); },
    };
    env.AI = { run: async (_model, { messages }) => {
      const instruction = messages.at(-1).content;
      ai.push(instruction.includes('reason in English') ? 'en' : instruction.includes('reason in Vietnamese') ? 'vi' : 'extract');
      return { response: '{"suggestions":[]}' };
    } };

    for (const [method, suffix, body] of [
      ['PATCH', '', { name: 'ignored' }],
      ['POST', '/cv-text', { text: cv }],
      ['POST', '/cv-suggest', { job_id: 'job' }],
      ['POST', '/cv-file', undefined],
      ['POST', '/skills/confirm', { skills: [{ skill: 'Java' }] }],
      ['POST', '/skills', { skill: 'Java' }],
      ['DELETE', '/skills/Java', undefined],
      ['DELETE', '/cv', undefined],
    ]) {
      await request('profiles other ' + method + suffix, method, base + '/other' + suffix, 404,
        { body, raw: suffix === '/cv-file' ? 'PDF' : undefined, error: 'profile_not_found' });
    }
    assert.deepEqual({ ...others() }, otherBefore, 'cannot change another user profile');
    assert.equal(files.size + scores.length + scans.length + ai.length, 0, 'no external effects for another profile');
    await request('profiles patch malformed arrays precede ownership', 'PATCH', base + '/other', 400,
      { body: { locations: 'invalid' }, error: 'invalid_profile' });
    await request('profiles create invalid array', 'POST', base, 400, { body: { target_roles: [3] }, error: 'invalid_profile' });
    await request('profiles original invalid body', 'POST', base, 400, { body: { locations: 'bad' }, error: 'invalid_profile' });
    await request('profiles create empty', 'POST', base, 201, { body: {} });
    await request('profiles create malformed JSON', 'POST', base, 201, { raw: '{' });
    await request('profiles create text/plain JSON', 'POST', base, 201,
      { headers: { 'content-type': 'text/plain' }, body: { name: 'Plain fixture', target_roles: ['Fixture role'] } });
    await request('profiles patch raw encoded id', 'PATCH', base + '/raw%2Fid', 200, { body: { name: 'Raw ID fixture' } });
    const patch = await request('profiles patch enqueues rescore', 'PATCH', base + '/p', 200,
      { body: { level: 'senior', salary_min: 25, target_roles: ['Different fixture role'] } });
    assert.equal(patch.rescore_queued, true);
    assert.ok(scores.some(msg => msg.kind === 'rescore_profile' && msg.profileId === 'p'), 'PATCH queues rescore');

    const pdfMax = 5242880;
    await request('profiles cv file header first', 'POST', base + '/missing/cv-file', 413,
      { raw: 'PDF', headers: { 'content-length': String(pdfMax + 1) }, error: 'file_too_large' });
    await request('profiles cv text consent first', 'POST', base + '/p/cv-text', 403, { body: { text: cv }, error: 'cv_consent_required' });
    await request('profiles cv file consent', 'POST', base + '/p/cv-file', 403, { raw: 'PDF', error: 'cv_consent_required' });
    assert.equal(files.size, 0, 'no R2 writes without consent');
    await request('profiles cv suggest missing job', 'POST', base + '/p/cv-suggest', 404,
      { body: {}, error: 'job_not_found' });
    await request('profiles cv suggest missing CV', 'POST', base + '/p/cv-suggest', 409,
      { body: { job_id: 'job' }, error: 'no_cv' });
    db.prepare('UPDATE users SET consent_cv_at=?, ai_opt_out=1 WHERE id=?').run(t, 'u');
    await request('profiles cv text too short', 'POST', base + '/p/cv-text', 400, { body: { text: 'tiny' }, error: 'cv_text_too_short' });
    await request('profiles cv text too long', 'POST', base + '/p/cv-text', 413, { body: { text: 'x'.repeat(200001) }, error: 'text_too_long' });
    await request('profiles cv file oversized body', 'POST', base + '/p/cv-file', 413, { raw: new Uint8Array(pdfMax + 1), error: 'file_too_large' });
    await request('profiles cv file success', 'POST', base + '/p/cv-file', 200, { raw: 'PDF', headers: { 'x-filename': 'fixture.pdf' } });
    await request('profiles cv text opt out', 'POST', base + '/p/cv-text', 200, { body: { text: cv } });
    const optedOut = await request('profiles cv suggest opt out', 'POST', base + '/p/cv-suggest', 200, { body: { job_id: 'job' } });
    assert.equal(optedOut.ai_used, false);
    assert.deepEqual(ai, [], 'AI opted-out user never calls the AI mock');
    db.prepare("UPDATE users SET ai_opt_out=0 WHERE id='u'").run();
    await request('profiles cv suggest query language', 'POST', base + '/p/cv-suggest?lang=en', 200, { body: { job_id: 'job' } });
    await request('profiles cv suggest accept language cache', 'POST', base + '/p/cv-suggest', 200,
      { headers: { 'accept-language': 'en-GB' }, body: { job_id: 'job' } });
    await request('profiles cv suggest explicit language wins', 'POST', base + '/p/cv-suggest?lang=vi', 200,
      { headers: { 'accept-language': 'en-GB' }, body: { job_id: 'job' } });
    assert.deepEqual(ai, ['en', 'vi']);
    for (const key of kv.keys()) if (key.startsWith('cvsug:') && key.endsWith(':en')) kv.delete(key);
    kv.set('cvsugrl:u:' + Math.floor(t / 86400), '15');
    await request('profiles cv suggest rate limit', 'POST', base + '/p/cv-suggest?lang=en', 429,
      { body: { job_id: 'job' }, error: 'rate_limited' });
    await request('profiles cv delete success', 'DELETE', base + '/p/cv', 200);
    assert.equal(files.size, 0, 'CV text and PDF removed');

    await request('profiles skills confirm', 'POST', base + '/p/skills/confirm', 200, { body: { skills: [{ skill: 'Java', weight: 4 }] } });
    await request('profiles skill invalid', 'POST', base + '/p/skills', 400, { body: { skill: '' }, error: 'invalid_skill' });
    for (const skill of ['Kỹ năng / nền', 'Percent%2F']) {
      await request('profiles skill save ' + skill, 'POST', base + '/p/skills', 200, { body: { skill } });
      await request('profiles skill delete ' + skill, 'DELETE', base + '/p/skills/' + encodeURIComponent(skill), 200);
      assert.equal(db.prepare("SELECT 1 FROM profile_skills WHERE profile_id='p' AND skill=?").get(skill), undefined, 'delete uses one decode');
    }
    await request('profiles skill malformed encoding', 'DELETE', base + '/p/skills/%XY', 400, { error: 'invalid_skill' });
    await request('profiles skill decoded whitespace', 'DELETE', base + '/p/skills/%20', 400, { error: 'invalid_skill' });

    for (const [path, methods] of [[base, ['PUT', 'PATCH', 'DELETE', 'HEAD']], [base + '/p', ['GET', 'PUT', 'POST', 'HEAD']]]) {
      for (const method of methods) {
        await request('profiles fallback anonymous ' + method + path, method, path, 401, { token: null });
        await request('profiles fallback authenticated ' + method + path, method, path, 404);
      }
    }
    await request('profiles GET anonymous', 'GET', base, 401, { token: null });
    await request('profiles OPTIONS', 'OPTIONS', base, 200, { token: null });
    await request('profiles trailing slash', 'GET', base + '/', 404, { error: 'not_found' });
    await request('profiles upper case', 'GET', '/api/Profiles', 404, { error: 'not_found' });
    await request('profiles other subpath', 'GET', base + '/p/other', 401, { token: null, error: 'unauthorized' });
    await request('profiles me fallback', 'GET', '/api/me', 200);
    await request('profiles Telegram fallback', 'GET', '/api/me/telegram/bot', 200);
    return { requests, effects: {
      profiles: db.prepare('SELECT * FROM profiles ORDER BY id').all().map(row => ({ ...row })),
      skills: db.prepare('SELECT * FROM profile_skills ORDER BY profile_id,skill').all().map(row => ({ ...row })),
      files: db.prepare('SELECT * FROM files ORDER BY id').all().map(row => ({ ...row })),
      r2, kv: [...kv], scores, scans, ai,
    } };
  } finally {
    crypto.randomUUID = original.uuid;
    console.log = original.log;
    db.close();
  }
};
