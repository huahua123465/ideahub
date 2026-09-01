import { randomUUID } from 'node:crypto';

import { query, tx } from '../db/index.mjs';
import { currentUser } from '../lib/auth.mjs';
import { activeProvider } from '../lib/ai-provider.mjs';
import { sampleListItem } from '../lib/sample-archive.mjs';
import {
  ANALYSIS_DIMENSIONS,
  ANALYSIS_TARGETS,
  RESEARCH_PROMPT_VERSION,
  RESEARCH_SCHEMA_VERSION,
  buildEvidenceManifest,
  cleanText,
  effectiveElement,
  normalizeDecision,
  normalizeManualElements,
  recordMetricSnapshot,
  requestAssetVisionEvidence,
  requestAiAnalysis,
  requestAiEvaluation,
  analysisFailureTransition,
  safeAnalysisError,
  sha256,
  stableJson,
} from '../lib/sample-research.mjs';
import { HttpError, badRequest, conflict, notFound, qInt, readJson, sendJson } from '../lib/http.mjs';

const DIMENSION_KEYS = new Set(ANALYSIS_DIMENSIONS.map(item => item.key));
const TARGET_KEYS = new Set(ANALYSIS_TARGETS.map(item => item.key));
const ANALYSIS_SOURCES = new Set(['ai','manual','legacy']);
const EVIDENCE_KIND_DB = Object.freeze({
  body:'body', ocr:'ocr', video_transcript:'transcript', audio_transcript:'transcript',
  comment:'comment', metadata:'metadata', bgm_metadata:'metadata',
  asset_metadata:'asset', image_vision:'asset',
});

let analysisQueue = Promise.resolve();
const analysisRetryTimers=new Map();
const enqueuedAnalysisJobs=new Set();

export function literalLikePattern(value) {
  return `%${String(value || '').replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

function strictId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${label} 不合法`);
  return id;
}

function cleanIdempotency(value, fallback) {
  const key = cleanText(value, 160) || fallback;
  if (!key || key.length > 160) throw badRequest('Idempotency-Key 不合法');
  return key;
}

function rowJob(row) {
  if (!row) return null;
  return {
    id:Number(row.id), sampleId:Number(row.sample_id), sourceCaptureId:Number(row.source_capture_id),
    idempotencyKey:row.idempotency_key, inputSha256:row.input_sha256, status:row.status,
    attempts:Number(row.attempts), maxAttempts:Number(row.max_attempts),
    selectOnSuccess:Boolean(row.select_on_success), provider:row.provider, modelName:row.model_name,
    requestedBy:row.requested_by == null ? null : Number(row.requested_by),
    startedAt:row.started_at, finishedAt:row.finished_at,
    errorCode:row.error_code, errorMessage:row.error_message,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function rowVersion(row) {
  if (!row) return null;
  return {
    id:Number(row.id), sampleId:Number(row.sample_id), jobId:row.job_id == null ? null : Number(row.job_id),
    sourceCaptureId:Number(row.source_capture_id), revision:Number(row.revision), source:row.source,
    status:row.status, inputSha256:row.input_sha256, schemaVersion:row.schema_version,
    promptVersion:row.prompt_version, modelProvider:row.model_provider, modelName:row.model_name,
    modelVersion:row.model_version, manifestSha256:row.manifest_sha256,
    createdBy:row.created_by == null ? null : Number(row.created_by),
    createdAt:row.created_at, completedAt:row.completed_at,
  };
}

function rowEvaluation(row) {
  return {
    id:Number(row.id), sampleId:Number(row.sample_id),
    analysisVersionId:row.analysis_version_id == null ? null : Number(row.analysis_version_id),
    target:row.target, source:row.source, revision:Number(row.revision), summary:row.summary,
    strengths:row.strengths || [], weaknesses:row.weaknesses || [], worthLearning:row.worth_learning || [],
    avoidCopying:row.avoid_copying || [], effectHypotheses:row.effect_hypotheses || [],
    evidenceSourceIds:row.evidence_source_ids || [], confidence:row.confidence == null ? null : Number(row.confidence),
    inputSha256:row.input_sha256, promptVersion:row.prompt_version,
    modelProvider:row.model_provider, modelName:row.model_name,
    createdBy:row.created_by == null ? null : Number(row.created_by), createdAt:row.created_at,
  };
}

function rowMetric(row) {
  const observedAt = row.observed_at;
  const saves = row.saves == null ? null : Number(row.saves);
  return {
    id:Number(row.id), sampleId:Number(row.sample_id),
    captureId:row.capture_id == null ? null : Number(row.capture_id), snapshotKey:row.snapshot_key,
    observedAt, capturedAt:observedAt, likes:row.likes == null ? null : Number(row.likes),
    saves, collects:saves, comments:row.comments == null ? null : Number(row.comments),
    shares:row.shares == null ? null : Number(row.shares), views:row.views == null ? null : Number(row.views),
    rawMetrics:row.raw_metrics || {}, parseWarnings:row.parse_warnings || [], createdAt:row.created_at,
  };
}

async function ensureSample(sampleId, db = { query }) {
  const { rows } = await db.query('SELECT * FROM samples WHERE id=$1 AND deleted_at IS NULL', [sampleId]);
  if (!rows[0]) throw notFound('样本不存在或已删除');
  return rows[0];
}

async function loadResearchSource(sampleId, captureId = null, db = { query }) {
  const sample = await ensureSample(sampleId, db);
  const { rows:captures } = await db.query(`
    SELECT * FROM sample_captures WHERE sample_id=$1
      ${captureId ? 'AND id=$2' : ''}
     ORDER BY captured_at DESC,id DESC LIMIT 1`, captureId ? [sampleId,captureId] : [sampleId]);
  if (!captures[0]) throw notFound(captureId ? '采集版本不属于该样本' : '样本还没有可分析的采集版本');
  const { rows:assets } = await db.query(
    'SELECT * FROM sample_assets WHERE sample_id=$1 AND deleted_at IS NULL ORDER BY id', [sampleId]);
  return { sample, capture:captures[0], assets };
}

async function manifestWithRuntimeVision(source,provider,{preserveInputSha=false,supplemental=[]}={}){
  const base=buildEvidenceManifest({...source,supplementalVisionEvidence:supplemental});
  const pinnedIds=new Set(base.sources.filter(item=>item.sourceKind==='asset_metadata'&&item.assetId!=null)
    .map(item=>Number(item.assetId)));
  const coveredIds=new Set(base.sources.filter(item=>item.sourceKind==='image_vision'&&item.assetId!=null)
    .map(item=>Number(item.assetId)));
  const missing=(source.assets||[]).filter(asset=>pinnedIds.has(Number(asset.id))&&!coveredIds.has(Number(asset.id)));
  if(!missing.length)return base;
  const generated=await requestAssetVisionEvidence({assets:missing,provider});
  if(!generated.length)return base;
  const enriched=buildEvidenceManifest({...source,supplementalVisionEvidence:generated});
  if(preserveInputSha)enriched.inputSha256=base.inputSha256;
  return enriched;
}

function carriedRuntimeVision(version){
  const byLocator=new Map();
  for(const element of version?.elements||[])for(const evidence of element.evidence||[]){
    if(evidence.kind!=='image_vision'||!String(evidence.locator||'').startsWith('runtime.asset_vision['))continue;
    if(byLocator.has(evidence.locator))continue;
    let observation;try{observation=JSON.parse(evidence.quoteText||'{}');}catch{continue;}
    if(!observation?.description)continue;
    byLocator.set(evidence.locator,{...observation,source_kind:'image_vision',asset_kind:'image',
      asset_id:evidence.assetId??null});
  }
  return [...byLocator.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,item])=>item);
}

async function activeDimensionTags(db = { query }) {
  const { rows } = await db.query(
    'SELECT id,kind,name,sort FROM tags WHERE active AND kind=ANY($1::text[]) ORDER BY kind,sort,id',
    [[...DIMENSION_KEYS]]);
  return rows.map(row => ({ id:Number(row.id), kind:row.kind, name:row.name, sort:Number(row.sort) }));
}

