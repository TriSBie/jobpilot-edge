// T-117b: so contract entry Hono đã bundle với legacy trên hai DB seed độc lập.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../../..');
const legacyPath = path.resolve(process.argv[2] || 'apps/api/src/worker.js');
const entrySource = path.resolve(process.argv[3] || path.join(root, 'apps/api/src/index.ts'));
const entryName = path.basename(entrySource, path.extname(entrySource));
const bundleDir = path.join(root, '.test-build/contract', entryName);
const bundled = path.join(bundleDir, entryName + '.js');
const build = spawnSync(process.execPath, ['tools/wrangler.mjs', 'deploy', entrySource, '--dry-run', '--outdir', bundleDir], { cwd: root, encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout, build.stderr); process.exit(build.status || 1); }

const fixed = 1793346000000;
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync(path.join(root, 'db/migrations')).sort()) db.exec(fs.readFileSync(path.join(root, 'db/migrations', file), 'utf8'));
  const t = fixed / 1000;
  db.prepare("INSERT INTO users (id,email,name,created_at,last_active_day) VALUES ('u','user@example.invalid','User',?,?),('owner','owner@example.invalid','Owner',?,?)").run(t, Math.floor(t/86400), t, Math.floor(t/86400));
  db.prepare("INSERT INTO profiles (id,user_id,name,level,locations,created_at,updated_at) VALUES ('p','u','Backend','middle','[\"Remote\"]',?,?)").run(t,t);
  db.prepare("INSERT INTO profile_skills(profile_id,skill,weight) VALUES ('p','Java',5),('p','Spring Boot',5),('p','PostgreSQL',3)").run();
  db.prepare("INSERT INTO sources(id,type,name,created_at) VALUES ('src-itviec','itviec','ITviec',?)").run(t);
  db.prepare("INSERT INTO jobs(id,source_id,source_url,title,company,skills,content_hash,first_seen_at,created_at) VALUES ('job','src-itviec','https://itviec.com/it-jobs/example','Java Backend','Example','[\"Java\",\"Spring Boot\",\"PostgreSQL\"]','hash',?,?)").run(t,t);
  db.prepare("INSERT INTO job_matches(job_id,profile_id,final_score,tier,scored_at) VALUES ('job','p',90,'strong',?)").run(t);
  db.prepare("INSERT INTO applications(id,profile_id,job_id,stage,created_at,updated_at) VALUES ('app','p','job','saved',?,?)").run(t,t);
  const execute = (sql,args) => { const s=db.prepare(sql); return /^\s*(SELECT|WITH)|\bRETURNING\b/i.test(sql) ? s.all(...args) : (s.run(...args),[]); };
  const stmt = (sql,args=[]) => ({sql,args,bind:(...a)=>stmt(sql,a), first:async()=>execute(sql,args)[0]||null, all:async()=>({results:execute(sql,args)}),run:async()=>{execute(sql,args);return {success:true};}});
  const kv=new Map([['session:tok','u'],['session:owner','owner']]);
  const points=[], waits=[];
  const env={DB:{prepare:s=>stmt(s),batch:async a=>a.map(s=>({results:execute(s.sql,s.args)}))},KV:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,v),delete:async k=>kv.delete(k),list:async()=>({keys:[]})},FILES:{get:async()=>null},EVENTS:{writeDataPoint:p=>points.push(p)},OWNER_EMAIL:'owner@example.invalid'};
  env.TG_TOKEN_KEY = Buffer.alloc(32, 1).toString('base64');
  return {db,env,points,waits,ctx:{waitUntil:p=>waits.push(p),passThroughOnException(){}}};
}
const scenarios=[
  {name:'health',url:'/api/health',status:200,token:null},
  {name:'public',url:'/api/public/sample',status:200,token:null},
  {name:'public try',url:'/api/public/try?skills=Java,Spring%20Boot,PostgreSQL',status:200,token:null},
  {name:'me',url:'/api/me',status:200},
  {name:'profiles',url:'/api/profiles',status:200},
  {name:'jobs',url:'/api/jobs?profile_id=p&limit=10',status:200},
  {name:'applications',url:'/api/applications?profile_id=p',status:200},
  {name:'interviews',url:'/api/applications/app/interviews',status:200},
  {name:'notifications',url:'/api/notifications',status:200},
  {name:'telegram',url:'/api/me/telegram/bot',status:200},
  {name:'admin',url:'/api/admin/quota',status:200,token:'owner'},
  {name:'auth logout',url:'/api/auth/logout',method:'POST',status:200},
  {name:'rum',url:'/api/rum',method:'POST',body:{metric:'LCP',page:'landing',value:100},status:204,token:null},
  {name:'preflight',url:'/api/jobs',method:'OPTIONS',status:200,token:null},
  {name:'wrong method',url:'/api/jobs',method:'PUT',status:404},
  {name:'unknown path',url:'/api/khong-co',status:404},
  {name:'missing token',url:'/api/me',status:401,token:null},
  {name:'invalid token',url:'/api/me',status:401,token:'bad'},
  {name:'nonowner',url:'/api/admin/quota',status:403},
  {name:'invalid body',url:'/api/profiles',method:'POST',body:{locations:'bad'},status:400},
  {name:'DB failure',url:'/api/me',status:500,dbError:true},
  {name:'HEAD',url:'/api/health',method:'HEAD',status:200,token:null},
  {name:'trailing slash',url:'/api/me/',status:404},
];
(async()=>{
  const original={Date:globalThis.Date,fetch:globalThis.fetch,caches:globalThis.caches,log:console.log,error:console.error};
  class FixedDate extends original.Date { constructor(...args){super(...(args.length?args:[fixed]));} static now(){return fixed;} }
  try {
    globalThis.Date=FixedDate;
    globalThis.fetch=async()=>{throw new Error('unexpected external fetch');};
    const legacy=(await import(pathToFileURL(legacyPath).href)).default;
    const current=(await import(pathToFileURL(bundled).href)).default;
    const rows=[];
    for(const scenario of scenarios){
      const responses=[],logs=[];
      for(const worker of [legacy,current]){
        const state=setup(),cache=new Map(),workerLogs=[];
        globalThis.caches={default:{match:async r=>cache.get(r.url)?.clone(),put:async(r,res)=>cache.set(r.url,res.clone())}};
        console.log=(...a)=>workerLogs.push(a.join(' ')); console.error=()=>{};
        try {
          if(scenario.dbError)state.env.DB.prepare=()=>{throw new Error('fixture DB unavailable');};
          const headers={'content-type':'application/json','cf-connecting-ip':'203.0.113.2'};
          const token=scenario.token===undefined?'tok':scenario.token;if(token)headers.authorization=`Bearer ${token}`;
          const res=await worker.fetch(new Request('https://api.test'+scenario.url,{method:scenario.method||'GET',headers,body:scenario.body&&JSON.stringify(scenario.body)}),state.env,state.ctx);
          assert.equal(res.status,scenario.status,scenario.name);
          const body=await res.text();
          responses.push({status:res.status,headers:[...res.headers].sort(),body:scenario.method==='HEAD'?'':body});
          await Promise.all(state.waits);
          const log=workerLogs.map(x=>{try{return JSON.parse(x);}catch{return null;}}).find(x=>x&&Object.hasOwn(x,'d1_queries'));
          assert(log,`${scenario.name}: structured log`);
          for(const key of ['route','method','status','ms','d1_queries','cache','user_hash'])assert(Object.hasOwn(log,key),`${scenario.name}: ${key}`);
          logs.push(log);
          if(scenario.name==='public try'){
            const r=await worker.fetch(new Request('https://api.test'+scenario.url,{headers}),state.env,state.ctx);await r.text();
            assert(workerLogs.some(x=>x.includes('"cache":"hit"')),'waitUntil cache write must be visible');
          }
        }finally{state.db.close();}
      }
      assert.deepEqual(responses[1],responses[0],scenario.name+' status/header/body');
      assert.deepEqual(logs[1],logs[0],scenario.name+' logs');
      rows.push({scenario:scenario.name,status:responses[1].status,identical:true});
    }
    console.log=original.log; console.error=original.error;
    console.log('T-117b entry contract selfcheck OK:',JSON.stringify(rows));
  }finally{globalThis.Date=original.Date;globalThis.fetch=original.fetch;globalThis.caches=original.caches;console.log=original.log;console.error=original.error;}
})().catch(e=>{console.error(e);process.exitCode=1});
