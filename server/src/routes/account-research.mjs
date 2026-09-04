import { activeProvider } from '../lib/ai-provider.mjs';
import { currentUser } from '../lib/auth.mjs';
import { query, tx } from '../db/index.mjs';
import { HttpError, sendJson, readJson } from '../lib/http.mjs';
import { safeAnalysisError } from '../lib/sample-research.mjs';
import {
  ACCOUNT_CLAIM_TYPES, ACCOUNT_QUALITY_FORMULA_VERSION, ACCOUNT_QUALITY_LABELS,
  ACCOUNT_RESEARCH_DIMENSIONS, ACCOUNT_RESEARCH_DTO_VERSION, ACCOUNT_RESEARCH_LIMITS,
  ACCOUNT_RESEARCH_PROMPT_VERSION, ACCOUNT_RESEARCH_SCHEMA_VERSION, ACCOUNT_SAMPLING_RULE_VERSION,
  accountResearchPermissions, accountResearchRequestSha256, buildAccountEvidenceManifest,
  buildAccountSamplingPlan, buildAccountContentMatrix, buildAccountSaturation, classifyAccountPattern, deduplicateAccountEvidence,
  deriveAccountClaimQuality, deriveAccountResearchQuality, normalizeAccountClaimDecision,
  normalizeAccountRunRequest, requestAccountResearchAnalysis, resolveAccountIdentity,
  validateAccountClaimLanguage,
} from '../lib/account-research.mjs';

const PLATFORM_LABELS={xiaohongshu:'小红书',douyin:'抖音',bilibili:'哔哩哔哩',youtube:'YouTube',manual:'手工录入',unknown:'未知平台'};
const IDENTITY_LABELS={platform_id:'稳定平台 ID',profile_id:'主页稳定 ID',verified_handle:'稳定 handle',
  name_candidate:'名称回退，待确认',conflict:'身份冲突，待确认',missing:'身份缺失，待确认'};
const QUALITY_LABELS={evidence_sufficient:'证据充分',evidence_moderate:'证据一般',hypothesis_only:'仅为假设',insufficient:'数据不足'};
const STABILITY_LABELS={stable:'稳定出现',recurring:'重复出现',occasional:'偶尔出现',insufficient:'数据不足'};

class AccountResearchError extends HttpError {
  constructor(status,code,message){super(status,message);this.code=code;}
}
const fail=(status,code,message)=>new AccountResearchError(status,code,message);

export function sendAccountResearchError(res,error){
  let status=Number(error?.status)||500,code=error?.code;
  if(error instanceof TypeError){status=400;code='INVALID_REQUEST';}
  else if(error?.code==='23505'){status=409;code='CONFLICT';}
  else if(error?.code==='42501'){status=403;code='FORBIDDEN';}
  else if(error?.code==='55000'||error?.code==='23514'||error?.code==='23503'){status=409;code='STATE_CONFLICT';}
  if(!Number.isInteger(status)||status<400||status>599)status=500;
  if(!/^[A-Z0-9_]+$/.test(String(code||'')))code=status===500?'INTERNAL_ERROR':'REQUEST_FAILED';
  const message=status===500?'账户研究服务暂时不可用':String(error?.message||'请求失败').replace(/[\r\n]+/gu,' ').slice(0,280);
  sendJson(res,status,{dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,error:{status,code,message}});
}

const wrapped=handler=>async(req,res,params,url)=>{try{await handler(req,res,params,url);}catch(error){sendAccountResearchError(res,error);}};
const clean=(value,max=1000)=>String(value??'').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,max);
function strictAccountId(value){const id=clean(value,640);if(!id||id!==String(value))throw fail(400,'INVALID_ACCOUNT_ID','研究账户标识不合法');return id;}
function strictPositiveId(value,label){const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw fail(400,'INVALID_ID',`${label}不合法`);return id;}
function idempotencyKey(req){const raw=req.headers?.['idempotency-key']??req.headers?.['x-idempotency-key'];
  if(typeof raw!=='string'||raw.length>160||/[\p{Cc}\p{Cf}]/u.test(raw)||!raw.trim())throw fail(400,'IDEMPOTENCY_KEY_REQUIRED','写入请求必须提供 1—160 字符且不含控制字符的 Idempotency-Key');
  return raw.trim();}
function strictQuery(url,allowed){for(const key of url.searchParams.keys())if(!allowed.includes(key))throw fail(400,'INVALID_QUERY',`不支持查询参数 ${key}`);}
function intQuery(url,key,fallback,min,max){const raw=url.searchParams.get(key);if(raw==null||raw==='')return fallback;const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw fail(400,'INVALID_QUERY',`${key} 不合法`);return value;}
function dateLabel(value){const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):String(value).slice(0,10);}
function windowLabel(start,end){return `${dateLabel(start)}—${dateLabel(end)}`;}
function identityDto(row){return {quality:row.identity_quality,label:IDENTITY_LABELS[row.identity_quality]||'身份待确认',needsReview:Boolean(row.needs_review),source:row.identity_source};}
function permissionsDto(user){return {...accountResearchPermissions(user)};}

function nestedValue(value,...paths){for(const path of paths){let cursor=value;for(const key of path)cursor=cursor?.[key];if(cursor!=null&&cursor!=='')return cursor;}return null;}
function rowIdentityInput(row){
  const payload=row.normalized_payload||{};
  return {sampleId:Number(row.id),platform:row.platform,
    platformAccountId:nestedValue(payload,['platformAccountId'],['platform_account_id'],['account','id'],['author','id'],['user','id']),
    profileUrl:nestedValue(payload,['profileUrl'],['accountProfileUrl'],['account','profileUrl'],['author','profileUrl'],['user','profileUrl']),
    accountHandle:row.account_handle??nestedValue(payload,['accountHandle'],['account','handle'],['author','handle'],['user','handle']),
    accountName:row.account_name??nestedValue(payload,['accountName'],['account','name'],['author','name'],['user','name'])};
}

function rowProfilePublic(row,field){const payload=row.normalized_payload||{};const paths={
  bio:[['accountBio'],['bio'],['account','bio'],['author','bio'],['user','bio']],
  qualification:[['qualification'],['account','qualification'],['author','qualification'],['user','qualification']],
  description:[['description'],['account','description'],['author','description'],['user','description']],
};return nestedValue(payload,...(paths[field]||[]));}

