// T-117c-applications: contract của entry với fixture hai người dùng trên SQLite RAM.
const assert = require('node:assert/strict');

module.exports = async function runApplicationsContract(worker, setup, fixed) {
  const { db, env, kv, points, waits, ctx } = setup();
  const t = fixed / 1000;
  const requests = {}, logs = [], external = [];
  const original = { log: console.log, uuid: crypto.randomUUID, fetch: globalThis.fetch };
  let seq = 0;
  console.log = (...args) => logs.push(args.join(' '));
  crypto.randomUUID = () => 'application-fixture-' + (++seq);
  globalThis.fetch = async () => { external.push('fetch'); throw new Error('unexpected outbound request'); };
  try {
    env.FILES = { get: async () => external.push('R2.get'), put: async () => external.push('R2.put'), delete: async () => external.push('R2.delete') };
    env.Q_SCORE = { send: async () => external.push('Q_SCORE.send') };
    env.Q_INGEST = { send: async () => external.push('Q_INGEST.send') };
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare("INSERT INTO profiles (id,user_id,name,created_at,updated_at) VALUES ('other','owner','Other',?,?),('empty','u','Empty',?,?)").run(t,t,t,t);
    db.prepare("UPDATE users SET last_active_day = NULL WHERE id = 'u'").run();
    const seedJob = db.prepare("INSERT INTO jobs (id,source_url,title,company,content_hash,first_seen_at,created_at,submitted_by) VALUES (?,?,?,'Fixture',?,?,?,?)");
    for (const [id, owner] of [['fresh', null], ['raw-job', null], ['offer-job', null], ['quick-new', null], ['quick-open', null], ['private-a', 'u'], ['private-b', 'owner']]) {
      seedJob.run(id, 'https://fixture.invalid/' + id, id, 'hash-' + id, t, t, owner);
    }
    db.prepare("UPDATE applications SET admin_note='internal only' WHERE id='app'").run();
    const seedApp = db.prepare("INSERT INTO applications (id,profile_id,job_id,stage,applied_at,created_at,updated_at,admin_note) VALUES (?,?,?,?,?,?,?,?)");
    seedApp.run('other-app', 'other', 'private-b', 'applied', t - 300, t - 400, t - 300, 'other internal note');
    seedApp.run('offer-app', 'p', 'offer-job', 'offer', t - 900, t - 1000, t - 500, 'offer internal note');
    seedApp.run('raw%2Fapp', 'p', 'raw-job', 'new', null, t - 600, t - 600, null);
    const seedInterview = db.prepare("INSERT INTO interviews (id,application_id,kind,round_label,scheduled_at,result,checklist,created_at) VALUES (?,?,?, ?,?,?,'[]',?)");
    for (const [id, app, kind, scheduled, result, created] of [
      ['iv-past', 'app', 'screen', t - 100, 'pass', t - 200],
      ['iv-later', 'app', 'technical', t + 300, 'pending', t - 100],
      ['iv-soon', 'app', 'hr', t + 100, 'pending', t - 150],
      ['iv-unset', 'app', null, 0, 'pending', t - 160],
      ['raw%2Fiv', 'raw%2Fapp', 'hr', 0, 'pending', t - 200],
      ['other-iv', 'other-app', 'hr', 0, 'pending', t - 200],
    ]) seedInterview.run(id, app, kind, id, scheduled, result, created);

    const snapshot = () => ({
      users: db.prepare('SELECT id,last_active_day FROM users ORDER BY id').all().map(r => ({ ...r })),
      applications: db.prepare('SELECT * FROM applications ORDER BY id').all().map(r => ({ ...r })),
      interviews: db.prepare('SELECT * FROM interviews ORDER BY id').all().map(r => ({ ...r })),
      events: db.prepare('SELECT * FROM application_events ORDER BY id').all().map(r => ({ ...r })),
      kv: [...kv.entries()].sort(),
    });
    const getApp = id => db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    const base = '/api/applications';
    const interviews = base + '/app/interviews', interview = '/api/interviews/iv-soon';
    const quick = base + '/quick', patch = base + '/app';
    const request = async (name, method, path, status, { token = 'tok', body, raw, error, headers = {} } = {}) => {
      assert.ok(!Object.hasOwn(requests, name), name + ' duplicate case');
      const before = snapshot();
      const init = { method, headers: { 'content-type': 'application/json', ...headers } };
      if (token) init.headers.authorization = 'Bearer ' + token;
      if (raw !== undefined || body !== undefined) init.body = raw ?? JSON.stringify(body);
      const logStart = logs.length, pointStart = points.length;
      const response = await worker.fetch(new Request('https://api.test' + path, init), env, ctx);
      await Promise.all(waits.splice(0));
      const text = await response.text();
      const data = text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
      assert.equal(response.status, status, name);
      if (error) assert.equal(data.error, error, name + ' error');
      if (method === 'HEAD') assert.equal(text, '', name + ' body');
      if (data) assert.ok(!JSON.stringify(data).includes('"admin_note"'), name + ' user response omits admin_note');
      const requestLogs = logs.slice(logStart).flatMap(line => {
        try { const log = JSON.parse(line); return Object.hasOwn(log, 'd1_queries') ? [log] : []; }
        catch { return []; }
      });
      const requestPoints = points.slice(pointStart);
      assert.equal(requestLogs.length, 1, name + ' request log');
      assert.equal(requestPoints.filter(point => point.blobs[0] === 'request').length, 1, name + ' request metric');
      const effects = {};
      for (const [table, after] of Object.entries(snapshot())) {
        const rows = before[table];
        const previous = new Map(rows.map(r => [r.id ?? r[0], r]));
        const changed = after.filter(r => JSON.stringify(r) !== JSON.stringify(previous.get(r.id ?? r[0])));
        const keys = new Set(after.map(r => r.id ?? r[0]));
        const removed = [...previous.keys()].filter(id => !keys.has(id));
        if (changed.length || removed.length) effects[table] = { changed, removed };
      }
      requests[name] = { response: { status, headers: [...response.headers].sort(), body: text }, log: requestLogs[0], points: requestPoints, effects };
      return data;
    };

    const list = await request('list legacy array', 'GET', base + '?profile_id=p', 200);
    assert.ok(Array.isArray(list), 'list without stats still returns an array');
    const appItem = list.find(row => row.id === 'app');
    assert.deepEqual(appItem.next_interview.id, 'iv-soon');
    assert.deepEqual(appItem.rounds, { done: 1, total: 4 });
    assert.deepEqual(appItem.match, { final_score: 90, tier: 'strong' });
    const stats = await request('list opt-in stats', 'GET', base + '?profile_id=p&stats=1', 200);
    assert.deepEqual(stats.items, list);
    assert.deepEqual(stats.stats, { applied: 0, interview: 0, offer: 1, rejected: 0, silent_14d: 0, prev: { applied: 0, interview: 0, offer: 0, rejected: 0 } });
    await request('list stats exact flag', 'GET', base + '?profile_id=p&stats=true', 200);
    await request('list empty profile', 'GET', base + '?profile_id=empty&stats=1', 200);
    await request('list missing profile query', 'GET', base + '?stats=1', 400, { error: 'profile_id_required' });
    await request('list other profile', 'GET', base + '?profile_id=other', 404, { error: 'profile_not_found' });

    const routes = [
      ['GET', base + '?profile_id=p'], ['POST', base], ['POST', quick], ['PATCH', patch],
      ['GET', interviews], ['POST', interviews], ['PATCH', interview], ['DELETE', interview],
    ];
    for (const [method, route] of routes) {
      await request(method + ' ' + route + ' no session', method, route, 401, { token: null, error: 'unauthorized' });
      await request(method + ' ' + route + ' invalid session', method, route, 401, { token: 'invalid', error: 'unauthorized' });
    }
    for (const route of new Set(routes.map(([, route]) => route))) {
      const preflight = { origin: 'https://fixture.invalid', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type,authorization' };
      await request('OPTIONS ' + route, 'OPTIONS', route, 200, { token: null, headers: preflight });
      await request('PUT ' + route + ' anonymous', 'PUT', route, 401, { token: null, error: 'unauthorized' });
      await request('PUT ' + route, 'PUT', route, 404, { error: 'not_found' });
      await request('HEAD ' + route + ' anonymous', 'HEAD', route, 401, { token: null });
      await request('HEAD ' + route, 'HEAD', route, 404);
    }
    await request('no trailing slash alias', 'GET', base + '/?profile_id=p', 404, { error: 'not_found' });
    await request('no encoded collection alias', 'GET', '/api/%61pplications?profile_id=p', 404, { error: 'not_found' });

    const otherBefore = snapshot();
    await request('other application patch', 'PATCH', base + '/other-app', 404, { body: { stage: 'applied', note: 'fixture' }, error: 'application_not_found' });
    await request('other application interviews list', 'GET', base + '/other-app/interviews', 404, { error: 'application_not_found' });
    await request('other application interviews create', 'POST', base + '/other-app/interviews', 404, { body: { kind: 'hr' }, error: 'application_not_found' });
    await request('other interview patch', 'PATCH', '/api/interviews/other-iv', 404, { body: { result: 'pass' }, error: 'interview_not_found' });
    await request('other interview delete', 'DELETE', '/api/interviews/other-iv', 404, { error: 'interview_not_found' });
    await request('other profile before stage', 'POST', base, 404, { body: { profile_id: 'other', job_id: 'job', stage: 'unknown' }, error: 'profile_not_found' });
    await request('other profile before action', 'POST', quick, 404, { body: { profile_id: 'other', job_id: 'job', action: 'unknown' }, error: 'profile_not_found' });
    await request('private job rejected', 'POST', base, 404, { body: { profile_id: 'p', job_id: 'private-b' }, error: 'job_not_found' });
    await request('quick private job before action', 'POST', quick, 404, { body: { profile_id: 'p', job_id: 'private-b', action: 'unknown' }, error: 'job_not_found' });
    assert.deepEqual(snapshot(), otherBefore, 'denied requests leave fixture data unchanged');

    await request('create malformed JSON', 'POST', base, 404, { raw: '{', error: 'profile_not_found' });
    await request('create stage before job', 'POST', base, 400, { body: { profile_id: 'p', job_id: 'missing', stage: 'unknown' }, error: 'invalid_stage' });
    await request('create missing job', 'POST', base, 404, { body: { profile_id: 'p', job_id: 'missing' }, error: 'job_not_found' });
    const fresh = await request('create default stage', 'POST', base, 201, { body: { profile_id: 'p', job_id: 'fresh', note: 'first note' } });
    assert.equal(fresh.stage, 'new');
    await request('create own private job', 'POST', base, 201, { body: { profile_id: 'p', job_id: 'private-a' } });
    const upsert = await request('upsert existing application', 'POST', base, 201, { body: { profile_id: 'p', job_id: 'job', stage: 'new' } });
    assert.equal(upsert.id, 'app');
    assert.equal(getApp('app').admin_note, 'internal only');

    await request('quick invalid action', 'POST', quick, 400, { body: { profile_id: 'p', job_id: 'job', action: 'unknown' }, error: 'invalid_action' });
    const open = await request('quick open new', 'POST', quick, 200, { body: { profile_id: 'p', job_id: 'quick-open', action: 'open' } });
    assert.equal(open.stage, 'saved');
    await request('quick open preserves offer', 'POST', quick, 200, { body: { profile_id: 'p', job_id: 'offer-job', action: 'open' } });
    const applied = await request('quick applied new', 'POST', quick, 200, { body: { profile_id: 'p', job_id: 'quick-new', action: 'applied' } });
    assert.equal(applied.applied_at, t);
    assert.equal(applied.next_follow_up_at, t + 7 * 86400);
    await request('quick applied upgrades saved', 'POST', quick, 200, { body: { profile_id: 'p', job_id: 'quick-open', action: 'applied' } });
    await request('quick applied preserves offer', 'POST', quick, 200, { body: { profile_id: 'p', job_id: 'offer-job', action: 'applied' } });

    await request('patch ownership before stage', 'PATCH', base + '/missing', 404, { body: { stage: 'unknown' }, error: 'application_not_found' });
    await request('patch invalid stage', 'PATCH', patch, 400, { body: { stage: null }, error: 'invalid_stage' });
    await request('patch raw id', 'PATCH', base + '/raw%2Fapp', 200, { body: { note: 'raw path' } });
    await request('patch first applied', 'PATCH', patch, 200, { body: { stage: 'applied', note: 'note', next_follow_up_at: t + 50 } });
    await request('patch follow-up preserved', 'PATCH', patch, 200, { body: { stage: 'offer' } });
    assert.equal(getApp('app').next_follow_up_at, t + 50);
    await request('patch clear follow-up', 'PATCH', patch, 200, { body: { stage: 'applied', next_follow_up_at: null } });
    assert.equal(getApp('app').applied_at, t);
    assert.equal(getApp('app').next_follow_up_at, null);
    await request('patch malformed JSON', 'PATCH', patch, 200, { raw: '{' });
    await request('patch JSON null', 'PATCH', patch, 200, { body: null });

    const rounds = await request('interviews ordered', 'GET', interviews, 200);
    assert.deepEqual(rounds.map(r => r.id), ['iv-past', 'iv-soon', 'iv-later', 'iv-unset']);
    await request('interviews owned raw path', 'GET', base + '/raw%2Fapp/interviews', 200);
    await request('interview create ownership before kind', 'POST', base + '/missing/interviews', 404, { body: {}, error: 'application_not_found' });
    await request('interview create malformed JSON', 'POST', interviews, 400, { raw: '{', error: 'invalid_kind' });
    await request('interview create JSON null', 'POST', interviews, 400, { body: null, error: 'invalid_kind' });
    await request('interview create missing kind', 'POST', interviews, 400, { body: {}, error: 'invalid_kind' });
    await request('interview create invalid kind', 'POST', interviews, 400, { body: { kind: 'unknown' }, error: 'invalid_kind' });
    await request('interview create invalid label', 'POST', interviews, 400, { body: { kind: 'hr', round_label: '' }, error: 'invalid_round_label' });
    await request('interview create invalid note', 'POST', interviews, 400, { body: { kind: 'hr', note: 3 }, error: 'invalid_note' });
    await request('interview create invalid schedule', 'POST', interviews, 400, { body: { kind: 'hr', scheduled_at: -1 }, error: 'invalid_scheduled_at' });
    const created = await request('interview create defaults', 'POST', interviews, 201, { body: { kind: 'hr', result: 'fail', checklist: 'discarded' } });
    assert.equal(created.result, 'pending');
    assert.ok(created.checklist.length && created.checklist.every(row => row.done === false));
    assert.equal(getApp('app').stage, 'interview');
    await request('interview create preserves offer', 'POST', base + '/offer-app/interviews', 201, { body: { kind: 'offer' } });
    assert.equal(getApp('offer-app').stage, 'offer');

    await request('interview patch ownership before body', 'PATCH', '/api/interviews/missing', 404, { body: null, error: 'interview_not_found' });
    for (const body of [null, [], 5, 'text', true]) {
      await request('interview patch non-object ' + JSON.stringify(body), 'PATCH', interview, 400, { body, error: 'invalid_body' });
    }
    for (const [key, value] of Object.entries({ kind: 'unknown', round_label: ' ', note: 4, scheduled_at: '1', result: 'unknown', checklist: [{ text: 'x', done: 'yes' }] })) {
      await request('interview patch invalid ' + key, 'PATCH', interview, 400, { body: { [key]: value }, error: 'invalid_' + key });
    }
    await request('interview patch malformed JSON', 'PATCH', interview, 200, { raw: '{' });
    await request('interview patch ignores unknown columns', 'PATCH', interview, 200, { body: { application_id: 'other-app' } });
    const updated = await request('interview patch allowed columns', 'PATCH', interview, 200, { body: {
      kind: 'technical', round_label: '  Round  ', scheduled_at: 0, result: 'pass', note: null, checklist: [{ text: '  Check  ', done: true }], application_id: 'other-app',
    } });
    assert.equal(updated.application_id, 'app');
    assert.equal(updated.round_label, 'Round');
    assert.deepEqual(updated.checklist, [{ text: 'Check', done: true }]);
    await request('interview patch raw id', 'PATCH', '/api/interviews/raw%2Fiv', 200, { body: { note: 'raw path' } });
    assert.deepEqual(await request('interview delete owned', 'DELETE', interview, 200), { ok: true });
    await request('interview delete missing', 'DELETE', interview, 404, { error: 'interview_not_found' });
    assert.deepEqual(external, [], 'no network, R2 or queue activity');
    assert.deepEqual([...kv.entries()].sort(), otherBefore.kv, 'sessions unchanged');
    return requests;
  } finally {
    console.log = original.log;
    crypto.randomUUID = original.uuid;
    globalThis.fetch = original.fetch;
    db.close();
  }
};
