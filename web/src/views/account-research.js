/** 账户研究 v3：账户级冻结抽样、证据结论与追加式人工审核。 */
import { api } from '../api.js';
import { esc } from '../util.js';
import { toast } from '../toast.js';
import {
  assertAccountResearchConfigDto,
  assertAccountResearchDecisionMutationDto,
  assertAccountResearchDetailDto,
  assertAccountResearchListDto,
  assertAccountResearchRunMutationDto,
} from '../account-research-contract.js';

const CLAIM_LABELS={observation:'直接观察',interpretation:'结构解释',hypothesis:'效果假设',insufficient:'数据不足'};
const DECISION_LABELS={pending:'待审核',confirmed:'已确认',edited:'已修订',rejected:'已驳回'};
const SOURCE_LABELS={body:'正文',image:'图片',video:'视频',comment:'评论',profile:'账户资料'};
let host=null;
let active=false;
let config=null;
let accounts=[];
let selectedAccountId='';
let detail=null;
let currentRunId=null;
let currentDimensionKey='';
let listSeq=0;
let detailSeq=0;
let runBusy=false;
const claimBusy=new Set();
let evidenceReturnFocus=null;
let bodyOverflow='';

function el(selector){return host?.querySelector(selector)||null;}
function pct(value){return `${Math.round(Math.max(0,Math.min(1,Number(value)||0))*100)}%`;}
function date(value){if(!value)return '—';const parsed=new Date(value);return Number.isNaN(parsed.valueOf())?String(value):parsed.toLocaleDateString('zh-CN');}
function checked(validator,value,label){try{return validator(value);}catch(error){const mismatch=/version mismatch/iu.test(error.message||'');throw Object.assign(new Error(mismatch?`${label}的数据版本不匹配，请重试或等待服务升级。`:`${label}的数据结构不完整，请刷新后重试。`),{code:mismatch?'DTO_VERSION_MISMATCH':'DTO_SHAPE_MISMATCH',cause:error});}}
function failureMessage(error,fallback){return Number(error?.status)===403?'权限已变化，当前操作未保存。请刷新账户研究后重试。':error?.message||fallback;}

export function leaveAccountResearch(){
  active=false;detailSeq+=1;listSeq+=1;closeEvidence(false);
}

export async function openAccountResearch(container){
  host=container;active=true;
  if(!host.dataset.accountResearchReady){scaffold();bind();host.dataset.accountResearchReady='1';}
  await loadAccountIndex();
}

function scaffold(){
  host.innerHTML=`<div class="account-research-shell">
    <header class="account-research-head"><div><span>账户级证据研究</span><h1>账户研究</h1><p>把稳定账户身份、冻结作品和精确证据放在同一个可审核版本中。</p></div><aside><b>研究边界</b><span>AI 结果是辅助数据；n/N 只指当前冻结样本中可判断的作品。</span></aside></header>
    <div class="account-research-workspace">
      <aside class="account-research-index" aria-label="研究账户列表"><header><div><b>研究账户</b><span id="accountResearchCount">—</span></div><button type="button" data-account-reload>刷新</button></header><div id="accountResearchList" class="account-research-list" aria-live="polite"></div></aside>
      <main id="accountResearchDetail" class="account-research-detail" aria-live="polite"><div class="account-research-state"><i></i><b>正在读取账户研究…</b></div></main>
    </div>
    <div class="account-evidence-backdrop" data-evidence-close hidden></div><aside class="account-evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="accountEvidenceTitle" hidden><header><div><span>可回溯证据</span><h2 id="accountEvidenceTitle">精确证据</h2></div><button type="button" data-evidence-close aria-label="关闭证据查看器">×</button></header><div id="accountEvidenceBody"></div></aside>
  </div>`;
}