async function candidateRows(db=query){
  const {rows}=await db(`SELECT s.id,s.platform,s.account_name,s.account_handle,s.title,s.body_text,s.content_type,
      s.published_at,s.metrics,c.id capture_id,c.captured_at,c.normalized_payload
    FROM samples s
    LEFT JOIN research_account_sample_links l ON l.sample_id=s.id
    LEFT JOIN LATERAL(SELECT id,captured_at,normalized_payload FROM sample_captures
      WHERE sample_id=s.id ORDER BY captured_at DESC,id DESC LIMIT 1)c ON true
    WHERE s.deleted_at IS NULL AND l.id IS NULL ORDER BY s.id LIMIT 5000`);
  return rows;
}

function groupCandidates(rows){
  const groups=new Map();
  for(const row of rows){const identity=resolveAccountIdentity(rowIdentityInput(row));if(!groups.has(identity.key))groups.set(identity.key,{identity,rows:[]});groups.get(identity.key).rows.push(row);}
  return [...groups.values()];
}

async function persistedAccounts(db=query){
  const {rows}=await db(`SELECT a.*,(SELECT count(*)::int FROM account_research_runs r WHERE r.account_id=a.id AND r.status='complete')version_count
    FROM research_accounts a ORDER BY a.updated_at DESC,a.id DESC`);return rows;
}

function virtualAccount(candidate){const i=candidate.identity;return {id:null,stable_key:i.key,platform:i.platform,
  platform_account_id:i.platformAccountId,display_name:i.displayName,handle:i.handle,profile_url:candidate.rows.map(row=>rowIdentityInput(row).profileUrl).find(Boolean)||null,
  identity_quality:i.quality,identity_source:i.source,needs_review:i.needsReview,current_run_id:null,version_count:0,updated_at:candidate.rows.at(-1)?.captured_at||candidate.rows.at(-1)?.published_at||null,_candidate:candidate};}

async function discoverAccounts(db=query){
  const [saved,candidates]=await Promise.all([persistedAccounts(db),candidateRows(db).then(groupCandidates)]);
  const savedKeys=new Set(saved.map(row=>row.stable_key));return [...saved,...candidates.filter(item=>!savedKeys.has(item.identity.key)).map(virtualAccount)];
}

async function findAccount(value,db=query){
  const {rows}=await db('SELECT * FROM research_accounts WHERE stable_key=$1 OR id::text=$1 LIMIT 1',[value]);
  if(rows[0])return rows[0];
  const candidate=groupCandidates(await candidateRows(db)).find(item=>item.identity.key===value);
  return candidate?virtualAccount(candidate):null;
}

async function materializeAccount(client,account,userId){
  const candidate=account._candidate;if(!candidate)throw fail(404,'NOT_FOUND','研究账户不存在');
  const i=candidate.identity;
  let saved=account.id?account:null;
  if(!saved){let {rows}=await client.query(`INSERT INTO research_accounts(stable_key,platform,platform_account_id,display_name,handle,profile_url,
        identity_quality,identity_source,needs_review)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(stable_key)DO NOTHING RETURNING *`,[i.key,i.platform,i.platformAccountId,i.displayName,i.handle,account.profile_url,i.quality,i.source,i.needsReview]);
    saved=rows[0];if(!saved)saved=(await client.query('SELECT * FROM research_accounts WHERE stable_key=$1 FOR UPDATE',[i.key])).rows[0];}
  if(!saved)throw fail(409,'IDENTITY_CONFLICT','账户身份发生并发冲突');
  for(const row of candidate.rows){
    const input=rowIdentityInput(row);const pairs=[['display_name',input.accountName],['handle',input.accountHandle],['profile_url',input.profileUrl]];
    if(i.platformAccountId)pairs.push([i.source==='profile_url'?'profile_id':'platform_account_id',i.platformAccountId]);
    for(const [type,value]of pairs){const alias=clean(value,type==='profile_url'?2000:500);if(!alias)continue;
      await client.query(`INSERT INTO research_account_aliases(account_id,platform,alias_type,alias_value,normalized_value,source_sample_id,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,now())) ON CONFLICT DO NOTHING`,[saved.id,i.platform,type,alias,
        ['platform_account_id','profile_id'].includes(type)?alias:alias.toLowerCase(),row.id,row.captured_at]);}
    const profile={displayName:input.accountName||null,handle:input.accountHandle||null,profileUrl:input.profileUrl||null,
      bio:clean(rowProfilePublic(row,'bio'),4000)||null,qualification:clean(rowProfilePublic(row,'qualification'),4000)||null,
      description:clean(rowProfilePublic(row,'description'),4000)||null,platformAccountId:input.platformAccountId||null};
    await client.query(`INSERT INTO research_account_profile_snapshots(account_id,source_sample_id,source_capture_id,snapshot_key,captured_at,
        display_name,handle,profile_url,profile_json,snapshot_sha256)VALUES($1,$2,$3,$4,COALESCE($5,now()),$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT(account_id,snapshot_key)DO NOTHING`,[saved.id,row.id,row.capture_id||null,`sample:${row.id}:capture:${row.capture_id||'none'}`,
      row.captured_at,input.accountName||null,input.accountHandle||null,input.profileUrl||null,JSON.stringify(profile),accountResearchRequestSha256(profile)]);
    await client.query(`INSERT INTO research_account_sample_links(account_id,sample_id,identity_quality,identity_source,linked_by)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(sample_id)DO NOTHING`,[saved.id,row.id,i.quality,i.source,userId]);
    const linked=(await client.query('SELECT account_id FROM research_account_sample_links WHERE sample_id=$1',[row.id])).rows[0];
    if(Number(linked?.account_id)!==Number(saved.id))throw fail(409,'IDENTITY_CONFLICT','样本已经绑定到另一个研究账户，需人工处理身份冲突');
  }
  return saved;
}

async function attachNewMatchingSamples(client,account,userId){
  if(!['platform_id','profile_id','verified_handle'].includes(account.identity_quality))return account;
  const match=groupCandidates(await candidateRows(client.query.bind(client))).find(item=>item.identity.key===account.stable_key);
  return match?materializeAccount(client,{...account,_candidate:match},userId):account;
}

