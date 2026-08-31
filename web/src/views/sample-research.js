/**
 * 样本研究详情（第二阶段）。
 *
 * 这里故意只消费已经核验过的 research DTO：AI 原值、人工决定和有效值
 * 分开呈现，页面上任何“编辑”都会追加一条决定，不会覆盖历史分析。
 */
import { api } from '../api.js';
import { esc } from '../util.js';
import { toast } from '../toast.js';

const FALLBACK_DIMENSIONS = [
  ['audience','用户对象','受众与需求'],['user_need','用户需求','受众与需求'],
  ['topic','选题','受众与需求'],['core_viewpoint','核心观点','观点与爆点'],
  ['breakout_point','爆点','观点与爆点'],['title_mechanism','标题机制','标题与开头'],
  ['opening_method','开头方式','标题与开头'],['content_structure','内容结构','结构与论证'],
  ['argumentation_method','论证方式','结构与论证'],['language_style','语言风格','表达与篇幅'],
  ['length','篇幅','表达与篇幅'],['layout','排版','表达与篇幅'],
  ['visual_style','视觉风格','视听与行动'],['bgm','BGM','视听与行动'],
  ['cta','CTA','视听与行动'],
].map(([key,label,group],index)=>({key,label,group,sortOrder:index+1}));
const TARGETS = {
  traffic:'流量型', persona:'人设型', expertise:'专业型', conversion:'转化型',
};
const TARGET_HELP = {
  traffic:'看点击、传播和停留，不用转化标准苛责它。',
  persona:'看人物可信度、立场与记忆点。',
  expertise:'看判断逻辑、证据与可迁移方法。',
  conversion:'看行动引导、意向筛选和承接效率。',
};
const SOURCE_LABEL = {ai:'AI 拆解',manual:'人工拆解',legacy:'历史迁移'};
const DECISION_LABEL = {confirmed:'已确认',confirm:'已确认',edited:'已修订',rejected:'已驳回',pending:'待确认'};
const EVIDENCE_LABEL = {none:'无证据',weak:'弱',medium:'中等',strong:'强'};

let host = null;
let sample = null;
let active = false;
let tab = 'original';
let config = null;
let research = null;
let versions = [];
let selectedVersionId = null;
let selectedVersion = null;
let evaluations = [];
let loading = false;
let loadError = '';
let actionError = '';
let failedVersionId = null;
let sectionErrors = {};
let job = null;
let pollTimer = null;
let pollFailures = 0;
let requestSeq = 0;
let versionSeq = 0;
let captureSeq = 0;
let captureLoading = false;
let busyAction = '';
let actionSeq = 0;
let callbacks = {};

export function leaveResearch() {
  active = false;
  requestSeq+=1;versionSeq+=1;captureSeq+=1;actionSeq+=1;busyAction='';job=null;pollFailures=0;
  clearTimeout(pollTimer);
  pollTimer = null;
}
export function updateResearchOptions(options={}){callbacks={...callbacks,...options};if(active)paint();}

export async function openResearch(container, sampleDetail, options = {}) {
  const changed = Number(sample?.id) !== Number(sampleDetail?.id);
  if (changed) {
    clearTimeout(pollTimer); pollTimer=null; requestSeq+=1;versionSeq+=1;captureSeq+=1;actionSeq+=1;
    tab='original';research=null;versions=[];selectedVersionId=null;selectedVersion=null;
    evaluations=[];job=null;pollFailures=0;busyAction='';loadError='';actionError='';failedVersionId=null;sectionErrors={};
  }
  active = true;
  host = container;
  sample = sampleDetail;
  callbacks = options;
  bindOnce();
  await loadResearch();
}
function sameAction(seq,sampleId,versionId=null){return active&&seq===actionSeq&&Number(sample?.id)===Number(sampleId)&&(versionId==null||String(selectedVersionId)===String(versionId));}

