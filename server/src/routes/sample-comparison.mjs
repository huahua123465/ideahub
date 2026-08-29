import { randomUUID } from 'node:crypto';

import { query, tx } from '../db/index.mjs';
import { currentUser } from '../lib/auth.mjs';
import { activeProvider } from '../lib/ai-provider.mjs';
import { readJson, sendJson as baseSendJson, badRequest, notFound, conflict, forbidden, HttpError } from '../lib/http.mjs';
import {
  ASSESSMENT_TARGETS,DIMENSION_KEYS,STAGE3_LIMITS,STAGE3_SCHEMA_VERSION,STAGE3_PROMPT_VERSION,
  assertCanReview,assertDimension,assertExactFields,assertStage3Admin,assertTarget,assessmentJobDto,assessmentListDto,
  cleanText,comparisonListDto,comparisonPolicy,componentListDto,extractionListDto,frozenElementValue,
  normalizeAssessmentInput,normalizeComparisonInput,normalizeComponentRevisionInput,normalizeExtractionInput,
  normalizeRelationInput,normalizeScopeInput,parsePagination,requestAiComparisonAssessment,requireIdempotency,
  rejectServerDerived,reusableComponentDto,safeAssessmentError,sha256,stableJson,strictId,withIdempotency,
} from '../lib/sample-comparison.mjs';

function dbError(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === '23505') return conflict('记录与当前状态冲突，请刷新后重试');
  if (error?.code === '23503' || error?.code === '23514' || error?.code === '22P02') return badRequest('请求引用的数据不匹配或状态不合法');
  if (error?.code === '42501') return forbidden('当前角色没有执行此操作的权限');
  if (error?.code === '55000') return conflict('冻结或已审核的数据不能修改');
  return error;
}

function sendJson(res,status,data){
  if(Buffer.byteLength(JSON.stringify(data))>STAGE3_LIMITS.detailResponseBytesMax){
    throw new HttpError(413,'响应超过安全上限，请缩小查询范围',{code:'DETAIL_RESPONSE_TOO_LARGE'});
  }
  return baseSendJson(res,status,data);
}

async function guarded(operation) {
  try { return await operation(); } catch (error) { throw dbError(error); }
}

function compactMetrics(row) {
  if (!row) return { likes:null,saves:null,comments:null,shares:null,views:null };
  return { likes:row.likes,saves:row.saves,comments:row.comments,shares:row.shares,views:row.views };
}

function normalizeTimestamp(value) { return value == null ? null : new Date(value).toISOString(); }

async function ensureComparison(client, comparisonId, { lock = false } = {}) {
  const { rows } = await client.query(`SELECT * FROM sample_comparisons WHERE id=$1${lock?' FOR UPDATE':''}`,[comparisonId]);
  if (!rows[0]) throw notFound('比较项目不存在');
  return rows[0];
}

async function prepareScopeSnapshotTransaction(client,memberIds){
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  // Utility locks happen before the first MVCC snapshot. A writer already in flight must commit first,
  // so the following sample row locks and all frozen reads observe one post-lock snapshot.
  await client.query('LOCK TABLE sample_element_decisions IN SHARE MODE');
  await client.query('LOCK TABLE sample_metric_snapshots IN SHARE MODE');
  const {rows}=await client.query(`SELECT id FROM samples WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE`,[memberIds]);
  if(rows.length!==memberIds.length)throw badRequest('比较成员包含不存在的样本');
}