async function appendProfileSnapshots(client,accountId){
  const {rows}=await client.query(`SELECT s.id,s.platform,s.account_name,s.account_handle,c.id capture_id,c.captured_at,c.normalized_payload
    FROM research_account_sample_links l JOIN samples s ON s.id=l.sample_id
    JOIN sample_captures c ON c.sample_id=s.id WHERE l.account_id=$1 ORDER BY s.id,c.captured_at,c.id`,[accountId]);
  for(const row of rows){const input=rowIdentityInput(row);const profile={displayName:input.accountName||null,handle:input.accountHandle||null,
      profileUrl:input.profileUrl||null,bio:clean(rowProfilePublic(row,'bio'),4000)||null,
      qualification:clean(rowProfilePublic(row,'qualification'),4000)||null,
      description:clean(rowProfilePublic(row,'description'),4000)||null,platformAccountId:input.platformAccountId||null};
    await client.query(`INSERT INTO research_account_profile_snapshots(account_id,source_sample_id,source_capture_id,snapshot_key,captured_at,
      display_name,handle,profile_url,profile_json,snapshot_sha256)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT(account_id,snapshot_key)DO NOTHING`,[accountId,row.id,row.capture_id,`sample:${row.id}:capture:${row.capture_id}`,row.captured_at,
      input.accountName||null,input.accountHandle||null,input.profileUrl||null,JSON.stringify(profile),accountResearchRequestSha256(profile)]);}
}

async function loadAccountSamples(accountId,db=query){
  const {rows}=await db(`SELECT s.id,s.title,s.body_text,s.content_type,s.published_at,s.metrics,
      c.id capture_id,c.normalized_payload,
      EXISTS(SELECT 1 FROM sample_assets a WHERE a.sample_id=s.id AND a.deleted_at IS NULL)has_media,
      COALESCE((s.metrics->>'comments')::numeric,0)comment_count
    FROM research_account_sample_links l JOIN samples s ON s.id=l.sample_id
    LEFT JOIN LATERAL(SELECT id,normalized_payload FROM sample_captures WHERE sample_id=s.id ORDER BY captured_at DESC,id DESC LIMIT 1)c ON true
    WHERE l.account_id=$1 AND s.deleted_at IS NULL ORDER BY s.id LIMIT 5000`,[accountId]);
  return rows.map(row=>({...row,bodyText:row.body_text,contentType:row.content_type,publishedAt:row.published_at,
    assetCount:row.has_media?1:0,commentCount:Number(row.comment_count)||0,comments:nestedValue(row.normalized_payload||{},['comments'],['data','comments'])||[]}));
}

async function loadElementEvidence(sampleIds,db=query){
  if(!sampleIds.length)return [];
  const {rows}=await db(`SELECT v.sample_id,ee.id,ee.source_id,ee.quote_text,ee.start_offset,ee.end_offset,ee.time_start_ms,ee.time_end_ms,
      ee.comment_ref,es.source_kind,es.asset_id,es.source_capture_id,es.locator,a.kind asset_kind,a.duration_ms,
      CASE WHEN a.kind IN ('cover','image') THEN 1+(SELECT count(*) FROM sample_assets preceding
        WHERE preceding.sample_id=v.sample_id AND preceding.deleted_at IS NULL AND preceding.kind IN ('cover','image')
          AND (preceding.created_at,preceding.id)<(a.created_at,a.id)) ELSE NULL END image_ordinal
    FROM sample_element_evidence ee JOIN sample_analysis_elements e ON e.id=ee.element_id
    JOIN sample_analysis_versions v ON v.id=e.version_id
    JOIN sample_evidence_sources es ON es.version_id=ee.version_id AND es.source_id=ee.source_id
    LEFT JOIN sample_assets a ON a.id=es.asset_id AND a.sample_id=v.sample_id AND a.deleted_at IS NULL
    WHERE v.sample_id=ANY($1::bigint[]) AND v.status='complete' AND ee.verification_status='verified'
      AND ee.quote_text IS NOT NULL ORDER BY v.sample_id,ee.id LIMIT 3000`,[sampleIds]);
  return rows.map(row=>{
    let sourceKind=null,locator=null,bounds={};
    if(['ocr','asset'].includes(row.source_kind)&&['cover','image'].includes(row.asset_kind)&&Number(row.locator?.imageIndex)===Number(row.image_ordinal)){sourceKind='image';locator={imageIndex:Number(row.image_ordinal),...(row.locator.region?{region:row.locator.region}:{})};}
    else if(['transcript','asset'].includes(row.source_kind)&&row.asset_kind==='video'&&row.time_start_ms!=null&&row.time_end_ms!=null){sourceKind='video';locator={timeStartMs:Number(row.time_start_ms),timeEndMs:Number(row.time_end_ms)};bounds={durationMs:Number(row.duration_ms)};}
    else if(row.source_kind==='comment'&&row.comment_ref){sourceKind='comment';locator={commentRef:row.comment_ref};}
    else if(row.source_kind==='body'&&row.start_offset!=null&&row.end_offset!=null){sourceKind='body';locator={startOffset:Number(row.start_offset),endOffset:Number(row.end_offset)};}
    return sourceKind?{sampleId:Number(row.sample_id),sourceId:`element:${row.id}:${row.source_id}`,sourceKind,quoteText:row.quote_text,locator,
      assetId:row.asset_id==null?null:Number(row.asset_id),captureId:row.source_capture_id==null?null:Number(row.source_capture_id),
      elementEvidenceId:Number(row.id),bounds}:null;
  }).filter(Boolean);
}