function bindOnce() {
  if (!host || host.dataset.researchBound) return;
  host.dataset.researchBound = '1';
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('submit', onSubmit);
  host.addEventListener('keydown', event => {
    if(!event.target.matches('[role="tab"]'))return;
    if(event.key==='Enter'||event.key===' '){event.preventDefault();event.target.click();return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const tabs=[...host.querySelectorAll('[role="tab"]')];const current=tabs.indexOf(event.target);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(current+1)%tabs.length:(current-1+tabs.length)%tabs.length;
    const key=tabs[next]?.dataset.researchTab;if(!key)return;tab=key;actionError='';paint();requestAnimationFrame(()=>host.querySelector(`[data-research-tab="${CSS.escape(key)}"]`)?.focus());
  });
}

async function loadResearch() {
  const seq = ++requestSeq;
  loading = true; loadError = ''; actionError = ''; paint();
  try {
    const results = await Promise.allSettled([
      api.sampleResearchConfig(), api.sampleResearch(sample.id), api.sampleAnalyses(sample.id),
      api.sampleTags(sample.id), api.sampleEvaluations(sample.id), api.sampleTagDictionary(),
    ]);
    if (!active || seq !== requestSeq) return;
    const value=index=>results[index].status==='fulfilled'?results[index].value:null;
    const error=index=>results[index].status==='rejected'?(results[index].reason?.message||'读取失败'):'';
    const cfg=value(0),res=value(1)||{},analyses=value(2),tags=value(3),evals=value(4),dictionary=value(5);
    sectionErrors={elements:error(0)||error(1)||error(2),tags:error(3)||error(5),evaluation:error(4)};
    config = normalizeConfig({...cfg,tags:dictionary?.items||[]});
    research = {...res,tags:tags?.items || tags?.tags || res?.tags || []};
    versions = analyses?.items || analyses?.versions || res?.versions || [];
    const currentVersionId=analyses?.currentVersionId||res.currentAnalysisVersionId||res.currentVersionId||null;
    versions=versions.map(v=>({...v,isCurrent:String(v.id)===String(currentVersionId)}));
    selectedVersionId = currentVersionId || selectedVersionId || versions.find(v=>v.isCurrent)?.id || versions[0]?.id || null;
    selectedVersion = detailFromVersions(selectedVersionId);
    evaluations = evals?.items || evals?.evaluations || res.evaluations || [];
    job=res.activeJob||null;pollFailures=0;
    loading = false; paint();
    if(job&&['queued','running'].includes(job.status))pollJob(job.id||job.jobId);
    if (selectedVersionId && !hasElements(selectedVersion)) loadVersion(selectedVersionId, true);
  } catch (error) {
    if (seq !== requestSeq) return;
    loading = false; loadError = error.message || '研究资料读取失败'; paint();
  }
}

function normalizeConfig(value) {
  const dimensions = value?.dimensions?.length ? value.dimensions : FALLBACK_DIMENSIONS;
  const tags = value?.tags || value?.tagDictionary || [];
  return { ...value, dimensions:dimensions.map((d,index)=>({
    key:d.key || d.dimensionKey, label:d.label || d.name || d.dimensionKey,
    group:d.group || d.groupLabel || FALLBACK_DIMENSIONS.find(item=>item.key===(d.key||d.dimensionKey))?.group || '其他', sortOrder:d.sortOrder ?? d.ordinal ?? index+1,
  })), tags };
}
function detailFromVersions(id) { return versions.find(v=>String(v.id)===String(id)) || null; }
function hasElements(value) { return Array.isArray(value?.elements) && value.elements.length; }

async function loadVersion(id, quiet = false) {
  const seq=++versionSeq;const sampleId=Number(sample?.id);
  failedVersionId=null;
  selectedVersionId = id;
  selectedVersion = detailFromVersions(id);
  if (!quiet) paint();
  try {
    const loaded = await api.sampleAnalysis(sample.id,id);
    if(!active||seq!==versionSeq||Number(sample?.id)!==sampleId||String(selectedVersionId)!==String(id))return;
    selectedVersion = {...loaded,isCurrent:loaded.isCurrent??loaded.current??String(id)===String(research?.currentVersionId||research?.currentAnalysisVersionId)};
    const index=versions.findIndex(v=>String(v.id)===String(id));
    if(index>=0) versions[index]={...versions[index],...selectedVersion};
    paint();
  } catch(error){if(seq===versionSeq&&Number(sample?.id)===sampleId){failedVersionId=id;actionError=error.message||'分析版本读取失败';paint();}}
}

function onClick(event) {
  const target=event.target.closest('button,[data-research-action]');
  if(!target)return;
  if(target.dataset.researchTab){ tab=target.dataset.researchTab; actionError=''; paint(); return; }
  const action=target.dataset.researchAction;
  if(action==='back'){ callbacks.onBack?.(); return; }
  if(action==='previous-sample'){callbacks.onPrevious?.();return;}
  if(action==='next-sample'){callbacks.onNext?.();return;}
  if(action==='edit-sample'){callbacks.onEdit?.();return;}
  if(action==='attach-media'){callbacks.onAttach?.();return;}
  if(action==='retry'){ loadResearch(); return; }
  if(action==='retry-version'&&failedVersionId){loadVersion(failedVersionId);return;}
  if(action?.startsWith('retry-')){loadResearch();return;}
  if(action==='start-ai'){ startAnalysis('ai'); return; }
  if(action==='manual-version'){ createManualVersion(); return; }
  if(action==='select-version'){ selectVersion(); return; }
  if(action==='load-raw'){loadRawCapture(target);return;}
  if(action==='load-more-captures'){loadMoreResearchCaptures();return;}
  if(action==='decision-confirm') saveDecision(target.dataset.key,'confirmed');
  if(action==='decision-reject') saveDecision(target.dataset.key,'rejected');
  if(action==='decision-edit') toggleEdit(target.dataset.key);
  if(action==='error-clear'){actionError='';failedVersionId=null;paint();}
}

function onChange(event) {
  if(event.target.id==='sampleAnalysisVersion') loadVersion(event.target.value);
  if(event.target.name==='source'&&event.target.closest('#sampleEvaluationForm')){const form=event.target.closest('form'),ai=event.target.value==='ai';const fields=form.querySelector('[data-evaluation-manual-fields]');if(fields)fields.hidden=ai;const note=form.querySelector('[data-evaluation-source-note]');if(note)note.textContent=ai?'AI 将基于当前拆解版本和已核验证据生成新评价。':'人工填写会作为一个新的评价版本追加保存。';}
}

function onSubmit(event) {
  if(event.target.id==='sampleTagsForm'){event.preventDefault();saveTags(event.target);}
  if(event.target.matches('[data-element-edit-form]')){event.preventDefault();saveEditedDecision(event.target);}
  if(event.target.matches('[data-element-tags-form]')){event.preventDefault();saveElementTags(event.target);}
  if(event.target.id==='sampleEvaluationForm'){event.preventDefault();saveEvaluation(event.target);}
}

async function startAnalysis(source) {
  if(busyAction||job)return;const seq=actionSeq,sampleId=Number(sample.id);busyAction='analysis';
  actionError='';pollFailures=0; job={status:'queued',progress:4,message:'正在准备证据…'};paint();
  try{
    const started=await api.sampleAnalysisStart(sampleId,{sourceCaptureId:research?.sourceCaptureId||sample.captures?.[0]?.id||null,selectOnSuccess:true,source},`sample-${sampleId}-${Date.now()}`);
    if(!sameAction(seq,sampleId))return;
    job=started.job||started;
    paint(); pollJob(job.id||job.jobId);
  }catch(error){if(sameAction(seq,sampleId)){job=null;actionError=error.message||'AI 拆解启动失败';paint();}}
  finally{if(sameAction(seq,sampleId)){busyAction='';if(!job)paint();}}
}
function pollJob(jobId,delay=1200){
  clearTimeout(pollTimer);
  const sampleId=Number(sample?.id);
  pollTimer=setTimeout(async()=>{
    if(!active||Number(sample?.id)!==sampleId)return;
    try{
      const response=await api.sampleAnalysisJob(sampleId,jobId);if(!active||Number(sample?.id)!==sampleId)return;pollFailures=0;actionError='';job=response.job||response;paint();
      if(['queued','running'].includes(job.status))pollJob(jobId);
      else if(['completed','done','succeeded'].includes(job.status)){toast('success','十五维拆解已生成');job=null;await loadResearch();tab='elements';paint();}
      else {const message=job.errorMessage||job.error_message||'AI拆解未完成，原有版本没有变化';job=null;actionError=message;paint();}
    }catch(error){if(!active||Number(sample?.id)!==sampleId)return;pollFailures+=1;actionError='任务状态暂时无法读取，正在自动重连；后台任务不会因此取消。';paint();pollJob(jobId,Math.min(30_000,1200*(2**Math.min(5,pollFailures))));}
  },delay);
}

async function createManualVersion(){
  if(busyAction)return;const seq=actionSeq,sampleId=Number(sample.id);busyAction='manual';actionError='';paint();
  try{
    const value=await api.sampleAnalysisManual(sampleId,{sourceCaptureId:research?.sourceCaptureId||sample.captures?.[0]?.id||null,selectOnSuccess:true,elements:FALLBACK_DIMENSIONS.map(d=>({dimensionKey:d.key,state:'insufficient',value:null,functionText:null,applicability:null,limitations:null}))});
    if(!sameAction(seq,sampleId))return;
    toast('success','已建立人工空白拆解');selectedVersionId=value?.id||value?.version?.id;await loadResearch();tab='elements';paint();
  }catch(error){if(sameAction(seq,sampleId)){actionError=error.message||'人工拆解建立失败';paint();}}
  finally{if(sameAction(seq,sampleId)){busyAction='';paint();}}
}
async function selectVersion(){
  if(!selectedVersionId||busyAction)return;const seq=actionSeq,sampleId=Number(sample.id),versionId=selectedVersionId;busyAction='select';paint();
  try{await api.sampleAnalysisSelect(sampleId,versionId);if(!sameAction(seq,sampleId,versionId))return;toast('success','当前分析版本已切换');await loadResearch();}
  catch(error){if(sameAction(seq,sampleId,versionId)){actionError=error.message||'版本切换失败';paint();}}
  finally{if(sameAction(seq,sampleId,versionId)){busyAction='';paint();}}
}
async function loadRawCapture(button){
  const captureId=Number(button.dataset.captureId),box=button.closest('.research-capture');if(!captureId||!box)return;button.disabled=true;button.textContent='读取中…';
  try{const raw=await api.sampleCaptureRaw(sample.id,captureId);const text=JSON.stringify(raw,null,2);box.querySelector('pre').textContent=text.length>120000?`${text.slice(0,120000)}\n\n……仅预览前 12 万字。`:text;button.remove();}
  catch(error){button.disabled=false;button.textContent='重试读取';box.querySelector('pre').textContent=`读取失败：${error.message||'请稍后重试'}`;}
}

function toggleEdit(key){
  host.querySelectorAll('[data-element-editor]').forEach(el=>el.hidden=el.dataset.elementEditor!==key?!0:!el.hidden);
  const shown=host.querySelector(`[data-element-editor="${CSS.escape(key)}"]:not([hidden]) textarea`);shown?.focus();
}
function setFormError(form,message){
  let box=form.querySelector('.research-form-error');if(!box){box=document.createElement('div');box.className='research-form-error';form.prepend(box);}box.textContent=message;
}
async function saveDecision(key,decision,value=null,form=null,extra={}){
  if(!selectedVersionId||busyAction)return;const seq=actionSeq,sampleId=Number(sample.id),versionId=selectedVersionId;busyAction=`decision:${key}`;
  const button=form?.querySelector('button[type="submit"]');if(button)button.disabled=true;
  let saved=false;
  try{
    await api.sampleElementDecision(sampleId,versionId,key,{decision,value,note:extra.note||'',functionText:extra.functionText||null,applicability:extra.applicability||null,limitations:extra.limitations||null});
    if(!sameAction(seq,sampleId,versionId))return;
    saved=true;toast('success',decision==='rejected'?'已驳回该维度':'已确认该维度');await loadVersion(versionId,true);
  }catch(error){if(sameAction(seq,sampleId,versionId)){if(form)setFormError(form,error.message||'人工决定保存失败，输入仍保留');else{actionError=error.message||'人工决定保存失败';paint();}}}
  finally{if(sameAction(seq,sampleId,versionId)){busyAction='';if(saved)paint();else if(button?.isConnected)button.disabled=false;}}
}
async function saveEditedDecision(form){
  const data=new FormData(form),key=form.dataset.key,value=String(data.get('value')||'').trim();
  if(!value){toast('info','请填写修订后的内容');return;}
  await saveDecision(key,'edited',value,form,{functionText:String(data.get('functionText')||'').trim(),applicability:String(data.get('applicability')||'').trim(),limitations:String(data.get('limitations')||'').trim(),note:String(data.get('note')||'').trim()});
}
async function saveTags(form){
  const seq=actionSeq,sampleId=Number(sample.id);const tagIds=[...new FormData(form).getAll('tagIds')].map(Number);
  const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{await api.sampleTagsSave(sampleId,{tagIds});if(!sameAction(seq,sampleId))return;research.tags=(config.tags||[]).filter(t=>tagIds.includes(Number(t.id)));toast('success','样本标签已保存');callbacks.onUpdated?.();paint();}
  catch(error){if(sameAction(seq,sampleId))setFormError(form,error.message||'标签保存失败，已选内容仍保留');}
  finally{if(sameAction(seq,sampleId)&&button.isConnected)button.disabled=false;}
}
async function saveElementTags(form){
  const seq=actionSeq,sampleId=Number(sample.id),versionId=selectedVersionId,key=form.dataset.key,tagIds=[...new FormData(form).getAll('tagIds')].map(Number);const button=form.querySelector('button');button.disabled=true;
  try{await api.sampleElementTags(sampleId,versionId,key,{tagIds});if(!sameAction(seq,sampleId,versionId))return;toast('success','元素标签已保存');await loadVersion(versionId,true);}
  catch(error){if(sameAction(seq,sampleId,versionId))setFormError(form,error.message||'元素标签保存失败，勾选仍保留');}
  finally{if(sameAction(seq,sampleId,versionId)&&button.isConnected)button.disabled=false;}
}
async function saveEvaluation(form){
  const seq=actionSeq,sampleId=Number(sample.id),versionId=selectedVersionId;const data=new FormData(form);const list=name=>{const value=String(data.get(name)||'').trim();return value?[value]:[];};const source=data.get('source');const payload={target:data.get('target'),analysisVersionId:versionId||null,summary:'',strengths:list('strengths'),weaknesses:list('weaknesses'),worthLearning:list('learnable'),avoidCopying:list('avoid'),effectHypotheses:list('hypothesis')};
  const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{const value=source==='ai'?await api.sampleEvaluationAi(sampleId,{target:payload.target,analysisVersionId:payload.analysisVersionId}):await api.sampleEvaluationCreate(sampleId,payload);if(!sameAction(seq,sampleId,versionId))return;evaluations=[value?.evaluation||value,...evaluations];toast('success',source==='ai'?'AI 评价已生成':'评价版本已追加');paint();}
  catch(error){if(sameAction(seq,sampleId,versionId))setFormError(form,error.message||'评价保存失败，填写内容仍保留');}
  finally{if(sameAction(seq,sampleId,versionId)&&button.isConnected)button.disabled=false;}
}

function paint(){
  if(!host)return;
  if(loading){host.innerHTML=`<div class="research-state"><i class="research-spinner"></i><b>正在整理研究资料…</b><span>原始档案已经保留，这里只读取结构化研究结果。</span></div>`;return;}
  if(loadError){host.innerHTML=stateError(loadError,'retry');return;}
  const current=versions.find(v=>v.isCurrent)||detailFromVersions(research?.currentAnalysisVersionId);
  const count=effectiveElements(selectedVersion).filter(e=>['confirmed','edited','rejected'].includes(decisionOf(e))).length;
  host.innerHTML=`<div class="research-sticky"><div class="research-head"><button class="research-back" data-research-action="back">← 返回列表</button><div><span>${esc(sample.platformLabel||sample.platform||'样本')} · 内容研究</span><h2>${esc(sample.title||'未命名样本')}</h2><p>${esc(sample.accountName||'账号待补')} · ${versions.length?`${versions.length} 个拆解版本`:'尚未拆解'}</p><div class="research-head-actions"><button type="button" data-research-action="edit-sample">补充资料</button><button type="button" data-research-action="attach-media">补媒体</button></div></div><div class="research-sequence" aria-label="切换样本"><button type="button" data-research-action="previous-sample" ${callbacks.hasPrevious?'':'disabled'}>‹ 上一篇</button><button type="button" data-research-action="next-sample" ${callbacks.hasNext?'':'disabled'}>下一篇 ›</button></div><div class="research-progress"><b>${count}/15</b><span>维度已人工处理</span><progress max="15" value="${count}"></progress></div></div>
    <div class="research-tabs" role="tablist" aria-label="样本研究详情">${[['original','原始作品'],['elements','元素拆解'],['evaluation','评价']].map(([key,label])=>`<button id="sampleResearchTab-${key}" role="tab" aria-selected="${tab===key}" aria-controls="sampleResearchPanel-${key}" tabindex="${tab===key?'0':'-1'}" class="${tab===key?'on':''}" data-research-tab="${key}">${label}</button>`).join('')}</div></div>
    ${actionError?`<div class="research-inline-error"><span>${esc(actionError)}</span><div>${failedVersionId?'<button data-research-action="retry-version">重试版本</button>':''}<button data-research-action="error-clear">知道了</button></div></div>`:''}
    <div class="research-panel" id="sampleResearchPanel-${tab}" role="tabpanel" aria-labelledby="sampleResearchTab-${tab}">${tab==='original'?originalTab():tab==='elements'?elementsTab(current):evaluationTab()}</div>`;
}

function stateError(message,action){return `<div class="research-state error"><b>这一块暂时没读出来</b><span>${esc(message)}</span><button data-research-action="${action}">重试</button></div>`;}

function originalTab(){
  const assets=sample.assets||[];
  return `<div class="research-original-grid"><section class="research-original-copy"><header><div><small>原始正文</small><h3>${esc(sample.title||'未命名样本')}</h3></div>${sample.sourceUrl?`<a href="${esc(sample.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原作品 ↗</a>`:''}</header><div class="research-body">${esc(sample.bodyText||'正文尚未采集或录入。')}</div></section>
    <aside><section class="research-facts"><h3>原始信息</h3>${[['作品 ID',sample.platformContentId],['账号',sample.accountName],['发布时间',fmtDate(sample.publishedAt)],['内容类型',sample.contentType],['归档完整度',`${sample.completenessScore||0}%`]].map(([k,v])=>`<div><span>${k}</span><b>${esc(v||'—')}</b></div>`).join('')}${(sample.missingFields||[]).length?`<p>仍缺：${esc((sample.missingFields||[]).join('、'))}</p>`:''}</section><section class="research-original-assets"><h3>原始媒体 · ${assets.length}</h3>${assets.length?assets.map(asset=>assetPreview(asset)).join(''):'<p>媒体尚未归档。</p>'}</section></aside></div>${captureHistory()}`;
}
function captureHistory(){
  const captures=sample.captures||[];if(!captures.length)return '';
  const total=Number(sample.captureTotal||sample.captureCount||captures.length);
  return `<section class="research-captures"><header><h3>历次原始采集</h3><div><span>${total} 个时间点 · 已显示 ${captures.length}</span>${total>captures.length?`<button type="button" data-research-action="load-more-captures" ${captureLoading?'disabled':''}>${captureLoading?'读取中…':'加载更早版本'}</button>`:''}</div></header>${captures.map(capture=>`<details class="research-capture"><summary><b>${esc(capture.captureType||'采集')}</b><span>${fmtDate(capture.capturedAt||capture.createdAt)} · 完整度 ${capture.completenessScore??'—'}%</span></summary><div><button type="button" data-research-action="load-raw" data-capture-id="${capture.id}">按需读取原始 JSON</button><a href="/api/samples/${sample.id}/captures/${capture.id}/raw" target="_blank" rel="noopener">打开完整 JSON ↗</a><pre>尚未读取，避免打开详情时下载全部历史。</pre></div></details>`).join('')}</section>`;
}
async function loadMoreResearchCaptures(){
  if(captureLoading||!sample)return;const sampleId=Number(sample.id);const seq=++captureSeq;const shown=(sample.captures||[]).length;captureLoading=true;paint();
  try{const data=await api.sampleCaptures(sampleId,{page:Math.floor(shown/20)+1,pageSize:20});if(!active||seq!==captureSeq||Number(sample?.id)!==sampleId)return;const known=new Set((sample.captures||[]).map(item=>Number(item.id)));sample.captures=[...(sample.captures||[]),...(data.items||[]).filter(item=>!known.has(Number(item.id)))];sample.captureTotal=Number(data.total||sample.captureTotal||sample.captures.length);}
  catch(error){if(seq===captureSeq&&Number(sample?.id)===sampleId)actionError=error.message||'更早采集版本读取失败';}
  finally{if(seq===captureSeq){captureLoading=false;paint();}}
}
function assetPreview(asset){const url=asset.contentUrl||`/api/samples/${sample.id}/assets/${asset.id}`;if(String(asset.mimeType).startsWith('image/'))return `<figure><img loading="lazy" decoding="async" src="${esc(url)}" alt="${esc(asset.originalName||'原始图片')}"><figcaption>${esc(asset.originalName||asset.kind)}</figcaption></figure>`;if(String(asset.mimeType).startsWith('video/'))return `<figure><video controls preload="metadata" src="${esc(url)}"></video><figcaption>${esc(asset.originalName||'原始视频')}</figcaption></figure>`;if(String(asset.mimeType).startsWith('audio/'))return `<figure><audio controls preload="metadata" src="${esc(url)}"></audio><figcaption>${esc(asset.originalName||'原始音频')}</figcaption></figure>`;return `<a class="research-asset-file" href="${esc(url)}" target="_blank" rel="noopener">${esc(asset.originalName||asset.kind||'打开归档文件')} ↗</a>`;}

function elementsTab(current){
  if(sectionErrors.elements)return stateError(sectionErrors.elements,'retry-elements');
  const source=selectedVersion?.source||selectedVersion?.sourceType;
  const blocked=Boolean(busyAction);
  return `<div class="research-tools"><label><span>拆解版本</span><select id="sampleAnalysisVersion" ${blocked?'disabled':''}>${versions.length?versions.map(v=>`<option value="${v.id}" ${String(v.id)===String(selectedVersionId)?'selected':''}>v${v.revision||v.id} · ${esc(SOURCE_LABEL[v.source||v.sourceType]||v.source||'拆解')} · ${fmtDate(v.createdAt)}</option>`).join(''):'<option>暂无版本</option>'}</select></label><div><button data-research-action="start-ai" ${job||blocked?'disabled':''}>AI 重新拆解</button><button data-research-action="manual-version" ${blocked?'disabled':''}>${busyAction==='manual'?'建立中…':'新建人工拆解'}</button>${selectedVersionId&&!selectedVersion?.isCurrent?`<button class="primary" data-research-action="select-version" ${blocked?'disabled':''}>${busyAction==='select'?'切换中…':'设为当前版本'}</button>`:''}</div></div>
    ${job?jobHtml():''}
    ${selectedVersionId?`<div class="analysis-provenance"><span>${esc(SOURCE_LABEL[source]||source||'拆解')}</span><b>${esc(selectedVersion?.model||selectedVersion?.modelName||'人工建立')}</b><small>输入快照 ${esc(shortHash(selectedVersion?.inputSha256))} · ${selectedVersion?.staleSource?'原始采集已更新，此版结论仍保留':'与原始采集一致'}</small></div>${tagEditor()}${dimensionGroups()}`:`<div class="research-empty"><b>还没有结构化拆解</b><span>可以让 AI 基于已归档证据生成，也可以先建立一份人工空白表。</span><div><button data-research-action="start-ai" ${blocked?'disabled':''}>AI 生成十五维</button><button data-research-action="manual-version" ${blocked?'disabled':''}>${busyAction==='manual'?'建立中…':'人工开始'}</button></div></div>`}`;
}
function jobHtml(){const attempt=Number(job.attempts||0),limit=Number(job.maxAttempts||0),retrying=job.status==='queued'&&attempt>0&&job.errorMessage;const message=retrying?`准备自动重试：${job.errorMessage}`:job.message||'正在拆解十五个维度…',status=[job.status||'running',limit?`${attempt}/${limit}`:''].filter(Boolean).join(' · ');return `<div class="analysis-job"><div><i></i><b>${esc(message)}</b><span>${esc(status)}</span></div><progress max="100" value="${Number(job.progress||job.progressPercent||8)}"></progress></div>`;}
function tagEditor(){
  if(sectionErrors.tags)return `<div class="research-tags-empty">标签暂时没有读出来：${esc(sectionErrors.tags)} <button type="button" data-research-action="retry-tags">重试</button></div>`;
  const tags=config?.tags||[];const selected=new Set((research?.tags||[]).map(t=>Number(t.id)));
  if(!tags.length)return '<div class="research-tags-empty">标签字典还没有可用标签，管理员可先在“标签与对接”维护。</div>';
  const groups=groupBy(tags,t=>t.kindLabel||t.kind||'其他');
  return `<details class="research-tag-editor"><summary><span><b>样本标签</b><small>${selected.size?`已选 ${selected.size} 项`:'尚未选择'} · 展开后编辑</small></span><i>展开</i></summary><form id="sampleTagsForm"><p>同一篇可以多选；这里只选择现有字典，不会让 AI 私自造标签。</p>${Object.entries(groups).map(([name,list])=>`<fieldset><legend>${esc(name)}</legend>${list.map(t=>`<label><input type="checkbox" name="tagIds" value="${t.id}" ${selected.has(Number(t.id))?'checked':''}><span>${esc(t.name)}</span></label>`).join('')}</fieldset>`).join('')}<button type="submit">保存标签</button></form></details>`;
}
function dimensionGroups(){
  const dims=config?.dimensions||FALLBACK_DIMENSIONS;const byKey=new Map(effectiveElements(selectedVersion).map(e=>[e.dimensionKey||e.key,e]));const groupName=key=>['audience','user_need','topic'].includes(key)?'定位与需求':['layout','visual_style','bgm','cta'].includes(key)?'包装与承接':'内容表达',groups=groupBy(dims,d=>groupName(d.key));
  return `<div class="dimension-groups">${Object.entries(groups).map(([name,list])=>`<section><header><h3>${esc(name)}</h3><span>${list.filter(d=>byKey.has(d.key)).length}/${list.length}</span></header><div>${list.map(d=>elementCard(d,byKey.get(d.key))).join('')}</div></section>`).join('')}</div>`;
}
function effectiveElements(value){return value?.elements||value?.analysisElements||[];}
function decisionOf(element){return element?.decision?.decision||element?.decisionStatus||element?.reviewStatus||'pending';}
function elementCard(dim,element={}){
  const decision=decisionOf(element);const status=element.status||element.state||(!element.aiValue&&!element.value?'insufficient':'ok');const ai=valueText(element.aiValue??element.rawValue??element.value);const effective=valueText(element.effectiveValue??element.effective?.value??element.value);const evidence=element.evidence||element.evidences||[];const confidence=element.confidence==null?'—':`${Math.round(Number(element.confidence)*100)}%`;const functionText=element.function??element.functionText??element.effective?.functionText;const source=selectedVersion?.source||selectedVersion?.sourceType;const originalLabel=source==='ai'?'AI 原值':source==='manual'?'人工原值':'历史迁移原值';const effectiveFallback=decision==='rejected'?'已驳回，不参与筛选':status==='not_applicable'?'不适用':status==='insufficient'?'证据不足，待人工补充':'等待人工确认';
  return `<article class="dimension-card ${decision} ${status}"><header><div><span>${String(dim.sortOrder).padStart(2,'0')}</span><h4>${esc(dim.label)}</h4></div><div><i>${esc(DECISION_LABEL[decision]||decision)}</i><b>${confidence}</b></div></header><div class="dimension-values"><div><small>${originalLabel}</small><p>${esc(ai||(status==='not_applicable'?'不适用':status==='insufficient'?'证据不足':'尚未填写'))}</p></div><div><small>当前有效值</small><p>${esc(effective||effectiveFallback)}</p></div></div>${functionText?`<p class="dimension-function"><b>承担功能</b>${esc(functionText)}</p>`:''}${element.applicability||element.limitations?`<p class="dimension-boundary">${element.applicability?`适用：${esc(element.applicability)}`:''}${element.limitations?`<br>限制：${esc(element.limitations)}`:''}</p>`:''}${elementTagEditor(dim,element)}
    <details class="dimension-evidence"><summary>证据 ${evidence.length} 条 · 强度 ${esc(EVIDENCE_LABEL[element.evidenceStrength]||element.evidenceStrength||'—')}</summary>${evidence.length?evidence.map(ev=>`<blockquote><p>${esc(ev.quoteText||ev.quote||ev.text||'证据原文不可用')}</p><footer>${esc(ev.sourceType||ev.kind||'原始作品')} · ${esc(ev.locator||ev.location||ev.jsonPath||ev.commentRef||ev.sourceId||'位置待补')}</footer></blockquote>`).join(''):'<p>没有可核验的证据，因此该维度不应被当作已确认结论。</p>'}</details>
    <div class="dimension-actions"><button data-research-action="decision-confirm" data-key="${esc(dim.key)}" ${busyAction?'disabled':''}>确认</button><button data-research-action="decision-edit" data-key="${esc(dim.key)}" ${busyAction?'disabled':''}>编辑后确认</button><button class="danger" data-research-action="decision-reject" data-key="${esc(dim.key)}" ${busyAction?'disabled':''}>驳回</button></div>
    <form hidden data-element-edit-form data-element-editor="${esc(dim.key)}" data-key="${esc(dim.key)}"><label><span>修订后的有效值</span><textarea name="value" rows="3">${esc(effective||ai)}</textarea></label><label><span>元素承担的功能</span><textarea name="functionText" rows="2">${esc(functionText||'')}</textarea></label><label><span>适用范围</span><textarea name="applicability" rows="2">${esc(element.effective?.applicability||element.applicability||'')}</textarea></label><label><span>限制与边界</span><textarea name="limitations" rows="2">${esc(element.effective?.limitations||element.limitations||'')}</textarea></label><label><span>人工备注</span><textarea name="note" rows="2"></textarea></label><button type="submit" ${busyAction?'disabled':''}>保存修订</button></form></article>`;
}
function elementTagEditor(dim,element){
  const options=config?.tagsByKind?.[dim.key]||[];const selected=new Set((element.tags||[]).map(tag=>Number(tag.id)));
  if(!options.length)return '';
  return `<form class="dimension-tags" data-element-tags-form data-key="${esc(dim.key)}"><span>元素标签 · 追加后保留在此分析版本中，需更正时请建立新版本</span><div>${options.map(tag=>{const fixed=selected.has(Number(tag.id));return `<label><input type="checkbox" name="tagIds" value="${tag.id}" ${fixed?'checked disabled':''}><i>${esc(tag.name)}${fixed?' · 已记录':''}</i></label>`;}).join('')}</div><button type="submit">追加标签</button></form>`;
}

function evaluationTab(){
  if(sectionErrors.evaluation)return stateError(sectionErrors.evaluation,'retry-evaluation');
  const groups=groupBy(evaluations,e=>e.target||e.objective||'traffic');
  return `<div class="evaluation-layout"><form id="sampleEvaluationForm" class="evaluation-form"><header><div><small>追加评价版本</small><h3>用作品目标自己的标准评价</h3></div></header><div class="evaluation-targets">${Object.entries(TARGETS).map(([key,label])=>`<label><input type="radio" name="target" value="${key}" ${key==='traffic'?'checked':''}><span><b>${label}</b><small>${TARGET_HELP[key]}</small></span></label>`).join('')}</div><label><span>来源</span><select name="source"><option value="manual">人工评价</option><option value="ai">AI 评价</option></select></label><p class="evaluation-source-note" data-evaluation-source-note>人工填写会作为一个新的评价版本追加保存。</p><div data-evaluation-manual-fields>${[['strengths','优点'],['weaknesses','缺点'],['learnable','值得学习'],['avoid','不应该模仿'],['hypothesis','为什么可能有效']].map(([key,label])=>`<label><span>${label}</span><textarea name="${key}" rows="2"></textarea></label>`).join('')}</div><button type="submit">保存为新版本</button></form>
    <div class="evaluation-history">${Object.entries(TARGETS).map(([key,label])=>`<section><header><h3>${label}</h3><span>${(groups[key]||[]).length} 个版本</span></header>${(groups[key]||[]).length?(groups[key]||[]).map(e=>evaluationCard(e)).join(''):'<p>还没有此目标下的评价。</p>'}</section>`).join('')}</div></div>`;
}
function evaluationCard(e){const meta=[`v${e.revision||1}`,e.analysisVersionId?`拆解版 #${e.analysisVersionId}`:null,e.confidence==null?null:`置信度 ${Math.round(Number(e.confidence)*100)}%`,fmtDate(e.createdAt)].filter(Boolean).join(' · ');return `<article><header><b>${esc(e.source==='ai'?'AI 评价':'人工评价')}</b><span>${esc(meta)}</span></header>${[['优点',e.strengths],['缺点',e.weaknesses],['值得学习',e.worthLearning??e.learnable],['不应模仿',e.avoidCopying??e.avoid],['有效原因假设',e.effectHypotheses??e.hypothesis]].filter(([,v])=>Array.isArray(v)?v.length:v).map(([k,v])=>`<div><small>${k}</small><p>${esc(Array.isArray(v)?v.join('；'):v)}</p></div>`).join('')}</article>`;}

function valueText(value){if(value==null)return '';if(typeof value==='string')return value;if(Array.isArray(value))return value.map(valueText).filter(Boolean).join('、');if(typeof value==='object')return Object.entries(value).map(([k,v])=>`${k}：${valueText(v)}`).join('；');return String(value);}
function fmtDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.valueOf())?String(value):date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function shortHash(value){return value?String(value).slice(0,10):'—';}
function groupBy(items,keyer){return (items||[]).reduce((out,item)=>{const key=keyer(item);(out[key]||=[]).push(item);return out;},{});}