function bind(){
  host.addEventListener('click',event=>{
    if(event.target.closest('[data-account-reload]')){loadAccountIndex();return;}
    if(event.target.closest('[data-account-retry-list]')){loadAccountIndex();return;}
    if(event.target.closest('[data-account-retry-detail]')){loadAccountDetail(selectedAccountId);return;}
    const accountButton=event.target.closest('[data-research-account]');if(accountButton){selectAccount(accountButton.dataset.researchAccount);return;}
    const versionButton=event.target.closest('[data-account-run]');if(versionButton){selectRun(Number(versionButton.dataset.accountRun),versionButton);return;}
    const dimensionButton=event.target.closest('[data-account-dimension]');if(dimensionButton){selectDimension(dimensionButton.dataset.accountDimension,dimensionButton);return;}
    const evidenceButton=event.target.closest('[data-account-evidence]');if(evidenceButton){openEvidence(evidenceButton.dataset.accountEvidence,evidenceButton);return;}
    if(event.target.closest('[data-evidence-close]')){closeEvidence();return;}
  });
  host.addEventListener('submit',event=>{
    if(event.target.matches('[data-account-run-form]')){event.preventDefault();submitRun(event.target,event.submitter);return;}
    if(event.target.matches('[data-account-claim-form]')){event.preventDefault();submitDecision(event.target,event.submitter);}
  });
  host.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!el('.account-evidence-drawer')?.hidden){event.preventDefault();closeEvidence();return;}
    const tab=event.target.closest('[data-account-dimension],[data-account-run]');if(!tab||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();const selector=tab.hasAttribute('data-account-dimension')?'[data-account-dimension]':'[data-account-run]',tabs=[...host.querySelectorAll(selector)].filter(node=>!node.disabled),index=tabs.indexOf(tab),delta=['ArrowRight','ArrowDown'].includes(event.key)?1:-1,next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+delta+tabs.length)%tabs.length];next?.click();next?.focus();
  });
}

async function loadAccountIndex(){
  const seq=++listSeq;detailSeq+=1;config=null;accounts=[];detail=null;selectedAccountId='';
  el('#accountResearchCount').textContent='读取中';el('#accountResearchList').innerHTML='<div class="account-research-list-state"><i></i><span>正在读取账户列表…</span></div>';paintDetailState('正在校验账户研究配置…','loading');
  try{
    const [nextConfig,index]=await Promise.all([api.accountResearchConfig(),api.researchAccounts({page:1,pageSize:50})]);
    if(!active||seq!==listSeq)return;checked(assertAccountResearchConfigDto,nextConfig,'账户研究配置');checked(assertAccountResearchListDto,index,'账户列表');
    const keys=(nextConfig.dimensions||[]).map(item=>item.dimensionKey);if(keys.length!==8||new Set(keys).size!==8)throw new Error('账户研究维度配置不完整。');
    config=nextConfig;accounts=index.items||[];paintAccountList();
    if(!accounts.length){paintDetailState('还没有可查看的账户研究。先将同一账户的公开作品归档，再由管理员创建冻结研究。','empty');return;}
    await selectAccount(accounts[0].accountId);
  }catch(error){if(!active||seq!==listSeq)return;accounts=[];detail=null;el('#accountResearchCount').textContent='读取失败';el('#accountResearchList').innerHTML=`<div class="account-research-list-state error"><b>账户列表没有打开</b><span>${esc(error.message||'读取失败')}</span><button type="button" data-account-retry-list>重试</button></div>`;paintDetailState('列表恢复后才会读取账户详情。','error');}
}