export async function createScopeInTransaction(client,{ comparisonId,scopeInput,actorId }) {
  const normalized=normalizeScopeInput(scopeInput);
  await ensureComparison(client,comparisonId,{lock:true});
  // These locks make the repeatable-read snapshot atomic against Stage 2 append/update paths.
  await client.query('LOCK TABLE sample_element_decisions IN SHARE MODE');
  await client.query('LOCK TABLE sample_metric_snapshots IN SHARE MODE');
  const { rows:revisionRows }=await client.query(
    'SELECT COALESCE(MAX(revision),0)+1 revision FROM sample_comparison_scopes WHERE comparison_id=$1',[comparisonId]);
  const revision=Number(revisionRows[0].revision);
  const inputSha256=sha256(normalized);
  const { rows:scopeRows }=await client.query(`INSERT INTO sample_comparison_scopes(
    comparison_id,revision,status,topic_basis,purpose,input_sha256,created_by
  ) VALUES($1,$2,'building',$3,$4,$5,$6) RETURNING *`,
  [comparisonId,revision,normalized.topicBasis,normalized.purpose,inputSha256,actorId]);
  const scope=scopeRows[0];
  let totalEvidenceChars=0,totalTokens=0;
  for(let ordinal=1;ordinal<=normalized.memberIds.length;ordinal++){
    const sampleId=normalized.memberIds[ordinal-1];
    const { rows:samples }=await client.query(`SELECT * FROM samples
      WHERE id=$1 AND deleted_at IS NULL FOR SHARE`,[sampleId]);
    const sample=samples[0];
    if(!sample)throw badRequest(`样本 ${sampleId} 不存在`);
    if(!sample.current_analysis_version_id)throw badRequest(`样本 ${sampleId} 还没有 current 完整分析`);
    const versionId=Number(sample.current_analysis_version_id);
    const { rows:versions }=await client.query(`SELECT * FROM sample_analysis_versions
      WHERE id=$1 AND sample_id=$2 AND status='complete' FOR SHARE`,[versionId,sampleId]);
    if(!versions[0])throw badRequest(`样本 ${sampleId} 的 current 分析不是完整版本`);
    const { rows:metrics }=await client.query(`SELECT * FROM sample_metric_snapshots
      WHERE sample_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1`,[sampleId]);
    const metric=metrics[0]||null;
    const observed=metric?.observed_at?new Date(metric.observed_at):null;
    const published=sample.published_at?new Date(sample.published_at):null;
    const observationWindowSeconds=observed&&published&&observed>=published
      ?Math.floor((observed-published)/1000):null;
    const frozenMetrics=compactMetrics(metric);
    await client.query(`INSERT INTO sample_comparison_scope_members(
      comparison_id,scope_id,sample_id,analysis_version_id,ordinal,frozen_title,frozen_account_name,
      frozen_account_handle,frozen_platform,frozen_published_at,metric_snapshot_id,
      frozen_metric_observed_at,observation_window_seconds,frozen_metrics
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,[
      comparisonId,scope.id,sampleId,versionId,ordinal,sample.title||`样本 ${sampleId}`,
      sample.account_name,sample.account_handle,sample.platform,sample.published_at,metric?.id||null,
      metric?.observed_at||null,observationWindowSeconds,JSON.stringify(frozenMetrics),
    ]);
    const { rows:elements }=await client.query(`SELECT e.*,
      d.id latest_decision_id,d.decision,d.value_json decision_value_json,d.function_text decision_function_text,
      d.applicability decision_applicability,d.limitations decision_limitations,
      COALESCE(ev.tokens,'[]'::jsonb) verified_tokens
      FROM sample_analysis_elements e
      LEFT JOIN LATERAL(SELECT * FROM sample_element_decisions sd WHERE sd.element_id=e.id ORDER BY sd.id DESC LIMIT 1)d ON true
      LEFT JOIN LATERAL(
        SELECT jsonb_agg(jsonb_build_object('token','evidence:'||z.id::text,'quote',left(z.quote_text,2000)) ORDER BY z.id) tokens
        FROM(SELECT ee.id,ee.quote_text FROM sample_element_evidence ee
          WHERE ee.version_id=e.version_id AND ee.element_id=e.id AND ee.verification_status='verified'
          ORDER BY ee.id LIMIT 20)z
      )ev ON true
      WHERE e.version_id=$1 ORDER BY e.dimension_key FOR SHARE OF e`,[versionId]);
    if(elements.length!==15||new Set(elements.map(row=>row.dimension_key)).size!==15){
      throw badRequest(`样本 ${sampleId} 的完整分析没有恰好 15 个维度`);
    }
    for(const element of elements){
      const effective=frozenElementValue(element);
      let evidenceState='insufficient';
      let evidenceTokens=[];
      if(element.decision==='edited')evidenceState='manual_unverified';
      else if(effective.state==='value'&&element.verified_tokens.length)evidenceState='verified';
      if(evidenceState==='verified'){
        for(const token of element.verified_tokens){
          if(totalTokens>=STAGE3_LIMITS.evidenceTokensTotalMax)break;
          const remaining=STAGE3_LIMITS.totalEvidenceCharsMax-totalEvidenceChars;
          if(remaining<=0)break;
          const quote=String(token.quote||'').slice(0,Math.min(STAGE3_LIMITS.hydratedQuoteCharsMax,remaining));
          evidenceTokens.push({token:token.token,quote});totalTokens++;totalEvidenceChars+=quote.length;
        }
        if(!evidenceTokens.length)evidenceState='insufficient';
      }
      const hashPayload={ state:effective.state,value:effective.value,functionText:effective.functionText,
        applicability:effective.applicability,limitations:effective.limitations,latestDecisionId:element.latest_decision_id||null };
      await client.query(`INSERT INTO sample_comparison_snapshots(
        comparison_id,scope_id,sample_id,analysis_version_id,element_id,dimension_key,latest_decision_id,
        effective_state,effective_value,function_text,applicability,limitations,evidence_state,evidence_tokens,value_sha256
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15)`,[
        comparisonId,scope.id,sampleId,versionId,element.id,element.dimension_key,element.latest_decision_id,
        effective.state,effective.value==null?null:JSON.stringify(effective.value),effective.functionText,
        effective.applicability,effective.limitations,evidenceState,JSON.stringify(evidenceTokens),sha256(hashPayload),
      ]);
    }
  }
  const { rows:complete }=await client.query(`UPDATE sample_comparison_scopes SET status='complete',completed_at=now()
    WHERE id=$1 AND status='building' RETURNING *`,[scope.id]);
  return complete[0];
}

export async function loadScopeDetail(comparisonId,scopeId,db={query}) {
  const { rows:scopes }=await db.query(`SELECT * FROM sample_comparison_scopes
    WHERE id=$1 AND comparison_id=$2 AND status='complete'`,[scopeId,comparisonId]);
  const scope=scopes[0];if(!scope)throw notFound('比较范围不存在');
  const { rows:members }=await db.query(`SELECT m.*,s.title live_title,s.account_name live_account_name,
    s.account_handle live_account_handle,s.platform live_platform,s.published_at live_published_at,
    s.current_analysis_version_id,
    lm.id live_metric_id
    FROM sample_comparison_scope_members m JOIN samples s ON s.id=m.sample_id
    LEFT JOIN LATERAL(SELECT id FROM sample_metric_snapshots WHERE sample_id=m.sample_id
      ORDER BY observed_at DESC,id DESC LIMIT 1)lm ON true
    WHERE m.scope_id=$1 ORDER BY m.ordinal`,[scopeId]);
  const { rows:snapshots }=await db.query(`SELECT x.*,
    (SELECT id FROM sample_element_decisions d WHERE d.element_id=x.element_id ORDER BY d.id DESC LIMIT 1) live_decision_id
    FROM sample_comparison_snapshots x JOIN sample_analysis_dimensions dim ON dim.dimension_key=x.dimension_key
    WHERE x.scope_id=$1 ORDER BY dim.ordinal,x.sample_id`,[scopeId]);
  const bySample=new Map();
  for(const member of members){
    const reasons=[];
    if(Number(member.current_analysis_version_id)!==Number(member.analysis_version_id))reasons.push('analysis_changed');
    if((member.live_metric_id==null?null:Number(member.live_metric_id))!==(member.metric_snapshot_id==null?null:Number(member.metric_snapshot_id)))reasons.push('metric_changed');
    if(member.live_title!==member.frozen_title)reasons.push('title_changed');
    if(member.live_account_name!==member.frozen_account_name||member.live_account_handle!==member.frozen_account_handle)reasons.push('account_changed');
    if(member.live_platform!==member.frozen_platform)reasons.push('platform_changed');
    if(normalizeTimestamp(member.live_published_at)!==normalizeTimestamp(member.frozen_published_at))reasons.push('published_at_changed');
    bySample.set(Number(member.sample_id),{ sampleId:Number(member.sample_id),ordinal:Number(member.ordinal),
      analysisVersionId:Number(member.analysis_version_id),title:member.frozen_title,accountName:member.frozen_account_name,
      accountHandle:member.frozen_account_handle,platform:member.frozen_platform,publishedAt:member.frozen_published_at,
      metricSnapshotId:member.metric_snapshot_id==null?null:Number(member.metric_snapshot_id),
      metricObservedAt:member.frozen_metric_observed_at,observationWindowSeconds:member.observation_window_seconds==null?null:Number(member.observation_window_seconds),
      metrics:member.frozen_metrics,staleReasons:reasons,elements:[] });
  }
  for(const row of snapshots){
    const item=bySample.get(Number(row.sample_id));
    if((row.live_decision_id==null?null:Number(row.live_decision_id))!==(row.latest_decision_id==null?null:Number(row.latest_decision_id))
      && !item.staleReasons.includes('element_decision_changed'))item.staleReasons.push('element_decision_changed');
    item.elements.push({ id:Number(row.id),dimensionKey:row.dimension_key,state:row.effective_state,
      value:row.effective_value,functionText:row.function_text,applicability:row.applicability,
      limitations:row.limitations,evidenceState:row.evidence_state,evidenceTokens:row.evidence_tokens,
      valueSha256:row.value_sha256,latestDecisionId:row.latest_decision_id==null?null:Number(row.latest_decision_id) });
  }
  const memberDtos=[...bySample.values()].sort((a,b)=>a.ordinal-b.ordinal);
  return { id:Number(scope.id),comparisonId:Number(scope.comparison_id),revision:Number(scope.revision),
    topicBasis:scope.topic_basis,purpose:scope.purpose,inputSha256:scope.input_sha256,createdAt:scope.created_at,
    completedAt:scope.completed_at,members:memberDtos,...comparisonPolicy(memberDtos) };
}

async function persistAssessment(client,{ comparisonId,scopeId,input,source,actorId,jobId=null,provider=null,modelName=null,inputSha256=null }) {
  const normalized=normalizeAssessmentInput(input,{source});
  await ensureComparison(client,comparisonId,{lock:true});
  const { rows:scopeRows }=await client.query(`SELECT 1 FROM sample_comparison_scopes
    WHERE id=$1 AND comparison_id=$2 AND status='complete'`,[scopeId,comparisonId]);
  if(!scopeRows[0])throw notFound('完整比较范围不存在');
  const { rows:revisionRows }=await client.query(`SELECT COALESCE(MAX(revision),0)+1 revision
    FROM sample_comparison_assessments WHERE comparison_id=$1 AND target=$2`,[comparisonId,normalized.target]);
  const revision=Number(revisionRows[0].revision);
  const payloadHash=inputSha256||sha256({scopeId,normalized,source});
  const { rows }=await client.query(`INSERT INTO sample_comparison_assessments(
    comparison_id,scope_id,job_id,target,source,revision,common_points,key_differences,strengths,limitations,
    worth_learning,do_not_copy,hypotheses,open_questions,method_limitations,input_sha256,schema_version,
    prompt_version,model_provider,model_name,created_by
  )VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
    $13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21) RETURNING *`,[
    comparisonId,scopeId,jobId,normalized.target,source,revision,JSON.stringify(normalized.commonPoints),
    JSON.stringify(normalized.keyDifferences),JSON.stringify(normalized.strengths),JSON.stringify(normalized.limitations),
    JSON.stringify(normalized.worthLearning),JSON.stringify(normalized.doNotCopy),JSON.stringify(normalized.hypotheses),
    JSON.stringify(normalized.openQuestions),JSON.stringify(normalized.methodLimitations),payloadHash,STAGE3_SCHEMA_VERSION,
    source==='ai'?STAGE3_PROMPT_VERSION:null,source==='ai'?provider:null,source==='ai'?modelName:null,actorId,
  ]);
  const assessment=rows[0];
  for(let index=0;index<normalized.findings.length;index++){
    const finding=normalized.findings[index];
    let resolved=[];
    if(finding.evidenceTokens.length){
      if(finding.memberSampleId==null)throw badRequest(`findings[${index}] 引用证据时必须提供 memberSampleId`);
      const { rows:tokenRows }=await client.query(`SELECT id,sample_id,dimension_key,evidence_tokens
        FROM sample_comparison_snapshots WHERE scope_id=$1 AND sample_id=$2`,[scopeId,finding.memberSampleId]);
      const tokenMap=new Map();
      for(const snapshot of tokenRows)for(const token of snapshot.evidence_tokens||[])tokenMap.set(token.token,snapshot);
      resolved=finding.evidenceTokens.map(token=>({token,snapshot:tokenMap.get(token)}));
      if(resolved.some(item=>!item.snapshot))throw badRequest(`findings[${index}] 包含不属于冻结范围的证据 token`);
    }
    if(finding.evidenceState==='verified'&&!resolved.length)throw badRequest(`findings[${index}] 标记 verified 时必须提供证据 token`);
    const { rows:findingRows }=await client.query(`INSERT INTO sample_comparison_findings(
      comparison_id,scope_id,assessment_id,target,member_sample_id,kind,claim_text,limitations,evidence_state,ordinal
    )VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)RETURNING *`,[
      comparisonId,scopeId,assessment.id,normalized.target,finding.memberSampleId,finding.kind,finding.claimText,
      finding.limitations,finding.evidenceState,index+1,
    ]);
    for(const item of resolved)await client.query(`INSERT INTO sample_comparison_finding_evidence(
      assessment_id,finding_id,member_sample_id,scope_id,snapshot_id,dimension_key,evidence_token
    )VALUES($1,$2,$3,$4,$5,$6,$7)`,[assessment.id,findingRows[0].id,finding.memberSampleId,scopeId,
      item.snapshot.id,item.snapshot.dimension_key,item.token]);
  }
  return assessment;
}

async function loadAssessment(comparisonId,assessmentId,db={query}) {
  const { rows }=await db.query(`SELECT * FROM sample_comparison_assessments WHERE id=$1 AND comparison_id=$2`,[assessmentId,comparisonId]);
  if(!rows[0])throw notFound('比较评价不存在');
  const { rows:findings }=await db.query(`SELECT f.*,
    COALESCE(jsonb_agg(jsonb_build_object('snapshotId',e.snapshot_id,'dimensionKey',e.dimension_key,'token',e.evidence_token)
      ORDER BY e.id)FILTER(WHERE e.id IS NOT NULL),'[]'::jsonb)evidence
    FROM sample_comparison_findings f LEFT JOIN sample_comparison_finding_evidence e ON e.finding_id=f.id
    WHERE f.assessment_id=$1 GROUP BY f.id ORDER BY f.ordinal`,[assessmentId]);
  const row=rows[0];
  return { ...assessmentListDto(row),commonPoints:row.common_points,keyDifferences:row.key_differences,
    strengths:row.strengths,limitations:row.limitations,worthLearning:row.worth_learning,doNotCopy:row.do_not_copy,
    hypotheses:row.hypotheses,openQuestions:row.open_questions,methodLimitations:row.method_limitations,
    findings:findings.map(item=>({id:Number(item.id),memberSampleId:item.member_sample_id==null?null:Number(item.member_sample_id),
      kind:item.kind,claimText:item.claim_text,limitations:item.limitations,evidenceState:item.evidence_state,evidence:item.evidence})),
    claimPolicy:'observation_hypothesis_recommendation',causalClaimsAllowed:false };
}

let assessmentWorkerActive=false;
let assessmentRecoveryTimer=null;
let assessmentRecoveryStopped=false;
const ASSESSMENT_RECOVERY_POLL_MS=30_000;
let assessmentJobLeaseMs=75_000;
let assessmentHeartbeatMs=20_000;
let assessmentRequester=requestAiComparisonAssessment;
const activeAssessmentHeartbeats=new Set();

export function configureAssessmentWorkerForTests(options=null){
  assessmentJobLeaseMs=options?.leaseMs??75_000;
  assessmentHeartbeatMs=options?.heartbeatMs??20_000;
  assessmentRequester=options?.requester??requestAiComparisonAssessment;
}

function startAssessmentHeartbeat(job){
  let stopped=false,pending=Promise.resolve();
  const renew=()=>{
    if(stopped)return;
    pending=query(`UPDATE sample_comparison_assessment_jobs SET heartbeat_at=now(),
      lease_expires_at=now()+($3::int*interval '1 millisecond')
      WHERE id=$1 AND status='running' AND lease_owner=$2`,[job.id,job.lease_owner,assessmentJobLeaseMs])
      .catch(error=>console.warn('[sample-comparison] heartbeat failed:',error?.code||error?.name||'Error'));
  };
  const timer=setInterval(renew,Math.max(10,assessmentHeartbeatMs));timer.unref?.();
  const stop=async()=>{if(stopped)return;stopped=true;clearInterval(timer);activeAssessmentHeartbeats.delete(stop);await pending;};
  activeAssessmentHeartbeats.add(stop);return {stop};
}
async function claimAssessmentJob() {
  try{return await tx(async client=>{
    const { rows }=await client.query(`SELECT * FROM sample_comparison_assessment_jobs
      WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
    if(!rows[0])return null;
    const owner=`${process.pid}:${randomUUID()}`;
    const updated=await client.query(`UPDATE sample_comparison_assessment_jobs SET status='running',attempts=attempts+1,
      lease_owner=$2,lease_expires_at=now()+($3::int*interval '1 millisecond'),heartbeat_at=now(),started_at=COALESCE(started_at,now())
      WHERE id=$1 AND status='queued' RETURNING *`,[rows[0].id,owner,assessmentJobLeaseMs]);
    return updated.rows[0]||null;
  });}catch(error){if(error?.code==='23505')return null;throw error;}
}

