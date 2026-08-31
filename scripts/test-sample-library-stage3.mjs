import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ASSESSMENT_TARGETS,DIMENSION_KEYS,STAGE3_LIMITS,buildAssessmentProviderBody,comparisonListDto,
  comparisonPolicy,normalizeAssessmentInput,normalizeComponentRevisionInput,normalizeRelationInput,
  normalizeScopeInput,parsePagination,rejectServerDerived,requestAiComparisonAssessment,reusableComponentDto,
  safeAssessmentError,sha256,stableJson,
} from '../server/src/lib/sample-comparison.mjs';

let passed=0;
function test(name,fn){
  try{awaitMaybe(fn);console.log(`ok ${++passed} - ${name}`);}catch(error){console.error(`not ok - ${name}`);throw error;}
}
function awaitMaybe(fn){const value=fn();if(value?.then)throw new Error('Use the async test loop for promises');return value;}
async function testAsync(name,fn){try{await fn();console.log(`ok ${++passed} - ${name}`);}catch(error){console.error(`not ok - ${name}`);throw error;}}
function mustThrow(fn,pattern){assert.throws(fn,error=>pattern.test(error.message));}
const assessmentBody=(overrides={})=>({target:'traffic',commonPoints:[],keyDifferences:[],strengths:[],limitations:[],
  worthLearning:[],doNotCopy:[],hypotheses:[],openQuestions:[],methodLimitations:[],findings:[],...overrides});
const finding=(overrides={})=>({kind:'observation',claimText:'观察到结构差异',limitations:null,
  evidenceState:'insufficient',memberSampleId:null,evidenceTokens:[],...overrides});

test('fixed Stage3 targets, 15 dimensions and numeric limits',()=>{
  assert.deepEqual(ASSESSMENT_TARGETS,['traffic','persona','expertise','conversion']);
  assert.equal(DIMENSION_KEYS.length,15);assert.equal(new Set(DIMENSION_KEYS).size,15);
  assert.deepEqual({min:STAGE3_LIMITS.comparisonMembersMin,max:STAGE3_LIMITS.comparisonMembersMax},{min:2,max:6});
  assert.equal(STAGE3_LIMITS.providerRequestBytesMax,524288);
  assert.equal(STAGE3_LIMITS.providerResponseBytesMax,262144);
});

test('canonical hashing is deterministic',()=>{
  assert.equal(stableJson({b:2,a:[1,{z:true}]}),stableJson({a:[1,{z:true}],b:2}));
  assert.equal(sha256({b:2,a:1}),sha256({a:1,b:2}));
});

test('scope input requires 2-6 unique members and bounded topic',()=>{
  assert.deepEqual(normalizeScopeInput({memberIds:[2,1],topic:'主题'}).memberIds,[2,1]);
  mustThrow(()=>normalizeScopeInput({memberIds:[1],topic:'主题'}),/至少 2/);
  mustThrow(()=>normalizeScopeInput({memberIds:[1,1],topic:'主题'}),/不能重复/);
  mustThrow(()=>normalizeScopeInput({memberIds:[1,2,3,4,5,6,7],topic:'主题'}),/最多 6/);
});

test('variant endpoints are canonical while directed relations preserve direction',()=>{
  const variant=normalizeRelationInput({type:'variant',subjectSampleId:9,subjectAnalysisVersionId:90,
    objectSampleId:2,objectAnalysisVersionId:20});
  assert.deepEqual([variant.subjectSampleId,variant.subjectAnalysisVersionId,variant.objectSampleId,variant.objectAnalysisVersionId],[2,20,9,90]);
  const citation=normalizeRelationInput({type:'citation',subjectSampleId:9,subjectAnalysisVersionId:90,
    objectSampleId:2,objectAnalysisVersionId:20});
  assert.deepEqual([citation.subjectSampleId,citation.objectSampleId],[9,2]);
  mustThrow(()=>normalizeRelationInput({type:'imitation',subjectSampleId:2,subjectAnalysisVersionId:20,
    objectSampleId:2,objectAnalysisVersionId:21}),/自身/);
});