function paintAccountList(){
  el('#accountResearchCount').textContent=`${accounts.length} 个`;
  el('#accountResearchList').innerHTML=accounts.map(item=>`<button type="button" class="account-research-list-item ${item.accountId===selectedAccountId?'on':''}" data-research-account="${esc(item.accountId)}" aria-pressed="${item.accountId===selectedAccountId}"><span><i>${esc(item.platformLabel||item.platform)}</i><em class="${item.identity?.needsReview?'warn':''}">${esc(item.identity?.label||'身份待确认')}</em></span><b>${esc(item.displayName||'未命名账户')}</b><small>${item.handle?`@${esc(item.handle)}`:'未取得稳定 handle'} · ${Number(item.versionCount||0)} 个版本</small><footer><span>${Number(item.frozenSampleCount||0)} 篇冻结样本</span><span>${esc(item.quality?.labelText||'待评估')}</span></footer></button>`).join('')||'<div class="account-research-list-state"><b>暂无账户研究</b></div>';
}

async function selectAccount(accountId){
  selectedAccountId=String(accountId||'');paintAccountList();await loadAccountDetail(selectedAccountId);
}

async function loadAccountDetail(accountId){
  if(!accountId)return;const seq=++detailSeq;detail=null;currentRunId=null;currentDimensionKey=config?.dimensions?.[0]?.dimensionKey||'';paintDetailState('正在读取账户身份、冻结样本和研究版本…','loading');
  try{
    const value=await api.researchAccount(accountId);
    if(!active||seq!==detailSeq||selectedAccountId!==accountId)return;checked(assertAccountResearchDetailDto,value,'账户详情');
    detail=value;currentRunId=Number(value.currentRunId||(value.runs||[])[0]?.runId)||null;paintAccountList();paintDetail();
  }catch(error){if(!active||seq!==detailSeq||selectedAccountId!==accountId)return;detail=null;currentRunId=null;paintDetailError(error);}
}

function paintDetailState(message,state){
  const target=el('#accountResearchDetail');if(!target)return;target.innerHTML=`<div class="account-research-state ${state==='error'?'error':''}">${state==='loading'?'<i></i>':''}<b>${esc(message)}</b></div>`;
}

function paintDetailError(error){
  const title=Number(error?.status)===404?'账户详情已不存在':'账户详情没有打开';
  el('#accountResearchDetail').innerHTML=`<div class="account-research-state error"><b>${title}</b><span>${esc(error?.message||'读取失败')}</span><button type="button" data-account-retry-detail>重试详情</button></div>`;
}

function selectedRun(){return detail?.runs?.find(item=>Number(item.runId)===Number(currentRunId))||null;}
function selectRun(runId,button){if(!detail?.runs?.some(item=>Number(item.runId)===Number(runId)))return;currentRunId=Number(runId);currentDimensionKey=config?.dimensions?.[0]?.dimensionKey||'';paintDetail();requestAnimationFrame(()=>el(`[data-account-run="${runId}"]`)?.focus({preventScroll:true})||button?.focus());}
function selectDimension(key,button){if(!config?.dimensions?.some(item=>item.dimensionKey===key))return;currentDimensionKey=key;paintDimensions();requestAnimationFrame(()=>el(`[data-account-dimension="${CSS.escape(key)}"]`)?.focus({preventScroll:true})||button?.focus());}