export async function runAssessmentWorker() {
  if(assessmentWorkerActive)return;assessmentWorkerActive=true;
  try{
    while(true){
      const job=await claimAssessmentJob();if(!job)break;
      const heartbeat=startAssessmentHeartbeat(job);
      try{
        const scope=await loadScopeDetail(Number(job.comparison_id),Number(job.scope_id));
        const generated=await assessmentRequester({target:job.target,scope});
        await tx(async client=>{
          const { rows:locked }=await client.query(`SELECT * FROM sample_comparison_assessment_jobs
            WHERE id=$1 AND status='running' FOR UPDATE`,[job.id]);
          if(!locked[0])return;
          await persistAssessment(client,{comparisonId:Number(job.comparison_id),scopeId:Number(job.scope_id),
            input:generated.assessment,source:'ai',actorId:job.requested_by,jobId:Number(job.id),
            provider:generated.provider,modelName:generated.modelName,inputSha256:generated.inputSha256});
          await client.query(`UPDATE sample_comparison_assessment_jobs SET status='succeeded',finished_at=now(),
            lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now() WHERE id=$1`,[job.id]);
        });
      }catch(error){
        const safe=safeAssessmentError(error);
        const retryable=safe.code==='AI_TIMEOUT'||safe.code==='AI_NETWORK'||safe.code==='AI_HTTP_429'||/^AI_HTTP_5\d\d$/.test(safe.code);
        await tx(async client=>{
          const locked=(await client.query(`SELECT attempts,max_attempts FROM sample_comparison_assessment_jobs
            WHERE id=$1 AND status='running' FOR UPDATE`,[job.id])).rows[0];
          if(!locked)return;
          if(retryable&&Number(locked.attempts)<Number(locked.max_attempts)){
            await client.query(`UPDATE sample_comparison_assessment_jobs SET status='queued',lease_owner=NULL,
              lease_expires_at=NULL,error_code=$2,error_message=$3 WHERE id=$1`,[job.id,safe.code,safe.message]);
          }else{
            await client.query(`UPDATE sample_comparison_assessment_jobs SET status='failed',finished_at=now(),
              lease_owner=NULL,lease_expires_at=NULL,error_code=$2,error_message=$3 WHERE id=$1`,[job.id,safe.code,safe.message]);
          }
        }).catch(()=>{});
        console.warn('[sample-comparison] assessment job failed:',safe.code);
      }finally{await heartbeat.stop();}
    }
  }finally{assessmentWorkerActive=false;}
}

export async function recoverAssessmentJobs() {
  await tx(async client=>{
    await client.query(`UPDATE sample_comparison_assessment_jobs SET status='failed',finished_at=now(),
      lease_owner=NULL,lease_expires_at=NULL,error_code='AI_LEASE_EXHAUSTED',error_message='AI 任务租约到期且重试次数已用完'
      WHERE status='running' AND lease_expires_at<now() AND attempts>=max_attempts`);
    await client.query(`UPDATE sample_comparison_assessment_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
      error_code=NULL,error_message=NULL WHERE status='running' AND lease_expires_at<now() AND attempts<max_attempts`);
  });
}

async function nextRecoveryDelay(){
  const {rows}=await query(`SELECT min(lease_expires_at) next_expiry FROM sample_comparison_assessment_jobs
    WHERE status='running' AND lease_expires_at IS NOT NULL`);
  if(!rows[0]?.next_expiry)return ASSESSMENT_RECOVERY_POLL_MS;
  return Math.max(25,Math.min(ASSESSMENT_RECOVERY_POLL_MS,new Date(rows[0].next_expiry).getTime()-Date.now()+25));
}

async function assessmentRecoveryTick(){
  try{await recoverAssessmentJobs();await runAssessmentWorker();}
  catch(error){if(!assessmentRecoveryStopped)console.error('[sample-comparison] worker recovery failed:',error?.code||error?.name||'Error');}
  finally{if(!assessmentRecoveryStopped)scheduleAssessmentRecovery(await nextRecoveryDelay().catch(()=>ASSESSMENT_RECOVERY_POLL_MS));}
}

