// T-117b: entry bundle trên workerd local, D1/KV/queue/DO không kết nối production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
// Miniflare thuộc bộ Wrangler đã pin trong lockfile, không dùng bản global.
const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=require(require.resolve('miniflare',{paths:[path.dirname(require.resolve('wrangler/package.json'))]}));
(async()=>{
  const build=spawnSync(process.execPath,['tools/wrangler.mjs','deploy','--dry-run','--outdir','.test-build/api'],{cwd:root,encoding:'utf8'});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:path.join(root,'.test-build/api/index.js'),compatibilityDate:'2026-10-01',
    log:new Log(LogLevel.ERROR),kvNamespaces:['KV'],d1Databases:['DB'],r2Buckets:['FILES'],
    durableObjects:{USER_HUB:{className:'UserHub',useSQLite:true}},
    queueProducers:{Q_INGEST:'jobpilot-ingest',Q_SCORE:'jobpilot-score',Q_NOTIFY:'jobpilot-notify'},
    queueConsumers:{'jobpilot-score':{maxBatchSize:10,maxBatchTimeout:0}},
    bindings:{AUTO_CLOSE_ENABLED:'0',JOB_CLEANUP_ENABLED:'0'},
    outboundService:async()=>{throw new Error('test forbids outbound network');},
  }));
  try {
    const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('KV');
    for(const f of fs.readdirSync(path.join(root,'db/migrations')).sort()){
      const sql=fs.readFileSync(path.join(root,'db/migrations',f),'utf8');
      for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    }
    const t=Math.floor(Date.now()/1000);
    await db.prepare("INSERT INTO users(id,email,name,created_at,last_active_day) VALUES ('u','user@example.invalid','User',?,?)").bind(t,Math.floor(t/86400)).run();
    await db.prepare("INSERT INTO profiles(id,user_id,name,level,locations,created_at,updated_at) VALUES ('p','u','Backend','middle','[\"Remote\"]',?,?)").bind(t,t).run();
    await db.prepare("INSERT INTO profile_skills(profile_id,skill,weight) VALUES ('p','Java',5),('p','Spring Boot',5),('p','PostgreSQL',3)").run();
    await db.prepare("INSERT INTO jobs(id,source_url,title,company,skills,content_hash,first_seen_at,created_at) VALUES ('job','https://example.invalid/job','Java Backend','Example','[\"Java\",\"Spring Boot\",\"PostgreSQL\"]','hash',?,?)").bind(t,t).run();
    await kv.put('session:token','u');
    const health=await mf.dispatchFetch('https://api.test/api/health');assert.equal(health.status,200);
    assert.equal((await health.json()).bindings.DB,true);
    const head=await mf.dispatchFetch('https://api.test/api/health',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    const me=await mf.dispatchFetch('https://api.test/api/me',{headers:{authorization:'Bearer token'}});assert.equal(me.status,200);
    const ws=await mf.dispatchFetch('https://api.test/api/realtime',{headers:{authorization:'Bearer token',Upgrade:'websocket'}});
    assert.equal(ws.status,101);assert(ws.webSocket,'UserHub WebSocket is returned by real entry');
    ws.webSocket.accept();ws.webSocket.close(1000,'test complete');
    const producer=await mf.getQueueProducer('Q_SCORE');await producer.send({kind:'score',jobId:'job'});
    let match;
    for(let i=0;i<100;i++){match=await db.prepare("SELECT final_score FROM job_matches WHERE profile_id='p' AND job_id='job'").first();if(match)break;await new Promise(r=>setTimeout(r,50));}
    assert(match&&match.final_score>0,'queue consumer must persist a match');
    const worker=await mf.getWorker();
    const scheduled=await worker.scheduled({cron:'*/30 * * * *',scheduledTime:Date.now()});
    assert.equal(scheduled.outcome,'ok');
    const sources=await db.prepare('SELECT COUNT(*) n FROM sources').first();assert.equal(sources.n,6,'scheduled handler created sources');
    console.log('T-117b workerd runtime selfcheck OK:',JSON.stringify({health:200,HEAD:200,me:200,UserHub:101,queueScore:match.final_score,scheduled:scheduled.outcome,sources:sources.n}));
  }finally{await mf.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