function paintDetail(){
  if(!detail)return;const account=detail.account||{},run=selectedRun(),permissions=detail.permissions||config?.permissions||{};
  if(!run){el('#accountResearchDetail').innerHTML=`<section class="account-research-no-version"><span>${esc(account.platformLabel||account.platform||'账户')}</span><h2>${esc(account.displayName||'未命名账户')}</h2><b>这个账户还没有研究版本</b><p>页面不会用单篇十五维拆解冒充账户结论。${permissions.canCreateRun?'可以用下方配置创建首个冻结版本。':'请联系管理员创建首个冻结版本。'}</p>${permissions.canCreateRun?runForm(null):'<span class="account-readonly-note">当前角色只读</span>'}</section>`;return;}
  const identityWarn=account.identity?.needsReview?'<div class="account-risk-banner"><b>身份待人工确认</b><span>当前仅能使用显示名称回退，不会自动合并同名账户。</span></div>':'';
  el('#accountResearchDetail').innerHTML=`<section class="account-research-overview">
    <header><div><span>${esc(account.platformLabel||account.platform)} · ${esc(account.identity?.label||'身份待确认')}</span><h2>${esc(account.displayName||'未命名账户')}</h2><p>${account.handle?`@${esc(account.handle)} · `:''}${esc(account.stableKey||account.accountId||'')}</p></div>${permissions.canCreateRun?'<button type="button" data-account-run-jump>运行配置在下方</button>':'<span class="account-readonly-note">当前角色只读</span>'}</header>${identityWarn}
    <div class="account-quality-summary"><article><span>身份可靠性</span><b>${esc(account.identity?.label||'待确认')}</b><small>${account.identity?.needsReview?'名称回退不作为自动合并依据':'平台稳定标识已解析'}</small></article><article><span>观察窗口</span><b>${esc(run.observationWindow?.label||`${date(run.observationWindow?.start)}—${date(run.observationWindow?.end)}`)}</b><small>固定窗口，不随新作品自动漂移</small></article><article><span>冻结样本</span><b>${Number(run.sampling?.frozenSampleCount||0)} / ${Number(run.sampling?.eligibleCount||0)} 篇</b><small>${run.sampling?.mode==='census'?'全量可用作品':'时间、形式与表现分层抽样'}</small></article><article><span>人工进度</span><b>${Number(run.quality?.humanReview?.reviewed||0)} / ${Number(run.quality?.humanReview?.total||8)} 项</b><small>确认 ${Number(run.quality?.humanReview?.confirmed||0)} · 修订 ${Number(run.quality?.humanReview?.edited||0)} · 驳回 ${Number(run.quality?.humanReview?.rejected||0)}</small></article></div>
    <div class="account-coverage-bars">${coverageBar('正文',run.sampling?.coverage?.body)}${coverageBar('发布时间',run.sampling?.coverage?.publishedAt)}${coverageBar('媒体',run.sampling?.coverage?.media)}${coverageBar('评论',run.sampling?.coverage?.comments)}</div>
    <div class="account-risk-list"><b>不可判断与降级风险</b>${[...(run.sampling?.warnings||[]),...(run.quality?.risks||[])].map(item=>`<span>${esc(item)}</span>`).join('')}</div>
  </section>
  <nav class="account-version-tabs" role="tablist" aria-label="账户研究版本">${detail.runs.map(item=>`<button type="button" role="tab" data-account-run="${item.runId}" aria-selected="${item.runId===run.runId}" tabindex="${item.runId===run.runId?0:-1}" class="${item.runId===run.runId?'on':''}"><b>版本 ${item.version}</b><span>${date(item.completedAt)} · ${esc(item.status==='complete'?'已完成':item.status)}</span></button>`).join('')}</nav>
  <section class="account-research-version"><header><div><span>${esc(run.dtoVersion)} · ${esc(run.schemaVersion||'未标记存储版本')}</span><h2>八个账户研究维度</h2><p>观察、解释、假设和数据不足分开陈述，每条结论都回到精确证据与反例。</p></div><aside><b>${esc(run.quality?.labelText||'证据待评估')}</b><span>公开数据不支持因果声称</span></aside></header><div id="accountResearchDimensions"></div></section>
  ${contentMatrixHtml(run.contentMatrix)}
  ${saturationHtml(run.saturation)}
  <section class="account-sampling-panel"><header><div><span>可审计抽样</span><h2>冻结样本与运行复现</h2></div><b>${Number(run.sampling?.frozenSampleCount||0)} 篇</b></header><div class="account-sample-grid">${(run.sampling?.items||[]).map(item=>`<article><span>${esc(item.contentType||'作品')} · ${date(item.publishedAt)}</span><b>${esc(item.title||`样本 #${item.sampleId}`)}</b><small>${(item.inclusionReasons||[]).map(esc).join(' · ')}</small></article>`).join('')}</div><footer><span>抽样规则 ${esc(run.reproducibility?.samplingRuleVersion||'—')}</span><span>质量公式 ${esc(run.reproducibility?.qualityFormulaVersion||'—')}</span><span>提示词 ${esc(run.reproducibility?.promptVersion||'—')}</span><span>输入摘要 ${esc(run.reproducibility?.inputDigest||'—')}</span></footer></section>
  ${permissions.canCreateRun?runForm(run):''}`;
  paintDimensions();
}

