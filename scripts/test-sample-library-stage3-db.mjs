import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';

const testUrl=process.env.TEST_DATABASE_URL;
if(!testUrl){
  console.log('SKIP Stage3 PostgreSQL test: set TEST_DATABASE_URL to a disposable PostgreSQL 17 database.');
  process.exit(0);
}
if(process.env.DATABASE_URL&&new URL(process.env.DATABASE_URL).toString()===new URL(testUrl).toString()){
  throw new Error('TEST_DATABASE_URL must not be the same as DATABASE_URL');
}

const root=new pg.Client({connectionString:testUrl});
const testSchema=`stage3_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
const decoySchema=`${testSchema}_decoy`;
let appDb=null;
let comparisonRoutes=null;
let checks=0;
function ok(name){console.log(`ok ${++checks} - ${name}`);}
async function rejectSql(client,sql,params=[],codes=[]){
  try{await client.query(sql,params);assert.fail(`SQL should have failed: ${sql}`);}
  catch(error){if(error instanceof assert.AssertionError)throw error;if(codes.length)assert.ok(codes.includes(error.code),`${error.code}: ${error.message}`);}
}
function schemaUrl(base,schema){
  const url=new URL(base);url.searchParams.set('options',`-csearch_path=${schema},public`);return url.toString();
}

const fullSchema=await readFile(new URL('../server/src/schema.sql',import.meta.url),'utf8');
const stage3Marker='-- IdeaHub sample library, stage 3.';
const markerIndex=fullSchema.lastIndexOf(stage3Marker);
assert.ok(markerIndex>0,'schema.sql must contain the Stage3 sync block');
const baseSchema=fullSchema.slice(0,markerIndex);
const migration=await readFile(new URL('./migrations/20260829-sample-library-stage3.sql',import.meta.url),'utf8');
const migrationSha=createHash('sha256').update(migration).digest('hex');

try{
  await root.connect();
  const version=await root.query("SELECT current_setting('server_version_num')::int version_num,version() version");
  assert.ok(Number(version.rows[0].version_num)>=170000,`PostgreSQL 17+ required, got ${version.rows[0].version}`);
  ok(`PostgreSQL ${version.rows[0].version.match(/PostgreSQL\s+([^\s]+)/)?.[1]||'17+'}`);
  // TEST_DATABASE_URL is explicitly disposable. Remove only schemas created by prior failed runs of this script;
  // this makes reruns deterministic without touching public or unrelated schemas.
  const staleSchemas=await root.query(`SELECT nspname FROM pg_namespace
    WHERE nspname ~ '^stage3_[a-z0-9_]+$' AND nspname<>'stage3_template'`);
  for(const {nspname} of staleSchemas.rows){
    if(!/^stage3_[a-z0-9_]+$/.test(nspname))throw new Error('unexpected Stage3 test schema name');
    await root.query(`DROP SCHEMA "${nspname}" CASCADE`);
  }
  await root.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  const trgm=await root.query(`SELECT n.nspname schema_name FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'`);
  if(trgm.rows[0]?.schema_name!=='public'){
    throw new Error('TEST_DATABASE_URL must use an isolated database with pg_trgm preinstalled in public');
  }
  await root.query(`CREATE SCHEMA ${testSchema}`);
  await root.query(`SET search_path TO ${testSchema},public`);
  await root.query(baseSchema);
  await root.query(`CREATE SCHEMA ${decoySchema}`);
  await root.query(`CREATE TABLE ${decoySchema}.stage3_constraint_name_decoy(
    a int,b int,c int,
    CONSTRAINT sample_element_decisions_element_id_id_uk UNIQUE(a),
    CONSTRAINT sample_element_evidence_version_id_id_uk UNIQUE(b),
    CONSTRAINT sample_metric_snapshots_sample_id_id_uk UNIQUE(c))`);

  // Populate Stage1/2 before Stage3 migration so preservation checks are semantic, not empty-table smoke tests.
  const baselineSample=(await root.query(`INSERT INTO samples(canonical_key,platform,title,metrics)
    VALUES($1,'manual','迁移前样本','{"likes":null,"views":12}'::jsonb)RETURNING id`,[`baseline-${testSchema}`])).rows[0];
  const baselineCapture=(await root.query(`INSERT INTO sample_captures(
    sample_id,capture_key,capture_type,payload_sha256,normalized_payload)
    VALUES($1,'baseline','manual',$2,'{"body":"迁移前正文"}'::jsonb)RETURNING id`,[baselineSample.id,'1'.repeat(64)])).rows[0];
  const baselineVersion=(await root.query(`INSERT INTO sample_analysis_versions(
    sample_id,source_capture_id,revision,source,status,input_sha256,schema_version,manifest_sha256)
    VALUES($1,$2,1,'manual','building',$3,'baseline',$4)RETURNING id`,
    [baselineSample.id,baselineCapture.id,'2'.repeat(64),'3'.repeat(64)])).rows[0];
  await root.query(`INSERT INTO sample_analysis_elements(
    version_id,dimension_key,state,value_json,function_text,evidence_strength,applicability,limitations)
    SELECT $1,dimension_key,'value',jsonb_build_object('baseline',dimension_key),'迁移前功能','none','迁移前适用','迁移前限制'
    FROM sample_analysis_dimensions ORDER BY ordinal`,[baselineVersion.id]);
  await root.query("UPDATE sample_analysis_versions SET status='complete',completed_at=now()WHERE id=$1",[baselineVersion.id]);
  await root.query("INSERT INTO sample_analysis_selections(sample_id,version_id,reason)VALUES($1,$2,'explicit')",
    [baselineSample.id,baselineVersion.id]);
  await root.query(`INSERT INTO sample_metric_snapshots(sample_id,snapshot_key,observed_at,likes,views,raw_metrics)
    VALUES($1,'baseline',now(),NULL,12,'{"likes":null,"views":12,"semantic":"keep"}'::jsonb)`,[baselineSample.id]);

  const before=await root.query(`SELECT
    (SELECT count(*) FROM samples)::int samples,
    (SELECT count(*) FROM sample_analysis_versions)::int versions,
    (SELECT count(*) FROM sample_analysis_dimensions)::int dimensions,
    md5((SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'current',current_analysis_version_id,'metrics',metrics)
      ORDER BY id),'[]'::jsonb)::text FROM samples)) sample_semantics,
    md5((SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version_id,'dimension',dimension_key,'state',state,'value',value_json)
      ORDER BY version_id,dimension_key),'[]'::jsonb)::text FROM sample_analysis_elements)) element_semantics,
    md5((SELECT COALESCE(jsonb_agg(jsonb_build_object('sample',sample_id,'raw',raw_metrics,'likes',likes,'views',views)
      ORDER BY sample_id,id),'[]'::jsonb)::text FROM sample_metric_snapshots)) metric_semantics`);
  await root.query(migration);
  await root.query(migration);
  const after=await root.query(`SELECT
    (SELECT count(*) FROM samples)::int samples,
    (SELECT count(*) FROM sample_analysis_versions)::int versions,
    (SELECT count(*) FROM sample_analysis_dimensions)::int dimensions,
    md5((SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'current',current_analysis_version_id,'metrics',metrics)
      ORDER BY id),'[]'::jsonb)::text FROM samples)) sample_semantics,
    md5((SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version_id,'dimension',dimension_key,'state',state,'value',value_json)
      ORDER BY version_id,dimension_key),'[]'::jsonb)::text FROM sample_analysis_elements)) element_semantics,
    md5((SELECT COALESCE(jsonb_agg(jsonb_build_object('sample',sample_id,'raw',raw_metrics,'likes',likes,'views',views)
      ORDER BY sample_id,id),'[]'::jsonb)::text FROM sample_metric_snapshots)) metric_semantics`);
  assert.deepEqual(after.rows[0],before.rows[0]);assert.equal(after.rows[0].dimensions,15);
  const scopedConstraints=await root.query(`SELECT conrelid::regclass::text table_name,conname FROM pg_constraint
    WHERE(conrelid='sample_element_decisions'::regclass AND conname='sample_element_decisions_element_id_id_uk')
      OR(conrelid='sample_element_evidence'::regclass AND conname='sample_element_evidence_version_id_id_uk')
      OR(conrelid='sample_metric_snapshots'::regclass AND conname='sample_metric_snapshots_sample_id_id_uk')`);
  assert.equal(scopedConstraints.rows.length,3);
  ok(`migration double-run is additive and idempotent (${migrationSha.slice(0,16)})`);

  const catalog=await root.query(`SELECT
    (SELECT count(*) FROM pg_tables WHERE schemaname=current_schema() AND(tablename LIKE 'sample_comparison%'OR tablename LIKE 'content_component%'))::int tables,
    (SELECT count(*) FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname LIKE 'sample_%_fk')::int ownership_constraints,
    (SELECT count(*) FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)AND NOT tgisinternal)::int triggers`);
  assert.ok(catalog.rows[0].tables>=15);assert.ok(catalog.rows[0].ownership_constraints>=15);assert.ok(catalog.rows[0].triggers>=25);
  ok('Stage3 tables, named ownership constraints and triggers are installed');

  const users=await root.query(`INSERT INTO users(name,role)VALUES
    ('Stage3 member','member'),('Stage3 reviewer','reviewer'),('Stage3 admin','admin')RETURNING id,role::text`);
  const memberId=Number(users.rows[0].id),reviewerId=Number(users.rows[1].id),adminId=Number(users.rows[2].id);
  const fixture=[];
  for(let n=1;n<=7;n++){
    const sample=(await root.query(`INSERT INTO samples(canonical_key,platform,title,account_name,published_at,created_by)
      VALUES($1,$2,$3,$4,now()-interval '2 days',$5)RETURNING id`,[`stage3-${testSchema}-${n}`,n===3?'other':'manual',
        n===1?'长'.repeat(500):`冻结样本 ${n}`,`账号 ${n}`,memberId])).rows[0];
    const sampleId=Number(sample.id);
    const capture=(await root.query(`INSERT INTO sample_captures(sample_id,capture_key,capture_type,payload_sha256,created_by)
      VALUES($1,$2,'manual',$3,$4)RETURNING id`,[sampleId,`stage3-${n}`,'a'.repeat(63)+n,memberId])).rows[0];
    const version=(await root.query(`INSERT INTO sample_analysis_versions(
      sample_id,source_capture_id,revision,source,status,input_sha256,schema_version,manifest_sha256,created_by
    )VALUES($1,$2,1,'manual','building',$3,'test',$4,$5)RETURNING id`,[sampleId,capture.id,
      'b'.repeat(63)+n,'c'.repeat(63)+n,memberId])).rows[0];
    const elements=await root.query(`INSERT INTO sample_analysis_elements(
      version_id,dimension_key,state,value_json,function_text,evidence_strength,applicability,limitations
    )SELECT $1,d.dimension_key,'value',to_jsonb('值-'||d.dimension_key),'功能','strong','适用','限制'
      FROM sample_analysis_dimensions d ORDER BY d.ordinal RETURNING id,dimension_key`,[version.id]);
    const source=(await root.query(`INSERT INTO sample_evidence_sources(
      version_id,sample_id,source_capture_id,source_id,source_kind,locator,content_sha256,content_length,display_label
    )VALUES($1,$2,$3,'body','body','{}'::jsonb,$4,20,'正文')RETURNING id`,[version.id,sampleId,capture.id,'d'.repeat(63)+n])).rows[0];
    const firstElement=elements.rows.find(row=>row.dimension_key==='audience');
    const evidence=(await root.query(`INSERT INTO sample_element_evidence(
      version_id,element_id,source_id,verification_status,quote_text,quote_sha256,start_offset,end_offset
    )VALUES($1,$2,'body','verified','可核验的样本证据',$3,0,8)RETURNING id`,[version.id,firstElement.id,'e'.repeat(63)+n])).rows[0];
    await root.query("UPDATE sample_analysis_versions SET status='complete',completed_at=now()WHERE id=$1",[version.id]);
    await root.query("INSERT INTO sample_analysis_selections(sample_id,version_id,reason,selected_by)VALUES($1,$2,'explicit',$3)",[sampleId,version.id,memberId]);
    if(n<3)await root.query(`INSERT INTO sample_metric_snapshots(sample_id,snapshot_key,observed_at,likes,views,created_by)
      VALUES($1,$2,now(),$3,$4,$5)`,[sampleId,`metric-${n}`,n===1?10:null,n===2?20:null,memberId]);
    fixture.push({sampleId,versionId:Number(version.id),evidenceId:Number(evidence.id)});
  }
  ok('Stage1/2 fixture has complete 15-row analyses and verified evidence');

  process.env.DATABASE_URL=schemaUrl(testUrl,testSchema);
  process.env.DB_DRIVER='pg';process.env.ALLOW_HEADER_AUTH='1';process.env.NODE_ENV='test';
  process.env.OPENAI_API_KEY='';
  const [{createRouter},routes,db,comparisonLib]=await Promise.all([
    import('../server/src/router.mjs'),import('../server/src/routes/sample-comparison.mjs'),import('../server/src/db/index.mjs'),
    import('../server/src/lib/sample-comparison.mjs'),
  ]);
  comparisonRoutes=routes;
  appDb=db;const router=createRouter();routes.mount(router);

  const idempotentActions=['comparison.create','scope.create','assessment.manual','assessment.job','assessment.select',
    'relation.create','relation.evidence','relation.event','extraction.create','component.create','revision.create',
    'revision.tags','revision.submit','revision.review','component.lifecycle'];
  for(let index=0;index<idempotentActions.length;index++){
    const action=idempotentActions[index],common={aggregateKey:`wrapper:${action}`,action,key:'same-key',actorId:memberId};
    const first=await db.tx(client=>comparisonLib.withIdempotency(client,{...common,request:{value:1}},async()=>({
      responseKind:'test',responseId:index+1,status:201})));
    const second=await db.tx(client=>comparisonLib.withIdempotency(client,{...common,request:{value:1}},async()=>assert.fail('replayed operation')));
    assert.equal(first.reused,false);assert.equal(second.reused,true);
    await assert.rejects(()=>db.tx(client=>comparisonLib.withIdempotency(client,{...common,request:{value:2}},async()=>({
      responseKind:'test',responseId:index+1,status:201}))),error=>error.status===409);
  }
  ok('common idempotency wrapper gives 201/200/409 semantics for every Stage3 POST action family');

  async function invoke(method,path,{userId=memberId,body=undefined,key=null,queryString=''}={}){
    const payload=body===undefined?'':JSON.stringify(body);
    const req=Readable.from(payload?[Buffer.from(payload)]:[]);req.method=method;req.url=`${path}${queryString}`;
    req.headers={};if(userId!=null)req.headers['x-user-id']=String(userId);if(key)req.headers['idempotency-key']=key;
    let status=0,text='';const res={writeHead(code){status=code;return this;},end(chunk=''){text+=chunk?String(chunk):'';}};
    const hit=router.match(method,path);assert.ok(hit?.handler,`${method} ${path} must be mounted`);
    try{await hit.handler(req,res,hit.params,new URL(`http://test${path}${queryString}`));}
    catch(error){status=error.status||500;text=JSON.stringify({error:error.message,detail:error.detail});}
    let json={};try{json=text?JSON.parse(text):{};}catch{json={raw:text};}return {status,json};
  }

  let response=await invoke('POST','/api/sample-comparisons',{userId:null,key:'anon-write',body:{title:'x',topic:'t',memberIds:fixture.slice(0,2).map(x=>x.sampleId)}});
  assert.equal(response.status,401);
  assert.equal((await invoke('POST','/api/sample-comparisons',{key:'null-body',body:null})).status,400);
  assert.equal((await invoke('POST','/api/sample-comparisons',{key:'array-body',body:[]})).status,400);
  assert.equal((await invoke('POST','/api/sample-comparisons',{key:'one-member',body:{title:'x',topic:'t',memberIds:[fixture[0].sampleId]}})).status,400);
  assert.equal((await invoke('POST','/api/sample-comparisons',{key:'seven-members',body:{title:'x',topic:'t',memberIds:fixture.map(x=>x.sampleId)}})).status,400);
  const createBody={title:'Stage3 横向比较',purpose:'冻结验证',topicBasis:'开场方式',memberIds:fixture.slice(0,3).map(x=>x.sampleId)};
  response=await invoke('POST','/api/sample-comparisons',{key:'comparison-create',body:createBody});
  assert.equal(response.status,201,JSON.stringify(response.json));
  const comparisonId=response.json.id,scopeId=response.json.scopes[0].id;
  const scopeResponse=await invoke('GET',`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}`);
  assert.equal(scopeResponse.status,200);assert.equal(scopeResponse.json.members.length,3);
  assert.equal(scopeResponse.json.members[0].title.length,500);
  assert.ok(scopeResponse.json.members.every(item=>item.elements.length===15));
  assert.equal(scopeResponse.json.sampleSize,3);assert.equal(scopeResponse.json.causalClaimsAllowed,false);
  assert.equal(scopeResponse.json.mixedPlatforms,true);
  ok('HTTP creates an immutable scope with 2-6 members and exactly 15 frozen rows each');

  for(const size of [2,6]){
    const boundary=await invoke('POST','/api/sample-comparisons',{key:`boundary-${size}`,body:{title:`边界 ${size}`,
      topicBasis:'边界',memberIds:fixture.slice(0,size).map(item=>item.sampleId)}});
    assert.equal(boundary.status,201,JSON.stringify(boundary.json));assert.equal(boundary.json.scopes[0].memberCount,size);
  }
  ok('HTTP and DB accept 2/6 members, reject 1/7, and preserve a 500-character Stage1 title');

  const retry=await invoke('POST','/api/sample-comparisons',{key:'comparison-create',body:createBody});
  assert.equal(retry.status,200);assert.equal(retry.json.id,comparisonId);
  const mismatch=await invoke('POST','/api/sample-comparisons',{key:'comparison-create',body:{...createBody,title:'different'}});
  assert.equal(mismatch.status,409);
  ok('Idempotency-Key returns 200 for same hash and 409 for a different hash');

  const refreshed=await invoke('POST',`/api/sample-comparisons/${comparisonId}/refresh`,{key:'comparison-refresh-latest',body:{}});
  assert.equal(refreshed.status,201,JSON.stringify(refreshed.json));assert.equal(refreshed.json.sourceComparisonId,comparisonId);
  assert.notEqual(refreshed.json.id,comparisonId);assert.match(refreshed.json.title,/最新拆解$/);
  assert.equal(refreshed.json.scopes[0].memberCount,3);
  const refreshedId=refreshed.json.id;
  assert.equal((await invoke('DELETE',`/api/sample-comparisons/${refreshedId}`,{userId:memberId,key:'comparison-delete-member'})).status,403);
  assert.equal((await invoke('DELETE',`/api/sample-comparisons/${refreshedId}`,{userId:reviewerId,key:'comparison-delete-reviewer'})).status,403);
  const deleted=await invoke('DELETE',`/api/sample-comparisons/${refreshedId}`,{userId:adminId,key:'comparison-delete-admin'});
  assert.equal(deleted.status,200,JSON.stringify(deleted.json));assert.equal(deleted.json.deleted,true);
  assert.equal((await invoke('GET',`/api/sample-comparisons/${refreshedId}`)).status,404);
  assert.equal((await invoke('GET',`/api/sample-comparisons/${comparisonId}`)).status,200);
  const visibleAfterDelete=await invoke('GET','/api/sample-comparisons',{queryString:`?q=${encodeURIComponent('最新拆解')}`});
  assert.equal(visibleAfterDelete.status,200);assert.equal(visibleAfterDelete.json.items.some(item=>item.id===refreshedId),false);
  ok('refresh creates a separate latest-analysis snapshot and admin delete hides only that comparison aggregate');

  const direct=schemaUrl(testUrl,testSchema);const raw=new pg.Client({connectionString:direct});await raw.connect();

  // A writer that began first must be observed after scope finalization waits for source-table locks.
  await raw.query('BEGIN');
  const raceElement=(await raw.query(`SELECT id FROM sample_analysis_elements
    WHERE version_id=$1 AND dimension_key='audience'`,[fixture[0].versionId])).rows[0];
  const raceDecision=(await raw.query(`INSERT INTO sample_element_decisions(element_id,decision,note,decided_by)
    VALUES($1,'confirmed','race',$2)RETURNING id`,[raceElement.id,memberId])).rows[0];
  const raceMetric=(await raw.query(`INSERT INTO sample_metric_snapshots(sample_id,snapshot_key,observed_at,likes,views,created_by)
    VALUES($1,'race-latest',now()+interval '1 second',99,199,$2)RETURNING id`,[fixture[0].sampleId,memberId])).rows[0];
  const racePromise=invoke('POST',`/api/sample-comparisons/${comparisonId}/scopes`,{key:'scope-race',body:{
    topicBasis:'并发冻结',memberIds:fixture.slice(0,3).map(item=>item.sampleId)}});
  await new Promise(resolve=>setTimeout(resolve,100));
  await raw.query('COMMIT');
  const raced=await racePromise;assert.equal(raced.status,201,JSON.stringify(raced.json));
  const racedMember=raced.json.members.find(item=>item.sampleId===fixture[0].sampleId);
  assert.equal(racedMember.metricSnapshotId,Number(raceMetric.id));
  assert.equal(racedMember.elements.find(item=>item.dimensionKey==='audience').latestDecisionId,Number(raceDecision.id));
  ok('scope finalization observes decisions and metrics committed by an in-flight writer without torn snapshots');

  // Direct finalization proves the database itself rejects 14 rows and a 16th duplicate.
  const countComparison=(await raw.query("INSERT INTO sample_comparisons(title)VALUES('维度计数负测')RETURNING id")).rows[0];
  const countScope=(await raw.query(`INSERT INTO sample_comparison_scopes(
    comparison_id,revision,status,topic_basis,input_sha256)VALUES($1,1,'building','维度计数',$2)RETURNING id`,
    [countComparison.id,'6'.repeat(64)])).rows[0];
  for(let index=0;index<2;index++){
    const item=fixture[index];
    await raw.query(`INSERT INTO sample_comparison_scope_members(
      comparison_id,scope_id,sample_id,analysis_version_id,ordinal,frozen_title,frozen_account_name,
      frozen_account_handle,frozen_platform,frozen_published_at,metric_snapshot_id,frozen_metric_observed_at,frozen_metrics)
      SELECT $1,$2,s.id,s.current_analysis_version_id,$3,s.title,s.account_name,s.account_handle,s.platform,s.published_at,
        lm.id,lm.observed_at,jsonb_build_object('likes',lm.likes,'saves',lm.saves,'comments',lm.comments,'shares',lm.shares,'views',lm.views)
      FROM samples s LEFT JOIN LATERAL(SELECT * FROM sample_metric_snapshots WHERE sample_id=s.id
        ORDER BY observed_at DESC,id DESC LIMIT 1)lm ON true WHERE s.id=$4`,
    [countComparison.id,countScope.id,index+1,item.sampleId]);
    await raw.query(`INSERT INTO sample_comparison_snapshots(
      comparison_id,scope_id,sample_id,analysis_version_id,element_id,dimension_key,latest_decision_id,
      effective_state,effective_value,function_text,applicability,limitations,evidence_state,value_sha256)
      SELECT $1,$2,$3,$4,e.id,e.dimension_key,d.id,e.state,e.value_json,e.function_text,e.applicability,e.limitations,
        'insufficient',$5 FROM sample_analysis_elements e
      LEFT JOIN LATERAL(SELECT id FROM sample_element_decisions WHERE element_id=e.id ORDER BY id DESC LIMIT 1)d ON true
      WHERE e.version_id=$4 AND($6::boolean=false OR e.dimension_key<>'cta')`,
    [countComparison.id,countScope.id,item.sampleId,item.versionId,'7'.repeat(64),index===0]);
  }
  await rejectSql(raw,"UPDATE sample_comparison_scopes SET status='complete',completed_at=now()WHERE id=$1",[countScope.id],['23514']);
  await raw.query(`INSERT INTO sample_comparison_snapshots(
    comparison_id,scope_id,sample_id,analysis_version_id,element_id,dimension_key,latest_decision_id,
    effective_state,effective_value,function_text,applicability,limitations,evidence_state,value_sha256)
    SELECT $1,$2,$3,$4,e.id,e.dimension_key,d.id,e.state,e.value_json,e.function_text,e.applicability,e.limitations,
      'insufficient',$5 FROM sample_analysis_elements e
    LEFT JOIN LATERAL(SELECT id FROM sample_element_decisions WHERE element_id=e.id ORDER BY id DESC LIMIT 1)d ON true
    WHERE e.version_id=$4 AND e.dimension_key='cta'`,
  [countComparison.id,countScope.id,fixture[0].sampleId,fixture[0].versionId,'7'.repeat(64)]);
  await rejectSql(raw,`INSERT INTO sample_comparison_snapshots(
    comparison_id,scope_id,sample_id,analysis_version_id,element_id,dimension_key,effective_state,effective_value,evidence_state,value_sha256)
    SELECT $1,$2,$3,$4,e.id,e.dimension_key,e.state,e.value_json,'insufficient',$5
    FROM sample_analysis_elements e WHERE e.version_id=$4 AND e.dimension_key='audience'`,
  [countComparison.id,countScope.id,fixture[0].sampleId,fixture[0].versionId,'7'.repeat(64)],['23505']);
  await raw.query("UPDATE sample_comparison_scopes SET status='complete',completed_at=now()WHERE id=$1",[countScope.id]);
  ok('database finalization rejects 14 dimensions and the unique identity rejects a 16th row');

  await rejectSql(raw,'UPDATE sample_comparison_snapshots SET function_text=$1 WHERE scope_id=$2',['tamper',scopeId],['55000']);
  await rejectSql(raw,'DELETE FROM sample_comparison_scope_members WHERE scope_id=$1',[scopeId],['55000']);
  await rejectSql(raw,`INSERT INTO sample_comparison_snapshots(
    comparison_id,scope_id,sample_id,analysis_version_id,element_id,dimension_key,effective_state,evidence_state,value_sha256
    )SELECT $1,$2,$3,$4,e.id,e.dimension_key,'insufficient','insufficient',$5 FROM sample_analysis_elements e
      WHERE e.version_id=$4 LIMIT 1`,[comparisonId,scopeId,fixture[0].sampleId,fixture[0].versionId,'f'.repeat(64)],['55000']);
  ok('complete scope, members and snapshots reject update/delete/late insert');

  const firstSnapshot=scopeResponse.json.members[0].elements.find(item=>item.dimensionKey==='audience');
  const extractionBody={dimensionKey:'audience',pattern:'身份点名',function:'快速限定受众',rationale:'冻结快照中反复出现',
    applicability:'受众边界清楚的内容',limitations:'样本量只有三篇',doNotCopy:'不要照搬具体句式',
    sources:[{snapshotId:firstSnapshot.id,sourceRole:'primary'}]};
  const extraction=await invoke('POST',`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/extractions`,
    {key:'extract-1',body:extractionBody});
  assert.equal(extraction.status,201,JSON.stringify(extraction.json));
  const extractionRetry=await invoke('POST',`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/extractions`,
    {key:'extract-1',body:extractionBody});
  assert.equal(extractionRetry.status,200);assert.equal(extractionRetry.json.id,extraction.json.id);
  await rejectSql(raw,'UPDATE sample_element_extractions SET pattern_text=$1 WHERE id=$2',['tamper',extraction.json.id],['55000']);

  const mismatchExtraction=(await raw.query(`INSERT INTO sample_element_extractions(
    comparison_id,scope_id,dimension_key,origin,status,pattern_text,function_text,rationale,applicability,limitations,do_not_copy)
    VALUES($1,$2,'audience','manual','building','p','f','r','a','l','d')RETURNING id`,[comparisonId,scopeId])).rows[0];
  await rejectSql(raw,`INSERT INTO sample_element_extraction_sources(
    extraction_id,extraction_dimension_key,comparison_id,scope_id,sample_id,snapshot_id,snapshot_dimension_key,source_role)
    VALUES($1,'audience',$2,$3,$4,$5,'audience','primary')`,[mismatchExtraction.id,comparisonId,scopeId,
    fixture[1].sampleId,firstSnapshot.id],['23503']);
  ok('local extraction requires a same-scope/dimension primary snapshot and becomes immutable');

  const componentBody={dimensionKey:'audience',name:'身份点名组件',pattern:'开头点出具体身份',function:'建立相关性',
    applicability:'明确细分受众',limitations:'不适合泛话题',doNotCopy:'不要制造歧视标签',extractionIds:[extraction.json.id],tagIds:[]};
  const component=await invoke('POST','/api/content-components',{key:'component-1',body:componentBody});
  assert.equal(component.status,201,JSON.stringify(component.json));
  assert.equal((await invoke('POST','/api/content-components',{key:'component-1',body:componentBody})).status,200);
  const componentId=component.json.id,revisionId=component.json.revisions[0].id;
  const tagsOnce=await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/tags`,
    {key:'tags-1',body:{tagIds:[]}});assert.equal(tagsOnce.status,201);
  assert.equal((await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/tags`,
    {key:'tags-1',body:{tagIds:[]}})).status,200);
  const submitted=await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/submit`,{key:'submit-1',body:{note:'请审核'}});
  assert.equal(submitted.status,201);assert.equal(submitted.json.revisions[0].state,'submitted');
  assert.equal((await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/submit`,
    {key:'submit-1',body:{note:'请审核'}})).status,200);
  const memberReview=await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/review`,
    {key:'review-member',body:{decision:'approved'}});assert.equal(memberReview.status,403);
  const approved=await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/review`,
    {userId:reviewerId,key:'review-approve',body:{decision:'approved'}});
  assert.equal(approved.status,201,JSON.stringify(approved.json));assert.equal(approved.json.currentApprovedRevisionId,revisionId);
  assert.equal((await invoke('POST',`/api/content-components/${componentId}/revisions/${revisionId}/review`,
    {userId:reviewerId,key:'review-approve',body:{decision:'approved'}})).status,200);

  const revision2Body={...componentBody,name:'需要修改的版本'};
  const revision2=await invoke('POST',`/api/content-components/${componentId}/revisions`,{key:'revision-2',body:revision2Body});
  assert.equal(revision2.status,201);const revision2Id=revision2.json.revisions[0].id;
  await invoke('POST',`/api/content-components/${componentId}/revisions/${revision2Id}/submit`,{key:'submit-2',body:{note:'二次审核'}});
  const changes=await invoke('POST',`/api/content-components/${componentId}/revisions/${revision2Id}/review`,
    {userId:reviewerId,key:'review-changes',body:{decision:'changes_requested',note:'补充限制'}});
  assert.equal(changes.status,201);assert.equal(changes.json.currentApprovedRevisionId,revisionId);

  const revision3Body={...componentBody,name:'批准后的新名称',limitations:'已补充限制'};
  const revision3=await invoke('POST',`/api/content-components/${componentId}/revisions`,{key:'revision-3',body:revision3Body});
  assert.equal(revision3.status,201);const revision3Id=revision3.json.revisions[0].id;
  await invoke('POST',`/api/content-components/${componentId}/revisions/${revision3Id}/submit`,{key:'submit-3',body:{note:'已修改'}});
  const approved3=await invoke('POST',`/api/content-components/${componentId}/revisions/${revision3Id}/review`,
    {userId:adminId,key:'review-approve-3',body:{decision:'approved'}});
  assert.equal(approved3.status,201);assert.equal(approved3.json.currentApprovedRevisionId,revision3Id);
  const reusable=await invoke('GET','/api/reusable-components',{queryString:'?page=1&pageSize=20'});
  assert.equal(reusable.status,200);assert.equal(reusable.json.items.length,1);
  assert.equal(reusable.json.items[0].name,'批准后的新名称');
  assert.equal('likes'in reusable.json.items[0],false);assert.equal('evidence'in reusable.json.items[0],false);
  const retired=await invoke('POST',`/api/content-components/${componentId}/lifecycle`,{userId:adminId,key:'retire-1',body:{action:'retire'}});
  assert.equal(retired.status,201);assert.equal(retired.json.lifecycleState,'retired');
  assert.equal((await invoke('POST',`/api/content-components/${componentId}/lifecycle`,
    {userId:adminId,key:'retire-1',body:{action:'retire'}})).status,200);
  const reactivated=await invoke('POST',`/api/content-components/${componentId}/lifecycle`,
    {userId:adminId,key:'reactivate-1',body:{action:'reactivate'}});
  assert.equal(reactivated.status,201);assert.equal(reactivated.json.lifecycleState,'active');
  ok('component draft, changes-requested replacement, approved selection, reusable name and lifecycle paths work');

  const assessmentTemplate={commonPoints:[],keyDifferences:[],strengths:[],limitations:[],worthLearning:[],doNotCopy:[],
    hypotheses:[{claimText:'可能与叙事身份有关',limitations:'样本量有限'}],openQuestions:[],methodLimitations:['样本量有限'],
    findings:[{kind:'hypothesis',claimText:'问题开场可能与停留有关',limitations:'缺少统一曝光基线',
      evidenceState:'insufficient',memberSampleId:fixture[0].sampleId,evidenceTokens:[]}]};
  let assessment=null;
  for(const target of ['traffic','persona','expertise','conversion']){
    const created=await invoke('POST',`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/assessments/manual`,
      {key:`assessment-${target}`,body:{...assessmentTemplate,target}});
    assert.equal(created.status,201,JSON.stringify(created.json));if(target==='traffic')assessment=created;
  }
  const assessmentRetry=await invoke('POST',`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/assessments/manual`,
    {key:'assessment-traffic',body:{...assessmentTemplate,target:'traffic'}});
  assert.equal(assessmentRetry.status,200);assert.equal(assessmentRetry.json.id,assessment.json.id);
  const deniedSelect=await invoke('POST',`/api/sample-comparisons/${comparisonId}/assessments/${assessment.json.id}/select`,
    {key:'selection-member',body:{}});assert.equal(deniedSelect.status,403);
  const selected=await invoke('POST',`/api/sample-comparisons/${comparisonId}/assessments/${assessment.json.id}/select`,
    {userId:reviewerId,key:'selection-reviewer',body:{reason:'人工复核'}});
  assert.equal(selected.status,201);assert.equal(selected.json.target,'traffic');
  assert.equal((await invoke('POST',`/api/sample-comparisons/${comparisonId}/assessments/${assessment.json.id}/select`,
    {userId:reviewerId,key:'selection-reviewer',body:{reason:'人工复核'}})).status,200);
  const findingRow=(await raw.query('SELECT id FROM sample_comparison_findings WHERE assessment_id=$1',[assessment.json.id])).rows[0];
  const wrongSnapshot=scopeResponse.json.members[1].elements.find(item=>item.dimensionKey==='audience');
  await rejectSql(raw,`INSERT INTO sample_comparison_finding_evidence(
    assessment_id,finding_id,member_sample_id,scope_id,snapshot_id,dimension_key,evidence_token)
    VALUES($1,$2,$3,$4,$5,'audience','mismatch')`,[assessment.json.id,findingRow.id,fixture[0].sampleId,scopeId,wrongSnapshot.id],['23503']);
  ok('four-target assessment history is separate and official selection is reviewer-gated');

  const relationBodies=[
    {type:'imitation',subjectSampleId:fixture[0].sampleId,subjectAnalysisVersionId:fixture[0].versionId,
      objectSampleId:fixture[1].sampleId,objectAnalysisVersionId:fixture[1].versionId},
    {type:'evolution',subjectSampleId:fixture[1].sampleId,subjectAnalysisVersionId:fixture[1].versionId,
      objectSampleId:fixture[0].sampleId,objectAnalysisVersionId:fixture[0].versionId},
  ];
  const relationIds=[];
  for(let index=0;index<2;index++){
    const relation=await invoke('POST','/api/sample-relations',{key:`relation-${index}`,body:relationBodies[index]});
    assert.equal(relation.status,201,JSON.stringify(relation.json));relationIds.push(relation.json.id);
    assert.equal((await invoke('POST','/api/sample-relations',{key:`relation-${index}`,body:relationBodies[index]})).status,200);
    const endpoint=index===0?fixture[0]:fixture[1];
    const evidence=await invoke('POST',`/api/sample-relations/${relation.json.id}/evidence`,{key:`relation-evidence-${index}`,
      body:{endpointSampleId:endpoint.sampleId,endpointAnalysisVersionId:endpoint.versionId,elementEvidenceId:endpoint.evidenceId}});
    assert.equal(evidence.status,201,JSON.stringify(evidence.json));
    assert.equal((await invoke('POST',`/api/sample-relations/${relation.json.id}/evidence`,{key:`relation-evidence-${index}`,
      body:{endpointSampleId:endpoint.sampleId,endpointAnalysisVersionId:endpoint.versionId,elementEvidenceId:endpoint.evidenceId}})).status,200);
    if(index===0){
      const reloaded=await invoke('GET',`/api/samples/${fixture[0].sampleId}/relations`);
      assert.equal(reloaded.status,200);const hydrated=reloaded.json.items.find(item=>item.id===relation.json.id);
      assert.equal(hydrated.state,'proposed');assert.equal(hydrated.evidenceCount,1);assert.equal(hydrated.evidence.length,1);
      assert.equal(hydrated.proposedBy,memberId);assert.equal(hydrated.permissions.canWithdraw,true);
      assert.deepEqual({endpointSampleId:hydrated.evidence[0].endpointSampleId,
        endpointAnalysisVersionId:hydrated.evidence[0].endpointAnalysisVersionId,
        elementEvidenceId:hydrated.evidence[0].elementEvidenceId},
      {endpointSampleId:endpoint.sampleId,endpointAnalysisVersionId:endpoint.versionId,elementEvidenceId:endpoint.evidenceId});
      assert.equal('quoteText'in hydrated.evidence[0],false);assert.equal('rawPayload'in hydrated.evidence[0],false);
      assert.equal(hydrated.latestEvent.eventType,'proposed');
    }
  }
  const confirmations=await Promise.all(relationIds.map((id,index)=>invoke('POST',`/api/sample-relations/${id}/events`,
    {userId:reviewerId,key:`relation-confirm-${index}`,body:{eventType:'confirmed'}})));
  assert.deepEqual(confirmations.map(item=>item.status).sort(),[201,400]);
  const confirmedIndex=confirmations.findIndex(item=>item.status===201);
  assert.equal((await invoke('POST',`/api/sample-relations/${relationIds[confirmedIndex]}/events`,
    {userId:reviewerId,key:`relation-confirm-${confirmedIndex}`,body:{eventType:'confirmed'}})).status,200);
  const withdrawn=await invoke('POST',`/api/sample-relations/${relationIds[confirmedIndex]}/events`,
    {userId:reviewerId,key:'relation-withdraw',body:{eventType:'withdrawn',reason:'复核'}});
  assert.equal(withdrawn.status,201);
  const reconfirmed=await invoke('POST',`/api/sample-relations/${relationIds[confirmedIndex]}/events`,
    {userId:adminId,key:'relation-reconfirm',body:{eventType:'confirmed'}});
  assert.equal(reconfirmed.status,201);
  ok('relation evidence survives list reload and the reloaded pending relation remains confirmable with cycle locking');

  const variant=await invoke('POST','/api/sample-relations',{key:'variant-canonical',body:{type:'variant',
    subjectSampleId:fixture[3].sampleId,subjectAnalysisVersionId:fixture[3].versionId,
    objectSampleId:fixture[2].sampleId,objectAnalysisVersionId:fixture[2].versionId}});
  assert.equal(variant.status,201);assert.ok(variant.json.subject.sampleId<variant.json.object.sampleId);

  const wrongEvidence=await invoke('POST',`/api/sample-relations/${relationIds[0]}/evidence`,{key:'wrong-endpoint',body:{
    endpointSampleId:fixture[2].sampleId,endpointAnalysisVersionId:fixture[2].versionId,elementEvidenceId:fixture[2].evidenceId}});
  assert.equal(wrongEvidence.status,400);
  ok('relation evidence is pinned to one of the two endpoint analyses');

  const noAi=await invoke('POST',`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/assessment-jobs`,
    {key:'no-ai',body:{target:'conversion'}});
  assert.equal(noAi.status,503);assert.equal(noAi.json.detail.code,'AI_NOT_CONFIGURED');
  const jobCount=await raw.query('SELECT count(*)::int count FROM sample_comparison_assessment_jobs');assert.equal(jobCount.rows[0].count,0);
  ok('missing AI key creates no job and returns a safe AI_NOT_CONFIGURED error');

  const successJob=(await raw.query(`INSERT INTO sample_comparison_assessment_jobs(
    comparison_id,scope_id,target,request_sha256,provider,model_name,requested_by)
    VALUES($1,$2,'persona',$3,'mock','mock-model',$4)RETURNING id`,[comparisonId,scopeId,'4'.repeat(64),memberId])).rows[0];
  routes.configureAssessmentWorkerForTests({leaseMs:120,heartbeatMs:30,requester:async({target,scope})=>{
    await new Promise(resolve=>setTimeout(resolve,350));
    const member=scope.members[0],element=member.elements.find(item=>item.evidenceTokens?.length);
    return {assessment:{...assessmentTemplate,target,findings:[{kind:'observation',claimText:'冻结证据显示结构差异',
      limitations:null,evidenceState:'verified',memberSampleId:member.sampleId,evidenceTokens:[element.evidenceTokens[0].token]}]},
      provider:'mock-provider',modelName:'mock-model-v1',inputSha256:'5'.repeat(64)};
  }});
  const longWorker=routes.runAssessmentWorker();
  await new Promise(resolve=>setTimeout(resolve,180));
  await routes.recoverAssessmentJobs();
  const activeSuccess=await raw.query('SELECT status,lease_expires_at>now() lease_fresh FROM sample_comparison_assessment_jobs WHERE id=$1',[successJob.id]);
  assert.deepEqual(activeSuccess.rows[0],{status:'running',lease_fresh:true});
  await longWorker;
  const successfulAssessment=await raw.query(`SELECT j.status,a.id,a.model_provider,a.model_name,a.input_sha256,
    (SELECT count(*)::int FROM sample_comparison_findings f WHERE f.assessment_id=a.id) findings,
    (SELECT count(*)::int FROM sample_comparison_finding_evidence e WHERE e.assessment_id=a.id) evidence,
    (SELECT count(*)::int FROM sample_comparison_assessment_selections s WHERE s.assessment_id=a.id) selections
    FROM sample_comparison_assessment_jobs j JOIN sample_comparison_assessments a ON a.job_id=j.id WHERE j.id=$1`,[successJob.id]);
  assert.equal(successfulAssessment.rows[0].status,'succeeded');
  assert.deepEqual({provider:successfulAssessment.rows[0].model_provider,model:successfulAssessment.rows[0].model_name,
    findings:successfulAssessment.rows[0].findings,evidence:successfulAssessment.rows[0].evidence,
    selections:successfulAssessment.rows[0].selections},
  {provider:'mock-provider',model:'mock-model-v1',findings:1,evidence:1,selections:0});
  routes.configureAssessmentWorkerForTests(null);
  ok('renewable heartbeat protects a long successful AI call and success creates evidence-backed assessment with no implicit selection');

  const getRoutes=[
    ['/api/sample-comparisons','?page=1&pageSize=20'],[`/api/sample-comparisons/${comparisonId}`,''],
    [`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}`,''],
    [`/api/sample-comparisons/${comparisonId}/assessment-jobs/${successJob.id}`,''],
    [`/api/sample-comparisons/${comparisonId}/assessments`,'?target=traffic'],
    [`/api/sample-comparisons/${comparisonId}/assessments/${assessment.json.id}`,''],
    [`/api/samples/${fixture[0].sampleId}/relations`,''],['/api/sample-element-extractions','?page=1&pageSize=20'],
    ['/api/content-components','?page=1&pageSize=20'],[`/api/content-components/${componentId}`,''],
    ['/api/reusable-components','?page=1&pageSize=20'],
  ];
  const postRoutes=[
    {path:'/api/sample-comparisons'},
    {path:`/api/sample-comparisons/${comparisonId}/scopes`},
    {path:`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/assessments/manual`},
    {path:`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/assessment-jobs`},
    {path:`/api/sample-comparisons/${comparisonId}/assessments/${assessment.json.id}/select`,restricted:'reviewer'},
    {path:'/api/sample-relations'},
    {path:`/api/sample-relations/${relationIds[confirmedIndex]}/evidence`},
    {path:'/api/sample-relations/999999/events',restricted:'reviewer',body:{eventType:'confirmed'}},
    {path:`/api/sample-comparisons/${comparisonId}/scopes/${scopeId}/extractions`},
    {path:'/api/content-components'},
    {path:`/api/content-components/${componentId}/revisions`},
    {path:`/api/content-components/${componentId}/revisions/${revision3Id}/tags`},
    {path:`/api/content-components/${componentId}/revisions/${revision3Id}/submit`},
    {path:`/api/content-components/${componentId}/revisions/${revision3Id}/review`,restricted:'reviewer'},
    {path:`/api/content-components/${componentId}/lifecycle`,restricted:'admin'},
  ];
  const writeSignature=async()=> (await raw.query(`SELECT jsonb_build_object(
    'idem',(SELECT count(*) FROM sample_stage3_idempotency),'scopes',(SELECT count(*) FROM sample_comparison_scopes),
    'assessments',(SELECT count(*) FROM sample_comparison_assessments),'jobs',(SELECT count(*) FROM sample_comparison_assessment_jobs),
    'assessmentSelections',(SELECT count(*) FROM sample_comparison_assessment_selections),'relations',(SELECT count(*) FROM sample_relations),
    'relationEvidence',(SELECT count(*) FROM sample_relation_evidence),'relationEvents',(SELECT count(*) FROM sample_relation_events),
    'extractions',(SELECT count(*) FROM sample_element_extractions),'components',(SELECT count(*) FROM content_components),
    'revisions',(SELECT count(*) FROM content_component_revisions),'decisions',(SELECT count(*) FROM content_component_revision_decisions),
    'lifecycle',(SELECT count(*) FROM content_component_lifecycle_events)) signature`)).rows[0].signature;
  const matrixBefore=await writeSignature();
  for(const [path,queryString] of getRoutes){
    assert.equal((await invoke('GET',path,{userId:null,queryString})).status,401,path);
    for(const userId of [memberId,reviewerId,adminId])assert.equal((await invoke('GET',path,{userId,queryString})).status,200,path);
  }
  for(let index=0;index<postRoutes.length;index++){
    const item=postRoutes[index],body=Object.hasOwn(item,'body')?item.body:null;
    assert.equal((await invoke('POST',item.path,{userId:null,key:`matrix-anon-${index}`,body})).status,401,item.path);
    for(const [role,userId] of [['member',memberId],['reviewer',reviewerId],['admin',adminId]]){
      const result=await invoke('POST',item.path,{userId,key:`matrix-${index}-${role}`,body});
      const denied=item.restricted==='admin'?role!=='admin':item.restricted==='reviewer'?role==='member':false;
      assert.equal(result.status,denied?403:(item.path.includes('/999999/')?404:400),`${role} ${item.path}`);
    }
  }
  assert.deepEqual(await writeSignature(),matrixBefore);
  ok('table-driven anonymous/member/reviewer/admin matrix covers every Stage3 route with zero writes on 401/403/invalid probes');

  const jobSeed=await raw.query(`INSERT INTO sample_comparison_assessment_jobs(
    comparison_id,scope_id,target,request_sha256,provider,model_name,requested_by
  )VALUES($1,$2,'conversion',$3,'test','test',$4)RETURNING id`,[comparisonId,scopeId,'9'.repeat(64),memberId]);
  await raw.query(`UPDATE sample_comparison_assessment_jobs SET status='running',attempts=attempts+1,started_at=now(),
    lease_owner='pre-restart',lease_expires_at=now()+interval '400 milliseconds' WHERE id=$1`,[jobSeed.rows[0].id]);
  await rejectSql(raw,`INSERT INTO sample_comparison_assessment_jobs(
    comparison_id,scope_id,target,request_sha256,provider,model_name,requested_by)
    VALUES($1,$2,'conversion',$3,'test','test',$4)`,[comparisonId,scopeId,'7'.repeat(64),memberId],['23505']);
  const secondJob=await raw.query(`INSERT INTO sample_comparison_assessment_jobs(
    comparison_id,scope_id,target,request_sha256,provider,model_name,requested_by
  )VALUES($1,$2,'expertise',$3,'test','test',$4)RETURNING id`,[comparisonId,scopeId,'8'.repeat(64),memberId]);
  await rejectSql(raw,`UPDATE sample_comparison_assessment_jobs SET status='running',attempts=attempts+1,started_at=now()WHERE id=$1`,
    [secondJob.rows[0].id],['23505']);
  routes.scheduleAssessmentRecovery(0);
  await new Promise(resolve=>setTimeout(resolve,100));
  const beforeExpiry=await raw.query(`SELECT status FROM sample_comparison_assessment_jobs WHERE id=ANY($1::bigint[])ORDER BY id`,
    [[jobSeed.rows[0].id,secondJob.rows[0].id]]);
  assert.deepEqual(beforeExpiry.rows.map(row=>row.status),['running','queued']);
  let activeJobs=2;
  for(let attempt=0;attempt<40&&activeJobs;attempt++){
    await new Promise(resolve=>setTimeout(resolve,100));
    activeJobs=Number((await raw.query(`SELECT count(*) count FROM sample_comparison_assessment_jobs
      WHERE id=ANY($1::bigint[])AND status IN('queued','running')`,[[jobSeed.rows[0].id,secondJob.rows[0].id]])).rows[0].count);
  }
  assert.equal(activeJobs,0);
  const recovered=await raw.query(`SELECT status,error_code FROM sample_comparison_assessment_jobs
    WHERE id=ANY($1::bigint[])ORDER BY id`,[[jobSeed.rows[0].id,secondJob.rows[0].id]]);
  assert.ok(recovered.rows.every(row=>row.status==='failed'&&row.error_code==='AI_NOT_CONFIGURED'));
  ok('partial indexes and recurring recovery reschedule a future lease, then unblock the queued job after restart');

  await raw.end();
  console.log(`1..${checks}`);
}finally{
  comparisonRoutes?.stopAssessmentRecovery?.();
  if(appDb)await appDb.close().catch(()=>{});
  if(root._connected){
    if(process.env.KEEP_STAGE3_TEST_SCHEMA==='1')console.log(`Kept test schema ${testSchema}`);
    else{
      await root.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`).catch(()=>{});
      await root.query(`DROP SCHEMA IF EXISTS ${decoySchema} CASCADE`).catch(()=>{});
    }
    await root.end().catch(()=>{});
  }
}