export function scheduleAssessmentRecovery(delayMs=0){
  assessmentRecoveryStopped=false;
  if(assessmentRecoveryTimer)clearTimeout(assessmentRecoveryTimer);
  assessmentRecoveryTimer=setTimeout(()=>assessmentRecoveryTick(),Math.max(0,delayMs));
  assessmentRecoveryTimer.unref?.();
}

export function stopAssessmentRecovery(){
  assessmentRecoveryStopped=true;
  if(assessmentRecoveryTimer)clearTimeout(assessmentRecoveryTimer);
  assessmentRecoveryTimer=null;
  for(const stop of [...activeAssessmentHeartbeats])void stop();
}

async function createRevisionInTransaction(client,{componentId,input,actorId,source='manual'}) {
  const normalized=normalizeComponentRevisionInput(input,{source});
  const { rows:components }=await client.query('SELECT * FROM content_components WHERE id=$1 FOR UPDATE',[componentId]);
  if(!components[0])throw notFound('组件不存在');
  const { rows:revisionRows }=await client.query('SELECT COALESCE(MAX(revision),0)+1 revision FROM content_component_revisions WHERE component_id=$1',[componentId]);
  const extractionRows=(await client.query(`SELECT id,dimension_key,status FROM sample_element_extractions
    WHERE id=ANY($1::bigint[])`,[normalized.extractionIds])).rows;
  if(extractionRows.length!==normalized.extractionIds.length||extractionRows.some(row=>row.status!=='complete'||row.dimension_key!==normalized.dimensionKey)){
    throw badRequest('所有组件来源必须是同维度的完整局部提取');
  }
  if(normalized.tagIds.length){
    const { rows:tags }=await client.query('SELECT id FROM tags WHERE active AND id=ANY($1::bigint[])',[normalized.tagIds]);
    if(tags.length!==normalized.tagIds.length)throw badRequest('标签不存在或已停用');
  }
  const hash=sha256({ ...normalized,extractionIds:normalized.extractionIds,tagIds:normalized.tagIds });
  const { rows }=await client.query(`INSERT INTO content_component_revisions(
    component_id,revision,dimension_key,origin,state,name,pattern_text,function_text,applicability,limitations,do_not_copy,content_sha256,created_by
  )VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12)RETURNING *`,[
    componentId,revisionRows[0].revision,normalized.dimensionKey,source,normalized.name,normalized.patternText,
    normalized.functionText,normalized.applicability,normalized.limitations,normalized.doNotCopy,hash,actorId,
  ]);
  const revision=rows[0];
  for(let index=0;index<normalized.extractionIds.length;index++)await client.query(`INSERT INTO content_component_revision_sources(
    component_id,revision_id,revision_dimension_key,extraction_id,extraction_dimension_key,source_role
  )VALUES($1,$2,$3,$4,$3,$5)`,[componentId,revision.id,normalized.dimensionKey,normalized.extractionIds[index],index===0?'primary':'supporting']);
  if(normalized.tagIds.length)await client.query(`INSERT INTO content_component_revision_tags(
    component_id,revision_id,tag_id,origin,created_by
  )SELECT $1,$2,unnest($3::bigint[]),$4,$5`,[componentId,revision.id,normalized.tagIds,source,actorId]);
  return revision;
}

async function loadComponent(componentId,db={query}) {
  const { rows:components }=await db.query('SELECT * FROM content_components WHERE id=$1',[componentId]);
  if(!components[0])throw notFound('组件不存在');
  const { rows:revisions }=await db.query(`SELECT r.*,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'name',t.name)ORDER BY t.kind,t.sort,t.id)
      FROM content_component_revision_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.revision_id=r.id),'[]'::jsonb)tags,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('extractionId',s.extraction_id,'role',s.source_role)ORDER BY s.id)
      FROM content_component_revision_sources s WHERE s.revision_id=r.id),'[]'::jsonb)sources,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'decision',d.decision,'note',d.note,'actorRole',d.actor_role,'createdAt',d.created_at)ORDER BY d.id)
      FROM content_component_revision_decisions d WHERE d.revision_id=r.id),'[]'::jsonb)decisions
    FROM content_component_revisions r WHERE r.component_id=$1 ORDER BY r.revision DESC,r.id DESC`,[componentId]);
  const { rows:selections }=await db.query('SELECT * FROM content_component_selections WHERE component_id=$1 ORDER BY id DESC',[componentId]);
  const { rows:lifecycle }=await db.query('SELECT * FROM content_component_lifecycle_events WHERE component_id=$1 ORDER BY id',[componentId]);
  return { id:Number(components[0].id),name:components[0].name,lifecycleState:components[0].lifecycle_state,
    currentApprovedRevisionId:selections[0]?Number(selections[0].revision_id):null,
    revisions:revisions.map(row=>({id:Number(row.id),revision:Number(row.revision),dimensionKey:row.dimension_key,
      origin:row.origin,state:row.state,name:row.name,patternText:row.pattern_text,functionText:row.function_text,
      applicability:row.applicability,limitations:row.limitations,doNotCopy:row.do_not_copy,contentSha256:row.content_sha256,
      tags:row.tags,sources:row.sources,decisions:row.decisions,createdAt:row.created_at})),
    selections:selections.map(row=>({id:Number(row.id),revisionId:Number(row.revision_id),createdAt:row.created_at})),
    lifecycle:lifecycle.map(row=>({id:Number(row.id),eventType:row.event_type,reason:row.reason,createdAt:row.created_at})) };
}

function idempotentStatus(result,createdStatus=201){return result.reused?200:createdStatus;}