function coverageBar(label,value){return `<div><span><b>${esc(label)}</b><em>${pct(value)}</em></span><i><u style="width:${pct(value)}"></u></i></div>`;}
function contentMatrixHtml(matrix={}){return `<section class="account-depth-card account-content-matrix"><header><div><span>内容支柱矩阵</span><h2>支柱 × 目标 × 形式 × 阶段</h2></div><b>${Number(matrix.uniqueSampleCount||0)} 篇去重作品</b></header>${matrix.status==='measured'?`<div class="account-matrix-table" role="table" aria-label="内容支柱矩阵">${(matrix.rows||[]).map(row=>`<article role="row"><header><b>${esc(row.patternCode)}</b><span>${esc(row.contentGoal)}</span><em>${Number(row.count||0)} 个成员</em></header><div>${(row.cells||[]).map(cell=>`<span role="cell"><b>${esc(cell.format)}</b><small>${esc(cell.period)} · ${Number(cell.count||0)} 篇</small></span>`).join('')}</div></article>`).join('')}</div><footer>成员计数 ${Number(matrix.membershipTotal||0)} · 全矩阵去重 ${Number(matrix.uniqueSampleCount||0)}</footer>`:'<p class="account-depth-empty">当前没有可审计的内容供给成员，矩阵标记为数据不足。</p>'}</section>`;}
function saturationHtml(saturation={}){const batches=saturation.batches||[],reached=saturation.status==='measured'&&saturation.reached,reason=saturation.status!=='insufficient'?(reached?'当前冻结样本已达到':'当前冻结样本未达到'):batches.length<3?`样本批次不足（当前 ${batches.length}，至少 3）`:Number(saturation.totalCodes||0)===0?'没有通过校验且命中作品的编码':'当前材料不足';return `<section class="account-depth-card account-saturation-card"><header><div><span>编码饱和度</span><h2>${esc(reason)}</h2></div><b>${esc(saturation.ruleVersion||'saturation/1.0')}</b></header><div class="account-saturation-batches">${batches.map(batch=>`<span><b>批次 ${Number(batch.batch)}</b><small>新增 ${Number(batch.newCodeCount)} · 累计 ${Number(batch.cumulativeCodeCount)} · ${pct(batch.newCodeRatio)}</small></span>`).join('')||'<span><b>暂无可测批次</b><small>至少需要三个非空样本批次</small></span>'}</div><div class="account-saturation-limitations">${(saturation.limitations||['仅描述当前冻结编码覆盖。']).map(item=>`<p>${esc(item)}</p>`).join('')}</div></section>`;}

function paintDimensions(){
  const mount=el('#accountResearchDimensions'),run=selectedRun();if(!mount||!run)return;const ordered=(config?.dimensions||[]).map(dimension=>run.dimensions?.find(item=>item.dimensionKey===dimension.dimensionKey)||{...dimension,claims:[]});
  if(!ordered.some(item=>item.dimensionKey===currentDimensionKey))currentDimensionKey=ordered[0]?.dimensionKey||'';
  const current=ordered.find(item=>item.dimensionKey===currentDimensionKey)||ordered[0];
  mount.innerHTML=`<nav class="account-dimension-tabs" role="tablist" aria-label="账户研究维度">${ordered.map(item=>`<button type="button" role="tab" id="account-dimension-${esc(item.dimensionKey)}" aria-controls="accountDimensionPanel" aria-selected="${item.dimensionKey===current.dimensionKey}" tabindex="${item.dimensionKey===current.dimensionKey?0:-1}" data-account-dimension="${esc(item.dimensionKey)}" data-dimension-key="${esc(item.dimensionKey)}" class="${item.dimensionKey===current.dimensionKey?'on':''}"><i>${String(item.ordinal).padStart(2,'0')}</i><span><b>${esc(item.label)}</b><small>${esc(item.dimensionKey)}</small></span></button>`).join('')}</nav><section id="accountDimensionPanel" class="account-dimension-panel" role="tabpanel" aria-labelledby="account-dimension-${esc(current.dimensionKey)}"><header><span>${String(current.ordinal).padStart(2,'0')} / 08</span><div><h3>${esc(current.label)}</h3><p>${esc(current.description||'')}</p></div></header><div class="account-claim-list">${(current.claims||[]).map(claim=>claimHtml(claim,run)).join('')||'<div class="account-research-state"><b>该维度暂无可审核结论</b></div>'}</div></section>`;
}

