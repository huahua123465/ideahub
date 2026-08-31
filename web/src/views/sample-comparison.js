/** Stage 3: frozen sample comparisons, assessments, relations and local extractions. */
import { api } from '../api.js';
import { esc } from '../util.js';
import { toast } from '../toast.js';
import { confirmAction } from '../confirm.js';

const TARGETS = {
  traffic:['流量目标','观察点击、传播与停留线索'],
  persona:['人设目标','观察人物立场、可信度与记忆点'],
  expertise:['专业目标','观察判断逻辑、证据与方法边界'],
  conversion:['转化目标','观察行动引导、意向承接与使用门槛'],
};
const RELATION_LABELS = {
  citation:'引用了', imitation:'模仿了', evolution:'由此演化', variant:'与其互为变体',
};
const RELATION_HELP = {
  citation:'有方向：主作品引用客作品。', imitation:'有方向：主作品模仿客作品。',
  evolution:'有方向：主作品由客作品演化。', variant:'无方向：两篇作品互为变体。',
};
const METRICS = [['likes','点赞'],['saves','收藏'],['comments','评论'],['shares','转发'],['views','播放/浏览']];
const FALLBACK_DIMENSIONS = [
  ['audience','用户对象'],['user_need','用户需求'],['topic','选题'],['core_viewpoint','核心观点'],
  ['breakout_point','爆点'],['title_mechanism','标题机制'],['opening_method','开头方式'],
  ['content_structure','内容结构'],['argumentation_method','论证方式'],['language_style','语言风格'],
  ['length','篇幅'],['layout','排版'],['visual_style','视觉风格'],['bgm','BGM'],['cta','CTA'],
].map(([key,label],index)=>({key,label,ordinal:index+1}));

let host = null;
let active = false;
let boundHost = null;
let callbacks = {};
let screen = 'records';
let records = [];
let recordsTotal = 0;
let recordsPage = 1;
let recordsLoading = false;
let recordsError = '';
let recordFilter = {q:'',target:'',memberId:''};
let comparison = null;
let scope = null;
let workspaceLoading = false;
let workspaceError = '';
let tab = 'matrix';
let assessments = [];
let extractions = [];
let relations = [];
let sectionErrors = {};
let sectionLoaded = {assessments:false,relations:false,extractions:false};
let assessmentTarget = 'traffic';
let currentUser = {role:'member'};
let jobs = loadStoredJobs();
const pollTimers = new Map();
const relationEvidence = new Map();
const relationEvidenceOptions = new Map();
let requestSeq = 0;
let recordsTimer = null;
let dialogReturnFocus = null;
const lifecycleBusy = new Set();

const key = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
const fmt = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
};
const valueText = value => {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.map(valueText).join('、');
  if (typeof value === 'object') return Object.values(value).map(valueText).join('、');
  return String(value);
};
const stateLabel = state => ({pending:'待确认',proposed:'待确认',confirmed:'已确认',rejected:'已驳回',withdrawn:'已撤回',superseded:'已替代'}[state] || state || '待确认');
const canReview = () => ['reviewer','admin'].includes(currentUser?.role);
const jobKey = (target=assessmentTarget,comparisonId=comparison?.id,scopeId=scope?.id) => `${comparisonId||0}:${scopeId||0}:${target}`;
function loadStoredJobs(){try{return new Map(JSON.parse(sessionStorage.getItem('ideahub.comparisonJobs')||'[]'));}catch{return new Map();}}
function saveStoredJobs(){try{sessionStorage.setItem('ideahub.comparisonJobs',JSON.stringify([...jobs]));}catch{/* unavailable */}}
function currentJob(){return jobs.get(jobKey())||null;}

export function leaveComparison() {
  active = false;
  requestSeq += 1;
  clearTimeout(recordsTimer);
  for(const timer of pollTimers.values())clearTimeout(timer);
  pollTimers.clear();
  recordsTimer = null;
  closeOpenDialogs();
}

export async function openComparisonLibrary(container, options = {}) {
  active = true;
  host = container;
  callbacks = options;
  screen = 'records';
  ensureBound();
  await loadRecords();
}

export async function openComparisonWorkspace(container, comparisonId, options = {}) {
  active = true;
  host = container;
  callbacks = options;
  screen = 'workspace';
  tab = 'matrix';
  comparison = null;
  scope = null;
  assessments = [];
  extractions = [];
  relations = [];
  sectionErrors = {};
  sectionLoaded = {assessments:false,relations:false,extractions:false};
  ensureBound();
  await loadWorkspace(comparisonId);
}

function ensureBound() {
  if (!host || boundHost === host) return;
  if (boundHost) {
    boundHost.removeEventListener('click', onClick);
    boundHost.removeEventListener('submit', onSubmit);
    boundHost.removeEventListener('input', onInput);
    boundHost.removeEventListener('change', onChange);
    boundHost.removeEventListener('keydown', onKeydown);
  }
  boundHost = host;
  host.addEventListener('click', onClick);
  host.addEventListener('submit', onSubmit);
  host.addEventListener('input', onInput);
  host.addEventListener('change', onChange);
  host.addEventListener('keydown', onKeydown);
}

function onClick(event) {
  const button = event.target.closest('button,[data-comparison-id]');
  if (!button) return;
  const action = button.dataset.comparisonAction;
  if (button.dataset.comparisonId) return callbacks.onOpen?.(Number(button.dataset.comparisonId));
  if (action === 'new-from-samples') return callbacks.onNewFromSamples?.();
  if (action === 'refresh-comparison') return refreshComparison(button);
  if (action === 'delete-comparison') return deleteComparison(button);
  if (action === 'retry-records') return loadRecords();
  if (action === 'records') { screen='records';for(const timer of pollTimers.values())clearTimeout(timer);pollTimers.clear();loadRecords(); return; }
  if (action === 'retry-workspace' && comparison?.id) return loadWorkspace(comparison.id);
  if (action === 'tab') { setTab(button.dataset.tab, button); return; }
  if (action === 'assessment-target') { assessmentTarget=button.dataset.target; paint(); return; }
  if (action === 'start-ai') return startAiAssessment(button);
  if (action === 'retry-job') { const activeJob=currentJob();if(activeJob)pollJob(jobKey(),activeJob.id||activeJob.jobId,true);return; }
  if (action === 'select-assessment') return selectAssessment(button);
  if (action === 'load-assessment-detail') return loadAssessmentDetail(button);
  if (action === 'retry-assessments') return loadAssessments(true);
  if (action === 'retry-relations') return loadRelations(true);
  if (action === 'retry-extractions') return loadExtractions(true);
  if (action === 'new-relation') return openRelationDialog(null,button);
  if (action === 'edit-relation') return openRelationDialog(relations.find(item=>String(item.id)===String(button.dataset.id)),button);
  if (action === 'add-relation-evidence') return openRelationEvidenceDialog(relations.find(item=>String(item.id)===String(button.dataset.id)),button);
  if (action === 'relation-event') return relationEvent(button);
  if (action === 'new-extraction') return openExtractionDialog(button);
  if (action === 'component-from-extraction') return callbacks.onOpenComponents?.(extractions.find(item=>String(item.id)===String(button.dataset.id)));
  if (action === 'close-dialog') return closeDialog(button.closest('dialog'));
  if (action === 'record-page') { const next=Number(button.dataset.page); if(next>0&&next!==recordsPage){recordsPage=next;loadRecords();} }
}