async function insertEvidenceSources(client, version, manifest) {
  for (const source of manifest.sources) {
    const sourceKind = EVIDENCE_KIND_DB[source.sourceKind];
    if (!sourceKind) continue;
    const locator = {
      pointer:source.locator, semanticKind:source.sourceKind,
      ...(source.jsonPath ? { jsonPath:source.jsonPath } : {}),
      ...(source.commentRef ? { commentRef:source.commentRef } : {}),
      ...(source.timeStartMs != null ? { timeStartMs:source.timeStartMs, timeEndMs:source.timeEndMs } : {}),
    };
    await client.query(`
      INSERT INTO sample_evidence_sources(
        version_id,sample_id,source_capture_id,asset_id,source_id,source_kind,locator,
        content_sha256,content_length,display_label
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`, [
      version.id,version.sample_id,version.source_capture_id,source.assetId,source.sourceId,sourceKind,
      JSON.stringify(locator),source.contentSha256,source.contentLength,source.displayLabel,
    ]);
  }
}

async function nextRevision(client, sampleId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sample-analysis:${sampleId}`]);
  const { rows } = await client.query(
    'SELECT COALESCE(max(revision),0)+1 AS revision FROM sample_analysis_versions WHERE sample_id=$1', [sampleId]);
  return Number(rows[0].revision);
}

/** Shared by AI jobs, manual entry, and the idempotent legacy migration. */
export async function persistAnalysisVersion(client, {
  sampleId, sourceCaptureId, source, elements, manifest, inputSha256, createdBy = null,
  jobId = null, provider = null, modelName = null, modelVersion = null,
  select = true, selectionReason = 'explicit', promptVersion = RESEARCH_PROMPT_VERSION,
}) {
  if (!ANALYSIS_SOURCES.has(source)) throw badRequest('分析来源不合法');
  if (!Array.isArray(elements) || elements.length !== 15) throw badRequest('分析版本必须包含固定15个维度');
  const keys = new Set(elements.map(item => item.dimensionKey));
  if (keys.size !== 15 || [...keys].some(key => !DIMENSION_KEYS.has(key))) {
    throw badRequest('分析版本必须恰好包含15个不同维度');
  }
  const revision = await nextRevision(client, sampleId);
  const { rows:versions } = await client.query(`
    INSERT INTO sample_analysis_versions(
      sample_id,job_id,source_capture_id,revision,source,status,input_sha256,schema_version,
      prompt_version,model_provider,model_name,model_version,manifest_sha256,created_by
    ) VALUES($1,$2,$3,$4,$5,'building',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [
    sampleId,jobId,sourceCaptureId,revision,source,inputSha256,RESEARCH_SCHEMA_VERSION,
    promptVersion,provider,modelName,modelVersion,manifest?.manifestSha256 || sha256([]),createdBy,
  ]);
  const version = versions[0];
  await insertEvidenceSources(client, version, manifest || { sources:[] });
  const manifestIds = new Set((manifest?.sources || []).map(item => item.sourceId));
  const deferredManualTags = [];
  for (const element of elements) {
    const { rows } = await client.query(`
      INSERT INTO sample_analysis_elements(
        version_id,dimension_key,state,value_json,function_text,confidence,evidence_strength,
        applicability,limitations
      ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *`, [
      version.id,element.dimensionKey,element.state,
      element.valueJson == null ? null : JSON.stringify(element.valueJson),
      element.functionText,source === 'manual' ? null : element.confidence,
      element.evidenceStrength === 'moderate' ? 'medium' : (element.evidenceStrength || 'none'),
      element.applicability,element.limitations,
    ]);
    const elementRow = rows[0];
    const evidence = Array.isArray(element.evidence) ? element.evidence
      : (element.evidenceSourceIds || []).filter(id => manifestIds.has(id)).map(id => ({ sourceId:id }));
    for (const item of evidence) {
      if (!manifestIds.has(item.sourceId)) continue;
      const source = manifest.sources.find(candidate => candidate.sourceId === item.sourceId);
      const quote = item.quoteText || source?.content?.slice(0, 800) || '';
      if (!quote) continue;
      const hasTimes = item.timeStartMs != null && item.timeEndMs != null
        || source?.timeStartMs != null && source?.timeEndMs != null;
      await client.query(`
        INSERT INTO sample_element_evidence(
          version_id,element_id,source_id,verification_status,quote_text,quote_sha256,
          start_offset,end_offset,time_start_ms,time_end_ms,json_path,comment_ref
        ) VALUES($1,$2,$3,'verified',$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING`, [version.id,elementRow.id,item.sourceId,quote,sha256(quote),
        item.startOffset ?? 0,item.endOffset ?? quote.length,
        hasTimes ? (item.timeStartMs ?? source?.timeStartMs) : null,
        hasTimes ? (item.timeEndMs ?? source?.timeEndMs) : null,
        item.jsonPath ?? source?.jsonPath,item.commentRef ?? source?.commentRef]);
    }
    const tagRecords = Array.isArray(element.tagRecords) && element.tagRecords.length
      ? element.tagRecords : [...new Set(element.tagIds || [])].map(tagId => ({
        tagId,origin:source,confidence:source === 'manual' ? null : element.confidence,
      }));
    const seenTags = new Set();
    for (const tag of tagRecords) {
      const tagId=Number(tag.tagId),origin=ANALYSIS_SOURCES.has(tag.origin)?tag.origin:source;
      const identity=`${tagId}:${origin}`;
      if(!Number.isSafeInteger(tagId)||seenTags.has(identity))continue;
      seenTags.add(identity);
      if (origin === 'manual') deferredManualTags.push({ elementId:elementRow.id,
        dimensionKey:element.dimensionKey,tagId,createdBy:tag.createdBy ?? createdBy });
      else await client.query(`
          INSERT INTO sample_element_tags(
            version_id,element_id,dimension_key,tag_id,origin,confidence,created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [
        version.id,elementRow.id,element.dimensionKey,tagId,origin,
        tag.confidence ?? element.confidence,tag.createdBy ?? createdBy]);
    }
  }
  const { rows:completed } = await client.query(
    "UPDATE sample_analysis_versions SET status='complete',completed_at=now() WHERE id=$1 RETURNING *", [version.id]);
  for (const tag of deferredManualTags) {
    await client.query(`INSERT INTO sample_element_tags(
      version_id,element_id,dimension_key,tag_id,origin,confidence,created_by
    ) VALUES($1,$2,$3,$4,'manual',NULL,$5) ON CONFLICT DO NOTHING`, [
    version.id,tag.elementId,tag.dimensionKey,tag.tagId,tag.createdBy]);
  }
  if (select) {
    await client.query(`INSERT INTO sample_analysis_selections(sample_id,version_id,reason,selected_by)
      VALUES($1,$2,$3,$4)`, [sampleId,version.id,selectionReason,createdBy]);
  }
  return completed[0];
}

async function processAnalysisJob(jobId) {
  const { rows:claimed } = await query(`
    UPDATE sample_analysis_jobs
       SET status='running',attempts=attempts+1,started_at=now(),finished_at=NULL,
           error_code=NULL,error_message=NULL,updated_at=now()
     WHERE id=$1 AND status='queued' AND attempts<max_attempts RETURNING *`, [jobId]);
  const job = claimed[0];
  if (!job) return;
  try {
    const source = await loadResearchSource(Number(job.sample_id), Number(job.source_capture_id));
    const baseManifest = buildEvidenceManifest(source);
    if (baseManifest.inputSha256 !== job.input_sha256) {
      const error = new Error('analysis input changed'); error.code = 'INPUT_CHANGED'; throw error;
    }
    const provider=await activeProvider();
    const manifest=await manifestWithRuntimeVision(source,provider,{preserveInputSha:true});
    const tags = await activeDimensionTags();
    const result = await requestAiAnalysis({ manifest, activeTags:tags,provider });
    const version = await tx(async client => {
      const {rows:owned}=await client.query(`SELECT id FROM sample_analysis_jobs
        WHERE id=$1 AND status='running' AND attempts=$2 FOR UPDATE`,[job.id,job.attempts]);
      if(!owned[0]){const error=new Error('analysis attempt is no longer current');error.code='JOB_ATTEMPT_STALE';throw error;}
      const saved = await persistAnalysisVersion(client, {
        sampleId:Number(job.sample_id), sourceCaptureId:Number(job.source_capture_id), source:'ai',
        elements:result.elements, manifest, inputSha256:manifest.inputSha256,
        createdBy:job.requested_by == null ? null : Number(job.requested_by), jobId:Number(job.id),
        provider:result.provider, modelName:result.model, modelVersion:result.modelVersion, select:false,
        selectionReason:'run_success',
      });
      const {rowCount}=await client.query(`UPDATE sample_analysis_jobs SET status='succeeded',provider=$2,model_name=$3,
        finished_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND attempts=$4`,[job.id,result.provider,result.model,job.attempts]);
      if(rowCount!==1){const error=new Error('analysis attempt lost ownership');error.code='JOB_ATTEMPT_STALE';throw error;}
      if (job.select_on_success) await client.query(`
        INSERT INTO sample_analysis_selections(sample_id,version_id,reason,selected_by)
        VALUES($1,$2,'run_success',$3)`, [job.sample_id,saved.id,job.requested_by]);
      return saved;
    });
    return version;
  } catch (error) {
    const safe = safeAnalysisError(error);
    const transition=analysisFailureTransition({code:safe.code,attempts:job.attempts,maxAttempts:job.max_attempts,retryAfterMs:error?.retryAfterMs});
    let rowCount;try{({rowCount}=await query(`UPDATE sample_analysis_jobs SET status=$4,error_code=$2,error_message=$3,
      started_at=CASE WHEN $4='queued' THEN NULL ELSE started_at END,
      finished_at=CASE WHEN $4='failed' THEN now() ELSE NULL END,updated_at=now()
      WHERE id=$1 AND status='running' AND attempts=$5`,[job.id,safe.code,safe.message,transition.status,job.attempts]));}
    catch(writeError){writeError.analysisClaimedAttempt=Number(job.attempts);throw writeError;}
    if(rowCount&&transition.retry)scheduleAnalysisRetry(Number(job.id),transition.delayMs);
    return null;
  }
}

function enqueueAnalysisJob(id) {
  const key=Number(id);
  if(enqueuedAnalysisJobs.has(key)||analysisRetryTimers.has(key))return false;
  enqueuedAnalysisJobs.add(key);
  analysisQueue=analysisQueue.then(()=>processAnalysisJob(key)).catch(error=>{
    console.error('[sample-research] analysis queue failure:',error?.name||'Error');
    scheduleAnalysisWorkerRecovery(key,error?.analysisClaimedAttempt??null);
  }).finally(()=>enqueuedAnalysisJobs.delete(key));
  return true;
}
function scheduleAnalysisRetry(id,delayMs){
  const key=Number(id),existing=analysisRetryTimers.get(key);
  if(existing)clearTimeout(existing);
  const timer=setTimeout(()=>{analysisRetryTimers.delete(key);enqueueAnalysisJob(key);},delayMs);
  timer.unref?.();analysisRetryTimers.set(key,timer);
}
async function reconcileAnalysisWorkerFailure(id,claimedAttempt){
  if(claimedAttempt!=null)await query(`UPDATE sample_analysis_jobs SET
    status=CASE WHEN attempts<max_attempts THEN'queued'ELSE'failed'END,
    started_at=NULL,finished_at=CASE WHEN attempts<max_attempts THEN NULL ELSE now()END,
    error_code=CASE WHEN attempts<max_attempts THEN COALESCE(error_code,'WORKER_RECOVERY')ELSE'RETRY_EXHAUSTED'END,
    error_message=CASE WHEN attempts<max_attempts THEN COALESCE(error_message,'任务状态写回失败，已自动恢复')ELSE'分析重试次数已用完'END,
    updated_at=now() WHERE id=$1 AND status='running'AND attempts=$2`,[id,claimedAttempt]);
  const {rows}=await query('SELECT status,attempts,max_attempts FROM sample_analysis_jobs WHERE id=$1',[id]),row=rows[0];
  if(!row)return;
  if(row.status==='queued'&&Number(row.attempts)<Number(row.max_attempts))enqueueAnalysisJob(id);
  else if(row.status==='queued')await query(`UPDATE sample_analysis_jobs SET status='failed',
    error_code='RETRY_EXHAUSTED',error_message='分析重试次数已用完',finished_at=now(),updated_at=now()
    WHERE id=$1 AND status='queued'AND attempts>=max_attempts`,[id]);
}
function scheduleAnalysisWorkerRecovery(id,claimedAttempt=null,delayMs=3000){
  const key=Number(id);if(analysisRetryTimers.has(key))return;
  const timer=setTimeout(async()=>{
    analysisRetryTimers.delete(key);
    try{await reconcileAnalysisWorkerFailure(key,claimedAttempt);}
    catch{scheduleAnalysisWorkerRecovery(key,claimedAttempt,Math.min(30_000,delayMs*2));}
  },delayMs);
  timer.unref?.();analysisRetryTimers.set(key,timer);
}

export async function recoverAnalysisJobs() {
  await query(`UPDATE sample_analysis_jobs SET status='failed',error_code='PARTIAL_RESTARTED',
    error_message='单项拆解在服务重启时中断，请手动重试',finished_at=now(),updated_at=now()
    WHERE status IN('queued','running') AND idempotency_key LIKE 'partial:%'`);
  await query(`UPDATE sample_analysis_jobs SET status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'failed' END,
    error_code=CASE WHEN attempts<max_attempts THEN NULL ELSE 'RESTART_EXHAUSTED' END,
    error_message=CASE WHEN attempts<max_attempts THEN NULL ELSE '服务重启后重试次数已用完' END,
    started_at=NULL,finished_at=CASE WHEN attempts<max_attempts THEN NULL ELSE now() END,updated_at=now()
    WHERE status='running'`);
  await query(`UPDATE sample_analysis_jobs SET status='failed',error_code='RETRY_EXHAUSTED',
    error_message='分析重试次数已用完',finished_at=now(),updated_at=now()
    WHERE status='queued' AND attempts>=max_attempts`);
  const { rows } = await query("SELECT id FROM sample_analysis_jobs WHERE status='queued' ORDER BY created_at,id");
  rows.forEach(row => enqueueAnalysisJob(Number(row.id)));
  return rows.length;
}

async function loadVersionDetail(sampleId, versionId) {
  const { rows:versions } = await query(`
    SELECT v.*,s.current_analysis_version_id,
           (SELECT id FROM sample_captures WHERE sample_id=v.sample_id ORDER BY captured_at DESC,id DESC LIMIT 1) latest_capture_id
      FROM sample_analysis_versions v JOIN samples s ON s.id=v.sample_id AND s.deleted_at IS NULL
     WHERE v.id=$1 AND v.sample_id=$2 AND v.status='complete'`, [versionId,sampleId]);
  const version = versions[0];
  if (!version) throw notFound('分析版本不存在或不属于该样本');
  const [{ rows:elements }, { rows:evidence }, { rows:elementTags }] = await Promise.all([
    query(`SELECT e.*,d.id decision_id,d.decision,d.value_json decision_value_json,
                  d.function_text decision_function_text,d.applicability decision_applicability,
                  d.limitations decision_limitations,d.note decision_note,d.decided_by,d.created_at decision_created_at
             FROM sample_analysis_elements e
             LEFT JOIN LATERAL (SELECT * FROM sample_element_decisions WHERE element_id=e.id
               ORDER BY created_at DESC,id DESC LIMIT 1) d ON true
            WHERE e.version_id=$1 ORDER BY (SELECT ordinal FROM sample_analysis_dimensions WHERE dimension_key=e.dimension_key)`, [versionId]),
    query(`SELECT ee.*,es.source_kind,es.locator,es.display_label,es.content_sha256
      FROM sample_element_evidence ee JOIN sample_evidence_sources es
        ON es.version_id=ee.version_id AND es.source_id=ee.source_id
      WHERE ee.version_id=$1 ORDER BY ee.element_id,ee.id`, [versionId]),
    query(`SELECT et.*,t.name,t.kind FROM sample_element_tags et JOIN tags t ON t.id=et.tag_id
      WHERE et.version_id=$1 ORDER BY et.element_id,t.sort,t.id`, [versionId]),
  ]);
  const evidenceByElement = new Map();
  for (const item of evidence) {
    const key = Number(item.element_id);
    if (!evidenceByElement.has(key)) evidenceByElement.set(key, []);
    evidenceByElement.get(key).push({
      id:Number(item.id), sourceId:item.source_id, verificationStatus:item.verification_status,
      verified:item.verification_status==='verified', sourceType:item.display_label || item.source_kind,
      kind:item.locator?.semanticKind || item.source_kind,
      locator:item.locator?.pointer || item.locator?.jsonPath || null,
      assetId:item.asset_id==null?null:Number(item.asset_id),
      contentSha256:item.content_sha256,
      quoteText:item.quote_text, startOffset:item.start_offset, endOffset:item.end_offset,
      timeStartMs:item.time_start_ms == null ? null : Number(item.time_start_ms),
      timeEndMs:item.time_end_ms == null ? null : Number(item.time_end_ms),
      jsonPath:item.json_path, commentRef:item.comment_ref,
    });
  }
  const tagsByElement = new Map();
  for (const item of elementTags) {
    const key = Number(item.element_id);
    if (!tagsByElement.has(key)) tagsByElement.set(key, []);
    tagsByElement.get(key).push({ id:Number(item.tag_id), name:item.name, kind:item.kind,
      origin:item.origin, confidence:item.confidence == null ? null : Number(item.confidence) });
  }
  const current = Number(version.current_analysis_version_id) === Number(version.id);
  return {
    ...rowVersion(version), current,isCurrent:current,
    staleSource:Number(version.latest_capture_id) !== Number(version.source_capture_id),
    elements:elements.map(row => {
      const decision = row.decision_id ? {
        id:Number(row.decision_id), decision:row.decision, value_json:row.decision_value_json,
        function_text:row.decision_function_text, applicability:row.decision_applicability,
        limitations:row.decision_limitations, note:row.decision_note,
        decidedBy:row.decided_by == null ? null : Number(row.decided_by), createdAt:row.decision_created_at,
      } : null;
      const effective = effectiveElement(row, decision);
      return {
        id:Number(row.id), dimensionKey:row.dimension_key, state:row.state, value:row.value_json,
        functionText:row.function_text, confidence:row.confidence == null ? null : Number(row.confidence),
        evidenceStrength:row.evidence_strength, applicability:row.applicability, limitations:row.limitations,
        decision, effective, evidence:evidenceByElement.get(Number(row.id)) || [],
        tags:tagsByElement.get(Number(row.id)) || [], createdAt:row.created_at,
      };
    }),
  };
}

function stringList(value, maxItems = 50, maxLength = 600) {
  if (!Array.isArray(value)) return [];
  return value.map(item => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

export async function insertEvaluation(client, sampleId, body, userId, source = 'manual', aiMeta = {}) {
  const target = cleanText(body.target, 24);
  if (!TARGET_KEYS.has(target)) throw badRequest('评价目标不合法');
  const analysisVersionId = body.analysisVersionId == null ? null : strictId(body.analysisVersionId, '分析版本 id');
  const evidenceIds = [...new Set((body.evidenceSourceIds || []).map(value => cleanText(value, 120)).filter(Boolean))].slice(0, 100);
  if (evidenceIds.length && !analysisVersionId) {
    throw badRequest('评价引用证据时必须同时指定对应的分析版本');
  }
  if (analysisVersionId) {
    const { rows } = await client.query(
      "SELECT 1 FROM sample_analysis_versions WHERE id=$1 AND sample_id=$2 AND status='complete'", [analysisVersionId,sampleId]);
    if (!rows[0]) throw badRequest('评价引用的分析版本不属于该样本');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sample-evaluation:${sampleId}:${target}`]);
  const { rows:revisions } = await client.query(
    'SELECT COALESCE(max(revision),0)+1 revision FROM sample_evaluations WHERE sample_id=$1 AND target=$2', [sampleId,target]);
  if (analysisVersionId && evidenceIds.length) {
    const { rows } = await client.query(`SELECT source_id FROM sample_evidence_sources
      WHERE version_id=$1 AND source_id=ANY($2::text[])`, [analysisVersionId,evidenceIds]);
    if (rows.length !== evidenceIds.length) throw badRequest('评价引用了当前分析版本之外的证据');
  }
  const payload = {
    summary:cleanText(body.summary, 4_000) || null, strengths:stringList(body.strengths),
    weaknesses:stringList(body.weaknesses), worthLearning:stringList(body.worthLearning),
    avoidCopying:stringList(body.avoidCopying), effectHypotheses:stringList(body.effectHypotheses),
  };
  const { rows } = await client.query(`
    INSERT INTO sample_evaluations(
      sample_id,analysis_version_id,target,source,revision,summary,strengths,weaknesses,
      worth_learning,avoid_copying,effect_hypotheses,evidence_source_ids,confidence,input_sha256,
      prompt_version,model_provider,model_name,created_by
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::text[],
      $13,$14,$15,$16,$17,$18) RETURNING *`, [sampleId,analysisVersionId,target,source,
    Number(revisions[0].revision),payload.summary,JSON.stringify(payload.strengths),JSON.stringify(payload.weaknesses),
    JSON.stringify(payload.worthLearning),JSON.stringify(payload.avoidCopying),JSON.stringify(payload.effectHypotheses),
    evidenceIds,source === 'manual' ? null : aiMeta.confidence,source === 'manual' ? null : aiMeta.inputSha256,
    source === 'manual' ? null : aiMeta.promptVersion,source === 'manual' ? null : aiMeta.provider,
    source === 'manual' ? null : aiMeta.modelName,userId]);
  return rows[0];
}

export async function combinationSearch(body = {}) {
  const requestedPage=body.page==null?1:Number(body.page);
  const requestedPageSize=body.pageSize==null?24:Number(body.pageSize);
  if(!Number.isSafeInteger(requestedPage)||requestedPage<1)throw badRequest('page 必须是正整数');
  if(!Number.isSafeInteger(requestedPageSize)||requestedPageSize<1)throw badRequest('pageSize 必须是正整数');
  const page=requestedPage;const pageSize=Math.min(100,requestedPageSize);
  const where = ['s.deleted_at IS NULL'];
  const args = [];
  const bind = value => { args.push(value); return `$${args.length}`; };
  const search = cleanText(body.q, 200);
  if (search) {
    const p = bind(literalLikePattern(search));
    where.push(`(s.title ILIKE ${p} ESCAPE '\\' OR s.body_text ILIKE ${p} ESCAPE '\\' OR s.account_name ILIKE ${p} ESCAPE '\\' OR s.platform_content_id ILIKE ${p} ESCAPE '\\')`);
  }
  const platform = cleanText(body.platform,80).toLowerCase();
  const archiveStatus = cleanText(body.archiveStatus,40);
  if (platform) where.push(`s.platform=${bind(platform)}`);
  if (archiveStatus) where.push(`s.archive_status=${bind(archiveStatus)}`);
  if(body.tagIds!=null&&!Array.isArray(body.tagIds))throw badRequest('tagIds 必须是数组');
  const rawTagIds=body.tagIds||[];
  if(rawTagIds.some(value=>!Number.isSafeInteger(Number(value))||Number(value)<=0))throw badRequest('tagIds 含有非法ID');
  const tagIds = [...new Set(rawTagIds.map(Number))].slice(0, 100);
  let selectedTags = [];
  if (tagIds.length) {
    const { rows } = await query('SELECT id,kind,name FROM tags WHERE active AND id=ANY($1::bigint[])', [tagIds]);
    if (rows.length !== tagIds.length) throw badRequest('筛选条件含有不存在或停用的标签');
    selectedTags = rows.map(row => ({ id:Number(row.id), kind:row.kind, name:row.name }));
    const grouped = new Map();
    for (const item of selectedTags) {
      if (!grouped.has(item.kind)) grouped.set(item.kind, []);
      grouped.get(item.kind).push(item);
    }
    for (const group of grouped.values()) {
      const selected = bind(group.map(item => item.id));
      where.push(`EXISTS(
        SELECT 1 FROM entity_tags et WHERE et.entity='sample' AND et.entity_id=s.id
          AND et.tag_id=ANY(${selected}::bigint[])
        UNION ALL
        SELECT 1 FROM sample_element_tags setag
          JOIN sample_analysis_elements se ON se.id=setag.element_id AND se.version_id=s.current_analysis_version_id
          LEFT JOIN LATERAL(SELECT decision FROM sample_element_decisions WHERE element_id=se.id
            ORDER BY created_at DESC,id DESC LIMIT 1) sd ON true
         WHERE setag.version_id=s.current_analysis_version_id
           AND setag.tag_id=ANY(${selected}::bigint[]) AND COALESCE(sd.decision,'')<>'rejected'
           AND (se.state='value' OR sd.decision='edited')
      )`);
    }
  }
  if(body.elements!=null&&!Array.isArray(body.elements))throw badRequest('elements 必须是数组');
  const conditions = Array.isArray(body.elements) ? body.elements.slice(0, 15) : [];
  if (Array.isArray(body.elements) && body.elements.length > 15) throw badRequest('一次最多组合15个元素条件');
  const normalizedConditions = [];
  for (const raw of conditions) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('元素筛选条件格式不正确');
    const dimensionKey = cleanText(raw.dimensionKey, 80);
    if (!DIMENSION_KEYS.has(dimensionKey)) throw badRequest('存在未知拆解维度');
    if(raw.facets!=null&&!Array.isArray(raw.facets))throw badRequest('facets 必须是数组');
    const terms = [...new Set([cleanText(raw.query, 200), ...(raw.facets || []).map(value => cleanText(value, 200))]
      .filter(Boolean))].slice(0, 20);
    const facetMode = raw.facetMode === 'all' ? 'all' : 'any';
    const dimension = bind(dimensionKey);
    const valueSql = `CASE WHEN d.decision='edited' THEN d.value_json
      WHEN d.decision='rejected' THEN NULL ELSE e.value_json END`;
    const termSql = terms.map(term => `${valueSql}::text ILIKE ${bind(literalLikePattern(term))} ESCAPE '\\'`);
    where.push(`EXISTS(
      SELECT 1 FROM sample_analysis_elements e
      LEFT JOIN LATERAL(SELECT decision,value_json FROM sample_element_decisions
        WHERE element_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1)d ON true
      WHERE e.version_id=s.current_analysis_version_id AND e.dimension_key=${dimension}
        AND (e.state='value' OR d.decision='edited') AND COALESCE(d.decision,'')<>'rejected'
        ${termSql.length ? `AND (${termSql.join(facetMode === 'all' ? ' AND ' : ' OR ')})` : ''}
    )`);
    normalizedConditions.push({ dimensionKey, terms, facetMode });
  }
  const clause = where.join(' AND ');
  const { rows:counts } = await query(`SELECT count(*) count,
    count(*) FILTER(WHERE s.archive_status='complete') complete,
    count(*) FILTER(WHERE s.archive_status<>'complete') incomplete
    FROM samples s WHERE ${clause}`, args);
  const limit = bind(pageSize); const offset = bind((page - 1) * pageSize);
  const { rows } = await query(`
    SELECT s.id,s.canonical_key,s.platform,s.platform_content_id,s.source_url,s.title,
           left(s.body_text,280) body_excerpt,s.content_type,s.account_name,s.account_handle,
           s.published_at,s.metrics,s.archive_status,s.completeness_score,s.missing_fields,
           s.current_analysis_version_id,s.created_at,s.updated_at,
           (SELECT count(*) FROM sample_captures c WHERE c.sample_id=s.id) capture_count,
           (SELECT count(*) FROM sample_assets a WHERE a.sample_id=s.id AND a.deleted_at IS NULL) asset_count,
           (SELECT a.id FROM sample_assets a WHERE a.sample_id=s.id AND a.kind IN('cover','image')
             AND a.deleted_at IS NULL ORDER BY CASE WHEN a.kind='cover' THEN 0 ELSE 1 END,a.id LIMIT 1) cover_asset_id
      FROM samples s WHERE ${clause}
     ORDER BY COALESCE(s.published_at,s.created_at) DESC,s.id DESC LIMIT ${limit} OFFSET ${offset}`, args);
  const ids = rows.map(row => Number(row.id));
  const reasons = new Map(ids.map(id => [id, { matchedTags:[], matchedElements:[] }]));
  const reviewStats = new Map(ids.map(id => [id,{ confirmedElementCount:0,decisionCount:0,rejectedElementCount:0 }]));
  if (ids.length) {
    const { rows:stats } = await query(`SELECT s.id,
      count(*) FILTER(WHERE d.decision IN('confirmed','edited'))::int confirmed_count,
      count(*) FILTER(WHERE d.decision IS NOT NULL)::int decision_count,
      count(*) FILTER(WHERE d.decision='rejected')::int rejected_count
      FROM samples s
      LEFT JOIN sample_analysis_elements e ON e.version_id=s.current_analysis_version_id
      LEFT JOIN LATERAL(SELECT decision FROM sample_element_decisions WHERE element_id=e.id
        ORDER BY created_at DESC,id DESC LIMIT 1)d ON true
      WHERE s.id=ANY($1::bigint[]) GROUP BY s.id`,[ids]);
    stats.forEach(row=>reviewStats.set(Number(row.id),{
      confirmedElementCount:Number(row.confirmed_count||0),decisionCount:Number(row.decision_count||0),
      rejectedElementCount:Number(row.rejected_count||0),
    }));
  }
  if (ids.length && selectedTags.length) {
    const { rows:matches } = await query(`
      SELECT et.entity_id,t.id,t.kind,t.name FROM entity_tags et
        JOIN tags t ON t.id=et.tag_id WHERE et.entity='sample' AND et.entity_id=ANY($1::bigint[])
        AND et.tag_id=ANY($2::bigint[])
      UNION
      SELECT s.id entity_id,t.id,t.kind,t.name FROM samples s
        JOIN sample_element_tags setag ON setag.version_id=s.current_analysis_version_id
        JOIN sample_analysis_elements se ON se.id=setag.element_id
        JOIN tags t ON t.id=setag.tag_id
        LEFT JOIN LATERAL(SELECT decision FROM sample_element_decisions WHERE element_id=se.id
          ORDER BY created_at DESC,id DESC LIMIT 1) sd ON true
       WHERE s.id=ANY($1::bigint[]) AND setag.tag_id=ANY($2::bigint[])
         AND COALESCE(sd.decision,'')<>'rejected' AND (se.state='value' OR sd.decision='edited')`, [ids,tagIds]);
    matches.forEach(item => reasons.get(Number(item.entity_id))?.matchedTags.push(
      { id:Number(item.id), kind:item.kind, name:item.name }));
  }
  if (ids.length && normalizedConditions.length) {
    const { rows:matches } = await query(`SELECT s.id sample_id,e.dimension_key,
      CASE WHEN d.decision='edited' THEN d.value_json WHEN d.decision='rejected' THEN NULL ELSE e.value_json END effective_value
      FROM samples s JOIN sample_analysis_elements e ON e.version_id=s.current_analysis_version_id
      LEFT JOIN LATERAL(SELECT decision,value_json FROM sample_element_decisions WHERE element_id=e.id
        ORDER BY created_at DESC,id DESC LIMIT 1)d ON true
      WHERE s.id=ANY($1::bigint[]) AND e.dimension_key=ANY($2::text[])
        AND COALESCE(d.decision,'')<>'rejected' AND (e.state='value' OR d.decision='edited')`,
    [ids,normalizedConditions.map(item => item.dimensionKey)]);
    matches.forEach(item => reasons.get(Number(item.sample_id))?.matchedElements.push(
      { dimensionKey:item.dimension_key, effectiveValue:item.effective_value }));
  }
  return { items:rows.map(row => ({ ...sampleListItem(row),
    currentAnalysisVersionId:row.current_analysis_version_id == null ? null : Number(row.current_analysis_version_id),
    ...reviewStats.get(Number(row.id)),...reasons.get(Number(row.id)) })),
  total:Number(counts[0]?.count || 0), page, pageSize,
  summary:{ total:Number(counts[0]?.count||0),complete:Number(counts[0]?.complete||0),
    incomplete:Number(counts[0]?.incomplete||0) } };
}