test('claim normalization enforces evidence and non-causal AI language',()=>{
  mustThrow(()=>normalizeAssessmentInput(assessmentBody({findings:[{...finding({kind:'hypothesis'}),limitations:undefined}]}),{source:'manual'}),/limitations/);
  for(const claimText of ['这个结构导致转化提升','这个结构造成增长','这是最佳方案','总分98分','评分很高',
    '位列第一','当前排名靠前','这个结构促成转化','这个方法能够增加销量']){
    mustThrow(()=>normalizeAssessmentInput(assessmentBody({findings:[finding({claimText})]}),{source:'ai'}),/非因果、非排名/);
  }
  mustThrow(()=>normalizeAssessmentInput(assessmentBody({findings:[finding({evidenceState:'manual_unverified'})]}),{source:'ai'}),/不能支持 AI observation/);
  const valid=normalizeAssessmentInput(assessmentBody({target:'persona',findings:[finding({kind:'hypothesis',
    claimText:'可能与叙事身份有关',limitations:'只有两个样本'})]}),{source:'ai'});
  assert.equal(valid.findings[0].kind,'hypothesis');
});

test('assessment JSON validation rejects null, missing arrays, extra properties and bad nested shapes',()=>{
  mustThrow(()=>normalizeAssessmentInput(null),/JSON 对象/);
  mustThrow(()=>normalizeAssessmentInput({target:'traffic'}),/缺少必填字段/);
  mustThrow(()=>normalizeAssessmentInput({...assessmentBody(),winner:'A'}),/不允许的字段/);
  mustThrow(()=>normalizeAssessmentInput(assessmentBody({commonPoints:'bad'})),/必须是数组/);
  mustThrow(()=>normalizeAssessmentInput(assessmentBody({findings:[{...finding(),extra:true}]})),/不允许的字段/);
  mustThrow(()=>normalizeAssessmentInput(assessmentBody({commonPoints:Array(61).fill('x')})),/最多 60/);
});

test('component revision requires complete reusable fields and bounded sources/tags',()=>{
  const valid=normalizeComponentRevisionInput({dimensionKey:'opening_method',name:'问题开场',pattern:'先提具体问题',
    function:'建立注意',applicability:'问题明确时',limitations:'复杂议题可能过度简化',doNotCopy:'不要照搬措辞',
    extractionIds:[1],tagIds:[]});
  assert.equal(valid.dimensionKey,'opening_method');
  mustThrow(()=>normalizeComponentRevisionInput({...valid,doNotCopy:'',extractionIds:[1]}),/doNotCopy/);
});

test('provider payload is frozen whitelist only, store false and within byte cap',()=>{
  const scope={id:4,inputSha256:'a'.repeat(64),topicBasis:'开场比较',members:[1,2].map(sampleId=>({sampleId,
    title:`样本${sampleId}`,accountName:'账号',platform:'manual',publishedAt:null,metricObservedAt:null,
    observationWindowSeconds:null,metrics:{likes:null},elements:DIMENSION_KEYS.map((dimensionKey,index)=>({
      dimensionKey,state:index?'insufficient':'value',value:index?null:'问题',functionText:null,applicability:null,
      limitations:null,evidenceState:index?'insufficient':'verified',evidenceTokens:index?[]:[{token:`evidence:${sampleId}`,quote:'可核验引文'}],
    }))}))};
  const body=buildAssessmentProviderBody({target:'traffic',scope});
  const serialized=JSON.stringify(body);
  assert.equal(body.store,false);assert.ok(Buffer.byteLength(serialized)<=STAGE3_LIMITS.providerRequestBytesMax);
  for(const forbidden of ['raw_payload','Cookie','storage_state','apiKey','source_url','localPath'])assert.equal(serialized.includes(forbidden),false);
  assert.match(body.instructions,/不得输出总分/);assert.equal(body.text.format.type,'json_schema');
  scope.members[0].elements[0].evidenceTokens[0].quote='原文声称总分98分并位列第一';
  assert.equal(buildAssessmentProviderBody({target:'traffic',scope}).store,false);
});

await testAsync('provider response byte limit stops oversized bodies before JSON parsing',async()=>{
  const scope={id:1,inputSha256:'a'.repeat(64),topicBasis:'主题',members:[]};
  await assert.rejects(()=>requestAiComparisonAssessment({target:'traffic',scope,
    provider:{apiKey:'test-key',baseUrl:'https://example.invalid/v1',model:'test',source:'test'},
    fetchImpl:async()=>new Response(new Uint8Array(STAGE3_LIMITS.providerResponseBytesMax+1),{status:200})}),
  error=>error.code==='AI_RESPONSE_TOO_LARGE');
});