function onSubmit(event) {
  if (event.target.id === 'comparisonRecordFilters') { event.preventDefault(); recordsPage=1; loadRecords(); }
  if (event.target.id === 'comparisonManualAssessmentForm') { event.preventDefault(); saveManualAssessment(event.target); }
  if (event.target.id === 'comparisonRelationForm') { event.preventDefault(); saveRelation(event.target); }
  if (event.target.id === 'comparisonRelationEvidenceForm') { event.preventDefault(); saveRelationEvidence(event.target); }
  if (event.target.id === 'comparisonExtractionForm') { event.preventDefault(); saveExtraction(event.target); }
}

function onInput(event) {
  if (!event.target.closest('#comparisonRecordFilters')) return;
  recordFilter.q = host.querySelector('#comparisonRecordQ')?.value || '';
  recordFilter.memberId = host.querySelector('#comparisonRecordMember')?.value || '';
  clearTimeout(recordsTimer);
  recordsTimer = setTimeout(()=>{recordsPage=1;loadRecords();},260);
}

function onChange(event) {
  if (event.target.id === 'comparisonRecordTarget') { recordFilter.target=event.target.value;recordsPage=1;loadRecords(); }
  if (event.target.id === 'comparisonAssessmentTarget') { activateAssessmentTarget(event.target.value); }
  if (event.target.name === 'type' && event.target.closest('#comparisonRelationForm')) {
    const note=event.target.closest('form').querySelector('[data-relation-help]');
    if(note)note.textContent=RELATION_HELP[event.target.value]||'';
  }
}

function onKeydown(event) {
  if (event.target.matches('.comparison-tabs [role="tab"]')) {
    const tabs=[...host.querySelectorAll('.comparison-tabs [role="tab"]')];
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const index=tabs.indexOf(event.target);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:(index-1+tabs.length)%tabs.length;
    tabs[next]?.focus(); setTab(tabs[next]?.dataset.tab,tabs[next]); return;
  }
  const dialog=event.target.closest('dialog[open]');
  if (!dialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDialog(dialog); return; }
  if (event.key !== 'Tab') return;
  const focusable=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')].filter(el=>el.getClientRects().length);
  if (!focusable.length) return;
  const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}

function setTab(next, focusTarget) {
  if (!['matrix','assessments','relations','extractions'].includes(next)) return;
  tab=next; paint();
  requestAnimationFrame(()=>host.querySelector(`[data-tab="${CSS.escape(next)}"]`)?.focus({preventScroll:true}));
  if(next==='assessments'&&!sectionLoaded.assessments&&!sectionErrors.assessments)loadAssessments();
  if(next==='relations'&&!sectionLoaded.relations&&!sectionErrors.relations)loadRelations();
  if(next==='extractions'&&!sectionLoaded.extractions&&!sectionErrors.extractions)loadExtractions();
}

async function loadRecords() {
  const seq=++requestSeq;
  recordsLoading=true;recordsError='';paint();
  try {
    const [data,me]=await Promise.all([api.sampleComparisons({...recordFilter,page:recordsPage,pageSize:12}),api.me()]);
    if(!active||seq!==requestSeq||screen!=='records')return;
    currentUser=me||currentUser;records=data.items||data.comparisons||[];recordsTotal=Number(data.total??records.length);recordsLoading=false;paint();
  } catch(error) {
    if(seq!==requestSeq)return;recordsLoading=false;recordsError=error.message||'比较记录读取失败';paint();
  }
}

async function refreshComparison(button){
  const id=Number(button.dataset.id||comparison?.id),title=button.dataset.title||comparison?.title||comparison?.name||'这条比较记录';
  if(!id||lifecycleBusy.has(`refresh:${id}`))return;
  const ok=await confirmAction({eyebrow:'建立新的冻结快照',title:'基于最新拆解重新比较？',
    message:`系统会读取「${title}」中相同的样本，并使用每篇作品当前最新的完整拆解创建一条新比较。`,
    note:'旧比较记录、旧评价和旧快照都会保留；新记录不会自动继承旧评价。',confirmLabel:'创建最新比较'});
  if(!ok)return;
  lifecycleBusy.add(`refresh:${id}`);button.disabled=true;button.textContent='正在创建…';
  try{
    const created=await api.sampleComparisonRefresh(id,key('comparison-refresh'));
    const nextId=Number(created?.id||created?.comparison?.id);
    if(!nextId)throw new Error('服务端没有返回新的比较记录 ID');
    toast('ok','已用最新拆解创建新比较，旧记录仍然保留');
    callbacks.onOpen?.(nextId);
  }catch(error){toast('info',error.message||'最新比较创建失败');button.disabled=false;button.textContent='基于最新拆解重新比较';}
  finally{lifecycleBusy.delete(`refresh:${id}`);}
}

async function deleteComparison(button){
  const id=Number(button.dataset.id||comparison?.id),title=button.dataset.title||comparison?.title||comparison?.name||'这条比较记录';
  if(!id||lifecycleBusy.has(`delete:${id}`))return;
  const ok=await confirmAction({eyebrow:'仅删除比较快照',title:'删除这条比较记录？',
    message:`「${title}」将从比较记录中移除，之后无法再打开这份冻结对照。`,
    note:'原始样本、图片、拆解结果和已经沉淀的组件都不会删除。',confirmLabel:'确认删除'});
  if(!ok)return;
  lifecycleBusy.add(`delete:${id}`);button.disabled=true;button.textContent='正在删除…';
  try{
    await api.sampleComparisonDelete(id,key('comparison-delete'));
    toast('ok','比较记录已删除，原始样本与拆解未受影响');
    if(screen==='workspace'){screen='records';comparison=null;scope=null;await loadRecords();}
    else await loadRecords();
  }catch(error){toast('info',error.message||'比较记录删除失败');button.disabled=false;button.textContent='删除记录';}
  finally{lifecycleBusy.delete(`delete:${id}`);}
}

async function loadWorkspace(id) {
  const seq=++requestSeq;
  workspaceLoading=true;workspaceError='';paint();
  try {
    const detail=await api.sampleComparison(id);
    const scopeId=detail.currentScopeId||detail.latestScopeId||detail.scope?.id||detail.currentScope?.id||detail.scopes?.[0]?.id;
    if(!scopeId)throw new Error('比较记录还没有可读取的冻结范围');
    const results=await Promise.allSettled([
      api.sampleComparisonScope(id,scopeId),api.comparisonAssessments(id,{}),api.sampleExtractions({comparisonId:id,page:1,pageSize:100}),api.me(),
    ]);
    if(!active||seq!==requestSeq||screen!=='workspace')return;
    comparison=detail;
    scope=results[0].status==='fulfilled'?results[0].value:null;
    currentUser=results[3].status==='fulfilled'?results[3].value:currentUser;
    assessments=results[1].status==='fulfilled'?await hydrateAssessments(results[1].value.items||results[1].value.assessments||[]):[];
    extractions=results[2].status==='fulfilled'?(results[2].value.items||[]):[];
    sectionErrors={
      matrix:results[0].status==='rejected'?(results[0].reason?.message||'冻结范围读取失败'):'',
      assessments:results[1].status==='rejected'?(results[1].reason?.message||'评价历史读取失败'):'',
      extractions:results[2].status==='rejected'?(results[2].reason?.message||'局部提取读取失败'):'',
      relations:'',
    };
    sectionLoaded={assessments:results[1].status==='fulfilled',relations:false,extractions:results[2].status==='fulfilled'};
    workspaceLoading=false;paint();resumeWorkspaceJobs();
  } catch(error) {
    if(seq!==requestSeq)return;workspaceLoading=false;workspaceError=error.message||'比较工作台读取失败';comparison={id};paint();
  }
}