function qualityRow(row={}){
  const total=Number(row.total||0),reviewed=Number(row.reviewed||0),confirmed=Number(row.confirmed||0);
  const edited=Number(row.edited||0),rejected=Number(row.rejected||0);
  const ratio=value=>reviewed?Number((value/reviewed).toFixed(4)):null;
  return { total,reviewed,pending:Math.max(0,total-reviewed),confirmed,edited,rejected,
    reviewCoverage:total?Number((reviewed/total).toFixed(4)):null,
    exactConfirmationRate:ratio(confirmed),correctionRate:ratio(edited),rejectionRate:ratio(rejected) };
}

export async function analysisQualitySummary(db={query}){
  const base=`FROM samples s JOIN sample_analysis_versions v ON v.id=s.current_analysis_version_id
    JOIN sample_analysis_elements e ON e.version_id=v.id
    LEFT JOIN LATERAL(SELECT decision FROM sample_element_decisions d WHERE d.element_id=e.id
      ORDER BY d.created_at DESC,d.id DESC LIMIT 1)d ON true
    WHERE s.deleted_at IS NULL AND v.source='ai' AND v.status='complete'`;
  const aggregate=`count(*)::int total,count(d.decision)::int reviewed,
    count(*) FILTER(WHERE d.decision='confirmed')::int confirmed,
    count(*) FILTER(WHERE d.decision='edited')::int edited,
    count(*) FILTER(WHERE d.decision='rejected')::int rejected`;
  const [{rows:overallRows},{rows:dimensionRows},{rows:modelRows}]=await Promise.all([
    db.query(`SELECT ${aggregate} ${base}`),
    db.query(`SELECT e.dimension_key,${aggregate} ${base} GROUP BY e.dimension_key ORDER BY e.dimension_key`),
    db.query(`SELECT v.model_name,v.prompt_version,${aggregate} ${base}
      GROUP BY v.model_name,v.prompt_version ORDER BY count(*) DESC,v.model_name,v.prompt_version`),
  ]);
  return { overall:qualityRow(overallRows[0]),
    dimensions:dimensionRows.map(row=>({dimensionKey:row.dimension_key,...qualityRow(row)})),
    models:modelRows.map(row=>({modelName:row.model_name,promptVersion:row.prompt_version,...qualityRow(row)})) };
}