export function mount(router) {
  router.post('/api/sample-comparisons',async(req,res)=>guarded(async()=>{
    const me=await currentUser(req);const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes);
    rejectServerDerived(body);
    const normalized=normalizeComparisonInput(body);const key=requireIdempotency(req);
    const outcome=await tx(async client=>{
      await prepareScopeSnapshotTransaction(client,normalized.scope.memberIds);
      return withIdempotency(client,{aggregateKey:'sample-comparisons',action:'create',key,request:normalized,actorId:me.id},async()=>{
        const { rows }=await client.query('INSERT INTO sample_comparisons(title,purpose,created_by)VALUES($1,$2,$3)RETURNING *',
          [normalized.title,normalized.purpose,me.id]);
        await createScopeInTransaction(client,{comparisonId:Number(rows[0].id),scopeInput:normalized.scope,actorId:me.id});
        return {responseKind:'comparison',responseId:Number(rows[0].id),status:201};
      });
    });
    const detail=await loadComparisonDetail(outcome.responseId);sendJson(res,idempotentStatus(outcome),detail);
  }));

  router.get('/api/sample-comparisons',async(req,res,params,url)=>{
    await currentUser(req);const {page,pageSize,offset}=parsePagination(url);
    const q=cleanText(url.searchParams.get('q'),200,'q')||null;
    const target=url.searchParams.get('target')?assertTarget(url.searchParams.get('target')):null;
    const memberId=url.searchParams.get('memberId')?strictId(url.searchParams.get('memberId'),'memberId'):null;
    const args=[q,target,memberId,pageSize,offset];
    const where=`WHERE ($1::text IS NULL OR c.title ILIKE '%'||$1||'%' OR c.purpose ILIKE '%'||$1||'%')
      AND($2::text IS NULL OR EXISTS(SELECT 1 FROM sample_comparison_assessments a WHERE a.comparison_id=c.id AND a.target=$2))
      AND($3::bigint IS NULL OR EXISTS(SELECT 1 FROM sample_comparison_scope_members m JOIN sample_comparison_scopes s ON s.id=m.scope_id
        WHERE m.comparison_id=c.id AND m.sample_id=$3 AND s.status='complete'))`;
    const [{rows},{rows:counts}]=await Promise.all([
      query(`SELECT c.*,ls.id scope_id,ls.revision scope_revision,ls.topic_basis,ls.created_at scope_created_at,
        (SELECT count(*) FROM sample_comparison_scope_members m WHERE m.scope_id=ls.id)member_count,
        COALESCE((SELECT jsonb_object_agg(z.target,z.item)FROM(SELECT DISTINCT ON(a.target)a.target,
          jsonb_build_object('id',a.id,'scopeId',a.scope_id,'revision',a.revision,'source',a.source) item
          FROM sample_comparison_assessment_selections sel JOIN sample_comparison_assessments a ON a.id=sel.assessment_id
          WHERE sel.comparison_id=c.id ORDER BY a.target,sel.id DESC)z),'{}'::jsonb)current_assessments,
        COALESCE((SELECT jsonb_object_agg(target,n)FROM(SELECT target,count(*)n FROM sample_comparison_assessments
          WHERE comparison_id=c.id GROUP BY target)z),'{}'::jsonb)assessment_counts
        FROM sample_comparisons c LEFT JOIN LATERAL(SELECT * FROM sample_comparison_scopes
          WHERE comparison_id=c.id AND status='complete' ORDER BY revision DESC,id DESC LIMIT 1)ls ON true
        ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT $4 OFFSET $5`,args),
      query(`SELECT count(*) count FROM sample_comparisons c ${where}`,args.slice(0,3)),
    ]);
    sendJson(res,200,{items:rows.map(comparisonListDto),total:Number(counts[0].count),page,pageSize,
      filterSemantics:{target:'assessment_history_or_current',memberId:'any_complete_scope_member'}});
  });

  router.get('/api/sample-comparisons/:id',async(req,res,params)=>{
    await currentUser(req);sendJson(res,200,await loadComparisonDetail(strictId(params.id,'比较 id')));
  });

  router.post('/api/sample-comparisons/:id/scopes',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),comparisonId=strictId(params.id,'比较 id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),normalized=normalizeScopeInput(body),key=requireIdempotency(req);
    const outcome=await tx(async client=>{await prepareScopeSnapshotTransaction(client,normalized.memberIds);
      return withIdempotency(client,{aggregateKey:`comparison:${comparisonId}`,action:'scope.create',key,request:normalized,actorId:me.id},async()=>{
        const scope=await createScopeInTransaction(client,{comparisonId,scopeInput:normalized,actorId:me.id});
        return {responseKind:'scope',responseId:Number(scope.id),status:201};
      });});
    sendJson(res,idempotentStatus(outcome),await loadScopeDetail(comparisonId,outcome.responseId));
  }));

  router.get('/api/sample-comparisons/:id/scopes/:scopeId',async(req,res,params)=>{
    await currentUser(req);sendJson(res,200,await loadScopeDetail(strictId(params.id,'比较 id'),strictId(params.scopeId,'scope id')));
  });

  router.post('/api/sample-comparisons/:id/scopes/:scopeId/assessments/manual',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),comparisonId=strictId(params.id,'比较 id'),scopeId=strictId(params.scopeId,'scope id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),normalized=normalizeAssessmentInput(body,{source:'manual'}),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`scope:${scopeId}`,action:'assessment.manual',
      key,request:normalized,actorId:me.id},async()=>{const assessment=await persistAssessment(client,{comparisonId,scopeId,input:normalized,source:'manual',actorId:me.id});
        return {responseKind:'assessment',responseId:Number(assessment.id),status:201};}));
    sendJson(res,idempotentStatus(outcome),await loadAssessment(comparisonId,outcome.responseId));
  }));

  router.post('/api/sample-comparisons/:id/scopes/:scopeId/assessment-jobs',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),comparisonId=strictId(params.id,'比较 id'),scopeId=strictId(params.scopeId,'scope id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),key=requireIdempotency(req);
    rejectServerDerived(body);
    assertExactFields(body,['target'],['target']);
    const target=assertTarget(body.target);
    const request={target,scopeId};
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`scope:${scopeId}`,action:'assessment.job',
      key,request,actorId:me.id},async()=>{
        const provider=await activeProvider();
        if(!provider?.apiKey)throw new HttpError(503,'尚未配置 AI，可继续使用人工评价',{code:'AI_NOT_CONFIGURED',manualEntryAllowed:true});
        const { rows:scopeRows }=await client.query(`SELECT input_sha256 FROM sample_comparison_scopes
          WHERE id=$1 AND comparison_id=$2 AND status='complete'`,[scopeId,comparisonId]);
        if(!scopeRows[0])throw notFound('完整比较范围不存在');
        const { rows }=await client.query(`INSERT INTO sample_comparison_assessment_jobs(
          comparison_id,scope_id,target,status,request_sha256,provider,model_name,requested_by
        )VALUES($1,$2,$3,'queued',$4,$5,$6,$7)RETURNING *`,[comparisonId,scopeId,target,
          sha256({target,scopeHash:scopeRows[0].input_sha256}),provider.source||'configured',provider.model,me.id]);
        return {responseKind:'assessment_job',responseId:Number(rows[0].id),status:202};
      }));
    queueMicrotask(()=>runAssessmentWorker().catch(error=>console.error('[sample-comparison] worker failed:',error?.name||'Error')));
    const job=(await query('SELECT * FROM sample_comparison_assessment_jobs WHERE id=$1',[outcome.responseId])).rows[0];
    sendJson(res,outcome.reused?200:202,{job:assessmentJobDto(job),manualEntryAllowed:true});
  }));

  router.get('/api/sample-comparisons/:id/assessment-jobs/:jobId',async(req,res,params)=>{
    await currentUser(req);const comparisonId=strictId(params.id,'比较 id'),jobId=strictId(params.jobId,'任务 id');
    const {rows}=await query('SELECT * FROM sample_comparison_assessment_jobs WHERE id=$1 AND comparison_id=$2',[jobId,comparisonId]);
    if(!rows[0])throw notFound('AI 评价任务不存在');sendJson(res,200,{job:assessmentJobDto(rows[0]),manualEntryAllowed:true});
  });

  router.get('/api/sample-comparisons/:id/assessments',async(req,res,params,url)=>{
    await currentUser(req);const comparisonId=strictId(params.id,'比较 id');
    const target=url.searchParams.get('target')?assertTarget(url.searchParams.get('target')):null;
    const {rows}=await query(`SELECT * FROM sample_comparison_assessments WHERE comparison_id=$1
      AND($2::text IS NULL OR target=$2)ORDER BY target,revision DESC,id DESC`,[comparisonId,target]);
    sendJson(res,200,{items:rows.map(assessmentListDto),targets:ASSESSMENT_TARGETS});
  });

  router.get('/api/sample-comparisons/:id/assessments/:assessmentId',async(req,res,params)=>{
    await currentUser(req);sendJson(res,200,await loadAssessment(strictId(params.id,'比较 id'),strictId(params.assessmentId,'评价 id')));
  });

  router.post('/api/sample-comparisons/:id/assessments/:assessmentId/select',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req);assertCanReview(me);
    const comparisonId=strictId(params.id,'比较 id'),assessmentId=strictId(params.assessmentId,'评价 id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),key=requireIdempotency(req);
    rejectServerDerived(body);
    assertExactFields(body,['reason']);
    const reason=cleanText(body.reason,STAGE3_LIMITS.purposeChars,'选择理由');
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`comparison:${comparisonId}`,action:'assessment.select',
      key,request:{assessmentId,reason},actorId:me.id},async()=>{
        await ensureComparison(client,comparisonId,{lock:true});
        const {rows:assessments}=await client.query('SELECT * FROM sample_comparison_assessments WHERE id=$1 AND comparison_id=$2',[assessmentId,comparisonId]);
        if(!assessments[0])throw notFound('比较评价不存在');
        const {rows}=await client.query(`INSERT INTO sample_comparison_assessment_selections(
          comparison_id,target,assessment_id,reason,selected_by)VALUES($1,$2,$3,$4,$5)RETURNING *`,
        [comparisonId,assessments[0].target,assessmentId,reason,me.id]);
        return {responseKind:'assessment_selection',responseId:Number(rows[0].id),status:201};
      }));
    const row=(await query('SELECT * FROM sample_comparison_assessment_selections WHERE id=$1',[outcome.responseId])).rows[0];
    sendJson(res,idempotentStatus(outcome),{id:Number(row.id),comparisonId:Number(row.comparison_id),target:row.target,
      assessmentId:Number(row.assessment_id),reason:row.reason,createdAt:row.created_at});
  }));

  router.post('/api/sample-relations',async(req,res)=>guarded(async()=>{
    const me=await currentUser(req),body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),normalized=normalizeRelationInput(body),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:'sample-relations',action:'create',key,request:normalized,actorId:me.id},async()=>{
      const {rows:versions}=await client.query(`SELECT id FROM sample_analysis_versions WHERE status='complete' AND
        ((sample_id=$1 AND id=$2)OR(sample_id=$3 AND id=$4))`,[normalized.subjectSampleId,normalized.subjectAnalysisVersionId,
        normalized.objectSampleId,normalized.objectAnalysisVersionId]);
      if(versions.length!==2)throw badRequest('关系两端必须固定到各自样本的完整分析版本');
      const {rows}=await client.query(`INSERT INTO sample_relations(
        relation_type,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id,origin,rationale,proposed_by
      )VALUES($1,$2,$3,$4,$5,'manual',$6,$7)RETURNING *`,[normalized.relationType,normalized.subjectSampleId,
        normalized.subjectAnalysisVersionId,normalized.objectSampleId,normalized.objectAnalysisVersionId,normalized.rationale,me.id]);
      await client.query(`INSERT INTO sample_relation_events(relation_id,event_type,actor_id,actor_role)
        VALUES($1,'proposed',$2,$3)`,[rows[0].id,me.id,me.role]);
      return {responseKind:'relation',responseId:Number(rows[0].id),status:201};
    }));sendJson(res,idempotentStatus(outcome),await loadRelation(outcome.responseId,me));
  }));

  router.get('/api/samples/:id/relations',async(req,res,params,url)=>{
    const me=await currentUser(req);const sampleId=strictId(params.id,'样本 id');
    const state=url.searchParams.get('state')||null;
    if(state&&!['proposed','confirmed','rejected','withdrawn','superseded'].includes(state))throw badRequest('state 不合法');
    const {rows}=await query(`SELECT r.*,ss.title subject_title,os.title object_title
      FROM sample_relations r JOIN samples ss ON ss.id=r.subject_sample_id JOIN samples os ON os.id=r.object_sample_id
      WHERE(r.subject_sample_id=$1 OR r.object_sample_id=$1)AND($2::text IS NULL OR r.current_state=$2)ORDER BY r.id DESC`,[sampleId,state]);
    const relationIds=rows.map(row=>Number(row.id));
    const [{rows:evidenceRows},{rows:eventRows}]=relationIds.length?await Promise.all([
      query(`SELECT re.id,re.relation_id,re.endpoint_sample_id,re.endpoint_analysis_version_id,
        re.element_evidence_id,re.note,re.created_at,e.dimension_key
        FROM sample_relation_evidence re
        JOIN sample_element_evidence ee ON ee.id=re.element_evidence_id
          AND ee.version_id=re.endpoint_analysis_version_id AND ee.verification_status='verified'
        JOIN sample_analysis_elements e ON e.id=ee.element_id AND e.version_id=ee.version_id
        WHERE re.relation_id=ANY($1::bigint[]) ORDER BY re.relation_id,re.id`,[relationIds]),
      query(`SELECT id,relation_id,event_type,reason,actor_role,superseded_by_relation_id,created_at
        FROM sample_relation_events WHERE relation_id=ANY($1::bigint[]) ORDER BY relation_id,id`,[relationIds]),
    ]):[{rows:[]},{rows:[]}];
    const evidenceByRelation=new Map(),eventsByRelation=new Map();
    for(const item of evidenceRows){
      const key=Number(item.relation_id);if(!evidenceByRelation.has(key))evidenceByRelation.set(key,[]);
      evidenceByRelation.get(key).push({id:Number(item.id),endpointSampleId:Number(item.endpoint_sample_id),
        endpointAnalysisVersionId:Number(item.endpoint_analysis_version_id),elementEvidenceId:Number(item.element_evidence_id),
        dimensionKey:item.dimension_key,note:item.note,createdAt:item.created_at});
    }
    for(const item of eventRows){
      const key=Number(item.relation_id);if(!eventsByRelation.has(key))eventsByRelation.set(key,[]);
      eventsByRelation.get(key).push({id:Number(item.id),eventType:item.event_type,reason:item.reason,
        actorRole:item.actor_role,supersededByRelationId:item.superseded_by_relation_id==null?null:Number(item.superseded_by_relation_id),
        createdAt:item.created_at});
    }
    sendJson(res,200,{items:rows.map(row=>relationDto(row,sampleId,evidenceByRelation.get(Number(row.id))||[],
      eventsByRelation.get(Number(row.id))||[],me))});
  });

  router.post('/api/sample-relations/:id/evidence',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),relationId=strictId(params.id,'关系 id'),body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),key=requireIdempotency(req);
    rejectServerDerived(body);
    assertExactFields(body,['endpointSampleId','endpointAnalysisVersionId','elementEvidenceId','note'],
      ['endpointSampleId','endpointAnalysisVersionId','elementEvidenceId']);
    const request={endpointSampleId:strictId(body.endpointSampleId,'endpointSampleId'),
      endpointAnalysisVersionId:strictId(body.endpointAnalysisVersionId,'endpointAnalysisVersionId'),
      elementEvidenceId:strictId(body.elementEvidenceId,'elementEvidenceId'),note:cleanText(body.note,STAGE3_LIMITS.statementChars,'证据说明')};
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`relation:${relationId}`,action:'evidence.add',key,request,actorId:me.id},async()=>{
      const relation=(await client.query('SELECT * FROM sample_relations WHERE id=$1 FOR UPDATE',[relationId])).rows[0];
      if(!relation)throw notFound('关系不存在');
      const {rows}=await client.query(`INSERT INTO sample_relation_evidence(
        relation_id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id,
        endpoint_sample_id,endpoint_analysis_version_id,element_evidence_id,note,added_by
      )VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)RETURNING *`,[relationId,relation.subject_sample_id,
        relation.subject_analysis_version_id,relation.object_sample_id,relation.object_analysis_version_id,
        request.endpointSampleId,request.endpointAnalysisVersionId,request.elementEvidenceId,request.note,me.id]);
      return {responseKind:'relation_evidence',responseId:Number(rows[0].id),status:201};
    }));const row=(await query('SELECT * FROM sample_relation_evidence WHERE id=$1',[outcome.responseId])).rows[0];
    sendJson(res,idempotentStatus(outcome),{id:Number(row.id),relationId:Number(row.relation_id),endpointSampleId:Number(row.endpoint_sample_id),
      endpointAnalysisVersionId:Number(row.endpoint_analysis_version_id),elementEvidenceId:Number(row.element_evidence_id),note:row.note,createdAt:row.created_at});
  }));

  router.post('/api/sample-relations/:id/events',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),relationId=strictId(params.id,'关系 id'),body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),key=requireIdempotency(req);
    rejectServerDerived(body);
    assertExactFields(body,['eventType','reason','supersededByRelationId'],['eventType']);
    const eventType=String(body.eventType||'').trim();
    if(!['confirmed','rejected','withdrawn','superseded'].includes(eventType))throw badRequest('eventType 不合法');
    if(!(['reviewer','admin'].includes(me.role))){
      if(eventType!=='withdrawn')throw forbidden('成员只能撤回自己提出且仍待审核的关系');
    }
    const request={eventType,reason:cleanText(body.reason,STAGE3_LIMITS.purposeChars,'原因'),
      supersededByRelationId:eventType==='superseded'?strictId(body.supersededByRelationId,'supersededByRelationId'):null};
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`relation:${relationId}`,action:'event',key,request,actorId:me.id},async()=>{
      const relation=(await client.query('SELECT * FROM sample_relations WHERE id=$1 FOR UPDATE',[relationId])).rows[0];
      if(!relation)throw notFound('关系不存在');
      if(!(['reviewer','admin'].includes(me.role))&&
        (relation.current_state!=='proposed'||Number(relation.proposed_by)!==me.id)){
        throw forbidden('成员只能撤回自己提出且仍待审核的关系');
      }
      // Acquire before the INSERT command starts, so a waiter gets a fresh READ COMMITTED snapshot
      // after the preceding confirmation commits. The trigger takes the same lock defensively.
      if(eventType==='confirmed')await client.query('SELECT pg_advisory_xact_lock(730082913)');
      const {rows}=await client.query(`INSERT INTO sample_relation_events(
        relation_id,event_type,reason,actor_id,actor_role,superseded_by_relation_id
      )VALUES($1,$2,$3,$4,$5,$6)RETURNING *`,[relationId,eventType,request.reason,me.id,me.role,request.supersededByRelationId]);
      return {responseKind:'relation_event',responseId:Number(rows[0].id),status:201};
    }));const row=(await query('SELECT * FROM sample_relation_events WHERE id=$1',[outcome.responseId])).rows[0];
    sendJson(res,idempotentStatus(outcome),{id:Number(row.id),relationId,eventType:row.event_type,reason:row.reason,
      supersededByRelationId:row.superseded_by_relation_id==null?null:Number(row.superseded_by_relation_id),createdAt:row.created_at});
  }));

  router.post('/api/sample-comparisons/:id/scopes/:scopeId/extractions',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),comparisonId=strictId(params.id,'比较 id'),scopeId=strictId(params.scopeId,'scope id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),normalized=normalizeExtractionInput(body,{source:'manual'}),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`scope:${scopeId}`,action:'extraction.create',key,request:normalized,actorId:me.id},async()=>{
      const {rows}=await client.query(`INSERT INTO sample_element_extractions(
        comparison_id,scope_id,assessment_id,dimension_key,origin,status,pattern_text,function_text,rationale,applicability,limitations,do_not_copy,created_by
      )VALUES($1,$2,$3,$4,'manual','building',$5,$6,$7,$8,$9,$10,$11)RETURNING *`,[comparisonId,scopeId,
        normalized.assessmentId,normalized.dimensionKey,normalized.patternText,normalized.functionText,normalized.rationale,
        normalized.applicability,normalized.limitations,normalized.doNotCopy,me.id]);
      const extraction=rows[0];
      for(const source of normalized.sources){
        const snapshot=(await client.query(`SELECT * FROM sample_comparison_snapshots
          WHERE id=$1 AND scope_id=$2 AND dimension_key=$3`,[source.snapshotId,scopeId,normalized.dimensionKey])).rows[0];
        if(!snapshot)throw badRequest('局部提取来源必须属于同一 scope 和维度');
        await client.query(`INSERT INTO sample_element_extraction_sources(
          extraction_id,extraction_dimension_key,comparison_id,scope_id,sample_id,snapshot_id,snapshot_dimension_key,source_role,note
        )VALUES($1,$2,$3,$4,$5,$6,$2,$7,$8)`,[extraction.id,normalized.dimensionKey,comparisonId,scopeId,
          snapshot.sample_id,snapshot.id,source.sourceRole,source.note]);
      }
      await client.query(`UPDATE sample_element_extractions SET status='complete',completed_at=now() WHERE id=$1`,[extraction.id]);
      return {responseKind:'extraction',responseId:Number(extraction.id),status:201};
    }));const row=(await query('SELECT * FROM sample_element_extractions WHERE id=$1',[outcome.responseId])).rows[0];
    sendJson(res,idempotentStatus(outcome),extractionListDto(row));
  }));

  router.get('/api/sample-element-extractions',async(req,res,params,url)=>{
    await currentUser(req);const {page,pageSize,offset}=parsePagination(url);
    const dimensionKey=url.searchParams.get('dimensionKey')?assertDimension(url.searchParams.get('dimensionKey')):null;
    const comparisonId=url.searchParams.get('comparisonId')?strictId(url.searchParams.get('comparisonId'),'comparisonId'):null;
    const [{rows},{rows:counts}]=await Promise.all([
      query(`SELECT * FROM sample_element_extractions WHERE status='complete'AND($1::text IS NULL OR dimension_key=$1)
        AND($2::bigint IS NULL OR comparison_id=$2)ORDER BY id DESC LIMIT $3 OFFSET $4`,[dimensionKey,comparisonId,pageSize,offset]),
      query(`SELECT count(*)count FROM sample_element_extractions WHERE status='complete'AND($1::text IS NULL OR dimension_key=$1)
        AND($2::bigint IS NULL OR comparison_id=$2)`,[dimensionKey,comparisonId]),
    ]);sendJson(res,200,{items:rows.map(extractionListDto),total:Number(counts[0].count),page,pageSize});
  });

  router.post('/api/content-components',async(req,res)=>guarded(async()=>{
    const me=await currentUser(req),body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),normalized=normalizeComponentRevisionInput(body,{source:'manual'}),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:'content-components',action:'create',key,request:normalized,actorId:me.id},async()=>{
      const {rows}=await client.query('INSERT INTO content_components(name,created_by)VALUES($1,$2)RETURNING *',[normalized.name,me.id]);
      await createRevisionInTransaction(client,{componentId:Number(rows[0].id),input:normalized,actorId:me.id});
      return {responseKind:'component',responseId:Number(rows[0].id),status:201};
    }));sendJson(res,idempotentStatus(outcome),await loadComponent(outcome.responseId));
  }));

  router.post('/api/content-components/:id/revisions',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),componentId=strictId(params.id,'组件 id'),body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),
      normalized=normalizeComponentRevisionInput(body,{source:'manual'}),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`component:${componentId}`,action:'revision.create',key,request:normalized,actorId:me.id},async()=>{
      const revision=await createRevisionInTransaction(client,{componentId,input:normalized,actorId:me.id});
      return {responseKind:'component_revision',responseId:Number(revision.id),status:201};
    }));sendJson(res,idempotentStatus(outcome),await loadComponent(componentId));
  }));

  router.post('/api/content-components/:id/revisions/:revisionId/tags',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),componentId=strictId(params.id,'组件 id'),revisionId=strictId(params.revisionId,'revision id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),key=requireIdempotency(req);
    rejectServerDerived(body);
    assertExactFields(body,['tagIds'],['tagIds']);
    if(!Array.isArray(body.tagIds)||body.tagIds.length>STAGE3_LIMITS.tagsPerRevisionMax)throw badRequest('tagIds 必须是最多 30 项的数组');
    const tagIds=[...new Set(body.tagIds.map(id=>strictId(id,'tagId')))];
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`revision:${revisionId}`,action:'tags.add',key,request:{tagIds},actorId:me.id},async()=>{
      const revision=(await client.query('SELECT * FROM content_component_revisions WHERE id=$1 AND component_id=$2 FOR UPDATE',[revisionId,componentId])).rows[0];
      if(!revision)throw notFound('组件版本不存在');
      if(tagIds.length){const tags=(await client.query('SELECT id FROM tags WHERE active AND id=ANY($1::bigint[])',[tagIds])).rows;
        if(tags.length!==tagIds.length)throw badRequest('标签不存在或已停用');
        await client.query(`INSERT INTO content_component_revision_tags(component_id,revision_id,tag_id,origin,created_by)
          SELECT $1,$2,unnest($3::bigint[]),'manual',$4 ON CONFLICT DO NOTHING`,[componentId,revisionId,tagIds,me.id]);}
      return {responseKind:'component_revision',responseId:revisionId,status:201};
    }));sendJson(res,idempotentStatus(outcome),await loadComponent(componentId));
  }));

  router.get('/api/content-components',async(req,res,params,url)=>{
    await currentUser(req);sendJson(res,200,await listComponents(url,false));
  });
  router.get('/api/reusable-components',async(req,res,params,url)=>{
    await currentUser(req);sendJson(res,200,await listComponents(url,true));
  });
  router.get('/api/content-components/:id',async(req,res,params)=>{
    await currentUser(req);sendJson(res,200,await loadComponent(strictId(params.id,'组件 id')));
  });

  router.post('/api/content-components/:id/revisions/:revisionId/submit',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req),componentId=strictId(params.id,'组件 id'),revisionId=strictId(params.revisionId,'revision id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes),key=requireIdempotency(req);
    rejectServerDerived(body);
    assertExactFields(body,['note']);
    const note=cleanText(body.note,STAGE3_LIMITS.purposeChars,'提交说明');
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`revision:${revisionId}`,action:'submit',key,request:{note},actorId:me.id},async()=>{
      const {rows}=await client.query(`INSERT INTO content_component_revision_decisions(
        component_id,revision_id,decision,note,actor_id,actor_role)VALUES($1,$2,'submitted',$3,$4,$5)RETURNING *`,
      [componentId,revisionId,note,me.id,me.role]);return {responseKind:'component_decision',responseId:Number(rows[0].id),status:201};
    }));sendJson(res,idempotentStatus(outcome),await loadComponent(componentId));
  }));

  router.post('/api/content-components/:id/revisions/:revisionId/review',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req);assertCanReview(me);
    const componentId=strictId(params.id,'组件 id'),revisionId=strictId(params.revisionId,'revision id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes);
    rejectServerDerived(body);
    assertExactFields(body,['decision','note'],['decision']);
    const decision=String(body.decision||'').trim();
    if(!['approved','changes_requested'].includes(decision))throw badRequest('decision 必须是 approved 或 changes_requested');
    const note=cleanText(body.note,STAGE3_LIMITS.purposeChars,'审核说明',{required:decision==='changes_requested'}),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`revision:${revisionId}`,action:'review',key,
      request:{decision,note},actorId:me.id},async()=>{
        await client.query('SELECT 1 FROM content_components WHERE id=$1 FOR UPDATE',[componentId]);
        const {rows}=await client.query(`INSERT INTO content_component_revision_decisions(
          component_id,revision_id,decision,note,actor_id,actor_role)VALUES($1,$2,$3,$4,$5,$6)RETURNING *`,
        [componentId,revisionId,decision,note,me.id,me.role]);
        if(decision==='approved')await client.query(`INSERT INTO content_component_selections(
          component_id,revision_id,decision_id,selected_by)VALUES($1,$2,$3,$4)`,[componentId,revisionId,rows[0].id,me.id]);
        return {responseKind:'component_decision',responseId:Number(rows[0].id),status:201};
      }));sendJson(res,idempotentStatus(outcome),await loadComponent(componentId));
  }));

  router.post('/api/content-components/:id/lifecycle',async(req,res,params)=>guarded(async()=>{
    const me=await currentUser(req);assertStage3Admin(me);const componentId=strictId(params.id,'组件 id');
    const body=await readJson(req,STAGE3_LIMITS.requestBodyBytes);
    rejectServerDerived(body);
    assertExactFields(body,['action','reason'],['action']);
    const action=String(body.action||'').trim();
    if(!['retire','reactivate'].includes(action))throw badRequest('action 必须是 retire 或 reactivate');
    const eventType=action==='retire'?'retired':'reactivated',reason=cleanText(body.reason,STAGE3_LIMITS.purposeChars,'原因'),key=requireIdempotency(req);
    const outcome=await tx(client=>withIdempotency(client,{aggregateKey:`component:${componentId}`,action:'lifecycle',key,
      request:{action,reason},actorId:me.id},async()=>{const {rows}=await client.query(`INSERT INTO content_component_lifecycle_events(
        component_id,event_type,reason,actor_id,actor_role)VALUES($1,$2,$3,$4,'admin')RETURNING *`,[componentId,eventType,reason,me.id]);
        return {responseKind:'component_lifecycle',responseId:Number(rows[0].id),status:201};}));
    sendJson(res,idempotentStatus(outcome),await loadComponent(componentId));
  }));

  scheduleAssessmentRecovery(0);
}

