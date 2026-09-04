import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {Readable} from 'node:stream';
import * as accountRoutes from '../server/src/routes/account-research.mjs';
import {buildAccountContentMatrix,buildAccountSaturation} from '../server/src/lib/account-research.mjs';
import {assertAccountResearchConfigDto,assertAccountResearchListDto,assertAccountResearchDetailDto,
  assertAccountResearchRunMutationDto,assertAccountResearchDecisionMutationDto,assertAccountResearchErrorDto} from '../web/src/account-research-contract.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required; use only a disposable PostgreSQL 16 database');
if(process.env.DATABASE_URL&&new URL(url).toString()===new URL(process.env.DATABASE_URL).toString())throw new Error('refusing DATABASE_URL');
const suffix=randomBytes(6).toString('hex'),fresh=`arv3_f_${suffix}`,upgrade=`arv3_u_${suffix}`,failure=`arv3_x_${suffix}`;
if(![fresh,upgrade,failure].every(value=>/^arv3_[fux]_[0-9a-f]{12}$/.test(value)))throw new Error('unsafe schema name');
const root=new pg.Client({connectionString:url});
const schemaSql=await readFile(new URL('../server/src/schema.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('./migrations/20260902-account-research-v3.sql',import.meta.url),'utf8');
const v11Marker='-- account-research/1.1: auditable multi-claim depth, persisted matrix and saturation.';
const v11Offset=migration.indexOf(v11Marker);if(v11Offset<0)throw new Error('account research 1.1 migration marker missing');
const legacyV10Migration=`${migration.slice(0,v11Offset)}COMMIT;`;
const v11OnlyMigration=`BEGIN;\n${migration.slice(v11Offset)}`;
const stageMigrations=await Promise.all(['20260829-sample-library-stage1.sql','20260829-sample-library-stage2.sql',
  '20260829-sample-library-stage3.sql','20260831-sample-comparison-lifecycle.sql','20260829-sample-library-stage4.sql']
  .map(name=>readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8')));
const marker='-- ============================================================\n--  账户研究 v3';
const offset=schemaSql.indexOf(marker);if(offset<0)throw new Error('account research schema marker missing');
const stage1Marker='-- ============================================================\n--  内容样本研究库（阶段一：原始档案）';
const stage1Offset=schemaSql.indexOf(stage1Marker);if(stage1Offset<0)throw new Error('stage 1 schema marker missing');
let passed=0;const check=(name,fn=()=>{})=>{fn();passed++;console.log(`✓ ${name}`);};
const sha=value=>createHash('sha256').update(String(value)).digest('hex');
const options=schema=>{const target=new URL(url);target.searchParams.set('options',`-csearch_path=${schema},public`);return target.toString();};
async function catalog(client){
  const tables=(await client.query(`SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND
    (tablename LIKE 'account_research_%' OR tablename LIKE 'research_account%')ORDER BY 1`)).rows.map(x=>x.tablename);
  const constraints=(await client.query(`SELECT c.conname,c.contype,pg_get_constraintdef(c.oid) def FROM pg_constraint c
    WHERE c.connamespace=current_schema()::regnamespace AND(c.conrelid::regclass::text LIKE 'account_research_%' OR c.conrelid::regclass::text LIKE 'research_account%')ORDER BY 1`)).rows;
  const indexes=(await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND
    (tablename LIKE 'account_research_%' OR tablename LIKE 'research_account%')ORDER BY 1`)).rows;
  const triggers=(await client.query(`SELECT event_object_table,trigger_name FROM information_schema.triggers WHERE trigger_schema=current_schema() AND
    (event_object_table LIKE 'account_research_%' OR event_object_table LIKE 'research_account%')ORDER BY 1,2`)).rows;
  return {tables,constraints,indexes,triggers};
}
async function rejectSql(client,sql,params=[],pattern=/./){await client.query('SAVEPOINT expected_failure');try{await client.query(sql,params);assert.fail('write unexpectedly succeeded');}
  catch(error){assert.match(String(error.message),pattern);}finally{await client.query('ROLLBACK TO SAVEPOINT expected_failure');await client.query('RELEASE SAVEPOINT expected_failure');}}

try{
  await root.connect();const version=Number((await root.query('SHOW server_version_num')).rows[0].server_version_num);assert.ok(version>=160000&&version<170000,`PostgreSQL 16 required, got ${version}`);
  const trgm=(await root.query(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'`)).rows[0];
  if(!trgm)await root.query('CREATE EXTENSION pg_trgm WITH SCHEMA public');else if(trgm.nspname!=='public')throw new Error('pg_trgm must be in public in disposable database');
  await root.query(`CREATE SCHEMA "${fresh}"`);await root.query(`CREATE SCHEMA "${upgrade}"`);await root.query(`CREATE SCHEMA "${failure}"`);
  const f=new pg.Client({connectionString:options(fresh)}),u=new pg.Client({connectionString:options(upgrade)});await f.connect();await u.connect();
  try{
    await u.query(schemaSql.slice(0,stage1Offset));for(const sql of stageMigrations)await u.query(sql);
    const legacyUser=(await u.query(`INSERT INTO users(name,role)VALUES('legacy admin','admin')RETURNING id`)).rows[0];
    const legacySample=(await u.query(`INSERT INTO samples(canonical_key,platform,title,body_text,archive_status,current_analysis_version_id)
      VALUES('legacy-preserved','manual','legacy','legacy body','usable',NULL)RETURNING id`)).rows[0];
    const legacyCapture=(await u.query(`INSERT INTO sample_captures(sample_id,capture_key,capture_type,payload_sha256)
      VALUES($1,'legacy-cap','manual',$2)RETURNING id`,[legacySample.id,sha('legacy-cap')])).rows[0];
    const legacyVersion=(await u.query(`INSERT INTO sample_analysis_versions(sample_id,source_capture_id,revision,source,input_sha256,schema_version,manifest_sha256)
      VALUES($1,$2,1,'manual',$3,'legacy-fixture',$4)RETURNING id`,[legacySample.id,legacyCapture.id,sha('legacy-input'),sha('legacy-manifest')])).rows[0];
    await u.query(`INSERT INTO sample_analysis_elements(version_id,dimension_key,state,value_json,function_text,limitations)
      SELECT $1,dimension_key,'value',to_jsonb(dimension_key),'legacy function','legacy limitation' FROM sample_analysis_dimensions`,[legacyVersion.id]);
    await u.query(`UPDATE sample_analysis_versions SET status='complete',completed_at='2026-01-01' WHERE id=$1`,[legacyVersion.id]);
    await u.query(`INSERT INTO sample_analysis_selections(sample_id,version_id,reason,selected_by)VALUES($1,$2,'explicit',$3)`,[legacySample.id,legacyVersion.id,legacyUser.id]);
    const legacyElement=(await u.query(`SELECT id FROM sample_analysis_elements WHERE version_id=$1 ORDER BY id LIMIT 1`,[legacyVersion.id])).rows[0];
    const legacyDecision=(await u.query(`INSERT INTO sample_element_decisions(element_id,decision,note,decided_by)
      VALUES($1,'confirmed','legacy decision',$2)RETURNING id`,[legacyElement.id,legacyUser.id])).rows[0];
    const legacyWork=(await u.query(`INSERT INTO works(channel,side,title,created_by)VALUES('matrix','benchmark','legacy work',$1)RETURNING id`,[legacyUser.id])).rows[0];
    await u.query(`INSERT INTO work_analyses(work_id,task_id,platform,schema_ver,payload,digest)
      VALUES($1,'legacy-task','manual',13,$2::json,$3::jsonb)`,[legacyWork.id,JSON.stringify({ordered:'payload',items:[1,2]}),JSON.stringify({topic:'legacy'})]);
    const before={users:Number((await u.query('SELECT count(*) n FROM users')).rows[0].n),samples:Number((await u.query('SELECT count(*) n FROM samples')).rows[0].n),
      dimensions:(await u.query('SELECT dimension_key,ordinal,label FROM sample_analysis_dimensions ORDER BY ordinal')).rows,
      semantic:(await u.query(`SELECT s.current_analysis_version_id,v.status,v.completed_at,d.id decision_id,d.decision,
        wa.task_id,wa.schema_ver,wa.payload::text payload,wa.digest FROM samples s JOIN sample_analysis_versions v ON v.id=s.current_analysis_version_id
        JOIN sample_element_decisions d ON d.id=$2 CROSS JOIN work_analyses wa WHERE s.id=$1 AND wa.work_id=$3`,[legacySample.id,legacyDecision.id,legacyWork.id])).rows[0]};
    await u.query(legacyV10Migration);
    const legacyDraftAccount=(await u.query(`INSERT INTO research_accounts(stable_key,platform,platform_account_id,identity_quality,identity_source,needs_review)VALUES('manual:id:legacy-draft','manual','legacy-draft','platform_id','platform_account_id',false)RETURNING id`)).rows[0];
    const legacyDraft=(await u.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)VALUES($1,1,'building','manual','2026-01-01','2026-02-01',10,0,0,'{}','[]','{}',$2,'account-research/1.0','account-research-dto/1.0','account-sampling/1.0','account-quality/1.0',$3)RETURNING id`,[legacyDraftAccount.id,sha('legacy-building'),legacyUser.id])).rows[0];
    await u.query(v11OnlyMigration);await u.query(migration);
    const aborted=(await u.query(`SELECT status,warnings_json,normalized_request,(SELECT count(*) FROM account_research_claims WHERE run_id=$1) claims,(SELECT count(*) FROM account_research_claim_samples WHERE run_id=$1) members FROM account_research_runs WHERE id=$1`,[legacyDraft.id])).rows[0];
    assert.equal(aborted.status,'failed');assert.equal(aborted.warnings_json.filter(value=>value==='legacy_v1_build_aborted').length,1);assert.equal(aborted.normalized_request.legacy_v1_build_aborted,true);assert.equal(Number(aborted.claims),0);assert.equal(Number(aborted.members),0);
    await f.query(schemaSql);
    const after={users:Number((await u.query('SELECT count(*) n FROM users')).rows[0].n),samples:Number((await u.query('SELECT count(*) n FROM samples')).rows[0].n),
      dimensions:(await u.query('SELECT dimension_key,ordinal,label FROM sample_analysis_dimensions ORDER BY ordinal')).rows,
      semantic:(await u.query(`SELECT s.current_analysis_version_id,v.status,v.completed_at,d.id decision_id,d.decision,
        wa.task_id,wa.schema_ver,wa.payload::text payload,wa.digest FROM samples s JOIN sample_analysis_versions v ON v.id=s.current_analysis_version_id
        JOIN sample_element_decisions d ON d.id=$2 CROSS JOIN work_analyses wa WHERE s.id=$1 AND wa.work_id=$3`,[legacySample.id,legacyDecision.id,legacyWork.id])).rows[0]};
    assert.deepEqual(after,before);check('upgrade double-run preserves legacy users, samples, current pointers and 15-dimension dictionary');
    check('repeat migration atomically aborts legacy 1.0 building drafts exactly once without guessed claims or members');
    const normalize=value=>JSON.parse(JSON.stringify(value).replaceAll(fresh,'SCHEMA').replaceAll(upgrade,'SCHEMA'));
    assert.deepEqual(normalize(await catalog(f)),normalize(await catalog(u)));check('fresh schema and upgraded schema have identical account-research tables, constraints, indexes and triggers');
    const x=new pg.Client({connectionString:options(failure)});await x.connect();try{await x.query(schemaSql.slice(0,offset));
      const poisoned=migration.replace('\nCOMMIT;\n\n-- Post-migration','\nSELECT 1/0;\nCOMMIT;\n\n-- Post-migration');assert.notEqual(poisoned,migration);
      await assert.rejects(x.query(poisoned),/division by zero/i);await x.query('ROLLBACK');
      assert.equal((await catalog(x)).tables.length,0);await x.query(migration);assert.equal((await catalog(x)).tables.length,15);
      check('injected migration failure rolls back atomically and a clean retry succeeds');
    }finally{await x.end();}

    await u.query('BEGIN');
    const reviewer=(await u.query(`INSERT INTO users(name,role)VALUES('reviewer','reviewer')RETURNING id`)).rows[0];
    const member=(await u.query(`INSERT INTO users(name,role)VALUES('member','member')RETURNING id`)).rows[0];
    const sample=(await u.query(`INSERT INTO samples(canonical_key,platform,account_name,account_handle,title,body_text,content_type,published_at,metrics,archive_status)
      VALUES('arv3-sample','xiaohongshu','账户甲','HandleA','fixture title','作品😀结论正文','image_post','2026-01-10','{"comments":1}','usable')RETURNING id`)).rows[0];
    const capture=(await u.query(`INSERT INTO sample_captures(sample_id,capture_key,capture_type,captured_at,normalized_payload,payload_sha256)
      VALUES($1,'cap-1','manual','2026-01-15',$2::jsonb,$3)RETURNING id`,[sample.id,JSON.stringify({platformAccountId:'CaseID',accountName:'账户甲',bio:'公开简介',qualification:'认证咨询师'}),sha('capture')])).rows[0];
    const image=(await u.query(`INSERT INTO sample_assets(sample_id,capture_id,kind,storage_key,mime_type,byte_size,sha256,width,height,archive_quality)
      VALUES($1,$2,'image',$3,'image/png',10,$4,100,100,'original')RETURNING id`,[sample.id,capture.id,'1'.repeat(48),sha('image')])).rows[0];
    const video=(await u.query(`INSERT INTO sample_assets(sample_id,capture_id,kind,storage_key,mime_type,byte_size,sha256,duration_ms,archive_quality)
      VALUES($1,$2,'video',$3,'video/mp4',10,$4,5000,'original')RETURNING id`,[sample.id,capture.id,'2'.repeat(48),sha('video')])).rows[0];
    const versionRow=(await u.query(`INSERT INTO sample_analysis_versions(sample_id,source_capture_id,revision,source,input_sha256,schema_version,manifest_sha256)
      VALUES($1,$2,1,'manual',$3,'fixture',$4)RETURNING id`,[sample.id,capture.id,sha('input'),sha('manifest')])).rows[0];
    await u.query(`INSERT INTO sample_analysis_elements(version_id,dimension_key,state,value_json)SELECT $1,dimension_key,'value',to_jsonb(dimension_key) FROM sample_analysis_dimensions`,[versionRow.id]);
    const elements=(await u.query(`SELECT id FROM sample_analysis_elements WHERE version_id=$1 ORDER BY id`,[versionRow.id])).rows;
    const sources=[
      ['body-src','body',null,{startOffset:4,endOffset:8},'结论正文',4,8,null,null,null],
      ['comment-src','comment',null,{commentRef:'c-1'},'评论原文',null,null,null,null,'c-1'],
      ['image-src','ocr',image.id,{imageIndex:1,region:{x:.1,y:.1,width:.5,height:.5}},'图片文字',null,null,null,null,null],
      ['video-src','transcript',video.id,{timeStartMs:1000,timeEndMs:2000},'视频原话',null,null,1000,2000,null],
    ];
    const evidenceIds=[];
    for(const [index,[sourceId,kind,assetId,locator,quote,start,end,tStart,tEnd,commentRef]]of sources.entries()){
      await u.query(`INSERT INTO sample_evidence_sources(version_id,sample_id,source_capture_id,asset_id,source_id,source_kind,locator,content_sha256,content_length)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[versionRow.id,sample.id,capture.id,assetId,sourceId,kind,JSON.stringify(locator),sha(`${sourceId}-content`),quote.length]);
      evidenceIds.push((await u.query(`INSERT INTO sample_element_evidence(version_id,element_id,source_id,verification_status,quote_text,quote_sha256,start_offset,end_offset,time_start_ms,time_end_ms,comment_ref)
        VALUES($1,$2,$3,'verified',$4,$5,$6,$7,$8,$9,$10)RETURNING id`,[versionRow.id,elements[index].id,sourceId,quote,sha(quote),start,end,tStart,tEnd,commentRef])).rows[0].id);
    }
    await u.query(`INSERT INTO sample_evidence_sources(version_id,sample_id,source_capture_id,asset_id,source_id,source_kind,locator,content_sha256,content_length)
      VALUES($1,$2,$3,$4,'image-999-src','ocr','{"imageIndex":999}',$5,4)`,[versionRow.id,sample.id,capture.id,image.id,sha('image-999-source')]);
    const image999Evidence=(await u.query(`INSERT INTO sample_element_evidence(version_id,element_id,source_id,verification_status,quote_text,quote_sha256)
      VALUES($1,$2,'image-999-src','verified','越界图片',$3)RETURNING id`,[versionRow.id,elements[4].id,sha('越界图片')])).rows[0];
    await u.query(`INSERT INTO sample_evidence_sources(version_id,sample_id,source_capture_id,asset_id,source_id,source_kind,locator,content_sha256,content_length)
      VALUES($1,$2,$3,$4,'image-bad-region','ocr','{"imageIndex":1,"region":{"x":0.9,"y":0.1,"width":0.5,"height":0.5}}',$5,4)`,[versionRow.id,sample.id,capture.id,image.id,sha('image-bad-region-source')]);
    const badRegionEvidence=(await u.query(`INSERT INTO sample_element_evidence(version_id,element_id,source_id,verification_status,quote_text,quote_sha256)
      VALUES($1,$2,'image-bad-region','verified','坏的区域',$3)RETURNING id`,[versionRow.id,elements[5].id,sha('坏的区域')])).rows[0];
    await u.query(`UPDATE sample_analysis_versions SET status='complete',completed_at=now()WHERE id=$1`,[versionRow.id]);
    const account=(await u.query(`INSERT INTO research_accounts(stable_key,platform,platform_account_id,display_name,handle,identity_quality,identity_source,needs_review)
      VALUES('xiaohongshu:id:CaseID','xiaohongshu','CaseID','账户甲','handlea','platform_id','platform_account_id',false)RETURNING id`)).rows[0];
    await u.query(`INSERT INTO research_account_sample_links(account_id,sample_id,identity_quality,identity_source,linked_by)VALUES($1,$2,'platform_id','platform_account_id',$3)`,[account.id,sample.id,legacyUser.id]);
    const profile=(await u.query(`INSERT INTO research_account_profile_snapshots(account_id,source_sample_id,source_capture_id,snapshot_key,captured_at,display_name,handle,profile_json,snapshot_sha256)
      VALUES($1,$2,$3,'fixture','2026-01-15','账户甲','handlea',$4::jsonb,$5)RETURNING id`,[account.id,sample.id,capture.id,JSON.stringify({bio:'公开简介',qualification:'认证咨询师'}),sha('profile')])).rows[0];
    const run=(await u.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,
      coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)
      VALUES($1,1,'building','manual','2026-01-01','2026-02-01',10,1,1,'{}','[]','{}',$2,'account-research/1.0','account-research-dto/1.0','account-sampling/1.0','account-quality/1.0',$3)RETURNING id`,[account.id,sha('run'),legacyUser.id])).rows[0];
    await u.query(`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,inclusion_reasons,time_bucket,performance_band,performance_basis)
      VALUES($1,$2,$3,1,ARRAY['census'],'2026-01','top','proxy')`,[run.id,account.id,sample.id]);
    const dimensions=['identity_positioning','audience_needs','content_supply','expression_mechanism','trust_relationship','community_feedback','conversion_path','temporal_evolution'];
    for(const [index,key]of dimensions.entries())await u.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,'{}','材料有限','insufficient','account-quality/1.0')`,[run.id,account.id,key,index+1,index===0?'observation':'insufficient',index===0?'多篇使用清单标题':null,index===0?1:0,index===0?1:null]);
    for(const [index,[sourceId,kind,assetId,locator,quote]]of sources.entries()){
      const evidence=(await u.query(`INSERT INTO account_research_evidence(run_id,account_id,sample_id,canonical_text,content_sha256)VALUES($1,$2,$3,$4,$5)RETURNING id`,[run.id,account.id,sample.id,quote,sha(`canonical-${index}`)])).rows[0];
      await u.query(`INSERT INTO account_research_evidence_locations(run_id,evidence_id,sample_id,source_capture_id,asset_id,source_element_evidence_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,[run.id,evidence.id,sample.id,capture.id,assetId,evidenceIds[index],sourceId,index===2?'image':index===3?'video':kind,quote,JSON.stringify(locator),sha(`loc-${index}`)]);
    }
    const pe=(await u.query(`INSERT INTO account_research_evidence(run_id,account_id,sample_id,canonical_text,content_sha256)VALUES($1,$2,$3,'认证咨询师',$4)RETURNING id`,[run.id,account.id,sample.id,sha('profile-canonical')])).rows[0];
    await u.query(`INSERT INTO account_research_evidence_locations(run_id,evidence_id,sample_id,source_capture_id,profile_snapshot_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
      VALUES($1,$2,$3,$4,$5,'profile-qualification','profile','认证咨询师','{"profileField":"qualification"}',$6)`,[run.id,pe.id,sample.id,capture.id,profile.id,sha('profile-loc')]);
    await rejectSql(u,`INSERT INTO account_research_evidence_locations(run_id,evidence_id,sample_id,source_capture_id,source_element_evidence_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
      VALUES($1,$2,$3,$4,$5,'bad-body','body','伪造','{"startOffset":4,"endOffset":8}',$6)`,[run.id,pe.id,sample.id,capture.id,evidenceIds[0],sha('bad')],/immutable verified source/i);
    await rejectSql(u,`INSERT INTO account_research_evidence_locations(run_id,evidence_id,sample_id,source_capture_id,profile_snapshot_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
      VALUES($1,$2,$3,$4,$5,'bad-profile','profile','任意简介','{"profileField":"bio"}',$6)`,[run.id,pe.id,sample.id,capture.id,profile.id,sha('bad-profile')],/immutable snapshot field/i);
    await rejectSql(u,`INSERT INTO account_research_evidence_locations(run_id,evidence_id,sample_id,source_capture_id,asset_id,source_element_evidence_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'image-999','image','越界图片','{"imageIndex":999}',$7)`,[run.id,pe.id,sample.id,capture.id,image.id,image999Evidence.id,sha('image-999')],/immutable verified source/i);
    await rejectSql(u,`INSERT INTO account_research_evidence_locations(run_id,evidence_id,sample_id,source_capture_id,asset_id,source_element_evidence_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'image-bad-region','image','坏的区域','{"imageIndex":1,"region":{"x":0.9,"y":0.1,"width":0.5,"height":0.5}}',$7)`,[run.id,pe.id,sample.id,capture.id,image.id,badRegionEvidence.id,sha('image-bad-region')],/immutable verified source/i);
    check('body/comment/image/video/profile locations require exact immutable provenance; forged quote/profile text rejected');
    await u.query(`UPDATE account_research_runs SET status='complete',completed_at=now()WHERE id=$1`,[run.id]);
    await rejectSql(u,'UPDATE account_research_claims SET limitations=limitations WHERE run_id=$1',[run.id],/append-only/i);
    await rejectSql(u,'DELETE FROM account_research_runs WHERE id=$1',[run.id],/immutable/i);
    await rejectSql(u,`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,inclusion_reasons,time_bucket,performance_band,performance_basis)
      VALUES($1,$2,$3,2,ARRAY['late'],'2026-01','top','proxy')`,[run.id,account.id,sample.id],/append-only/i);
    check('complete run and children are immutable and reject late child inserts');
    await u.query(`INSERT INTO account_research_decisions(account_id,run_id,claim_id,decision,note,idempotency_key,request_sha256,decided_by,decided_by_role)
      SELECT account_id,run_id,id,'confirmed','ok','decision-1',$2,$3,'reviewer' FROM account_research_claims WHERE run_id=$1 ORDER BY id LIMIT 1`,[run.id,sha('decision'),reviewer.id]);
    await rejectSql(u,`INSERT INTO account_research_decisions(account_id,run_id,claim_id,decision,note,idempotency_key,request_sha256,decided_by,decided_by_role)
      SELECT account_id,run_id,id,'confirmed','bad','decision-member',$2,$3,'member' FROM account_research_claims WHERE run_id=$1 ORDER BY id LIMIT 1`,[run.id,sha('member'),member.id],/reviewer or admin/i);
    check('database RBAC accepts reviewer and rejects member decisions');
    await rejectSql(u,`INSERT INTO research_accounts(stable_key,platform,platform_account_id,identity_quality,identity_source,needs_review)
      VALUES('other-key','xiaohongshu','CaseID','platform_id','platform_account_id',false)`,[],/unique/i);
    check('platform stable identity is unique while opaque ID case remains significant');
    await u.query(`INSERT INTO research_accounts(stable_key,platform,platform_account_id,identity_quality,identity_source,needs_review)
      VALUES('xiaohongshu:id:caseid','xiaohongshu','caseid','platform_id','platform_account_id',false)`);
    await u.query('COMMIT');
    const dimensionsAfter=(await u.query('SELECT dimension_key FROM sample_analysis_dimensions ORDER BY ordinal')).rows.map(x=>x.dimension_key);
    assert.equal(dimensionsAfter.length,15);assert.equal(dimensionsAfter[4],'breakout_point');check('old 15-dimension behavior and breakout_point key remain intact');

    const apiPool=new pg.Pool({connectionString:options(upgrade),max:8});
    await Promise.all([1,2].map(()=>apiPool.query(`INSERT INTO research_accounts(stable_key,platform,platform_account_id,identity_quality,identity_source,needs_review)
      VALUES('youtube:id:ConcurrentCase','youtube','ConcurrentCase','platform_id','platform_account_id',false)ON CONFLICT DO NOTHING`)));
    assert.equal(Number((await apiPool.query(`SELECT count(*) n FROM research_accounts WHERE stable_key='youtube:id:ConcurrentCase'`)).rows[0].n),1);
    const handlers=new Map(),router={get:(path,fn)=>handlers.set(`GET ${path}`,fn),post:(path,fn)=>handlers.set(`POST ${path}`,fn)};
    const tx=async fn=>{const c=await apiPool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}};
    let capturedAiManifest=null;const insufficientClaims=dimensions.map(dimensionKey=>({dimensionKey,claimType:'insufficient',claimText:null,
      operationalDefinition:null,eligibleCount:0,presentCount:0,prevalence:null,timeBuckets:[],representativeSampleIds:[],counterexampleSampleIds:[],
      limitations:'insufficient evidence',causalClaimsAllowed:false,eligibleSampleIds:[],presentSampleIds:[],evidence:[]}));
    accountRoutes.mount(router,{query:apiPool.query.bind(apiPool),tx,currentUser:async req=>{if(!req.user)throw Object.assign(new Error('login required'),{status:401,code:'UNAUTHORIZED'});return req.user;},
      activeProvider:async()=>({apiKey:'stub',model:'stub',baseUrl:'https://invalid.local'}),requestAnalysis:async({manifest})=>{capturedAiManifest=manifest;return{claims:insufficientClaims,provider:'stub',modelName:'stub',modelVersion:'stub-v1'};}});
    const invoke=async(method,path,{user=null,key=null,body=null,queryString=''}={})=>{let routePath=path,params={};
      if(method==='GET'&&path.startsWith('/api/research-accounts/')&&path!=='/api/research-accounts/config'){routePath='/api/research-accounts/:accountId';params.accountId=decodeURIComponent(path.slice('/api/research-accounts/'.length));}
      if(method==='POST'&&path.endsWith('/runs')){routePath='/api/research-accounts/:accountId/runs';params.accountId=decodeURIComponent(path.slice('/api/research-accounts/'.length,-'/runs'.length));}
      const rerunMatch=method==='POST'?path.match(/^\/api\/research-accounts\/(.+)\/runs\/(\d+)\/rerun$/u):null;
      if(rerunMatch){routePath='/api/research-accounts/:accountId/runs/:runId/rerun';params={accountId:decodeURIComponent(rerunMatch[1]),runId:rerunMatch[2]};}
      const handler=handlers.get(`${method} ${routePath}`);assert.ok(handler,`${method} ${routePath}`);const payload=body==null?'':JSON.stringify(body);
      const req=Readable.from(payload?[Buffer.from(payload)]:[]);req.headers=key?{'idempotency-key':key}:{};req.user=user;let status,raw='';
      const res={writeHead(value){status=value;},end(value=''){raw+=value;}};await handler(req,res,params,new URL(`http://local${path}${queryString}`));return{status,json:JSON.parse(raw)};};
    const admin={id:Number(legacyUser.id),role:'admin',name:'legacy admin'},reviewerUser={id:Number(reviewer.id),role:'reviewer',name:'reviewer'},memberUser={id:Number(member.id),role:'member',name:'member'};
    const unauth=await invoke('GET','/api/research-accounts/config');assert.equal(unauth.status,401);assertAccountResearchErrorDto(unauth.json);
    const config=await invoke('GET','/api/research-accounts/config',{user:memberUser});assert.equal(config.status,200);assertAccountResearchConfigDto(config.json);
    const list=await invoke('GET','/api/research-accounts',{user:memberUser});assert.equal(list.status,200);assertAccountResearchListDto(list.json);
    const detail=await invoke('GET','/api/research-accounts/xiaohongshu%3Aid%3ACaseID',{user:memberUser});assert.equal(detail.status,200);assertAccountResearchDetailDto(detail.json);
    const runBody={windowStart:'2026-01-01',windowEnd:'2026-02-01',maxSamples:10,includeComments:false,source:'manual'};
    assert.equal((await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:memberUser,key:'member-denied',body:runBody})).status,403);
    const created=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'create-manual',body:runBody});assert.equal(created.status,201,JSON.stringify(created.json));assertAccountResearchRunMutationDto(created.json);
    const replay=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'create-manual',body:runBody});assert.equal(replay.status,200);assert.equal(replay.json.run.runId,created.json.run.runId);
    const conflict=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'create-manual',body:{...runBody,includeComments:true}});assert.equal(conflict.status,409);assertAccountResearchErrorDto(conflict.json);
    await apiPool.query(`INSERT INTO sample_captures(sample_id,capture_key,capture_type,normalized_payload,payload_sha256)
      VALUES($1,'cap-2','manual',$2::jsonb,$3)`,[sample.id,JSON.stringify({platformAccountId:'CaseID',accountName:'账户甲新名',bio:'后续公开简介'}),sha('capture-2')]);
    const laterSample=(await apiPool.query(`INSERT INTO samples(canonical_key,platform,account_name,title,body_text,content_type,published_at,archive_status)
      VALUES('arv3-later','xiaohongshu','账户甲新名','later','later body','text','2026-01-20','usable')RETURNING id`)).rows[0];
    await apiPool.query(`INSERT INTO sample_captures(sample_id,capture_key,capture_type,normalized_payload,payload_sha256)
      VALUES($1,'later-cap','manual',$2::jsonb,$3)`,[laterSample.id,JSON.stringify({platformAccountId:'CaseID',accountName:'账户甲新名'}),sha('later-cap')]);
    const concurrent=await Promise.all([invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'create-concurrent',body:runBody}),
      invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'create-concurrent',body:runBody})]);
    assert.deepEqual(concurrent.map(item=>item.status).sort(),[200,201]);assert.equal(concurrent[0].json.run.runId,concurrent[1].json.run.runId);
    assert.equal(concurrent[0].json.run.sampling.frozenSampleCount,2);
    assert.equal(Number((await apiPool.query('SELECT count(*) n FROM research_account_sample_links WHERE account_id=$1',[account.id])).rows[0].n),2);
    assert.ok(Number((await apiPool.query('SELECT count(*) n FROM research_account_profile_snapshots WHERE account_id=$1',[account.id])).rows[0].n)>=4);
    const excludedSample=(await apiPool.query(`INSERT INTO samples(canonical_key,platform,account_name,title,body_text,content_type,published_at,archive_status)
      VALUES('arv3-excluded','xiaohongshu','账户甲','excluded','excluded body','text','2026-03-20','usable')RETURNING id`)).rows[0];
    const excludedCapture=(await apiPool.query(`INSERT INTO sample_captures(sample_id,capture_key,capture_type,captured_at,normalized_payload,payload_sha256)
      VALUES($1,'excluded-cap','manual','2026-01-18',$2::jsonb,$3)RETURNING id`,[excludedSample.id,JSON.stringify({platformAccountId:'CaseID',bio:'UNSELECTED_PROFILE'}),sha('excluded-cap')])).rows[0];
    await apiPool.query(`INSERT INTO research_account_sample_links(account_id,sample_id,identity_quality,identity_source,linked_by)
      VALUES($1,$2,'platform_id','platform_account_id',$3)`,[account.id,excludedSample.id,admin.id]);
    await apiPool.query(`INSERT INTO research_account_profile_snapshots(account_id,source_sample_id,source_capture_id,snapshot_key,captured_at,profile_json,snapshot_sha256)
      VALUES($1,$2,$3,'excluded-profile','2026-01-18',$4::jsonb,$5)`,[account.id,excludedSample.id,excludedCapture.id,JSON.stringify({bio:'UNSELECTED_PROFILE'}),sha('excluded-profile')]);
    const overlong=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'x'.repeat(161),body:runBody});assert.equal(overlong.status,400);assertAccountResearchErrorDto(overlong.json);
    const tooLarge=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'large',body:{...runBody,unknown:'x'.repeat(70_000)}});assert.equal(tooLarge.status,400);assertAccountResearchErrorDto(tooLarge.json);
    let deep='leaf';for(let i=0;i<12;i++)deep={nested:deep};const tooDeep=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'deep',body:{...runBody,extra:deep}});assert.equal(tooDeep.status,400);assertAccountResearchErrorDto(tooDeep.json);
    const aiCreated=await invoke('POST','/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs',{user:admin,key:'create-ai-no-comments',body:{...runBody,source:'ai'}});
    assert.equal(aiCreated.status,201,JSON.stringify(aiCreated.json));assert.ok(capturedAiManifest.sources.some(item=>item.sourceKind==='profile'));
    assert.ok(!capturedAiManifest.sources.some(item=>item.sourceKind==='comment'));
    assert.ok(!capturedAiManifest.sources.some(item=>['UNSELECTED_PROFILE','后续公开简介'].includes(item.quoteText)));
    assert.equal(aiCreated.json.run.sampling.coverage.comments,0);assert.ok(aiCreated.json.run.quality.risks.some(item=>item.includes('明确排除评论')));
    assert.equal(Number((await apiPool.query(`SELECT count(*) n FROM account_research_evidence_locations WHERE run_id=$1 AND source_kind='comment'`,[aiCreated.json.run.runId])).rows[0].n),0);
    const rerunPath=`/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs/${created.json.run.runId}/rerun`;
    const reruns=await Promise.all([invoke('POST',rerunPath,{user:admin,key:'rerun-same',body:runBody}),invoke('POST',rerunPath,{user:admin,key:'rerun-same',body:runBody})]);
    assert.deepEqual(reruns.map(item=>item.status).sort(),[200,201]);assert.equal(reruns[0].json.run.runId,reruns[1].json.run.runId);
    const conflictingReruns=await Promise.all([invoke('POST',rerunPath,{user:admin,key:'rerun-conflict',body:runBody}),
      invoke('POST',rerunPath,{user:admin,key:'rerun-conflict',body:{...runBody,includeComments:true}})]);
    assert.deepEqual(conflictingReruns.map(item=>item.status).sort(),[201,409]);
    const claimId=(await u.query('SELECT id FROM account_research_claims WHERE run_id=$1 ORDER BY id LIMIT 1',[created.json.run.runId])).rows[0].id;
    const observationClaimId=(await u.query(`SELECT id FROM account_research_claims WHERE run_id=$1 AND claim_type='observation'`,[run.id])).rows[0].id;
    const decisionPath=`/api/research-accounts/xiaohongshu%3Aid%3ACaseID/runs/${created.json.run.runId}/claims/${claimId}/decisions`;
    const decisionHandler=handlers.get('POST /api/research-accounts/:accountId/runs/:runId/claims/:claimId/decisions');
    const invokeDecision=async(user,keyValue,bodyValue)=>{const payload=Buffer.from(JSON.stringify(bodyValue));const req=Readable.from([payload]);req.headers={'idempotency-key':keyValue};req.user=user;let status,raw='';const res={writeHead(v){status=v;},end(v=''){raw+=v;}};
      await decisionHandler(req,res,{accountId:'xiaohongshu:id:CaseID',runId:String(created.json.run.runId),claimId:String(claimId)},new URL(`http://local${decisionPath}`));return{status,json:JSON.parse(raw)};};
    const invokeObservationEdit=async(keyValue,bodyValue)=>{const payload=Buffer.from(JSON.stringify(bodyValue));const req=Readable.from([payload]);req.headers={'idempotency-key':keyValue};req.user=reviewerUser;let status,raw='';const res={writeHead(v){status=v;},end(v=''){raw+=v;}};
      await decisionHandler(req,res,{accountId:'xiaohongshu:id:CaseID',runId:String(run.id),claimId:String(observationClaimId)},new URL('http://local/edit'));return{status,json:JSON.parse(raw)};};
    assert.equal((await invokeDecision(memberUser,'decision-denied',{decision:'confirmed'})).status,403);
    const forbiddenEdit=await invokeDecision(reviewerUser,'decision-edit-insufficient',{decision:'edited',claimText:'实质结论',limitations:'当前窗口有限'});
    assert.equal(forbiddenEdit.status,409);assertAccountResearchErrorDto(forbiddenEdit.json);
    for(const [index,claimText]of ['引发收藏增长','让收藏增长','促使转化提升','有助于粉丝增长','助推销量增长','令点击增加'].entries())
      assert.equal((await invokeObservationEdit(`causal-edit-${index}`,{decision:'edited',claimText,limitations:'当前窗口有限'})).status,400,claimText);
    assert.equal((await invokeObservationEdit('causal-edit-definition',{decision:'edited',claimText:'多篇使用清单标题',operationalDefinition:'收藏增长是因为标题结构',limitations:'当前窗口有限'})).status,400);
    const decided=await invokeDecision(reviewerUser,'decision-ok',{decision:'confirmed',note:'checked'});assert.equal(decided.status,201,JSON.stringify(decided.json));assertAccountResearchDecisionMutationDto(decided.json);
    assert.equal((await invokeDecision(reviewerUser,'decision-ok',{decision:'confirmed',note:'checked'})).status,200);
    const concurrentDecisions=await Promise.all([invokeDecision(reviewerUser,'decision-same',{decision:'confirmed',note:'same'}),invokeDecision(reviewerUser,'decision-same',{decision:'confirmed',note:'same'})]);
    assert.deepEqual(concurrentDecisions.map(item=>item.status).sort(),[200,201]);
    const conflictingDecisions=await Promise.all([invokeDecision(reviewerUser,'decision-conflict',{decision:'confirmed',note:'A'}),invokeDecision(reviewerUser,'decision-conflict',{decision:'confirmed',note:'B'})]);
    assert.deepEqual(conflictingDecisions.map(item=>item.status).sort(),[201,409]);
    const otherAccount=(await apiPool.query(`SELECT id FROM research_accounts WHERE stable_key='xiaohongshu:id:caseid'`)).rows[0];
    await assert.rejects(apiPool.query(`INSERT INTO research_account_sample_links(account_id,sample_id,identity_quality,identity_source,linked_by)
      VALUES($1,$2,'platform_id','platform_account_id',$3)`,[otherAccount.id,laterSample.id,admin.id]),/unique|duplicate/i);
    const guardRevision=Number((await apiPool.query('SELECT max(revision)+1 value FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].value);
    const guardRun=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,
      coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)
      VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',10,0,0,'{}','[]','{}',$3,'account-research/1.0','account-research-dto/1.0','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,guardRevision,sha('guard-run'),admin.id])).rows[0];
    for(const [index,keyName]of dimensions.entries())await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)
      VALUES($1,$2,$3,$4,'insufficient',NULL,0,0,NULL,'{}','insufficient','insufficient','account-quality/1.0')`,[guardRun.id,account.id,keyName,index+1]);
    const completer=await apiPool.connect(),lateWriter=await apiPool.connect();
    try{await completer.query('BEGIN');await completer.query(`UPDATE account_research_runs SET status='complete',completed_at=now()WHERE id=$1`,[guardRun.id]);
      const lateInsert=lateWriter.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)
        VALUES($1,$2,'identity_positioning',9,'insufficient',NULL,0,0,NULL,'{}','late','insufficient','account-quality/1.0')`,[guardRun.id,account.id]).then(()=>({ok:true}),error=>({ok:false,error}));
      await completer.query('COMMIT');const lateResult=await lateInsert;assert.equal(lateResult.ok,false);assert.match(String(lateResult.error?.message),/append-only/i);
    }finally{await completer.query('ROLLBACK').catch(()=>{});completer.release();lateWriter.release();}
    check('two-connection completion serializes with child insertion and rejects the late writer');
    const sparseRevision=Number((await apiPool.query('SELECT max(revision)+1 value FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].value);
    const sparseRun=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',10,2,2,'{}','[]','{}',$3,'account-research/1.1','account-research-dto/1.1','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,sparseRevision,sha('sparse-run'),admin.id])).rows[0];
    for(const [ordinal,sampleId]of [[1,sample.id],[3,laterSample.id]])await apiPool.query(`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,title,published_at,content_type,inclusion_reasons,time_bucket,performance_band,performance_basis)VALUES($1,$2,$3,$4,'sparse','2026-01-10','text',ARRAY['census'],'2026-01','top','proxy')`,[sparseRun.id,account.id,sampleId,ordinal]);
    for(const [index,keyName]of dimensions.entries())await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)VALUES($1,$2,$3,$4,$5,'insufficient',NULL,0,0,NULL,'{}','fixture','insufficient','account-quality/1.0')`,[sparseRun.id,account.id,keyName,`insufficient_${keyName}`,index+1]);
    const sparseClient=await apiPool.connect();try{await sparseClient.query('BEGIN');await rejectSql(sparseClient,`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[sparseRun.id,JSON.stringify({status:'insufficient',periods:['early','middle','recent','unknown'],rows:[],membershipTotal:0,uniqueSampleCount:0,limitations:['fixture']}),JSON.stringify({ruleVersion:'saturation/1.0',status:'insufficient',reached:false,threshold:.05,batchSize:5,totalCodes:0,batches:[{batch:1,codes:[],codeCount:0,newCodeCount:0,cumulativeCodeCount:0,newCodeRatio:0,newCodes:[]}],observations:[{batch:1,codes:[],codeCount:0,newCodeCount:0,cumulativeCodeCount:0,newCodeRatio:0,newCodes:[]}],limitations:['fixture']})],/contiguous frozen sample ordinals/i);await sparseClient.query('ROLLBACK');}finally{sparseClient.release();}
    check('1.1 completion rejects sparse frozen sample ordinals');
    const outsideRevision=Number((await apiPool.query('SELECT max(revision)+1 value FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].value),outsideRun=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',10,1,1,'{}','[]','{}',$3,'account-research/1.1','account-research-dto/1.1','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,outsideRevision,sha('outside-run'),admin.id])).rows[0];
    await apiPool.query(`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,title,published_at,content_type,inclusion_reasons,time_bucket,performance_band,performance_basis)VALUES($1,$2,$3,1,'outside','2026-03-20','text',ARRAY['census'],'2026-03','top','proxy')`,[outsideRun.id,account.id,excludedSample.id]);for(const [index,keyName]of dimensions.entries())await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)VALUES($1,$2,$3,$4,$5,'insufficient',NULL,0,0,NULL,'{}','fixture','insufficient','account-quality/1.0')`,[outsideRun.id,account.id,keyName,`insufficient_${keyName}`,index+1]);
    await assert.rejects(apiPool.query(`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[outsideRun.id,JSON.stringify({status:'insufficient',periods:['early','middle','recent','unknown'],rows:[],membershipTotal:0,uniqueSampleCount:0,limitations:['fixture']}),JSON.stringify({ruleVersion:'saturation/1.0',status:'insufficient',reached:false,threshold:.05,batchSize:5,totalCodes:0,batches:[{batch:1,codes:[],codeCount:0,newCodeCount:0,cumulativeCodeCount:0,newCodeRatio:0,newCodes:[]}],observations:[{batch:1,codes:[],codeCount:0,newCodeCount:0,cumulativeCodeCount:0,newCodeRatio:0,newCodes:[]}],limitations:['fixture']})]),/outside observation window/i);check('1.1 completion rejects dated samples outside the observation window');
    const emptyMatrix={status:'insufficient',periods:['early','middle','recent','unknown'],rows:[],membershipTotal:0,uniqueSampleCount:0,limitations:['fixture']};
    const emptySaturation={ruleVersion:'saturation/1.0',status:'insufficient',reached:false,threshold:.05,batchSize:5,totalCodes:0,batches:[],observations:[],limitations:['fixture']};
    const cardinalityRun=async(name,counts)=>{const revision=Number((await apiPool.query('SELECT max(revision)+1 value FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].value),row=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',10,0,0,'{}','[]','{}',$3,'account-research/1.1','account-research-dto/1.1','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,revision,sha(name),admin.id])).rows[0];let ordinal=0;for(const [dimensionIndex,count]of counts.entries())for(let item=0;item<count;item++){ordinal++;await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)VALUES($1,$2,$3,$4,$5,'insufficient',NULL,0,0,NULL,'{}','fixture','insufficient','account-quality/1.0')`,[row.id,account.id,dimensions[dimensionIndex],`pattern_${dimensionIndex}_${item}`,ordinal]);}return row;};
    const completeCardinality=runId=>apiPool.query(`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[runId,JSON.stringify(emptyMatrix),JSON.stringify(emptySaturation)]);
    const maxRun=await cardinalityRun('forty-claims',Array(8).fill(5));await completeCardinality(maxRun.id);const zeroBatch=(await apiPool.query('SELECT saturation_json FROM account_research_runs WHERE id=$1',[maxRun.id])).rows[0].saturation_json;assert.equal(zeroBatch.status,'insufficient');assert.equal(zeroBatch.totalCodes,0);assert.equal(zeroBatch.batches.length,0);assert.equal(zeroBatch.reached,false);
    const missingRun=await cardinalityRun('missing-dimension',[1,1,1,1,1,1,1,0]);await assert.rejects(completeCardinality(missingRun.id),/1-5 claims in all eight dimensions/i);
    const sixRun=await cardinalityRun('six-one-dimension',[6,1,1,1,1,1,1,1]);await assert.rejects(completeCardinality(sixRun.id),/1-5 claims in all eight dimensions/i);
    const fortyOneRun=await cardinalityRun('forty-one-claims',[6,5,5,5,5,5,5,5]);await assert.rejects(completeCardinality(fortyOneRun.id),/1-5 claims in all eight dimensions/i);
    check('PG16 accepts 8/40 claim runs and rejects missing dimensions, six-per-dimension and 41 total');
    const depthRevision=Number((await apiPool.query('SELECT max(revision)+1 value FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].value);
    const depthRun=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)
      VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',10,1,1,'{}','[]','{}',$3,'account-research/1.1','account-research-dto/1.1','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,depthRevision,sha('depth-run'),admin.id])).rows[0];
    await apiPool.query(`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,title,published_at,content_type,inclusion_reasons,time_bucket,performance_band,performance_basis)VALUES($1,$2,$3,1,'fixture title','2026-01-10','image_post',ARRAY['census'],'2026-01','top','proxy')`,[depthRun.id,account.id,sample.id]);
    let depthClaim;
    for(const [index,keyName]of dimensions.entries()){const substantive=keyName==='content_supply';const saved=(await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,content_goal,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,'{}','fixture','insufficient','account-quality/1.0')RETURNING id`,[depthRun.id,account.id,keyName,substantive?'pillar_one':`insufficient_${keyName}`,substantive?'traffic':null,index+1,substantive?'observation':'insufficient',substantive?'内容支柱':null,substantive?1:0,substantive?1:null])).rows[0];if(substantive)depthClaim=saved;}
    for(const role of ['eligible','present','representative'])await apiPool.query(`INSERT INTO account_research_claim_samples(run_id,claim_id,account_id,sample_id,role)VALUES($1,$2,$3,$4,$5)`,[depthRun.id,depthClaim.id,account.id,sample.id,role]);
    const validMatrix={status:'measured',periods:['early','middle','recent','unknown'],rows:[{patternCode:'pillar_one',contentGoal:'traffic',sampleIds:[Number(sample.id)],count:1,cells:[{format:'image_post',period:'early',sampleIds:[Number(sample.id)],count:1}]}],membershipTotal:1,uniqueSampleCount:1,limitations:['fixture']};
    const code='content_supply/pillar_one',batch={batch:1,codes:[code],codeCount:1,newCodeCount:1,cumulativeCodeCount:1,newCodeRatio:1,newCodes:[code]};
    const validSaturation={ruleVersion:'saturation/1.0',status:'insufficient',reached:false,threshold:.05,batchSize:5,totalCodes:1,batches:[batch],observations:[batch],limitations:['fixture']};
    const depthTester=await apiPool.connect();try{await depthTester.query('BEGIN');
    await rejectSql(depthTester,`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[depthRun.id,JSON.stringify({...validMatrix,membershipTotal:2}),JSON.stringify(validSaturation)],/persisted matrix|frozen research/i);
    await rejectSql(depthTester,`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[depthRun.id,JSON.stringify({...validMatrix,rows:[{...validMatrix.rows[0],cells:[{...validMatrix.rows[0].cells[0],period:'recent'}]}]}),JSON.stringify(validSaturation)],/persisted matrix|frozen research/i);
    await rejectSql(depthTester,`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[depthRun.id,JSON.stringify(validMatrix),JSON.stringify({...validSaturation,batches:[{...batch,newCodeRatio:0}],observations:[{...batch,newCodeRatio:0}]})],/persisted matrix|frozen research/i);
    await rejectSql(depthTester,`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[depthRun.id,JSON.stringify(validMatrix),JSON.stringify({...validSaturation,totalCodes:2})],/persisted matrix|frozen research/i);
    await depthTester.query(`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[depthRun.id,JSON.stringify(validMatrix),JSON.stringify(validSaturation)]);await depthTester.query('COMMIT');}finally{await depthTester.query('ROLLBACK').catch(()=>{});depthTester.release();}
    assert.equal(validSaturation.status,'insufficient');assert.equal(validSaturation.totalCodes,1);assert.equal(validSaturation.batches.length,1);assert.equal(validSaturation.reached,false);
    check('PG16 recomputes matrix cells/totals and saturation codes/ratios before accepting a valid 1.1 run');
    const batchSamples=[];for(let i=1;i<=15;i++){const phase=i%4,publishedAt=phase===0?null:phase===1?'2026-01-03':phase===2?'2026-01-16':'2026-01-27',contentType=i===15?null:['image_post','video','article'][(i-1)%3],s=(await apiPool.query(`INSERT INTO samples(canonical_key,platform,title,body_text,content_type,published_at,archive_status)VALUES($1,'manual',$2,'body',$3,$4,'usable')RETURNING id`,[`arv3-batch-${suffix}-${i}`,`batch ${i}`,contentType,publishedAt])).rows[0];await apiPool.query(`INSERT INTO research_account_sample_links(account_id,sample_id,identity_quality,identity_source,linked_by)VALUES($1,$2,'platform_id','platform_account_id',$3)`,[account.id,s.id,admin.id]);batchSamples.push({sampleId:Number(s.id),ordinal:i,publishedAt,contentType,title:`batch ${i}`});}
    const matrixBatchRun=async(late=false)=>{const rev=Number((await apiPool.query('SELECT max(revision)+1 v FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].v),r=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',20,15,15,'{}','[]','{}',$3,'account-research/1.1','account-research-dto/1.1','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,rev,sha(`batch-${late}`),admin.id])).rows[0];for(const s of batchSamples)await apiPool.query(`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,title,published_at,content_type,inclusion_reasons,time_bucket,performance_band,performance_basis)VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY['census'],'fixture','top','proxy')`,[r.id,account.id,s.sampleId,s.ordinal,s.title,s.publishedAt,s.contentType]);const specs=[['pillar_alpha','traffic',[1,6,11,15]],['pillar_beta','persona',[1,2,7,12]],['pillar_gamma','expertise',late?[11,13,15]:[3,8,13,15]]],claims=[];let ordinal=0;for(const keyName of dimensions){for(const spec of keyName==='content_supply'?specs:[[ `insufficient_${keyName}`,null,[] ]]){ordinal++;const [patternCode,contentGoal,positions]=spec,ids=positions.map(pos=>batchSamples[pos-1].sampleId),substantive=keyName==='content_supply',claim=(await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,content_goal,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,'{}','fixture','insufficient','account-quality/1.0')RETURNING id`,[r.id,account.id,keyName,patternCode,contentGoal,ordinal,substantive?'observation':'insufficient',substantive?'pillar':null,ids.length,ids.length?1:null])).rows[0];for(const id of ids)for(const role of ['eligible','present'])await apiPool.query(`INSERT INTO account_research_claim_samples(run_id,claim_id,account_id,sample_id,role)VALUES($1,$2,$3,$4,$5)`,[r.id,claim.id,account.id,id,role]);claims.push({dimensionKey:keyName,patternCode,contentGoal,claimType:substantive?'observation':'insufficient',presentSampleIds:ids});}}const matrix=buildAccountContentMatrix(claims,batchSamples,{start:'2026-01-01',end:'2026-02-01'}),saturation=buildAccountSaturation(claims,batchSamples);await apiPool.query(`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[r.id,JSON.stringify(matrix),JSON.stringify(saturation)]);return{matrix,saturation};};
    const invalidMembershipRun=async(name,{eligibleCount,presentCount,roles})=>{const rev=Number((await apiPool.query('SELECT max(revision)+1 v FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].v),r=(await apiPool.query(`INSERT INTO account_research_runs(account_id,revision,status,source,observation_start,observation_end,max_samples,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,schema_version,dto_version,sampling_rule_version,quality_formula_version,requested_by)VALUES($1,$2,'building','manual','2026-01-01','2026-02-01',10,2,2,'{}','[]','{}',$3,'account-research/1.1','account-research-dto/1.1','account-sampling/1.0','account-quality/1.0',$4)RETURNING id`,[account.id,rev,sha(name),admin.id])).rows[0];for(const [idx,s]of batchSamples.slice(0,2).entries())await apiPool.query(`INSERT INTO account_research_run_samples(run_id,account_id,sample_id,ordinal,title,published_at,content_type,inclusion_reasons,time_bucket,performance_band,performance_basis)VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY['census'],'fixture','top','proxy')`,[r.id,account.id,s.sampleId,idx+1,s.title,s.publishedAt,s.contentType]);let target;for(const [index,keyName]of dimensions.entries()){const substantive=keyName==='content_supply',claim=(await apiPool.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,content_goal,ordinal,claim_type,claim_text,eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}','fixture','insufficient','account-quality/1.0')RETURNING id`,[r.id,account.id,keyName,substantive?'membership_pillar':`insufficient_${keyName}`,substantive?'traffic':null,index+1,substantive?'observation':'insufficient',substantive?'pillar':null,substantive?eligibleCount:0,substantive?presentCount:0,substantive?presentCount/eligibleCount:null])).rows[0];if(substantive)target=claim;}for(const [role,position]of roles)await apiPool.query(`INSERT INTO account_research_claim_samples(run_id,claim_id,account_id,sample_id,role)VALUES($1,$2,$3,$4,$5)`,[r.id,target.id,account.id,batchSamples[position-1].sampleId,role]);await assert.rejects(apiPool.query(`UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1`,[r.id,JSON.stringify(emptyMatrix),JSON.stringify(emptySaturation)]),/counts or subset memberships/i);};
    await invalidMembershipRun('eligible-count-mismatch',{eligibleCount:2,presentCount:1,roles:[['eligible',1],['present',1]]});await invalidMembershipRun('present-not-eligible',{eligibleCount:1,presentCount:1,roles:[['eligible',1],['present',2]]});await invalidMembershipRun('representative-not-present',{eligibleCount:2,presentCount:1,roles:[['eligible',1],['eligible',2],['present',2],['representative',1]]});await invalidMembershipRun('counterexample-present',{eligibleCount:2,presentCount:1,roles:[['eligible',1],['eligible',2],['present',1],['counterexample',1]]});check('PG16 rejects count mismatch and all invalid membership subsets');
    const reachedDepth=await matrixBatchRun(false);assert.equal(reachedDepth.matrix.rows.length,3);assert.equal(new Set(reachedDepth.matrix.rows.map(row=>row.contentGoal)).size,3);assert.ok(new Set(reachedDepth.matrix.rows.flatMap(row=>row.cells).map(cell=>cell.format)).size>=3);assert.deepEqual(new Set(reachedDepth.matrix.rows.flatMap(row=>row.cells).map(cell=>cell.period)),new Set(['early','middle','recent','unknown']));assert.ok(reachedDepth.matrix.membershipTotal>reachedDepth.matrix.uniqueSampleCount);assert.equal(reachedDepth.saturation.reached,true);
    const unreachedDepth=await matrixBatchRun(true);assert.equal(unreachedDepth.saturation.status,'measured');assert.equal(unreachedDepth.saturation.reached,false);check('PG16 validates three pillars/goals/formats/all periods and reached/not-reached three-batch saturation');
    check('real route DTOs, login/RBAC, idempotent 201/200/409, strict key limit and decision mutation pass against PostgreSQL');
    await apiPool.end();
  }finally{await f.end();await u.end();}
  console.log(`\nAccount research PostgreSQL 16 checks: ${passed} passed`);
}finally{
  await root.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`).catch(()=>{});await root.query(`DROP SCHEMA IF EXISTS "${upgrade}" CASCADE`).catch(()=>{});await root.query(`DROP SCHEMA IF EXISTS "${failure}" CASCADE`).catch(()=>{});await root.end().catch(()=>{});
}