export function mount(router) {
  router.get('/api/sample-research/config', async (req, res) => {
    await currentUser(req);
    const [tags,quality] = await Promise.all([activeDimensionTags(),analysisQualitySummary()]);
    const tagsByKind = Object.fromEntries(ANALYSIS_DIMENSIONS.map(dimension => [dimension.key,
      tags.filter(tag => tag.kind === dimension.key)]));
    sendJson(res, 200, { dimensions:ANALYSIS_DIMENSIONS, targets:ANALYSIS_TARGETS, tagsByKind,
      schemaVersion:RESEARCH_SCHEMA_VERSION, promptVersion:RESEARCH_PROMPT_VERSION,quality });
  });

  router.post('/api/samples/:id/analysis-jobs', async (req, res, params) => {
    const me = await currentUser(req);
    const sampleId = strictId(params.id, '样本 id');
    const body = await readJson(req);
    const source = await loadResearchSource(sampleId,
      body.sourceCaptureId == null ? null : strictId(body.sourceCaptureId, '采集版本 id'));
    const manifest = buildEvidenceManifest(source);
    // Refuse before inserting a fake queued/completed job when there is no provider key.
    const provider = await activeProvider();
    if (!provider?.apiKey) {
      throw new HttpError(503, '尚未配置 AI，可继续使用人工拆解',
        { code:'AI_NOT_CONFIGURED', manualEntryAllowed:true });
    }
    const headerKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    const bucket = Math.floor(Date.now() / 30_000);
    const idempotencyKey = cleanIdempotency(headerKey || body.idempotencyKey,
      `auto:${source.capture.id}:${manifest.inputSha256.slice(0,24)}:${bucket}`);
    let job,created=false;
    try {
      job = await tx(async client => {
        const { rows } = await client.query(`INSERT INTO sample_analysis_jobs(
          sample_id,source_capture_id,idempotency_key,input_sha256,status,select_on_success,provider,model_name,requested_by
        ) VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8)
        ON CONFLICT(sample_id,idempotency_key) DO NOTHING RETURNING *`, [sampleId,source.capture.id,
        idempotencyKey,manifest.inputSha256,body.selectOnSuccess !== false,provider.source,provider.model,me.id]);
        if (rows[0]){created=true;return rows[0];}
        const existing = await client.query(
          'SELECT * FROM sample_analysis_jobs WHERE sample_id=$1 AND idempotency_key=$2', [sampleId,idempotencyKey]);
        return existing.rows[0];
      });
    } catch (error) {
      if (error?.code !== '23505') throw error;
      const { rows } = await query(`SELECT * FROM sample_analysis_jobs WHERE sample_id=$1
        AND status IN('queued','running') ORDER BY created_at,id LIMIT 1`, [sampleId]);
      if (!rows[0]) throw conflict('该样本的分析任务刚刚发生状态变化，请重试');
      job = rows[0];
    }
    if (created&&job.status === 'queued') enqueueAnalysisJob(Number(job.id));
    sendJson(res, 202, { job:rowJob(job), manualEntryAllowed:true });
  });

  router.get('/api/samples/:id/analysis-jobs/:jobId', async (req, res, params) => {
    await currentUser(req);
    const sampleId = strictId(params.id, '样本 id'); const jobId = strictId(params.jobId, '任务 id');
    const { rows } = await query('SELECT * FROM sample_analysis_jobs WHERE id=$1 AND sample_id=$2', [jobId,sampleId]);
    if (!rows[0]) throw notFound('分析任务不存在');
    const { rows:versions } = await query('SELECT * FROM sample_analysis_versions WHERE job_id=$1', [jobId]);
    sendJson(res, 200, { job:rowJob(rows[0]), version:rowVersion(versions[0]), manualEntryAllowed:true });
  });

  router.get('/api/samples/:id/analyses', async (req, res, params) => {
    await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const sample = await ensureSample(sampleId);
    const { rows } = await query(`SELECT * FROM sample_analysis_versions
      WHERE sample_id=$1 AND status='complete' ORDER BY revision DESC,id DESC`, [sampleId]);
    sendJson(res, 200, { items:rows.map(rowVersion),
      currentVersionId:sample.current_analysis_version_id == null ? null : Number(sample.current_analysis_version_id) });
  });

  router.get('/api/samples/:id/analyses/:versionId', async (req, res, params) => {
    await currentUser(req); sendJson(res, 200, await loadVersionDetail(
      strictId(params.id, '样本 id'), strictId(params.versionId, '分析版本 id')));
  });

  router.post('/api/samples/:id/analyses/manual', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const body = await readJson(req, 2 * 1024 * 1024);
    const source = await loadResearchSource(sampleId,
      body.sourceCaptureId == null ? null : strictId(body.sourceCaptureId, '采集版本 id'));
    const manifest = buildEvidenceManifest(source);
    const elements = normalizeManualElements(body.elements);
    const activeTags = new Map((await activeDimensionTags()).map(tag=>[Number(tag.id),tag.kind]));
    for (const element of elements) for (const tagId of element.tagIds) {
      if (activeTags.get(Number(tagId)) !== element.dimensionKey) {
        throw badRequest(`标签 ${tagId} 不存在、已停用或不属于 ${element.dimensionKey}`);
      }
    }
    const inputSha256 = sha256({ manifest:manifest.inputSha256, manual:elements });
    const version = await tx(client => persistAnalysisVersion(client, {
      sampleId,sourceCaptureId:Number(source.capture.id),source:'manual',elements,manifest,inputSha256,
      createdBy:me.id,select:body.selectOnSuccess !== false,selectionReason:'explicit',promptVersion:null,
    }));
    sendJson(res, 201, await loadVersionDetail(sampleId, Number(version.id)));
  });

  router.post('/api/samples/:id/analyses/:versionId/select', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const versionId = strictId(params.versionId, '分析版本 id');
    const { rows } = await query("SELECT 1 FROM sample_analysis_versions WHERE id=$1 AND sample_id=$2 AND status='complete'",
      [versionId,sampleId]);
    if (!rows[0]) throw notFound('分析版本不存在或不属于该样本');
    await query(`INSERT INTO sample_analysis_selections(sample_id,version_id,reason,selected_by)
      VALUES($1,$2,'explicit',$3)`, [sampleId,versionId,me.id]);
    sendJson(res, 200, { ok:true, sampleId, currentVersionId:versionId });
  });

  router.post('/api/samples/:id/analyses/:versionId/elements/:dimensionKey/ai-rerun', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const versionId = strictId(params.versionId, '分析版本 id');
    const dimensionKey = cleanText(params.dimensionKey, 80);
    const dimension = ANALYSIS_DIMENSIONS.find(item => item.key === dimensionKey);
    if (!dimension) throw badRequest('拆解维度不存在');
    const body = await readJson(req);
    const base = await loadVersionDetail(sampleId,versionId);
    if (base.elements.length !== ANALYSIS_DIMENSIONS.length || base.elements.some(element => element.confidence == null)) {
      throw conflict('当前版本不是可安全继承的完整 AI 拆解，请先执行整篇 AI 重新拆解');
    }
    const source = await loadResearchSource(sampleId,
      body.sourceCaptureId == null ? null : strictId(body.sourceCaptureId, '采集版本 id'));
    const provider = await activeProvider();
    if (!provider?.apiKey) throw new HttpError(503, '尚未配置 AI，可继续使用人工拆解',
      { code:'AI_NOT_CONFIGURED', manualEntryAllowed:true });
    const carriedVision=carriedRuntimeVision(base);
    const manifest=await manifestWithRuntimeVision(source,provider,{supplemental:carriedVision});
    const manifestIds = new Set(manifest.sources.map(item => item.sourceId));
    const incompatible = base.elements.filter(element => element.dimensionKey !== dimensionKey
      && element.state === 'value' && !(element.evidence || []).some(item => manifestIds.has(item.sourceId)));
    if (incompatible.length) {
      throw conflict('原版部分证据不在当前采集快照中，无法保证其他维度原样继承；请改用整篇 AI 重新拆解');
    }
    const activeTags = await activeDimensionTags();
    const activeTagIds = new Set(activeTags.map(tag => Number(tag.id)));
    const idempotencyKey = `partial:${versionId}:${dimensionKey}:${randomUUID()}`;
    let job;
    try {
      const { rows } = await query(`INSERT INTO sample_analysis_jobs(
        sample_id,source_capture_id,idempotency_key,input_sha256,status,attempts,select_on_success,
        provider,model_name,requested_by,started_at
      ) VALUES($1,$2,$3,$4,'running',1,true,$5,$6,$7,now()) RETURNING *`, [
        sampleId,source.capture.id,idempotencyKey,manifest.inputSha256,provider.source,provider.model,me.id]);
      job=rows[0];
    } catch (error) {
      if (error?.code === '23505') throw conflict('该样本已有 AI 拆解任务进行中，请完成后再重试单项拆解');
      throw error;
    }
    let generated;
    try {
      generated = await requestAiAnalysis({ manifest,activeTags,dimensions:[dimension],provider });
    } catch (error) {
      const safe=safeAnalysisError(error);
      await query(`UPDATE sample_analysis_jobs SET status='failed',error_code=$2,error_message=$3,
        finished_at=now(),updated_at=now() WHERE id=$1 AND status='running'`,[job.id,safe.code,safe.message]);
      const status=safe.code==='AI_TIMEOUT'?504:safe.code==='AI_HTTP_429'?429:502;
      throw new HttpError(status,safe.message,{code:safe.code,manualEntryAllowed:true});
    }
    let saved;
    try {
      saved=await tx(async client=>{
        const target=generated.elements[0];
        const elements=base.elements.map(element=>element.dimensionKey===dimensionKey?target:{
          dimensionKey:element.dimensionKey,state:element.state,valueJson:element.value,
          functionText:element.functionText,confidence:element.confidence,
          evidenceStrength:element.evidenceStrength,applicability:element.applicability,
          limitations:element.limitations,evidence:(element.evidence||[]).filter(item=>manifestIds.has(item.sourceId)),
          tagRecords:(element.tags||[]).filter(tag=>tag.origin!=='ai'||activeTagIds.has(Number(tag.id)))
            .map(tag=>({tagId:Number(tag.id),origin:tag.origin,confidence:tag.confidence,createdBy:me.id})),
        });
        const created=await persistAnalysisVersion(client,{
          sampleId,sourceCaptureId:Number(source.capture.id),source:'ai',elements,manifest,
          inputSha256:manifest.inputSha256,createdBy:me.id,jobId:Number(job.id),provider:generated.provider,
          modelName:generated.model,modelVersion:generated.modelVersion,select:false,
          promptVersion:`${RESEARCH_PROMPT_VERSION}:single:${dimensionKey}:base:${versionId}`,
        });
        const {rows:newElements}=await client.query(
          'SELECT id,dimension_key FROM sample_analysis_elements WHERE version_id=$1',[created.id]);
        const newByKey=new Map(newElements.map(element=>[element.dimension_key,Number(element.id)]));
        for(const element of base.elements){
          if(element.dimensionKey===dimensionKey||!element.decision)continue;
          const decision=element.decision;
          await client.query(`INSERT INTO sample_element_decisions(
            element_id,decision,value_json,function_text,applicability,limitations,note,decided_by
          ) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,[
            newByKey.get(element.dimensionKey),decision.decision,
            decision.value_json==null?null:JSON.stringify(decision.value_json),decision.function_text,
            decision.applicability,decision.limitations,decision.note,decision.decidedBy]);
        }
        const {rowCount}=await client.query(`UPDATE sample_analysis_jobs SET status='succeeded',provider=$2,
          model_name=$3,finished_at=now(),updated_at=now() WHERE id=$1 AND status='running'`,[
          job.id,generated.provider,generated.model]);
        if(rowCount!==1)throw conflict('单项拆解任务状态已经变化，未切换当前版本');
        await client.query(`INSERT INTO sample_analysis_selections(sample_id,version_id,reason,selected_by)
          VALUES($1,$2,'run_success',$3)`,[sampleId,created.id,me.id]);
        return created;
      });
    } catch(error) {
      await query(`UPDATE sample_analysis_jobs SET status='failed',error_code='PARTIAL_PERSIST_FAILED',
        error_message='单项拆解保存失败，原版本未受影响',finished_at=now(),updated_at=now()
        WHERE id=$1 AND status='running'`,[job.id]);
      if(error instanceof HttpError)throw error;
      throw new HttpError(500,'单项拆解保存失败，原版本未受影响',{code:'PARTIAL_PERSIST_FAILED'});
    }
    sendJson(res,201,{version:await loadVersionDetail(sampleId,Number(saved.id)),
      baseVersionId:versionId,rerunDimensionKey:dimensionKey});
  });

  router.post('/api/samples/:id/analyses/:versionId/elements/:dimensionKey/decisions', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const versionId = strictId(params.versionId, '分析版本 id'); const dimensionKey = cleanText(params.dimensionKey, 80);
    if (!DIMENSION_KEYS.has(dimensionKey)) throw badRequest('拆解维度不存在');
    const body = await readJson(req); const decision = normalizeDecision(body);
    const { rows:elements } = await query(`SELECT e.id FROM sample_analysis_elements e
      JOIN sample_analysis_versions v ON v.id=e.version_id AND v.sample_id=$1 AND v.status='complete'
      WHERE e.version_id=$2 AND e.dimension_key=$3`, [sampleId,versionId,dimensionKey]);
    if (!elements[0]) throw notFound('拆解元素不存在');
    const key = cleanIdempotency(req.headers['idempotency-key'] || body.idempotencyKey,
      `decision:${randomUUID()}`);
    const { rows } = await query(`INSERT INTO sample_element_decisions(
      element_id,decision,value_json,function_text,applicability,limitations,note,idempotency_key,decided_by
    ) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(element_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`, [
    elements[0].id,decision.decision,decision.valueJson == null ? null : JSON.stringify(decision.valueJson),
    decision.functionText,decision.applicability,decision.limitations,decision.note,key,me.id]);
    const saved = rows[0] || (await query(
      'SELECT * FROM sample_element_decisions WHERE element_id=$1 AND idempotency_key=$2', [elements[0].id,key])).rows[0];
    sendJson(res, rows[0] ? 201 : 200, { id:Number(saved.id), elementId:Number(saved.element_id),
      decision:saved.decision, value:saved.value_json, note:saved.note,
      decidedBy:saved.decided_by == null ? null : Number(saved.decided_by),
      createdAt:saved.created_at });
  });

  router.post('/api/samples/:id/analyses/:versionId/elements/:dimensionKey/tags', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const versionId = strictId(params.versionId, '分析版本 id'); const dimensionKey = cleanText(params.dimensionKey, 80);
    if (!DIMENSION_KEYS.has(dimensionKey)) throw badRequest('拆解维度不存在');
    const body = await readJson(req);
    if (!Array.isArray(body.tagIds)) throw badRequest('tagIds 必须是数组');
    const tagIds = [...new Set(body.tagIds.map(Number).filter(Number.isSafeInteger))].slice(0, 20);
    const [{ rows:elements }, { rows:tags }] = await Promise.all([
      query(`SELECT e.id FROM sample_analysis_elements e JOIN sample_analysis_versions v ON v.id=e.version_id
        WHERE v.sample_id=$1 AND v.id=$2 AND v.status='complete' AND e.dimension_key=$3`, [sampleId,versionId,dimensionKey]),
      tagIds.length ? query('SELECT id FROM tags WHERE active AND kind=$1 AND id=ANY($2::bigint[])', [dimensionKey,tagIds])
        : Promise.resolve({ rows:[] }),
    ]);
    if (!elements[0]) throw notFound('拆解元素不存在');
    if (tags.length !== tagIds.length) throw badRequest('标签不存在、已停用或不属于该拆解维度');
    if(tagIds.length)await tx(client=>client.query(`INSERT INTO sample_element_tags(
      version_id,element_id,dimension_key,tag_id,origin,confidence,created_by
    ) SELECT $1,$2,$3,unnest($4::bigint[]),'manual',NULL,$5 ON CONFLICT DO NOTHING`,
    [versionId,elements[0].id,dimensionKey,tagIds,me.id]));
    const { rows } = await query(`SELECT t.id,t.kind,t.name,et.origin,et.created_at FROM sample_element_tags et
      JOIN tags t ON t.id=et.tag_id WHERE et.element_id=$1 ORDER BY t.sort,t.id`, [elements[0].id]);
    sendJson(res, 200, { items:rows.map(row => ({ id:Number(row.id),kind:row.kind,name:row.name,
      origin:row.origin,createdAt:row.created_at })) });
  });

  router.get('/api/samples/:id/tags', async (req, res, params) => {
    await currentUser(req); const sampleId = strictId(params.id, '样本 id'); await ensureSample(sampleId);
    const { rows } = await query(`SELECT t.id,t.kind,t.name,t.sort FROM entity_tags et JOIN tags t ON t.id=et.tag_id
      WHERE et.entity='sample' AND et.entity_id=$1 ORDER BY t.kind,t.sort,t.id`, [sampleId]);
    sendJson(res, 200, { items:rows.map(row => ({ ...row,id:Number(row.id),sort:Number(row.sort) })) });
  });

  router.post('/api/samples/:id/tags', async (req, res, params) => {
    await currentUser(req); const sampleId = strictId(params.id, '样本 id'); await ensureSample(sampleId);
    const body = await readJson(req); if (!Array.isArray(body.tagIds)) throw badRequest('tagIds 必须是数组');
    const ids = [...new Set(body.tagIds.map(Number).filter(Number.isSafeInteger))].slice(0, 100);
    const { rows:tags } = ids.length ? await query('SELECT id FROM tags WHERE active AND id=ANY($1::bigint[])', [ids]) : { rows:[] };
    if (tags.length !== ids.length) throw badRequest('标签不存在或已停用');
    await tx(async client => {
      await client.query("DELETE FROM entity_tags WHERE entity='sample' AND entity_id=$1", [sampleId]);
      if (ids.length) await client.query(`INSERT INTO entity_tags(entity,entity_id,tag_id)
        SELECT 'sample',$1,unnest($2::bigint[])`, [sampleId,ids]);
    });
    const { rows } = await query(`SELECT t.id,t.kind,t.name,t.sort FROM entity_tags et JOIN tags t ON t.id=et.tag_id
      WHERE et.entity='sample' AND et.entity_id=$1 ORDER BY t.kind,t.sort,t.id`, [sampleId]);
    sendJson(res, 200, { items:rows.map(row => ({ ...row,id:Number(row.id),sort:Number(row.sort) })) });
  });

  router.post('/api/samples/search', async (req, res) => {
    await currentUser(req); sendJson(res, 200, await combinationSearch(await readJson(req)));
  });

  router.get('/api/samples/:id/evaluations', async (req, res, params) => {
    await currentUser(req); const sampleId = strictId(params.id, '样本 id'); await ensureSample(sampleId);
    const { rows } = await query(`SELECT * FROM sample_evaluations WHERE sample_id=$1
      ORDER BY target,revision DESC,id DESC`, [sampleId]);
    sendJson(res, 200, { items:rows.map(rowEvaluation), targets:ANALYSIS_TARGETS });
  });

  router.post('/api/samples/:id/evaluations', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id'); await ensureSample(sampleId);
    const body = await readJson(req, 2 * 1024 * 1024);
    if (body.source && body.source !== 'manual') throw badRequest('AI 评价必须由 AI 评价入口生成，不能冒充');
    const saved = await tx(client => insertEvaluation(client,sampleId,body,me.id,'manual'));
    sendJson(res, 201, rowEvaluation(saved));
  });

  router.post('/api/samples/:id/evaluations/ai', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const sample = await ensureSample(sampleId); const body = await readJson(req);
    const versionId = body.analysisVersionId == null
      ? Number(sample.current_analysis_version_id) : strictId(body.analysisVersionId, '分析版本 id');
    if (!versionId) throw badRequest('请先创建并选择一个拆解版本');
    const analysis = await loadVersionDetail(sampleId,versionId);
    const source = await loadResearchSource(sampleId,analysis.sourceCaptureId);
    const rebuilt = buildEvidenceManifest(source);
    const { rows:storedSources } = await query(
      'SELECT source_id FROM sample_evidence_sources WHERE version_id=$1', [versionId]);
    const allowed = new Set(storedSources.map(row => row.source_id));
    const manifest = { ...rebuilt, sources:rebuilt.sources.filter(item => allowed.has(item.sourceId)) };
    let generated;
    try {
      generated = await requestAiEvaluation({ target:cleanText(body.target,24),manifest,analysis });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const safe=safeAnalysisError(error);
      const status=safe.code==='AI_TIMEOUT'?504:safe.code==='AI_HTTP_429'?429:502;
      throw new HttpError(status,safe.message,{code:safe.code,manualEntryAllowed:true});
    }
    const saved = await tx(client => insertEvaluation(client,sampleId,{
      ...generated,analysisVersionId:versionId,
    },me.id,'ai',generated));
    sendJson(res, 201, rowEvaluation(saved));
  });

  router.get('/api/samples/:id/metrics', async (req, res, params) => {
    await currentUser(req); const sampleId = strictId(params.id, '样本 id'); await ensureSample(sampleId);
    const { rows } = await query('SELECT * FROM sample_metric_snapshots WHERE sample_id=$1 ORDER BY observed_at,id', [sampleId]);
    sendJson(res, 200, { items:rows.map(rowMetric) });
  });

  router.post('/api/samples/:id/metrics', async (req, res, params) => {
    const me = await currentUser(req); const sampleId = strictId(params.id, '样本 id'); await ensureSample(sampleId);
    const body = await readJson(req);
    const saved = await recordMetricSnapshot({ query }, { sampleId,observedAt:body.observedAt,
      metrics:body.metrics,createdBy:me.id,snapshotKey:body.snapshotKey || `manual:${randomUUID()}` });
    sendJson(res, saved.created?201:200, rowMetric(saved.row));
  });

  router.get('/api/samples/:id/research', async (req, res, params) => {
    await currentUser(req); const sampleId = strictId(params.id, '样本 id');
    const sample = await ensureSample(sampleId);
    const [{ rows:versions }, { rows:evaluations }, { rows:metrics }, { rows:sampleTags }, { rows:captures }, {rows:activeJobs}] = await Promise.all([
      query("SELECT * FROM sample_analysis_versions WHERE sample_id=$1 AND status='complete' ORDER BY revision DESC", [sampleId]),
      query('SELECT * FROM sample_evaluations WHERE sample_id=$1 ORDER BY target,revision DESC', [sampleId]),
      query('SELECT * FROM sample_metric_snapshots WHERE sample_id=$1 ORDER BY observed_at,id', [sampleId]),
      query(`SELECT t.id,t.kind,t.name FROM entity_tags et JOIN tags t ON t.id=et.tag_id
        WHERE et.entity='sample' AND et.entity_id=$1 ORDER BY t.kind,t.sort,t.id`, [sampleId]),
      query('SELECT id FROM sample_captures WHERE sample_id=$1 ORDER BY captured_at DESC,id DESC LIMIT 1',[sampleId]),
      query("SELECT * FROM sample_analysis_jobs WHERE sample_id=$1 AND status IN('queued','running') ORDER BY created_at,id LIMIT 1",[sampleId]),
    ]);
    const currentId = sample.current_analysis_version_id == null ? null : Number(sample.current_analysis_version_id);
    const currentAnalysis = currentId ? await loadVersionDetail(sampleId,currentId) : null;
    sendJson(res, 200, {
      sampleId, sourceCaptureId:captures[0] ? Number(captures[0].id) : null,
      currentVersionId:currentId, currentAnalysisVersionId:currentId,
      versions:versions.map(rowVersion), currentAnalysis,
      evaluations:evaluations.map(rowEvaluation), metrics:metrics.map(rowMetric),
      sampleTags:sampleTags.map(row => ({ id:Number(row.id),kind:row.kind,name:row.name })),
      activeJob:rowJob(activeJobs[0]),
    });
  });

}