async function loadComparisonDetail(comparisonId) {
  const {rows:comparisons}=await query('SELECT * FROM sample_comparisons WHERE id=$1',[comparisonId]);
  if(!comparisons[0])throw notFound('比较项目不存在');
  const {rows:scopes}=await query(`SELECT s.*,(SELECT count(*) FROM sample_comparison_scope_members m WHERE m.scope_id=s.id)member_count
    FROM sample_comparison_scopes s WHERE comparison_id=$1 AND status='complete' ORDER BY revision DESC,id DESC`,[comparisonId]);
  const {rows:assessments}=await query(`SELECT a.*,
    EXISTS(SELECT 1 FROM sample_comparison_assessment_selections sel WHERE sel.assessment_id=a.id
      AND sel.id=(SELECT max(id)FROM sample_comparison_assessment_selections WHERE comparison_id=$1 AND target=a.target))is_current
    FROM sample_comparison_assessments a WHERE comparison_id=$1 ORDER BY target,revision DESC,id DESC`,[comparisonId]);
  const currents={},counts=Object.fromEntries(ASSESSMENT_TARGETS.map(target=>[target,0]));
  for(const row of assessments){counts[row.target]=(counts[row.target]||0)+1;if(row.is_current)currents[row.target]=assessmentListDto(row);}
  const c=comparisons[0];return {id:Number(c.id),title:c.title,purpose:c.purpose,createdBy:c.created_by==null?null:Number(c.created_by),
    createdAt:c.created_at,scopes:scopes.map(row=>({id:Number(row.id),revision:Number(row.revision),topicBasis:row.topic_basis,
      purpose:row.purpose,memberCount:Number(row.member_count),createdAt:row.created_at,completedAt:row.completed_at})),
    currentAssessments:currents,assessmentCounts:counts,targets:ASSESSMENT_TARGETS};
}