async function loadProfileEvidence(accountId,sampleIds,windowStart,windowEnd,db=query){
  if(!sampleIds.length)return [];
  const {rows}=await db(`SELECT id,source_sample_id,source_capture_id,display_name,handle,profile_url,profile_json
    FROM research_account_profile_snapshots WHERE account_id=$1 AND source_sample_id=ANY($2::bigint[])
      AND captured_at>=$3 AND captured_at<=$4 ORDER BY captured_at,id LIMIT 200`,[accountId,sampleIds,windowStart,windowEnd]);
  const fields=[['displayName','display_name'],['handle','handle'],['profileUrl','profile_url'],['bio',null],['qualification',null],['description',null]];
  return rows.flatMap(row=>fields.map(([field,column])=>{const quoteText=clean(column?row[column]:row.profile_json?.[field],field==='bio'?4000:2000);
    return quoteText?{sampleId:Number(row.source_sample_id),sourceId:`profile:${row.id}:${field}`,sourceKind:'profile',quoteText,
      locator:{profileField:field},captureId:row.source_capture_id==null?null:Number(row.source_capture_id),profileSnapshotId:Number(row.id)}:null;}).filter(Boolean));
}

async function claimRows(runId,db=query){
  return (await db(`SELECT c.*,d.decision,d.claim_text decision_claim_text,d.operational_definition decision_definition,
      d.limitations decision_limitations,d.note decision_note,d.created_at decision_at,u.name decision_by
    FROM account_research_claims c LEFT JOIN LATERAL(SELECT * FROM account_research_decisions
      WHERE claim_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)d ON true
    LEFT JOIN users u ON u.id=d.decided_by WHERE c.run_id=$1 ORDER BY c.ordinal`,[runId])).rows;
}

async function runDto(run,db=query){
  const [sampleResult,claims,qualityResult]=await Promise.all([
    db(`SELECT * FROM account_research_run_samples WHERE run_id=$1 ORDER BY ordinal`,[run.id]),
    claimRows(run.id,db),
    db('SELECT report_json FROM account_research_quality_reports WHERE run_id=$1 ORDER BY revision DESC LIMIT 1',[run.id]),
  ]);
  const samples=sampleResult.rows;const sampleMap=new Map(samples.map(item=>[Number(item.sample_id),item]));
  const {rows:roles}=await db('SELECT claim_id,sample_id,role FROM account_research_claim_samples WHERE run_id=$1 ORDER BY id',[run.id]);
  const {rows:evidence}=await db(`SELECT ce.claim_id,ce.direction,e.id evidence_id,l.id location_id,l.sample_id,l.source_kind,l.quote_text,l.locator_json,s.title
    FROM account_research_claim_evidence ce JOIN account_research_evidence e ON e.id=ce.evidence_id
    JOIN account_research_evidence_locations l ON l.evidence_id=e.id JOIN samples s ON s.id=l.sample_id
    WHERE ce.run_id=$1 ORDER BY ce.claim_id,e.id,l.id`,[run.id]);
  const sampleRef=id=>{const row=sampleMap.get(Number(id));return row?{sampleId:Number(row.sample_id),title:row.title,
    publishedAt:row.published_at,contentType:row.content_type,inclusionReasons:row.inclusion_reasons}:null;};
  const dimensions=ACCOUNT_RESEARCH_DIMENSIONS.map(dimension=>({dimensionKey:dimension.key,ordinal:dimension.ordinal,label:dimension.label,description:dimension.description,
    claims:claims.filter(item=>item.dimension_key===dimension.key).map(claim=>{
      const decisionStatus=claim.decision||'pending';const effectiveText=decisionStatus==='edited'?claim.decision_claim_text:claim.claim_text;
      const effectiveDefinition=decisionStatus==='edited'?claim.decision_definition:claim.operational_definition;
      const effectiveLimit=decisionStatus==='edited'?claim.decision_limitations:claim.limitations;
      const related=evidence.filter(item=>Number(item.claim_id)===Number(claim.id));const supportIds=new Set(related.filter(item=>item.direction==='support').map(item=>Number(item.evidence_id)));
      const quality=deriveAccountClaimQuality({claimType:claim.claim_type,supportEvidenceCount:supportIds.size,
        exactEvidenceCount:supportIds.size,eligibleCount:Number(claim.eligible_count),
        timeBucketCount:(claim.time_buckets||[]).length,sampleCoverage:run.eligible_count?Number(claim.eligible_count)/Number(run.eligible_count):0,humanDecision:decisionStatus});
      const stability=classifyAccountPattern({eligibleCount:Number(claim.eligible_count),presentCount:Number(claim.present_count),
        timeBucketCount:(claim.time_buckets||[]).length,counterexampleCount:roles.filter(item=>Number(item.claim_id)===Number(claim.id)&&item.role==='counterexample').length});
      const legacy=run.schema_version==='account-research/1.0';
      const refs=role=>legacy?[]:roles.filter(item=>Number(item.claim_id)===Number(claim.id)&&item.role===role).map(item=>sampleRef(item.sample_id)).filter(Boolean);
      return {dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,claimId:String(claim.id),dimensionKey:claim.dimension_key,
        patternCode:legacy?null:claim.pattern_code,contentGoal:legacy?null:claim.content_goal,claimType:claim.claim_type,
        claimText:effectiveText,operationalDefinition:effectiveDefinition,eligibleCount:Number(claim.eligible_count),presentCount:Number(claim.present_count),
        prevalence:claim.prevalence==null?null:Number(claim.prevalence),stability:{level:stability.level,label:STABILITY_LABELS[stability.level]},
        timeCoverage:{start:run.observation_start,end:run.observation_end,buckets:claim.time_buckets||[],label:windowLabel(run.observation_start,run.observation_end)},
        limitations:effectiveLimit,representativeSamples:refs('representative'),counterexamples:refs('counterexample'),
        sampleScope:{auditable:!legacy,eligibleSamples:refs('eligible'),presentSamples:refs('present')},
        quality:{label:quality.label,formulaVersion:quality.formulaVersion,aiConfidenceIgnored:true},
        decision:{dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,status:decisionStatus,note:claim.decision_note||null,decidedBy:claim.decision_by||null,decidedAt:claim.decision_at||null},
        causalClaimsAllowed:false,evidence:related.map(item=>({dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,evidenceId:`${item.evidence_id}:${item.location_id}`,
          direction:item.direction,sampleId:Number(item.sample_id),sampleTitle:item.title,sourceKind:item.source_kind,quoteText:item.quote_text,locator:item.locator_json}))};
    })}));
  const report=qualityResult.rows[0]?.report_json||{};const decisions=report.decisions||{};const coverage=run.coverage_json||{};
  const risks=[...(report.blockers||[]).map(item=>item.message),...(report.warnings||run.warnings_json||[])];
  const legacy=run.schema_version==='account-research/1.0';
  const insufficientMatrix={status:'insufficient',periods:['early','middle','recent','unknown'],rows:[],membershipTotal:0,uniqueSampleCount:0,limitations:['旧版研究没有可审计成员，不生成矩阵。']};
  const insufficientSaturation={ruleVersion:'saturation/1.0',status:'insufficient',reached:false,threshold:.05,batchSize:5,totalCodes:0,batches:[],observations:[],limitations:['旧版研究没有可审计编码，不计算饱和度。']};
  return {dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,schemaVersion:run.schema_version,runId:Number(run.id),version:Number(run.revision),status:run.status,
    createdAt:run.created_at,completedAt:run.completed_at,observationWindow:{start:run.observation_start,end:run.observation_end,label:windowLabel(run.observation_start,run.observation_end)},
    sampling:{mode:run.sampling_mode,eligibleCount:Number(run.eligible_count),frozenSampleCount:Number(run.frozen_sample_count),maxSamples:Number(run.max_samples),
      coverage:{publishedAt:Number(coverage.publishedAt)||0,body:Number(coverage.body)||0,media:Number(coverage.media)||0,comments:Number(coverage.comments)||0},
      items:samples.map(row=>sampleRef(row.sample_id)),warnings:run.warnings_json||[]},
    quality:{label:report.summaryLabel||'insufficient',labelText:QUALITY_LABELS[report.summaryLabel]||'数据不足',
      coverage:{sample:Number(report.coverage?.sample)||0,exactEvidence:Number(report.exactEvidenceCoverage)||0,time:Number(report.coverage?.publishedAt)||0,
        media:Number(report.coverage?.media)||0,comments:Number(report.coverage?.comments)||0},
      humanReview:{reviewed:Number(decisions.reviewed)||0,total:Number(decisions.total)||claims.length,confirmed:Number(decisions.confirmed)||0,
        edited:Number(decisions.edited)||0,rejected:Number(decisions.rejected)||0},risks:[...new Set(risks)]},
    contentMatrix:legacy?insufficientMatrix:(run.content_matrix_json||insufficientMatrix),
    saturation:legacy?insufficientSaturation:(run.saturation_json||insufficientSaturation),
    reproducibility:{samplingRuleVersion:run.sampling_rule_version,qualityFormulaVersion:run.quality_formula_version,
      modelVersion:run.model_version,promptVersion:run.prompt_version,inputDigest:run.input_sha256},dimensions};
}