async function loadAssessments(force=false) {
  if(!comparison?.id)return;
  if(force)sectionErrors.assessments='';
  try{const data=await api.comparisonAssessments(comparison.id,{});assessments=await hydrateAssessments(data.items||data.assessments||[]);comparison.assessmentCounts=Object.fromEntries(Object.keys(TARGETS).map(target=>[target,assessments.filter(item=>item.target===target).length]));sectionLoaded.assessments=true;sectionErrors.assessments='';if(tab==='assessments')paint();}
  catch(error){sectionErrors.assessments=error.message||'评价历史读取失败';if(tab==='assessments')paint();}
}

async function hydrateAssessments(summaries){
  if(!comparison?.id||!summaries.length)return summaries;
  const currentIds=new Set(Object.values(comparison.currentAssessments||{}).map(item=>String(item?.id)).filter(Boolean));
  const ordered=[...summaries.filter(item=>currentIds.has(String(item.id))),...summaries.filter(item=>item.target===assessmentTarget&&!currentIds.has(String(item.id)))];
  const candidates=[...new Map(ordered.map(item=>[String(item.id),item])).values()].slice(0,12);
  const loaded=await Promise.allSettled(candidates.map(item=>api.comparisonAssessment(comparison.id,item.id)));
  const details=new Map(candidates.map((item,index)=>[String(item.id),loaded[index].status==='fulfilled'?loaded[index].value:{}]));
  return summaries.map(item=>({...details.get(String(item.id)),...item,isCurrent:item.isCurrent||currentIds.has(String(item.id))}));
}

async function loadAssessmentDetail(button){const id=Number(button.dataset.id);button.disabled=true;try{const value=await api.comparisonAssessment(comparison.id,id);assessments=assessments.map(item=>Number(item.id)===id?{...item,...value}:item);if(tab==='assessments')paint();requestAnimationFrame(()=>host.querySelector(`[data-assessment-card="${id}"]`)?.focus({preventScroll:true}));}catch(error){toast('info',error.message||'评价详情读取失败');button.disabled=false;}}

async function activateAssessmentTarget(target){
  if(!TARGETS[target])return;assessmentTarget=target;
  const need=assessments.filter(item=>item.target===target&&!('commonPoints'in item)).slice(0,12);
  if(need.length){const loaded=await Promise.allSettled(need.map(item=>api.comparisonAssessment(comparison.id,item.id)));const details=new Map(need.map((item,index)=>[String(item.id),loaded[index].status==='fulfilled'?loaded[index].value:{}]));assessments=assessments.map(item=>({...details.get(String(item.id)),...item}));}
  if(tab==='assessments')paint();
}

async function loadRelations(force=false) {
  if(!scope)return;
  if(force)sectionErrors.relations='';
  try{
    const results=await Promise.all(members().map(member=>api.sampleRelations(member.sampleId||member.id,{})));
    const seen=new Set();relations=results.flatMap(value=>value.items||value.relations||[]).filter(item=>{const id=String(item.id);if(seen.has(id))return false;seen.add(id);return true;});
    sectionLoaded.relations=true;sectionErrors.relations='';if(tab==='relations')paint();
  }catch(error){sectionErrors.relations=error.message||'作品关系读取失败';if(tab==='relations')paint();}
}

async function loadExtractions(force=false) {
  if(!comparison?.id)return;
  if(force)sectionErrors.extractions='';
  try{const data=await api.sampleExtractions({comparisonId:comparison.id,page:1,pageSize:100});extractions=data.items||[];sectionLoaded.extractions=true;sectionErrors.extractions='';if(tab==='extractions')paint();}
  catch(error){sectionErrors.extractions=error.message||'局部提取读取失败';if(tab==='extractions')paint();}
}

function paint() {
  if(!host)return;
  if(screen==='records')return paintRecords();
  paintWorkspace();
}

function paintRecords() {
  const pages=Math.max(1,Math.ceil(recordsTotal/12));
  host.innerHTML=`<div class="comparison-records-page">
    <header class="stage3-page-head"><div><span>冻结范围 · 可追溯版本</span><h2>比较记录</h2><p>每次成员或主题变化都会建立新的范围版本，历史评价不会被覆盖。</p></div><button type="button" class="stage3-primary" data-comparison-action="new-from-samples">从已选样本新建</button></header>
    <form id="comparisonRecordFilters" class="stage3-filterbar"><label><span>搜索</span><input id="comparisonRecordQ" value="${esc(recordFilter.q)}" placeholder="名称或研究主题"></label><label><span>目标</span><select id="comparisonRecordTarget"><option value="">全部目标</option>${Object.entries(TARGETS).map(([value,[label]])=>`<option value="${value}" ${recordFilter.target===value?'selected':''}>${label}</option>`).join('')}</select></label><label><span>包含样本 ID</span><input id="comparisonRecordMember" inputmode="numeric" value="${esc(recordFilter.memberId)}" placeholder="例如 12"></label><button type="submit">应用筛选</button></form>
    ${recordsLoading?stateBlock('正在读取比较记录…','完整快照会在打开记录后按需加载。'):recordsError?errorBlock('比较记录没有读出来',recordsError,'retry-records'):records.length?`<div class="comparison-record-grid">${records.map(recordCard).join('')}</div>`:`<div class="stage3-empty"><b>还没有符合条件的比较记录</b><p>先在“样本”模式勾选 2–6 篇作品，再建立第一个冻结范围。</p><button type="button" data-comparison-action="new-from-samples">返回选择样本</button></div>`}
    <nav class="stage3-pagination" aria-label="比较记录分页"><span>共 ${recordsTotal} 条</span><div><button type="button" data-comparison-action="record-page" data-page="${recordsPage-1}" ${recordsPage<=1?'disabled':''}>上一页</button><b>${recordsPage} / ${pages}</b><button type="button" data-comparison-action="record-page" data-page="${recordsPage+1}" ${recordsPage>=pages?'disabled':''}>下一页</button></div></nav>
  </div>`;
}

function recordCard(item) {
  const targets=item.targets||item.currentAssessments||{};
  const counts=item.assessmentCounts||{};
  const memberCount=Number(item.memberCount??item.latestScope?.memberCount??item.scope?.memberCount??item.members?.length??0);
  const title=item.name||item.title||'未命名比较';
  return `<article class="comparison-record-card"><header><span>范围 v${item.scopeRevision||item.currentScopeRevision||item.latestScope?.revision||1}</span><b>${memberCount} 篇样本</b></header><h3>${esc(title)}</h3><p>${esc(item.topic||item.latestScope?.topicBasis||item.purpose||'未填写研究主题')}</p><div class="comparison-target-summary">${Object.entries(TARGETS).map(([target,[label]])=>{const count=Number(counts[target]||0);return `<span class="${count||targets[target]?'ready':''}">${label}<b>${count?`${count} 个版本`:targets[target]?'已选官方版本':'未评价'}</b></span>`;}).join('')}</div><footer><span>${fmt(item.updatedAt||item.createdAt)}</span><div class="comparison-record-actions"><button type="button" data-comparison-action="refresh-comparison" data-id="${item.id}" data-title="${esc(title)}">最新拆解重建</button>${currentUser?.role==='admin'?`<button type="button" class="danger" data-comparison-action="delete-comparison" data-id="${item.id}" data-title="${esc(title)}">删除</button>`:''}<button type="button" class="primary" data-comparison-id="${item.id}">打开工作台</button></div></footer></article>`;
}