function relationDto(row,viewpointSampleId=null,evidence=[],events=[],viewer=null){
  const type=row.relation_type;const subject=Number(row.subject_sample_id),object=Number(row.object_sample_id);
  const direction=type==='variant'?'variant':viewpointSampleId==null?null:(subject===viewpointSampleId?'outgoing':'incoming');
  const labels={citation:'引用',imitation:'模仿',evolution:'演化自',variant:'互为变体'};
  const proposedBy=row.proposed_by==null?null:Number(row.proposed_by),state=row.current_state;
  const reviewer=viewer&&['reviewer','admin'].includes(viewer.role);
  const ownPending=viewer&&state==='proposed'&&proposedBy===Number(viewer.id);
  return {id:Number(row.id),relationType:type,state:row.current_state,direction,subject:{sampleId:subject,
    analysisVersionId:Number(row.subject_analysis_version_id),title:row.subject_title},object:{sampleId:object,
    analysisVersionId:Number(row.object_analysis_version_id),title:row.object_title},rationale:row.rationale,
    text:type==='variant'?`${row.subject_title||subject} 与 ${row.object_title||object} ${labels[type]}`:
      `${row.subject_title||subject} ${labels[type]} ${row.object_title||object}`,
    proposedBy,createdBy:proposedBy,evidenceCount:evidence.length,hasVerifiedEvidence:evidence.length>0,evidence,
    permissions:{canAddEvidence:!!viewer,canConfirm:!!(reviewer&&evidence.length&&['proposed','withdrawn'].includes(state)),
      canReject:!!(reviewer&&state==='proposed'),canWithdraw:!!(ownPending||(reviewer&&['proposed','confirmed'].includes(state))),
      canSupersede:!!(reviewer&&!['rejected','superseded'].includes(state))},
    latestEvent:events.at(-1)||null,events,createdAt:row.created_at};
}