async function detailDto(account,user,db=query,runLimit=20){
  const {rows:runs}=account.id?await db("SELECT * FROM account_research_runs WHERE account_id=$1 AND status='complete' ORDER BY revision DESC LIMIT $2",[account.id,runLimit]):{rows:[]};
  return {dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,account:{accountId:account.stable_key,stableKey:account.stable_key,platform:account.platform,
    platformLabel:PLATFORM_LABELS[account.platform]||account.platform,displayName:account.display_name,handle:account.handle,profileUrl:account.profile_url,
    identity:identityDto(account)},currentRunId:account.current_run_id==null?null:Number(account.current_run_id),
    runs:await Promise.all(runs.map(row=>runDto(row,db))),permissions:permissionsDto(user)};
}

async function reserveIdempotency(client,{aggregateKey,action,key,requestSha,userId}){
  const inserted=await client.query(`INSERT INTO account_research_idempotency(aggregate_key,action,idempotency_key,request_sha256,created_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,[aggregateKey,action,key,requestSha,userId]);
  if(inserted.rows[0])return {row:inserted.rows[0],created:true};
  const existing=(await client.query(`SELECT * FROM account_research_idempotency
    WHERE aggregate_key=$1 AND action=$2 AND idempotency_key=$3 FOR UPDATE`,[aggregateKey,action,key])).rows[0];
  if(!existing||existing.request_sha256!==requestSha)throw fail(409,'IDEMPOTENCY_CONFLICT','同一幂等键已绑定不同请求');
  if(existing.response_id==null)throw fail(409,'REQUEST_IN_PROGRESS','相同请求正在处理中');
  return {row:existing,created:false};
}

function baselineClaims(){return ACCOUNT_RESEARCH_DIMENSIONS.map(dimension=>({dimensionKey:dimension.key,patternCode:`insufficient_${dimension.key}`,contentGoal:null,claimType:'insufficient',claimText:null,
  operationalDefinition:null,eligibleCount:0,presentCount:0,prevalence:null,timeBuckets:[],representativeSampleIds:[],counterexampleSampleIds:[],
  limitations:'当前运行未调用 AI，尚未形成可由证据支持的账户级结论。',causalClaimsAllowed:false,eligibleSampleIds:[],presentSampleIds:[],evidence:[]}));}

function summaryLabel(claims,report){if(report.blockers?.length)return'insufficient';const labels=claims.map(item=>item.qualityLabel);
  if(labels.some(value=>value==='evidence_sufficient'))return'evidence_sufficient';if(labels.some(value=>value==='evidence_moderate'))return'evidence_moderate';
  if(labels.some(value=>value==='hypothesis_only'))return'hypothesis_only';return'insufficient';}

async function createRun(req,res,accountValue,baseRunId,deps){
  const user=await deps.currentUser(req);if(user.role!=='admin')throw fail(403,'FORBIDDEN','只有管理员可以创建或重跑账户研究');
  const raw=await readJson(req,ACCOUNT_RESEARCH_LIMITS.requestBodyBytes);const normalized=normalizeAccountRunRequest(raw);const key=idempotencyKey(req);
  const virtual=await findAccount(accountValue,deps.query);if(!virtual)throw fail(404,'NOT_FOUND','研究账户不存在');
  const persisted=await deps.tx(async client=>{let saved=virtual.id?virtual:await materializeAccount(client,virtual,user.id);
    saved=await attachNewMatchingSamples(client,saved,user.id);await appendProfileSnapshots(client,saved.id);return saved;});
  let sourceRows=await loadAccountSamples(persisted.id,deps.query);
  const plan=buildAccountSamplingPlan(sourceRows,normalized);const chosenIds=new Set(plan.items.map(item=>item.sampleId));sourceRows=sourceRows.filter(row=>chosenIds.has(Number(row.id)));
  const elementEvidence=await loadElementEvidence([...chosenIds],deps.query);for(const row of sourceRows)row.elementEvidence=elementEvidence.filter(item=>item.sampleId===Number(row.id));
  const profileEvidence=await loadProfileEvidence(persisted.id,[...chosenIds],normalized.windowStart,normalized.windowEnd,deps.query);
  const manifest=buildAccountEvidenceManifest(sourceRows,{profileEvidence});
  if(!normalized.includeComments){manifest.sources=manifest.sources.filter(item=>item.sourceKind!=='comment');plan.coverage.comments=0;
    plan.warnings.push('本次运行明确排除评论，评论覆盖记为 0，用户与社群结论不得使用评论材料。');}
  manifest.sourceCount=manifest.sources.length;manifest.characterCount=manifest.sources.reduce((sum,item)=>sum+item.quoteText.length,0);
  manifest.inputDigest=accountResearchRequestSha256(manifest.sources.map(item=>({sourceId:item.sourceId,sampleId:item.sampleId,
    sourceKind:item.sourceKind,quoteText:item.quoteText,locator:item.locator,assetId:item.assetId,captureId:item.captureId,
    elementEvidenceId:item.elementEvidenceId||null,profileSnapshotId:item.profileSnapshotId||null})));
  if(manifest.truncated)plan.warnings.push('证据清单达到安全上限，未进入清单的材料计入覆盖缺口。');
  const requestSha=accountResearchRequestSha256({account:persisted.stable_key,baseRunId,request:normalized,input:manifest.inputDigest,samples:plan.items});
  const provider=normalized.source==='ai'?await deps.activeProvider():null;
  if(normalized.source==='ai'&&!provider?.apiKey)throw fail(503,'AI_NOT_CONFIGURED','尚未配置 AI；可配置后重试，或明确选择人工研究');
  const created=await deps.tx(async client=>{
    const idem=await reserveIdempotency(client,{aggregateKey:persisted.stable_key,action:baseRunId?'rerun':'create_run',key,requestSha,userId:user.id});
    if(!idem.created){const saved=(await client.query('SELECT * FROM account_research_runs WHERE id=$1',[idem.row.response_id])).rows[0];return {run:saved,reused:true};}
    const account=(await client.query('SELECT * FROM research_accounts WHERE id=$1 FOR UPDATE',[persisted.id])).rows[0];
    if(baseRunId){const base=(await client.query('SELECT id FROM account_research_runs WHERE id=$1 AND account_id=$2 AND status=\'complete\'',[baseRunId,account.id])).rows[0];if(!base)throw fail(404,'RUN_NOT_FOUND','原研究版本不存在');}
    const revision=Number((await client.query('SELECT COALESCE(max(revision),0)+1 revision FROM account_research_runs WHERE account_id=$1',[account.id])).rows[0].revision);
    let generated={claims:baselineClaims(),provider:'manual',modelName:'manual',modelVersion:'manual'};
    if(normalized.source==='ai'){
      try{generated=await deps.requestAnalysis({manifest,samples:sourceRows,provider});}
      catch(error){const safe=safeAnalysisError(error);const status=safe.code==='AI_TIMEOUT'?504:safe.code==='AI_HTTP_429'?429:502;throw fail(status,safe.code,safe.message.replace('拆解','账户研究'));}
    }
    const inserted=(await client.query(`INSERT INTO account_research_runs(account_id,base_run_id,revision,status,source,observation_start,observation_end,
        max_samples,include_comments,sampling_mode,eligible_count,frozen_sample_count,coverage_json,warnings_json,normalized_request,input_sha256,
        schema_version,dto_version,sampling_rule_version,quality_formula_version,prompt_version,model_provider,model_name,model_version,requested_by)
      VALUES($1,$2,$3,'building',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)RETURNING *`,[
      account.id,baseRunId,revision,normalized.source,normalized.windowStart,normalized.windowEnd,normalized.maxSamples,normalized.includeComments,plan.mode,
      plan.eligibleCount,plan.selectedCount,JSON.stringify(plan.coverage),JSON.stringify(plan.warnings),JSON.stringify(normalized),requestSha,
      ACCOUNT_RESEARCH_SCHEMA_VERSION,ACCOUNT_RESEARCH_DTO_VERSION,ACCOUNT_SAMPLING_RULE_VERSION,ACCOUNT_QUALITY_FORMULA_VERSION,
      normalized.source==='ai'?ACCOUNT_RESEARCH_PROMPT_VERSION:null,generated.provider,generated.modelName,generated.modelVersion,user.id])).rows[0];
    for(const item of plan.items){const row=sourceRows.find(value=>Number(value.id)===item.sampleId);await client.query(`INSERT INTO account_research_run_samples(
        run_id,account_id,sample_id,ordinal,title,published_at,content_type,inclusion_reasons,time_bucket,performance_band,performance_basis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11)`,[inserted.id,account.id,item.sampleId,item.ordinal,row?.title||null,item.publishedAt,item.contentType,item.inclusionReasons,item.timeBucket,item.performanceBand,item.performanceBasis]);}
    const manifestById=new Map(manifest.sources.map(item=>[item.sourceId,item]));const usedIds=new Set(generated.claims.flatMap(item=>item.evidence.map(value=>value.sourceId)));
    const canonicalRows=deduplicateAccountEvidence([...usedIds].map(sourceId=>{const item=manifestById.get(sourceId);return {sampleId:item.sampleId,sourceId,item,sourceKind:item.sourceKind,content:item.quoteText,locator:item.locator};}));
    const evidenceBySource=new Map();
    for(const canonical of canonicalRows){const evidence=(await client.query(`INSERT INTO account_research_evidence(run_id,account_id,sample_id,canonical_text,content_sha256)
        VALUES($1,$2,$3,$4,$5)RETURNING id`,[inserted.id,account.id,canonical.sampleId,canonical.content,canonical.contentSha256])).rows[0];
      for(const sourceId of canonical.sourceIds){const source=manifestById.get(sourceId);await client.query(`INSERT INTO account_research_evidence_locations(
          run_id,evidence_id,sample_id,source_capture_id,asset_id,source_element_evidence_id,profile_snapshot_id,source_id,source_kind,quote_text,locator_json,locator_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,[inserted.id,evidence.id,source.sampleId,source.captureId,source.assetId,
        source.elementEvidenceId||null,source.profileSnapshotId||null,source.sourceId,source.sourceKind,source.quoteText,JSON.stringify(source.locator),
        accountResearchRequestSha256({sourceId:source.sourceId,locator:source.locator})]);evidenceBySource.set(sourceId,evidence.id);}}
    const reportClaims=[];
    for(const [index,claim]of generated.claims.entries()){
      const supportCount=new Set(claim.evidence.filter(item=>item.direction==='support').map(item=>evidenceBySource.get(item.sourceId))).size;
      const quality=deriveAccountClaimQuality({claimType:claim.claimType,supportEvidenceCount:supportCount,exactEvidenceCount:supportCount,
        eligibleCount:claim.eligibleCount,timeBucketCount:claim.timeBuckets.length,sampleCoverage:plan.eligibleCount?claim.eligibleCount/plan.eligibleCount:0});
      const saved=(await client.query(`INSERT INTO account_research_claims(run_id,account_id,dimension_key,pattern_code,content_goal,ordinal,claim_type,claim_text,operational_definition,
          eligible_count,present_count,prevalence,time_buckets,limitations,quality_label,quality_formula_version,quality_reason_codes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14,$15,$16,$17::text[])RETURNING id`,[
        inserted.id,account.id,claim.dimensionKey,claim.patternCode||`insufficient_${claim.dimensionKey}`,claim.contentGoal??null,index+1,claim.claimType,claim.claimText,claim.operationalDefinition,claim.eligibleCount,claim.presentCount,
        claim.prevalence,claim.timeBuckets,claim.limitations,quality.label,quality.formulaVersion,quality.reasonCodes])).rows[0];
      for(const [role,ids]of [['eligible',claim.eligibleSampleIds],['present',claim.presentSampleIds],['representative',claim.representativeSampleIds],['counterexample',claim.counterexampleSampleIds]])for(const sampleId of ids)
        await client.query('INSERT INTO account_research_claim_samples(run_id,claim_id,account_id,sample_id,role)VALUES($1,$2,$3,$4,$5)',[inserted.id,saved.id,account.id,sampleId,role]);
      for(const link of claim.evidence)await client.query(`INSERT INTO account_research_claim_evidence(run_id,claim_id,evidence_id,direction)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[inserted.id,saved.id,evidenceBySource.get(link.sourceId),link.direction]);
      reportClaims.push({qualityLabel:quality.label,decision:null});
    }
    const report=deriveAccountResearchQuality({identity:{quality:account.identity_quality,needsReview:account.needs_review},samplingPlan:plan,claims:reportClaims});
    report.summaryLabel=summaryLabel(reportClaims,report);report.exactEvidenceCoverage=usedIds.size?1:0;
    await client.query(`INSERT INTO account_research_quality_reports(account_id,run_id,revision,formula_version,report_json,created_by)
      VALUES($1,$2,1,$3,$4::jsonb,$5)`,[account.id,inserted.id,ACCOUNT_QUALITY_FORMULA_VERSION,JSON.stringify(report),user.id]);
    const frozen=plan.items.map(item=>({...item,sampleId:item.sampleId,contentType:item.contentType,publishedAt:item.publishedAt}));
    const contentMatrix=buildAccountContentMatrix(generated.claims,frozen,{start:normalized.windowStart,end:normalized.windowEnd});
    const saturation=buildAccountSaturation(generated.claims,frozen);
    const completed=(await client.query("UPDATE account_research_runs SET status='complete',completed_at=now(),content_matrix_json=$2::jsonb,saturation_json=$3::jsonb WHERE id=$1 AND status='building' RETURNING *",[inserted.id,JSON.stringify(contentMatrix),JSON.stringify(saturation)])).rows[0];
    await client.query('INSERT INTO account_research_selections(account_id,run_id,reason,selected_by)VALUES($1,$2,$3,$4)',[account.id,inserted.id,baseRunId?'rerun_complete':'run_complete',user.id]);
    await client.query('UPDATE research_accounts SET current_run_id=$2,updated_at=now() WHERE id=$1',[account.id,inserted.id]);
    await client.query('UPDATE account_research_idempotency SET response_kind=\'run\',response_id=$1,response_status=201 WHERE id=$2',[inserted.id,idem.row.id]);
    return {run:completed,account,reused:false};
  });
  const account=created.account||(await deps.query('SELECT * FROM research_accounts WHERE id=$1',[created.run.account_id])).rows[0];
  sendJson(res,created.reused?200:201,{dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,accountId:account.stable_key,run:await runDto(created.run,deps.query),currentRunId:Number(account.current_run_id||created.run.id)});
}

async function saveDecision(req,res,params,deps){
  const user=await deps.currentUser(req);if(!['reviewer','admin'].includes(user.role))throw fail(403,'FORBIDDEN','只有评审委员或管理员可以审核账户结论');
  const accountValue=strictAccountId(params.accountId),runId=strictPositiveId(params.runId,'研究版本'),claimId=strictPositiveId(params.claimId,'账户结论');
  const decision=normalizeAccountClaimDecision(await readJson(req,ACCOUNT_RESEARCH_LIMITS.requestBodyBytes));const key=idempotencyKey(req);
  const account=await findAccount(accountValue,deps.query);if(!account?.id)throw fail(404,'CLAIM_NOT_FOUND','账户结论不存在');
  const claim=(await deps.query(`SELECT c.* FROM account_research_claims c JOIN account_research_runs r ON r.id=c.run_id
    WHERE c.id=$1 AND c.run_id=$2 AND c.account_id=$3 AND r.status='complete'`,[claimId,runId,account.id])).rows[0];
  if(!claim)throw fail(404,'CLAIM_NOT_FOUND','账户结论不存在');
  if(decision.decision==='edited'&&claim.claim_type==='insufficient')throw fail(409,'INSUFFICIENT_CLAIM_EDIT_FORBIDDEN','数据不足结论不能直接编辑为实质结论；请重跑研究，或确认/驳回当前判断');
  if(decision.decision==='edited')validateAccountClaimLanguage({claimType:claim.claim_type,claimText:decision.claimText,
    operationalDefinition:decision.operationalDefinition,limitations:decision.limitations});
  const requestSha=accountResearchRequestSha256({account:account.stable_key,runId,claimId,decision});
  const saved=await deps.tx(async client=>{const idem=await reserveIdempotency(client,{aggregateKey:`claim:${claimId}`,action:'decision',key,requestSha,userId:user.id});
    if(!idem.created)return {id:idem.row.response_id,reused:true};
    const row=(await client.query(`INSERT INTO account_research_decisions(account_id,run_id,claim_id,decision,claim_text,operational_definition,
        limitations,note,idempotency_key,request_sha256,decided_by,decided_by_role)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)RETURNING id`,[
      account.id,runId,claimId,decision.decision,decision.claimText,decision.operationalDefinition,decision.limitations,decision.note,key,requestSha,user.id,user.role])).rows[0];
    const rows=await claimRows(runId,client.query.bind(client));const reportClaims=rows.map(item=>({qualityLabel:item.quality_label,decision:item.decision||'pending'}));
    const run=(await client.query('SELECT * FROM account_research_runs WHERE id=$1',[runId])).rows[0];const plan={mode:run.sampling_mode,eligibleCount:run.eligible_count,
      selectedCount:run.frozen_sample_count,coverage:run.coverage_json,warnings:run.warnings_json};const report=deriveAccountResearchQuality({identity:{quality:account.identity_quality,needsReview:account.needs_review},samplingPlan:plan,claims:reportClaims});
    report.summaryLabel=summaryLabel(reportClaims,report);report.exactEvidenceCoverage=(await client.query(`SELECT CASE WHEN count(*)=0 THEN 0 ELSE 1 END value FROM account_research_evidence_locations WHERE run_id=$1`,[runId])).rows[0].value;
    const nextRevision=Number((await client.query('SELECT COALESCE(max(revision),0)+1 value FROM account_research_quality_reports WHERE run_id=$1',[runId])).rows[0].value);
    await client.query('INSERT INTO account_research_quality_reports(account_id,run_id,revision,formula_version,report_json,created_by)VALUES($1,$2,$3,$4,$5::jsonb,$6)',
      [account.id,runId,nextRevision,ACCOUNT_QUALITY_FORMULA_VERSION,JSON.stringify(report),user.id]);
    await client.query("UPDATE account_research_idempotency SET response_kind='decision',response_id=$1,response_status=201 WHERE id=$2",[row.id,idem.row.id]);return {id:row.id,reused:false};});
  const detail=await runDto((await deps.query('SELECT * FROM account_research_runs WHERE id=$1',[runId])).rows[0],deps.query);
  const claimDto=detail.dimensions.flatMap(item=>item.claims).find(item=>item.claimId===String(claimId));sendJson(res,saved.reused?200:201,{dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,
    accountId:account.stable_key,runId,claimId:String(claimId),decision:claimDto.decision,claim:claimDto});
}

export function mount(router,overrides={}){
  const deps={query:overrides.query||query,tx:overrides.tx||tx,currentUser:overrides.currentUser||currentUser,
    activeProvider:overrides.activeProvider||activeProvider,requestAnalysis:overrides.requestAnalysis||requestAccountResearchAnalysis};
  router.get('/api/research-accounts/config',wrapped(async(req,res)=>{const user=await deps.currentUser(req);sendJson(res,200,{dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,
    dimensions:ACCOUNT_RESEARCH_DIMENSIONS.map(item=>({dimensionKey:item.key,ordinal:item.ordinal,label:item.label,description:item.description})),
    claimTypes:[...ACCOUNT_CLAIM_TYPES],qualityLabels:[...ACCOUNT_QUALITY_LABELS],permissions:permissionsDto(user),causalClaimsAllowed:false});}));
  router.get('/api/research-accounts',wrapped(async(req,res,_params,url)=>{const user=await deps.currentUser(req);strictQuery(url,['page','pageSize']);
    const page=intQuery(url,'page',1,1,100000),pageSize=intQuery(url,'pageSize',50,1,100);const rows=await discoverAccounts(deps.query);const slice=rows.slice((page-1)*pageSize,page*pageSize);
    const items=[];for(const row of slice){let current=null;if(row.current_run_id){const run=(await deps.query('SELECT * FROM account_research_runs WHERE id=$1',[row.current_run_id])).rows[0];if(run)current=await runDto(run,deps.query);}
      items.push({dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,accountId:row.stable_key,stableKey:row.stable_key,platform:row.platform,
        platformLabel:PLATFORM_LABELS[row.platform]||row.platform,displayName:row.display_name,handle:row.handle,identity:identityDto(row),
        currentRunId:row.current_run_id==null?null:Number(row.current_run_id),versionCount:Number(row.version_count)||0,
        frozenSampleCount:current?.sampling.frozenSampleCount||0,observationWindow:current?.observationWindow||null,quality:current?.quality||null,updatedAt:row.updated_at||null});}
    sendJson(res,200,{dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,items,total:rows.length,page,pageSize,permissions:permissionsDto(user)});}));
  router.get('/api/research-accounts/:accountId',wrapped(async(req,res,params,url)=>{const user=await deps.currentUser(req);strictQuery(url,['runLimit']);
    const account=await findAccount(strictAccountId(params.accountId),deps.query);if(!account)throw fail(404,'NOT_FOUND','研究账户不存在');
    sendJson(res,200,await detailDto(account,user,deps.query,intQuery(url,'runLimit',20,1,50)));}));
  router.post('/api/research-accounts/:accountId/runs',wrapped((req,res,params)=>createRun(req,res,strictAccountId(params.accountId),null,deps)));
  router.post('/api/research-accounts/:accountId/runs/:runId/rerun',wrapped((req,res,params)=>createRun(req,res,strictAccountId(params.accountId),strictPositiveId(params.runId,'研究版本'),deps)));
  router.post('/api/research-accounts/:accountId/runs/:runId/claims/:claimId/decisions',wrapped((req,res,params)=>saveDecision(req,res,params,deps)));
}