function paintWorkspace() {
  if(workspaceLoading){host.innerHTML=stateBlock('正在建立比较工作台…','读取固定分析版本、十五维快照和指标观察时间。');return;}
  if(workspaceError){host.innerHTML=errorBlock('比较工作台没有打开',workspaceError,'retry-workspace');return;}
  if(!comparison||!scope){host.innerHTML=errorBlock('比较范围不可用','请返回记录列表后重试。','records');return;}
  const tabs=[['matrix','维度对照'],['assessments','目标评价'],['relations','作品关系'],['extractions','局部提取']];
  host.innerHTML=`<div class="comparison-workspace">
    <header class="comparison-workspace-head"><button type="button" data-comparison-action="records">← 比较记录</button><div><span>冻结范围 v${scope.revision||scope.scopeRevision||1}</span><h2>${esc(comparison.name||comparison.title||'样本比较')}</h2><p>${esc(scope.topicBasis||scope.topic||comparison.topic||comparison.purpose||'未填写研究主题')}</p></div><div class="comparison-workspace-tools"><div class="comparison-scope-status"><b>${members().length}</b><span>篇固定样本</span></div><button type="button" data-comparison-action="refresh-comparison" data-id="${comparison.id}" data-title="${esc(comparison.name||comparison.title||'样本比较')}">基于最新拆解重新比较</button>${currentUser?.role==='admin'?`<button type="button" class="danger" data-comparison-action="delete-comparison" data-id="${comparison.id}" data-title="${esc(comparison.name||comparison.title||'样本比较')}">删除记录</button>`:''}</div></header>
    ${frozenDisclosure()}
    <div class="comparison-tabs" role="tablist" aria-label="比较工作台">${tabs.map(([name,label])=>`<button id="comparisonTab-${name}" role="tab" aria-selected="${tab===name}" aria-controls="comparisonPanel-${name}" tabindex="${tab===name?'0':'-1'}" class="${tab===name?'on':''}" data-comparison-action="tab" data-tab="${name}">${label}</button>`).join('')}</div>
    <section class="comparison-panel" id="comparisonPanel-${tab}" role="tabpanel" aria-labelledby="comparisonTab-${tab}">${tab==='matrix'?matrixPanel():tab==='assessments'?assessmentPanel():tab==='relations'?relationsPanel():extractionsPanel()}</section>
  </div>`;
}

function frozenDisclosure() {
  const mixed=scope.mixedPlatforms??new Set(members().map(member=>member.platform).filter(Boolean)).size>1,coverage=scope.metricCoverage||{};
  const coverageText=METRICS.map(([key,label])=>{const item=coverage[key],available=typeof item==='object'?Number(item.available||0):Number(String(item||'0/0').split('/')[0]||0),total=typeof item==='object'?Number(item.total||scope.sampleSize||members().length):Number(String(item||`0/${members().length}`).split('/')[1]||members().length);return `<span><b>${label}</b>${available}/${total}</span>`;}).join('');
  return `<details class="comparison-frozen-note"><summary><span><b>比较范围已冻结</b><small>样本量 ${Number(scope.sampleSize||members().length)}；分析版本、决定、指标值和观察时间保留当时状态</small></span><i>查看元数据与指标</i></summary><div class="comparison-policy"><div><b>指标覆盖率</b>${coverageText}</div><p>${mixed||scope.rankingPolicy==='mixed_platforms_not_directly_rankable'?'成员来自不同平台，指标只披露各自观察值，不进行跨平台直接排序。':'同平台指标仍只作描述性观察，不用于排名或因果判断。'}</p></div><div class="comparison-frozen-grid">${members().map(member=>`<article><h3>${esc(member.title||`样本 #${member.sampleId||member.id}`)}</h3><dl><div><dt>账号</dt><dd>${esc(member.accountName||'—')}</dd></div><div><dt>平台</dt><dd>${esc(member.platformLabel||member.platform||'—')}</dd></div><div><dt>发布时间</dt><dd>${fmt(member.publishedAt)}</dd></div><div><dt>分析版本</dt><dd>v${esc(member.analysisRevision||member.analysisVersionId||'—')}</dd></div><div><dt>指标观察</dt><dd>${fmt(member.metricObservedAt||member.metrics?.observedAt)}</dd></div><div><dt>观察窗口</dt><dd>${member.observationWindowSeconds==null?'—':`${Math.round(member.observationWindowSeconds/3600)} 小时`}</dd></div></dl><div class="comparison-frozen-metrics">${METRICS.map(([key,label])=>`<span><small>${label}</small><b>${member.metrics?.[key]==null||member.metrics?.[key]===''?'—':esc(member.metrics[key])}</b></span>`).join('')}</div></article>`).join('')}</div><p>“—”表示冻结时未采集到该值，不会补成 0。观察时间不同的样本只并列披露。</p></details>`;
}

function members() { return scope?.members||scope?.sampleMembers||scope?.memberSnapshots||[]; }
function dimensions() {
  const supplied=scope?.dimensions||scope?.dimensionDictionary;
  return supplied?.length?supplied.map((d,index)=>({key:d.key||d.dimensionKey,label:d.label||d.name||d.dimensionKey,ordinal:d.ordinal||d.sortOrder||index+1})):FALLBACK_DIMENSIONS;
}
function memberElement(member,dimensionKey) {
  return (member.elements||member.elementSnapshots||scope?.elements?.filter(item=>String(item.sampleId)===String(member.sampleId||member.id))||[]).find(item=>(item.dimensionKey||item.key)===dimensionKey)||{};
}
function effectiveValue(element) { return element.effectiveValue??element.value??element.valueJson??element.snapshotValue; }