await testAsync('provider 401/429/5xx stay typed and parsed output cannot bypass exact validation',async()=>{
  const scope={id:1,inputSha256:'a'.repeat(64),topicBasis:'主题',members:[]};
  const provider={apiKey:'test-key',baseUrl:'https://example.invalid/v1',model:'test',source:'test'};
  for(const status of [401,429,500]){
    let caught;try{await requestAiComparisonAssessment({target:'traffic',scope,provider,
      fetchImpl:async()=>new Response('{}',{status})});}catch(error){caught=error;}
    assert.equal(caught.upstreamStatus,status);assert.equal(safeAssessmentError(caught).code,`AI_HTTP_${status}`);
  }
  const invalid={...assessmentBody(),extra:'forbidden'};
  await assert.rejects(()=>requestAiComparisonAssessment({target:'traffic',scope,provider,
    fetchImpl:async()=>new Response(JSON.stringify({output_text:JSON.stringify(invalid)}),{status:200,
      headers:{'content-type':'application/json'}})}),/不允许的字段/);
  for(const phrase of ['总分98分','评分为五星','位列第一','排名靠前','促成转化','能够增加销量']){
    const output=assessmentBody({commonPoints:[phrase]});
    await assert.rejects(()=>requestAiComparisonAssessment({target:'traffic',scope,provider,
      fetchImpl:async()=>new Response(JSON.stringify({output_text:JSON.stringify(output)}),{status:200,
        headers:{'content-type':'application/json'}})}),/非因果、非排名/);
  }
});

test('lightweight DTOs exclude snapshots, evidence, provider bodies and performance metrics',()=>{
  const row={id:1,title:'比较',purpose:null,created_at:'now',created_by:1,scope_id:2,scope_revision:1,
    topic_basis:'主题',member_count:2,scope_created_at:'now',current_assessments:{},assessment_counts:{},
    snapshots:['forbidden'],evidence:['forbidden'],provider_body:{secret:true}};
  assert.deepEqual(Object.keys(comparisonListDto(row)).sort(),
    ['assessmentCounts','createdAt','createdBy','currentAssessments','id','latestScope','purpose','title'].sort());
  const reusable=reusableComponentDto({id:1,component_name:'稳定身份',revision_name:'已批准版本名',revision_id:2,revision:1,dimension_key:'topic',
    pattern_text:'p',function_text:'f',applicability:'a',limitations:'l',do_not_copy:'d',tags:[],likes:999,views:999,evidence:'heavy'});
  assert.equal(reusable.name,'已批准版本名');
  assert.equal('likes'in reusable,false);assert.equal('views'in reusable,false);assert.equal('evidence'in reusable,false);
});

test('comparison policy is descriptive and preserves null metric coverage',()=>{
  const policy=comparisonPolicy([{platform:'x',metrics:{likes:1,views:null}},{platform:'y',metrics:{likes:null,views:2}}]);
  assert.equal(policy.causalClaimsAllowed,false);assert.equal(policy.mixedPlatforms,true);
  assert.deepEqual(policy.metricCoverage.likes,{available:1,total:2});
  assert.equal(policy.rankingPolicy,'mixed_platforms_not_directly_rankable');
});

test('pagination rejects invalid bounds',()=>{
  assert.deepEqual(parsePagination(new URL('http://local/?page=2&pageSize=100')),{page:2,pageSize:100,offset:100});
  mustThrow(()=>parsePagination(new URL('http://local/?page=0')),/page/);
  mustThrow(()=>parsePagination(new URL('http://local/?pageSize=101')),/pageSize/);
});

test('safe AI errors never expose upstream bodies',()=>{
  assert.deepEqual(safeAssessmentError({upstreamStatus:401}),{code:'AI_HTTP_401',message:'AI 密钥未通过验证'});
  assert.equal(safeAssessmentError({message:'Bearer super-secret'}).message.includes('super-secret'),false);
});

test('browser cannot submit server-derived actor, origin, role, provider, model or current state',()=>{
  for(const field of ['actorId','origin','role','provider','modelName','currentState','source']){
    mustThrow(()=>rejectServerDerived({[field]:'forged'}),/服务端决定/);
  }
});

const migration=await readFile(new URL('./migrations/20260829-sample-library-stage3.sql',import.meta.url),'utf8');
const lifecycleMigration=await readFile(new URL('./migrations/20260831-sample-comparison-lifecycle.sql',import.meta.url),'utf8');
const schema=await readFile(new URL('../server/src/schema.sql',import.meta.url),'utf8');
const routes=await readFile(new URL('../server/src/routes/sample-comparison.mjs',import.meta.url),'utf8');
const helper=await readFile(new URL('../server/src/lib/sample-comparison.mjs',import.meta.url),'utf8');
const index=await readFile(new URL('../server/src/index.mjs',import.meta.url),'utf8');