async function loadRelation(relationId,viewer=null){
  const {rows}=await query(`SELECT r.*,ss.title subject_title,os.title object_title FROM sample_relations r
    JOIN samples ss ON ss.id=r.subject_sample_id JOIN samples os ON os.id=r.object_sample_id WHERE r.id=$1`,[relationId]);
  if(!rows[0])throw notFound('关系不存在');return relationDto(rows[0],null,[],[],viewer);
}

async function listComponents(url,reusable){
  const {page,pageSize,offset}=parsePagination(url);const q=cleanText(url.searchParams.get('q'),200,'q')||null;
  const dimensionKey=url.searchParams.get('dimensionKey')?assertDimension(url.searchParams.get('dimensionKey')):null;
  const source=url.searchParams.get('source')||null;if(source&&!['manual','ai'].includes(source))throw badRequest('source 不合法');
  const state=url.searchParams.get('state')||null;if(state&&!['draft','submitted','approved','changes_requested','retired'].includes(state))throw badRequest('state 不合法');
  const rawTags=url.searchParams.getAll('tagIds').flatMap(value=>value.split(',')).filter(Boolean);
  const tagIds=[...new Set(rawTags.map(value=>strictId(value,'tagIds')))];
  const tags=tagIds.length?(await query('SELECT id,kind FROM tags WHERE id=ANY($1::bigint[])',[tagIds])).rows:[];
  if(tags.length!==tagIds.length)throw badRequest('tagIds 包含不存在的标签');
  const groups=new Map();for(const tag of tags){if(!groups.has(tag.kind))groups.set(tag.kind,[]);groups.get(tag.kind).push(Number(tag.id));}
  const args=[q,dimensionKey,source,state];const tagClauses=[];
  for(const ids of groups.values()){args.push(ids);tagClauses.push(`EXISTS(SELECT 1 FROM content_component_revision_tags rt
    WHERE rt.revision_id=r.id AND rt.tag_id=ANY($${args.length}::bigint[]))`);}
  const base=reusable?`FROM content_components c JOIN LATERAL(
      SELECT r0.* FROM content_component_selections s JOIN content_component_revisions r0 ON r0.id=s.revision_id
      WHERE s.component_id=c.id ORDER BY s.id DESC LIMIT 1)r ON true
    WHERE c.lifecycle_state='active' AND r.state='approved'`:
    `FROM content_components c JOIN LATERAL(SELECT r0.* FROM content_component_revisions r0
      WHERE r0.component_id=c.id ORDER BY r0.revision DESC,r0.id DESC LIMIT 1)r ON true WHERE true`;
  let where=` AND($1::text IS NULL OR c.name ILIKE '%'||$1||'%' OR r.name ILIKE '%'||$1||'%' OR r.pattern_text ILIKE '%'||$1||'%')
    AND($2::text IS NULL OR r.dimension_key=$2)AND($3::text IS NULL OR r.origin=$3)
    AND($4::text IS NULL OR CASE WHEN c.lifecycle_state='retired'THEN'retired'ELSE r.state END=$4)`;
  if(tagClauses.length)where+=` AND ${tagClauses.join(' AND ')}`;
  args.push(pageSize,offset);const limitParam=args.length-1,offsetParam=args.length;
  const select=`SELECT c.id,c.name component_name,c.lifecycle_state,r.id revision_id,r.revision,r.dimension_key,
    r.state revision_state,r.origin,r.name revision_name,r.pattern_text,r.function_text,r.applicability,r.limitations,r.do_not_copy,r.created_at revision_created_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'name',t.name)ORDER BY t.kind,t.sort,t.id)
      FROM content_component_revision_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.revision_id=r.id),'[]'::jsonb)tags`;
  const [{rows},{rows:counts}]=await Promise.all([
    query(`${select} ${base}${where} ORDER BY c.id DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,args),
    query(`SELECT count(*)count ${base}${where}`,args.slice(0,-2)),
  ]);
  return {items:rows.map(reusable?reusableComponentDto:componentListDto),total:Number(counts[0].count),page,pageSize,
    filterSemantics:{state:'displayed_revision_latest_decision_lifecycle_retired_wins',source:'displayed_revision_origin',tags:'within_kind_or_across_kind_and'}};
}