function matrixPanel() {
  if(sectionErrors.matrix)return errorBlock('冻结矩阵没有读出来',sectionErrors.matrix,'retry-workspace');
  const rows=dimensions(),cols=members();
  return `<div class="comparison-matrix-intro"><div><h3>十五维横向对照</h3><p>这里展示的是范围建立时的有效值与适用边界，不会随单篇样本后续编辑漂移。</p></div><span>${rows.length} 个维度 · ${cols.length} 篇作品</span></div>
    <div class="comparison-matrix-scroll" tabindex="0" aria-label="横向比较表，可在区域内左右滚动"><table class="comparison-matrix-table"><thead><tr><th scope="col">比较维度</th>${cols.map(member=>`<th scope="col"><span>${esc(member.platformLabel||member.platform||'样本')}</span><b>${esc(member.title||`样本 #${member.sampleId||member.id}`)}</b><small>${esc(member.accountName||'账号待补')}</small></th>`).join('')}</tr></thead><tbody>${rows.map(dim=>`<tr><th scope="row"><span>${String(dim.ordinal).padStart(2,'0')}</span><b>${esc(dim.label)}</b></th>${cols.map(member=>matrixCell(memberElement(member,dim.key))).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="comparison-mobile-dimensions">${rows.map(dim=>`<article class="comparison-mobile-dimension"><header><span>${String(dim.ordinal).padStart(2,'0')}</span><h3>${esc(dim.label)}</h3></header>${cols.map(member=>`<section><h4>${esc(member.title||`样本 #${member.sampleId||member.id}`)}</h4>${matrixCellBody(memberElement(member,dim.key))}</section>`).join('')}</article>`).join('')}</div>`;
}
function matrixCell(element){return `<td>${matrixCellBody(element)}</td>`;}
function matrixCellBody(element){const state=element.state||element.status||'value';return `<p>${esc(valueText(effectiveValue(element)))}</p>${element.functionText||element.function?`<small><b>承担功能</b>${esc(element.functionText||element.function)}</small>`:''}${element.applicability?`<small><b>适用</b>${esc(element.applicability)}</small>`:''}${element.limitations?`<small><b>限制</b>${esc(element.limitations)}</small>`:''}<i class="element-state ${esc(state)}">${state==='insufficient'?'证据不足':state==='not_applicable'?'不适用':'固定快照'}</i>`;}

function assessmentPanel() {
  if(sectionErrors.assessments)return errorBlock('评价历史没有读出来',sectionErrors.assessments,'retry-assessments');
  const list=assessments.filter(item=>(item.target||item.objective)===assessmentTarget);
  const activeJob=currentJob();
  return `<div class="comparison-assessment-layout"><section class="comparison-assessment-compose"><header><span>追加版本</span><h3>按目标建立评价</h3><p>四个目标各自保留独立版本与官方选择；只记录观察、假设、建议与方法边界。</p></header><label class="stage3-field"><span>评价目标</span><select id="comparisonAssessmentTarget">${Object.entries(TARGETS).map(([value,[label]])=>`<option value="${value}" ${assessmentTarget===value?'selected':''}>${label} · ${Number(comparison?.assessmentCounts?.[value]||assessments.filter(item=>item.target===value).length)} 个版本</option>`).join('')}</select></label><div id="comparisonAssessmentJob">${jobBanner(activeJob)}</div><button type="button" class="stage3-secondary stage3-ai-button" data-comparison-action="start-ai" ${activeJob?'disabled':''}>${activeJob?'该目标 AI 任务处理中':'启动 AI 评价'}</button>${manualAssessmentForm()}</section>
    <section class="comparison-assessment-history"><header><div><span>版本历史</span><h3>${TARGETS[assessmentTarget][0]}</h3></div><b>${list.length} 个版本</b></header>${list.length?list.map(assessmentCard).join(''):'<div class="stage3-empty compact"><b>这个目标还没有评价</b><p>可以追加人工版本，或启动一次 AI 任务。</p></div>'}</section></div>`;
}
function manualAssessmentForm() {
  const fields=[['commonPoints','共同点'],['keyDifferences','关键差异'],['strengths','可取之处'],['limitations','限制'],['worthLearning','值得学习'],['avoidCopying','不应照搬'],['effectHypotheses','可能的机制假设'],['verificationQuestions','待核实问题'],['methodLimitations','方法限制']];
  return `<form id="comparisonManualAssessmentForm" class="comparison-assessment-form"><input type="hidden" name="target" value="${assessmentTarget}"><header><b>人工评价</b><span>保存后追加为新版本</span></header>${fields.map(([name,label])=>`<label><span>${label}</span><textarea name="${name}" rows="2" maxlength="12000"></textarea></label>`).join('')}<div class="stage3-form-error" aria-live="polite"></div><button type="submit" class="stage3-primary">保存人工版本</button></form>`;
}
function assessmentCard(item) {
  const hypotheses=(item.hypotheses||item.effectHypotheses||[]).map(value=>typeof value==='object'?`${value.claimText||value.claim||''}${value.limitations?`（限制：${value.limitations}）`:''}`:value);
  const fields=[['共同点',item.commonPoints],['关键差异',item.keyDifferences],['可取之处',item.strengths],['限制',item.limitations],['值得学习',item.worthLearning],['不应照搬',item.doNotCopy??item.avoidCopying],['可能的机制假设',hypotheses],['待核实',item.openQuestions??item.verificationQuestions],['方法限制',item.methodLimitations]];
  const current=item.isCurrent||item.current||String(comparison?.currentAssessments?.[assessmentTarget]?.id)===String(item.id);
  const hydrated='commonPoints'in item||'findings'in item;
  return `<article class="comparison-assessment-card" data-assessment-card="${item.id}" tabindex="-1"><header><div><span class="source ${esc(item.source||item.origin||'manual')}">${(item.source||item.origin)==='ai'?'AI 评价':'人工评价'}</span>${current?'<i>官方采用</i>':''}</div><b>v${item.revision||item.id}</b></header><p class="assessment-meta">${fmt(item.createdAt)} · 范围 #${item.scopeId||scope.id}${item.confidence==null?'':` · 置信度 ${Math.round(Number(item.confidence)*100)}%`}</p>${hydrated?fields.filter(([,value])=>Array.isArray(value)?value.length:value).map(([label,value])=>`<div><small>${label}</small><p>${esc(Array.isArray(value)?value.join('；'):value)}</p></div>`).join(''):`<button type="button" data-comparison-action="load-assessment-detail" data-id="${item.id}">加载该版本详情</button>`}${!current&&canReview()?`<button type="button" data-comparison-action="select-assessment" data-id="${item.id}">设为该目标官方版本</button>`:''}</article>`;
}

async function saveManualAssessment(form) {
  const button=form.querySelector('button[type="submit"]');button.disabled=true;clearFormError(form);
  const data=new FormData(form),one=name=>{const value=String(data.get(name)||'').trim();return value?[value]:[];};
  const commonPoints=one('commonPoints'),keyDifferences=one('keyDifferences'),strengths=one('strengths'),limitations=one('limitations'),worthLearning=one('worthLearning'),doNotCopy=one('avoidCopying'),hypothesisClaims=one('effectHypotheses'),openQuestions=one('verificationQuestions'),methodLimitations=one('methodLimitations');
  const hypothesisLimit=methodLimitations[0]||limitations[0]||'需要在更多同类样本和一致观察窗口中继续核对。';
  const finding=(kind,claimText,evidenceState='manual_unverified')=>({kind,claimText,limitations:kind==='hypothesis'?hypothesisLimit:null,evidenceState,memberSampleId:null,evidenceTokens:[]});
  const findings=[...commonPoints.map(value=>finding('observation',value)),...keyDifferences.map(value=>finding('observation',value)),...strengths.map(value=>finding('observation',value)),...worthLearning.map(value=>finding('recommendation',value)),...doNotCopy.map(value=>finding('recommendation',value)),...hypothesisClaims.map(value=>finding('hypothesis',value,'insufficient'))];
  if(!findings.length){setFormError(form,'请至少填写一条共同点、差异、可取之处、建议或机制假设。');button.disabled=false;return;}
  const payload={target:String(data.get('target')),findings,commonPoints,keyDifferences,strengths,limitations,worthLearning,doNotCopy,hypotheses:hypothesisClaims.map(claimText=>({claimText,limitations:hypothesisLimit})),openQuestions,methodLimitations};
  try{await api.comparisonAssessmentManual(comparison.id,scope.id,payload,key('manual-assessment'));form.reset();toast('ok','人工评价已追加为新版本');await loadAssessments(true);}
  catch(error){setFormError(form,error.message||'保存失败，已填写内容仍保留');}
  finally{if(button.isConnected)button.disabled=false;}
}

async function startAiAssessment(button) {
  const mapKey=jobKey();if(jobs.has(mapKey))return;button.disabled=true;
  try{const started=await api.comparisonAssessmentJobStart(comparison.id,scope.id,{target:assessmentTarget},key('assessment-job'));const next=started.job||started;jobs.set(mapKey,next);saveStoredJobs();paint();pollJob(mapKey,next.id||next.jobId);}
  catch(error){jobs.delete(mapKey);saveStoredJobs();toast('info',error.message||'AI 评价任务启动失败');paint();}
}
function pollJob(mapKey,jobId,immediate=false) {
  clearTimeout(pollTimers.get(mapKey));
  const timer=setTimeout(async()=>{
    if(!active||!comparison)return;
    try{const response=await api.comparisonAssessmentJob(comparison.id,jobId),next={...(response.job||response),pollError:null};jobs.set(mapKey,next);saveStoredJobs();if(tab==='assessments')paint();if(['queued','running'].includes(next.status))pollJob(mapKey,jobId);else{pollTimers.delete(mapKey);jobs.delete(mapKey);saveStoredJobs();if(next.status==='succeeded'||next.status==='completed'){toast('ok','AI 评价版本已生成');await loadAssessments(true);}else{toast('info',next.errorMessage||'AI 评价未完成，可稍后重试');if(tab==='assessments')paint();}}}
    catch(error){pollTimers.delete(mapKey);const retained={...(jobs.get(mapKey)||{}),id:jobId,pollError:error.message||'任务状态读取失败'};jobs.set(mapKey,retained);saveStoredJobs();if(tab==='assessments')paint();}
  },immediate?80:900);
  pollTimers.set(mapKey,timer);
}
function jobBanner(job){if(!job)return '<p class="stage3-job-note">AI 只读取当前冻结范围内的白名单快照与已核验证据。</p>';if(job.pollError)return `<div class="stage3-job error" role="status" aria-live="polite"><span><b>${esc(job.pollError)}</b><small>任务仍保留</small></span><button type="button" data-comparison-action="retry-job">重试并恢复跟踪</button></div>`;return `<div class="stage3-job" role="status" aria-live="polite"><span><i></i><b>${esc(job.message||'正在生成该目标的评价版本…')}</b><small>${esc(job.status||'queued')}</small></span><progress max="100" value="${Number(job.progress||job.progressPercent||8)}"></progress></div>`;}
function resumeWorkspaceJobs(){for(const [mapKey,stored] of jobs){const [comparisonId,scopeId]=mapKey.split(':').map(Number);if(comparisonId===Number(comparison?.id)&&scopeId===Number(scope?.id)&&['queued','running'].includes(stored.status))pollJob(mapKey,stored.id||stored.jobId,true);}}
async function selectAssessment(button){button.disabled=true;try{await api.comparisonAssessmentSelect(comparison.id,button.dataset.id,key('assessment-select'));toast('ok','该目标的官方评价版本已更新');await loadWorkspace(comparison.id);}catch(error){toast('info',error.message||'官方版本选择失败');button.disabled=false;}}

function relationsPanel() {
  if(sectionErrors.relations)return errorBlock('作品关系没有读出来',sectionErrors.relations,'retry-relations');
  return `<div class="comparison-section-head"><div><span>文本关系图谱</span><h3>作品之间的可核验关系</h3><p>引用、模仿、演化按“主作品 → 客作品”表达；变体关系没有方向。确认前必须添加端点分析中的已核验证据。</p></div><button type="button" class="stage3-primary" data-comparison-action="new-relation">新建关系候选</button></div>${relations.length?`<div class="comparison-relation-list">${relations.map(relationCard).join('')}</div>`:'<div class="stage3-empty"><b>当前范围还没有关系候选</b><p>关系需要明确端点、固定分析版本与可核验证据。</p></div>'}${relationDialog()}${relationEvidenceDialog()}`;
}
function relationCard(item) {
  const subjectId=item.subjectSampleId??item.subject?.sampleId,objectId=item.objectSampleId??item.object?.sampleId;
  const subject=item.subjectTitle||item.subject?.title||memberName(subjectId),object=item.objectTitle||item.object?.title||memberName(objectId),type=item.type||item.relationType;
  const sentence=type==='variant'?`${subject} 与 ${object} 互为变体`:`${subject} ${RELATION_LABELS[type]||'关联'} ${object}`;
  const persistedEvidence=[item.evidence,item.evidences,item.verifiedEvidence].find(Array.isArray)||[],evidence=[...persistedEvidence,...(relationEvidence.get(String(item.id))||[])],evidenceCount=Number(item.evidenceCount??item.verifiedEvidenceCount??evidence.length),hasEvidence=Boolean(item.hasVerifiedEvidence??evidenceCount>0),state=item.state||'proposed',reviewable=['proposed','pending','withdrawn'].includes(state),canWithdraw=Boolean((item.canWithdraw??item.permissions?.canWithdraw)||(canReview()&&['proposed','pending','confirmed'].includes(state))||(state==='proposed'&&Number(item.proposedBy||item.proposedById)===Number(currentUser?.id)));
  return `<article class="comparison-relation-card"><header><span class="relation-state ${esc(state)}">${esc(stateLabel(state))}</span><b>${esc(type==='variant'?'无方向关系':'有方向关系')}</b></header><h4>${esc(item.text||sentence)}</h4><p>${esc(item.rationale||'尚未补充关系依据')}</p><details><summary>已添加端点证据 · ${evidenceCount} 条</summary>${evidence.length?evidence.map(value=>`<blockquote>${esc(value.quoteText||value.quote||value.note||'端点分析中的已核验证据')}<footer>${esc(value.locator||value.sourceLabel||`证据 #${value.elementEvidenceId||value.id}`)}</footer></blockquote>`).join(''):hasEvidence?'<p>已保存端点核验证据；正文按权限保持轻量披露。</p>':'<p>确认前至少需要一条属于任一端点固定分析版本的已核验证据。</p>'}</details><footer>${reviewable?`<button type="button" data-comparison-action="add-relation-evidence" data-id="${item.id}">添加端点证据</button>`:''}${canReview()&&reviewable?`<button type="button" data-comparison-action="edit-relation" data-id="${item.id}">编辑为替代候选</button>`:''}${canReview()&&hasEvidence&&reviewable?`<button type="button" data-comparison-action="relation-event" data-event="confirm" data-id="${item.id}">确认关系</button>`:''}${canReview()&&['proposed','pending'].includes(state)?`<button type="button" data-comparison-action="relation-event" data-event="reject" data-id="${item.id}">驳回</button>`:''}${canWithdraw?`<button type="button" data-comparison-action="relation-event" data-event="withdraw" data-id="${item.id}">撤回关系</button>`:''}</footer></article>`;
}
function relationDialog(){return `<dialog id="comparisonRelationDialog" class="stage3-dialog"><form id="comparisonRelationForm"><header><div><span>追加不可变候选</span><h3>作品关系</h3></div><button type="button" data-comparison-action="close-dialog" aria-label="关闭关系编辑">×</button></header><input type="hidden" name="supersedesRelationId"><div class="stage3-form-grid"><label><span>主作品</span><select name="subjectSampleId" required>${members().map(member=>`<option value="${member.sampleId||member.id}">${esc(member.title||`样本 #${member.sampleId||member.id}`)}</option>`).join('')}</select></label><label><span>关系类型</span><select name="type">${Object.entries(RELATION_LABELS).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><label><span>客作品</span><select name="objectSampleId" required>${members().map(member=>`<option value="${member.sampleId||member.id}">${esc(member.title||`样本 #${member.sampleId||member.id}`)}</option>`).join('')}</select></label><p class="stage3-field-note" data-relation-help>${RELATION_HELP.citation}</p><label class="wide"><span>关系依据</span><textarea name="rationale" rows="5" maxlength="12000" required placeholder="描述观察到的结构、表达或素材关系，并保留不确定性。"></textarea></label></div><div class="stage3-form-error" aria-live="polite"></div><footer><button type="button" data-comparison-action="close-dialog">取消</button><button type="submit" class="stage3-primary">保存为待确认候选</button></footer></form></dialog>`;}
function relationEvidenceDialog(){return `<dialog id="comparisonRelationEvidenceDialog" class="stage3-dialog"><form id="comparisonRelationEvidenceForm"><header><div><span>端点固定分析版本</span><h3>添加已核验证据</h3></div><button type="button" data-comparison-action="close-dialog" aria-label="关闭证据选择">×</button></header><input type="hidden" name="relationId"><div class="relation-evidence-picker" role="status">正在读取两端分析证据…</div><label class="stage3-field"><span>证据说明</span><textarea name="note" rows="3" maxlength="4000"></textarea></label><div class="stage3-form-error" aria-live="polite"></div><footer><button type="button" data-comparison-action="close-dialog">取消</button><button type="submit" class="stage3-primary">添加证据</button></footer></form></dialog>`;}

function openRelationDialog(item,trigger) {
  const dialog=host.querySelector('#comparisonRelationDialog');if(!dialog)return;
  const form=dialog.querySelector('form');form.reset();clearFormError(form);
  if(item){form.elements.supersedesRelationId.value=item.id;form.elements.subjectSampleId.value=item.subjectSampleId??item.subject?.sampleId;form.elements.objectSampleId.value=item.objectSampleId??item.object?.sampleId;form.elements.type.value=item.type||item.relationType;form.elements.rationale.value=item.rationale||'';}
  openDialog(dialog,trigger);
}
async function saveRelation(form) {
  const data=new FormData(form),button=form.querySelector('button[type="submit"]');button.disabled=true;clearFormError(form);
  const subjectSampleId=Number(data.get('subjectSampleId')),objectSampleId=Number(data.get('objectSampleId'));
  if(subjectSampleId===objectSampleId){setFormError(form,'主作品和客作品不能是同一篇样本。');button.disabled=false;return;}
  const subject=members().find(item=>Number(item.sampleId||item.id)===subjectSampleId),object=members().find(item=>Number(item.sampleId||item.id)===objectSampleId);
  const rationale=String(data.get('rationale')||'').trim(),supersedesRelationId=data.get('supersedesRelationId')?Number(data.get('supersedesRelationId')):null;
  const payload={subjectSampleId,subjectAnalysisVersionId:subject?.analysisVersionId,objectSampleId,objectAnalysisVersionId:object?.analysisVersionId,relationType:data.get('type'),rationale};
  try{const created=await api.sampleRelationCreate(payload,key('relation'));const createdId=created?.id||created?.relation?.id;if(supersedesRelationId&&createdId){try{await api.sampleRelationEvent(supersedesRelationId,{eventType:'superseded',supersededByRelationId:createdId,reason:'结构编辑建立了替代候选'},key('relation-supersede'));}catch(error){try{await api.sampleRelationEvent(createdId,{eventType:'withdrawn',reason:'替代旧关系失败，撤回新候选'},key('relation-compensate'));}catch{/* report original failure */}throw error;}}closeDialog(form.closest('dialog'));toast('ok',supersedesRelationId?'替代候选已建立，旧关系历史保留':'关系候选已建立');await loadRelations(true);}
  catch(error){setFormError(form,error.message||'关系候选保存失败，输入仍保留');}
  finally{if(button.isConnected)button.disabled=false;}
}
async function openRelationEvidenceDialog(item,trigger){
  if(!item)return;const dialog=host.querySelector('#comparisonRelationEvidenceDialog'),form=dialog?.querySelector('form');if(!dialog||!form)return;
  form.reset();form.elements.relationId.value=item.id;clearFormError(form);const picker=form.querySelector('.relation-evidence-picker');picker.textContent='正在读取两端分析证据…';openDialog(dialog,trigger);
  try{
    let options=relationEvidenceOptions.get(String(item.id));
    if(!options){const endpoints=[item.subject||{sampleId:item.subjectSampleId,analysisVersionId:item.subjectAnalysisVersionId,title:item.subjectTitle},item.object||{sampleId:item.objectSampleId,analysisVersionId:item.objectAnalysisVersionId,title:item.objectTitle}],results=await Promise.allSettled(endpoints.map(endpoint=>api.sampleAnalysis(endpoint.sampleId,endpoint.analysisVersionId)));options=results.flatMap((result,index)=>result.status==='fulfilled'?(result.value.elements||result.value.analysisElements||[]).flatMap(element=>(element.evidence||element.evidences||[]).filter(value=>value.id&&value.verified!==false).map(value=>({endpointSampleId:Number(endpoints[index].sampleId),endpointAnalysisVersionId:Number(endpoints[index].analysisVersionId),elementEvidenceId:Number(value.id),label:`${endpoints[index].title||`样本 #${endpoints[index].sampleId}`} · ${element.label||dimensionName(element.dimensionKey)} · ${String(value.quoteText||value.quote||'已核验证据').slice(0,90)}`,quoteText:value.quoteText||value.quote,locator:value.locator||value.location}))):[]);relationEvidenceOptions.set(String(item.id),options);}
    if(!dialog.open)return;picker.innerHTML=options.length?`<fieldset><legend>选择一条属于任一端点固定分析版本的证据</legend>${options.map((option,index)=>`<label><input type="radio" name="evidenceIndex" value="${index}" ${index===0?'checked':''}><span>${esc(option.label)}</span></label>`).join('')}</fieldset>`:'<p>两端固定分析版本中没有可添加的已核验证据。</p>';form.querySelector('button[type="submit"]').disabled=!options.length;form.dataset.options=String(item.id);
  }catch(error){if(dialog.open){picker.innerHTML='<p>端点证据读取失败。</p>';setFormError(form,error.message||'端点证据读取失败');form.querySelector('button[type="submit"]').disabled=true;}}
}
async function saveRelationEvidence(form){
  const relationId=Number(form.elements.relationId.value),options=relationEvidenceOptions.get(String(relationId))||[],index=Number(new FormData(form).get('evidenceIndex')),selected=options[index],button=form.querySelector('button[type="submit"]');if(!selected){setFormError(form,'请选择一条已核验证据。');return;}button.disabled=true;clearFormError(form);
  const payload={endpointSampleId:selected.endpointSampleId,endpointAnalysisVersionId:selected.endpointAnalysisVersionId,elementEvidenceId:selected.elementEvidenceId,note:String(new FormData(form).get('note')||'').trim()};
  try{const saved=await api.sampleRelationEvidence(relationId,payload,key('relation-evidence'));const list=relationEvidence.get(String(relationId))||[];list.push({...saved,...selected,note:payload.note});relationEvidence.set(String(relationId),list);closeDialog(form.closest('dialog'));toast('ok','端点已核验证据已添加');await loadRelations(true);relationEvidence.delete(String(relationId));if(tab==='relations')paint();}
  catch(error){setFormError(form,error.message||'证据添加失败，选择仍保留');}
  finally{if(button.isConnected)button.disabled=false;}
}
async function relationEvent(button){button.disabled=true;const eventType={confirm:'confirmed',reject:'rejected',withdraw:'withdrawn'}[button.dataset.event]||button.dataset.event;try{await api.sampleRelationEvent(button.dataset.id,{eventType},key('relation-event'));toast('ok','关系状态已追加');await loadRelations(true);}catch(error){toast('info',error.message||'关系状态更新失败');button.disabled=false;}}
function memberName(id){return members().find(member=>String(member.sampleId||member.id)===String(id))?.title||`样本 #${id}`;}

function extractionsPanel() {
  if(sectionErrors.extractions)return errorBlock('局部提取没有读出来',sectionErrors.extractions,'retry-extractions');
  return `<div class="comparison-section-head"><div><span>局部研究判断</span><h3>从冻结快照提取可复用模式</h3><p>提取只描述一个维度的局部模式，不承载整篇作品的互动表现结论。</p></div><button type="button" class="stage3-primary" data-comparison-action="new-extraction">新建局部提取</button></div>${extractions.length?`<div class="comparison-extraction-grid">${extractions.map(extractionCard).join('')}</div>`:'<div class="stage3-empty"><b>还没有局部提取</b><p>从同一维度至少选择一条主要来源快照，再记录适用范围与不可照搬之处。</p></div>'}${extractionDialog()}`;
}
function extractionCard(item){return `<article class="comparison-extraction-card"><header><span>${esc(dimensionName(item.dimensionKey))}</span><b>${(item.origin||item.source)==='ai'?'AI 草稿':'人工提取'}</b></header><h4>${esc(item.patternText||item.pattern||item.name||'未命名模式')}</h4><p>${esc(item.functionText||item.function||'尚未填写承担功能')}</p><dl><div><dt>适用</dt><dd>${esc(item.applicability||'—')}</dd></div><div><dt>限制</dt><dd>${esc(item.limitations||'—')}</dd></div><div><dt>不可照搬</dt><dd>${esc(item.doNotCopy||item.avoidCopying||'—')}</dd></div></dl><footer><span>${(item.sources||item.sourceSnapshots||[]).length||'已固定'} 条来源</span><button type="button" data-comparison-action="component-from-extraction" data-id="${item.id}">进入组件管理</button></footer></article>`;}
function extractionDialog(){return `<dialog id="comparisonExtractionDialog" class="stage3-dialog stage3-sheet"><form id="comparisonExtractionForm"><header><div><span>局部提取工作表</span><h3>记录一个可复用模式</h3></div><button type="button" data-comparison-action="close-dialog" aria-label="关闭局部提取">×</button></header><label class="stage3-field"><span>维度</span><select name="dimensionKey">${dimensions().map(dim=>`<option value="${dim.key}">${esc(dim.label)}</option>`).join('')}</select></label><label class="stage3-field"><span>模式</span><textarea name="pattern" rows="3" maxlength="4000" required></textarea></label><label class="stage3-field"><span>承担功能</span><textarea name="functionText" rows="3" maxlength="4000" required></textarea></label><label class="stage3-field"><span>判断依据</span><textarea name="rationale" rows="3" maxlength="12000" required></textarea></label><label class="stage3-field"><span>适用范围</span><textarea name="applicability" rows="3" maxlength="12000" required></textarea></label><label class="stage3-field"><span>限制与边界</span><textarea name="limitations" rows="3" maxlength="12000" required></textarea></label><label class="stage3-field"><span>不可照搬</span><textarea name="doNotCopy" rows="3" maxlength="12000" required></textarea></label><fieldset class="extraction-sources"><legend>来源快照 · 至少一条主要来源</legend>${members().map((member,index)=>`<label><input type="radio" name="primarySampleId" value="${member.sampleId||member.id}" ${index===0?'checked':''}><span><b>${esc(member.title||`样本 #${member.sampleId||member.id}`)}</b><small>设为主要来源</small></span></label>`).join('')}</fieldset><div class="stage3-form-error" aria-live="polite"></div><footer><button type="button" data-comparison-action="close-dialog">取消</button><button type="submit" class="stage3-primary">保存局部提取</button></footer></form></dialog>`;}
function openExtractionDialog(trigger){const dialog=host.querySelector('#comparisonExtractionDialog');if(!dialog)return;dialog.querySelector('form').reset();clearFormError(dialog.querySelector('form'));openDialog(dialog,trigger);}
async function saveExtraction(form){const data=new FormData(form),button=form.querySelector('button[type="submit"]');button.disabled=true;clearFormError(form);const dimensionKey=data.get('dimensionKey'),sampleId=Number(data.get('primarySampleId')),member=members().find(item=>Number(item.sampleId||item.id)===sampleId),element=memberElement(member||{},dimensionKey);const payload={dimensionKey,patternText:String(data.get('pattern')||'').trim(),functionText:String(data.get('functionText')||'').trim(),rationale:String(data.get('rationale')||'').trim(),applicability:String(data.get('applicability')||'').trim(),limitations:String(data.get('limitations')||'').trim(),doNotCopy:String(data.get('doNotCopy')||'').trim(),sources:[{snapshotId:element.snapshotId||element.id,sourceRole:'primary'}]};try{await api.sampleExtractionCreate(comparison.id,scope.id,payload,key('extraction'));closeDialog(form.closest('dialog'));toast('ok','局部提取已保存');await loadExtractions(true);}catch(error){setFormError(form,error.message||'局部提取保存失败，输入仍保留');}finally{if(button.isConnected)button.disabled=false;}}
function dimensionName(dimensionKey){return dimensions().find(item=>item.key===dimensionKey)?.label||dimensionKey||'未知维度';}

function openDialog(dialog,trigger){dialogReturnFocus=trigger||document.activeElement;dialog.showModal();requestAnimationFrame(()=>dialog.querySelector('input,select,textarea,button')?.focus());}
function closeDialog(dialog){if(!dialog?.open)return;dialog.close();const target=dialogReturnFocus;dialogReturnFocus=null;requestAnimationFrame(()=>target?.isConnected&&target.focus());}
function closeOpenDialogs(){host?.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());dialogReturnFocus=null;}
function setFormError(form,message){const box=form.querySelector('.stage3-form-error');if(box){box.textContent=message;box.focus?.();}}
function clearFormError(form){const box=form.querySelector('.stage3-form-error');if(box)box.textContent='';}
function stateBlock(title,note){return `<div class="stage3-state"><i></i><b>${esc(title)}</b><p>${esc(note)}</p></div>`;}
function errorBlock(title,message,action){return `<div class="stage3-state error"><b>${esc(title)}</b><p>${esc(message)}</p><button type="button" data-comparison-action="${esc(action)}">重试</button></div>`;}