function claimHtml(claim,run){
  const decision=claim.decision||{status:'pending'},permissions=detail?.permissions||config?.permissions||{},busy=claimBusy.has(claim.claimId),isHypothesis=claim.claimType==='hypothesis';
  const eligible=sampleTitles(claim.sampleScope?.eligibleSamples,claim.sampleScope?.auditable===false?'旧版结论无可审计成员':'没有可判断作品');
  const present=sampleTitles(claim.sampleScope?.presentSamples,'没有命中特征作品');
  return `<article class="account-claim account-claim-${esc(claim.claimType)}" data-claim-id="${esc(claim.claimId)}"><header><span class="account-claim-type">${esc(CLAIM_LABELS[claim.claimType]||claim.claimType)}</span><span class="account-decision-status ${esc(decision.status||'pending')}">${esc(DECISION_LABELS[decision.status]||decision.status)}</span><b>${Number(claim.presentCount||0)} / ${Number(claim.eligibleCount||0)}</b></header><small class="account-pattern-code">${esc(claim.patternCode||'未编码')}${claim.contentGoal?` · ${esc(claim.contentGoal)}`:''}</small><h4>${esc(claim.claimText||'当前证据不足，暂不形成账户级结论。')}</h4>${isHypothesis?'<p class="account-causal-warning">这是待验证效果假设，不代表因果。</p>':''}<dl><div><dt>稳定性</dt><dd>${esc(claim.stability?.label||'待评估')}</dd></div><div><dt>时间覆盖</dt><dd>${esc(claim.timeCoverage?.label||'—')}</dd></div><div><dt>操作定义</dt><dd>${esc(claim.operationalDefinition||'尚未定义')}</dd></div><div><dt>证据等级</dt><dd>${esc(claim.quality?.label||'待评估')}</dd></div></dl><section class="account-claim-limits"><b>限制</b><p>${esc(claim.limitations||'未记录限制')}</p></section><details class="account-sample-scope"><summary>查看样本范围 · 命中 ${Number(claim.presentCount||0)} / 可判断 ${Number(claim.eligibleCount||0)}</summary><div><section><b>全部可判断作品</b>${eligible}</section><section><b>命中特征作品</b>${present}</section></div></details><div class="account-claim-samples"><section><b>代表作品</b>${sampleTitles(claim.representativeSamples,'无可用代表作品')}</section><section class="counter"><b>反例</b>${sampleTitles(claim.counterexamples,'当前未取得可判断反例')}</section></div><button type="button" class="account-evidence-button" data-account-evidence="${esc(claim.claimId)}">查看 ${Number(claim.evidence?.length||0)} 条精确证据 <span>支持 ${Number(claim.evidence?.filter(item=>item.direction==='support').length||0)} · 反驳 ${Number(claim.evidence?.filter(item=>item.direction!=='support').length||0)}</span></button>${permissions.canReview?reviewForm(claim,busy):`<p class="account-review-readonly">只读：确认、修订与驳回仅对评审委员和管理员开放。</p>`}</article>`;
}
function sampleTitles(items,empty){return(items||[]).map(item=>`<span>${esc(item.title||`样本 #${item.sampleId}`)}</span>`).join('')||`<span>${esc(empty)}</span>`;}

function reviewForm(claim,busy){return `<form class="account-claim-review" data-account-claim-form data-claim-id="${esc(claim.claimId)}"><details><summary>人工审核与修订</summary><div><label><span>修订后结论</span><textarea name="claimText" rows="3">${esc(claim.claimText||'')}</textarea></label><label><span>操作定义</span><textarea name="operationalDefinition" rows="2">${esc(claim.operationalDefinition||'')}</textarea></label><label><span>限制</span><textarea name="limitations" rows="2">${esc(claim.limitations||'')}</textarea></label><label><span>审核备注</span><input name="note" value="${esc(claim.decision?.note||'')}" placeholder="记录核对依据"></label><p class="account-form-error" aria-live="polite"></p><footer><button type="submit" name="decision" value="rejected" ${busy?'disabled':''}>驳回</button><button type="submit" name="decision" value="edited" ${busy?'disabled':''}>保存修订</button><button type="submit" class="primary" name="decision" value="confirmed" ${busy?'disabled':''}>${busy?'提交中…':'确认结论'}</button></footer></div></details></form>`;}

function runForm(run){return `<section class="account-run-panel"><header><div><span>管理员操作</span><h2>${run?'重跑冻结研究':'创建首个研究版本'}</h2></div><small>成功后追加新版本，不覆盖旧结论和人工决定。</small></header><form data-account-run-form><label><span>观察开始</span><input type="date" name="windowStart" required value="${esc(run?.observationWindow?.start||'2026-01-01')}"></label><label><span>观察结束</span><input type="date" name="windowEnd" required value="${esc(run?.observationWindow?.end||'2026-08-01')}"></label><label><span>样本上限</span><input type="number" name="maxSamples" min="10" max="500" value="${Number(run?.sampling?.maxSamples||60)}"></label><label class="check"><input type="checkbox" name="includeComments" checked><span>纳入可引用评论</span></label><p class="account-form-error" aria-live="polite"></p><button type="submit" class="primary" name="action" value="${run?'rerun':'create'}" ${runBusy?'disabled':''}>${runBusy?'正在提交…':run?'追加重跑版本':'创建冻结版本'}</button></form></section>`;}

async function submitRun(form,submitter){
  if(runBusy)return;const run=selectedRun(),action=submitter?.value||'rerun',data=new FormData(form),payload={windowStart:data.get('windowStart'),windowEnd:data.get('windowEnd'),maxSamples:Number(data.get('maxSamples')||60),includeComments:data.has('includeComments'),source:'ai'},error= form.querySelector('.account-form-error');error.textContent='';runBusy=true;form.querySelectorAll('button').forEach(button=>button.disabled=true);submitter.textContent='正在提交…';
  try{const response=action==='create'?await api.researchAccountRunCreate(selectedAccountId,payload):await api.researchAccountRerun(selectedAccountId,run.runId,payload);checked(assertAccountResearchRunMutationDto,response,'账户研究运行');toast('ok','新的账户研究版本已追加');await loadAccountDetail(selectedAccountId);}
  catch(failure){error.textContent=failureMessage(failure,'研究运行提交失败，请重试。');form.querySelectorAll('button').forEach(button=>button.disabled=false);submitter.textContent=run?'追加重跑版本':'创建冻结版本';}
  finally{runBusy=false;}
}

async function submitDecision(form,submitter){
  const claimId=form.dataset.claimId;if(!claimId||claimBusy.has(claimId))return;const run=selectedRun(),data=new FormData(form),decision=submitter?.value||data.get('decision'),payload={decision,note:String(data.get('note')||'').trim()||null};
  if(decision==='edited')Object.assign(payload,{claimText:String(data.get('claimText')||'').trim(),operationalDefinition:String(data.get('operationalDefinition')||'').trim()||null,limitations:String(data.get('limitations')||'').trim()||null});
  const error=form.querySelector('.account-form-error');error.textContent='';claimBusy.add(claimId);form.querySelectorAll('button').forEach(button=>button.disabled=true);
  try{const response=await api.researchAccountClaimDecision(selectedAccountId,run.runId,claimId,payload);checked(assertAccountResearchDecisionMutationDto,response,'账户结论决定');const dimension=run.dimensions.find(item=>item.claims?.some(claim=>claim.claimId===claimId)),index=dimension?.claims.findIndex(claim=>claim.claimId===claimId);if(index>=0)dimension.claims[index]=response.claim;toast('ok',decision==='confirmed'?'结论已确认':decision==='edited'?'修订版已追加':'结论已驳回');paintDimensions();}
  catch(failure){error.textContent=failureMessage(failure,'审核提交失败，输入已保留。');form.querySelectorAll('button').forEach(button=>button.disabled=false);}
  finally{claimBusy.delete(claimId);}
}

function openEvidence(claimId,trigger){
  const claim=selectedRun()?.dimensions?.flatMap(item=>item.claims||[]).find(item=>item.claimId===claimId);if(!claim)return;evidenceReturnFocus=trigger;const drawer=el('.account-evidence-drawer'),backdrop=el('.account-evidence-backdrop'),body=el('#accountEvidenceBody');
  body.innerHTML=`<section class="account-evidence-context"><span>${esc(CLAIM_LABELS[claim.claimType]||claim.claimType)} · ${Number(claim.presentCount||0)}/${Number(claim.eligibleCount||0)}</span><b>${esc(claim.claimText||'数据不足')}</b><p>引用只表示对当前结论的支持或反驳，不将重复 OCR 虚增为多条证据。</p></section><div class="account-evidence-list">${(claim.evidence||[]).map(evidence=>`<article class="${evidence.direction==='support'?'support':'challenge'}"><header><span>${evidence.direction==='support'?'支持':'反驳'}</span><b>${esc(SOURCE_LABELS[evidence.sourceKind]||evidence.sourceKind)}</b></header><blockquote>${esc(evidence.quoteText||'无可引用片段')}</blockquote><p>${esc(evidence.sampleTitle||`样本 #${evidence.sampleId}`)}</p><footer>${locatorHtml(evidence.locator)}</footer></article>`).join('')||'<div class="account-research-state"><b>尚无精确证据</b></div>'}</div>`;
  backdrop.hidden=false;drawer.hidden=false;bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';requestAnimationFrame(()=>drawer.querySelector('button')?.focus());
}

function locatorHtml(locator={}){const parts=[];if(locator.startOffset!=null)parts.push(`文字位置 ${Number(locator.startOffset)}–${Number(locator.endOffset)}`);if(locator.imageIndex!=null)parts.push(`图片第 ${Number(locator.imageIndex)} 页${locator.region?' · 已标记区域':''}`);if(locator.timeStartMs!=null)parts.push(`视频 ${timecode(locator.timeStartMs)}–${timecode(locator.timeEndMs)}`);if(locator.commentRef)parts.push(`评论引用 ${locator.commentRef}`);if(locator.profileField)parts.push(`账户资料字段 ${locator.profileField}`);return parts.map(part=>`<span>${esc(part)}</span>`).join('');}
function timecode(ms){const seconds=Math.floor(Number(ms||0)/1000);return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function closeEvidence(restore=true){const drawer=el('.account-evidence-drawer'),backdrop=el('.account-evidence-backdrop');if(!drawer||drawer.hidden)return;drawer.hidden=true;backdrop.hidden=true;document.body.style.overflow=bodyOverflow;if(restore)evidenceReturnFocus?.focus({preventScroll:true});evidenceReturnFocus=null;}