test('schema.sql embeds the exact Stage3 migration block',()=>{
  const start=schema.lastIndexOf('-- IdeaHub sample library, stage 3.');
  assert.ok(start>0);assert.equal(schema.slice(start,start+migration.length),migration);
});

test('migration is additive, idempotent DDL and contains the required ownership guards',()=>{
  for(const table of ['sample_comparisons','sample_comparison_scopes','sample_comparison_snapshots',
    'sample_comparison_assessments','sample_comparison_assessment_jobs','sample_relations','sample_relation_evidence',
    'sample_element_extractions','content_components','content_component_revisions','content_component_selections']){
    assert.match(migration,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for(const token of ['REPEATABLE READ','pg_advisory_xact_lock','exactly 15 dimensions','verified endpoint evidence',
    'component selection requires its approving decision','snapshot_owner_fk','scope_row_identity_uk'])
    assert.match(`${routes}\n${migration}`,new RegExp(token,'i'));
  assert.doesNotMatch(migration,/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test('comparison lifecycle migration adds a reversible access-state without deleting source data',()=>{
  for(const token of ['deleted_at','deleted_by','sample_comparisons_active_created_idx'])assert.match(lifecycleMigration,new RegExp(token));
  assert.doesNotMatch(lifecycleMigration,/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.match(schema,/deleted_at\s+TIMESTAMPTZ/);
});

test('every contracted route is mounted and the server installs it',()=>{
  for(const route of [
    '/api/sample-comparisons','/api/sample-comparisons/:id','/api/sample-comparisons/:id/refresh','/api/sample-comparisons/:id/scopes',
    '/api/sample-comparisons/:id/scopes/:scopeId','/api/sample-comparisons/:id/scopes/:scopeId/assessments/manual',
    '/api/sample-comparisons/:id/scopes/:scopeId/assessment-jobs','/api/sample-comparisons/:id/assessment-jobs/:jobId',
    '/api/sample-comparisons/:id/assessments','/api/sample-comparisons/:id/assessments/:assessmentId',
    '/api/sample-comparisons/:id/assessments/:assessmentId/select','/api/sample-relations','/api/samples/:id/relations',
    '/api/sample-relations/:id/evidence','/api/sample-relations/:id/events',
    '/api/sample-comparisons/:id/scopes/:scopeId/extractions','/api/sample-element-extractions',
    '/api/content-components','/api/content-components/:id','/api/content-components/:id/revisions',
    '/api/content-components/:id/revisions/:revisionId/submit','/api/content-components/:id/revisions/:revisionId/review',
    '/api/content-components/:id/lifecycle','/api/reusable-components',
  ])assert.ok(routes.includes(`'${route}'`),route);
  assert.match(index,/sampleComparison\.mount\(router\)/);
});

test('relation list batches compact evidence and events without heavy quotes or raw payloads',()=>{
  const start=routes.indexOf("router.get('/api/samples/:id/relations'");
  const end=routes.indexOf("router.post('/api/sample-relations/:id/evidence'",start);
  const block=routes.slice(start,end);
  assert.match(block,/sample_relation_evidence/);assert.match(block,/sample_relation_events/);
  assert.match(routes,/evidenceCount:evidence\.length/);assert.match(block,/endpointAnalysisVersionId/);
  assert.match(routes,/permissions:\{canAddEvidence:/);assert.match(routes,/canWithdraw:/);
  assert.doesNotMatch(block,/quote_text|raw_payload|normalized_payload|provider/i);
});

test('mutating handlers require idempotency and role gates are explicit',()=>{
  const postCount=(routes.match(/router\.post\(/g)||[]).length;
  const deleteCount=(routes.match(/router\.del\(/g)||[]).length;
  const keyCount=(routes.match(/requireIdempotency\(req\)/g)||[]).length;
  assert.equal(keyCount,postCount+deleteCount);
  assert.match(routes,/assertCanReview\(me\)/);assert.match(routes,/assertStage3Admin\(me\)/);
  assert.match(routes,/scheduleAssessmentRecovery\(await nextRecoveryDelay/);
  assert.match(helper,/actor.*origin.*provider.*model/s);
});

console.log(`1..${passed}`);
