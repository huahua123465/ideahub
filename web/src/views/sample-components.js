/** Stage 3: versioned content-component review and lightweight reusable whitelist. */
import { api } from '../api.js';
import { esc } from '../util.js';
import { toast } from '../toast.js';

const DIMENSIONS = [
  ['audience','用户对象'],['user_need','用户需求'],['topic','选题'],['core_viewpoint','核心观点'],
  ['breakout_point','爆点'],['title_mechanism','标题机制'],['opening_method','开头方式'],
  ['content_structure','内容结构'],['argumentation_method','论证方式'],['language_style','语言风格'],
  ['length','篇幅'],['layout','排版'],['visual_style','视觉风格'],['bgm','BGM'],['cta','CTA'],
];
const STATES={draft:'草稿',submitted:'待审核',changes_requested:'需修改',approved:'已批准',retired:'已停用'};
const SOURCES={manual:'人工建立',ai:'AI 草稿'};

let host=null;
let active=false;
let boundHost=null;
let callbacks={};
let mode='management';
let items=[];
let total=0;
let page=1;
let loading=false;
let loadError='';
let detail=null;
let detailLoading=false;
let detailError='';
let me={role:'member'};
let filter={q:'',dimensionKey:'',state:'',source:'',tagIds:''};
let timer=null;
let seq=0;
let returnFocus=null;
let pendingSeed=null;

const idem=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const fmt=value=>{if(!value)return '—';const date=new Date(value);return Number.isNaN(date.valueOf())?String(value):date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
const dimName=key=>DIMENSIONS.find(([value])=>value===key)?.[1]||key||'未知维度';

export function leaveComponents(){active=false;seq+=1;clearTimeout(timer);timer=null;host?.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());}

export async function openComponentLibrary(container,options={}){
  active=true;host=container;callbacks=options;pendingSeed=options.seed||null;ensureBound();
  if(options.mode)mode=options.mode;
  await loadList();
  if(pendingSeed){const seed=pendingSeed;pendingSeed=null;requestAnimationFrame(()=>openEditor(null,host.querySelector('[data-component-action="new"]'),seed));}
}

function ensureBound(){
  if(!host||boundHost===host)return;
  if(boundHost){boundHost.removeEventListener('click',onClick);boundHost.removeEventListener('submit',onSubmit);boundHost.removeEventListener('input',onInput);boundHost.removeEventListener('change',onChange);boundHost.removeEventListener('keydown',onKeydown);}
  boundHost=host;host.addEventListener('click',onClick);host.addEventListener('submit',onSubmit);host.addEventListener('input',onInput);host.addEventListener('change',onChange);host.addEventListener('keydown',onKeydown);
}

function onClick(event){
  const button=event.target.closest('button,[data-component-id]');if(!button)return;
  const action=button.dataset.componentAction;
  if(button.dataset.componentId)return openDetail(Number(button.dataset.componentId));
  if(action==='mode'){mode=button.dataset.mode;page=1;detail=null;loadList();return;}
  if(action==='retry-list')return loadList();
  if(action==='retry-detail'&&detail?.id)return openDetail(detail.id);
  if(action==='close-detail'){detail=null;detailError='';paint();return;}
  if(action==='new')return openEditor(null,button,null);
  if(action==='new-revision')return openEditor(detail,button,null);
  if(action==='close-dialog')return closeDialog(button.closest('dialog'));
  if(action==='submit')return submitRevision(button);
  if(action==='review')return reviewRevision(button);
  if(action==='lifecycle')return lifecycle(button);
  if(action==='page'){const next=Number(button.dataset.page);if(next>0&&next!==page){page=next;loadList();}}
}
function onSubmit(event){
  if(event.target.id==='componentFilters'){event.preventDefault();page=1;loadList();}
  if(event.target.id==='componentEditorForm'){event.preventDefault();saveComponent(event.target);}
}
function onInput(event){if(!event.target.closest('#componentFilters'))return;filter.q=host.querySelector('#componentQ')?.value||'';filter.tagIds=host.querySelector('#componentTags')?.value||'';clearTimeout(timer);timer=setTimeout(()=>{page=1;loadList();},260);}
function onChange(event){if(!event.target.closest('#componentFilters'))return;filter.dimensionKey=host.querySelector('#componentDimension')?.value||'';filter.state=host.querySelector('#componentState')?.value||'';filter.source=host.querySelector('#componentSource')?.value||'';page=1;loadList();}
function onKeydown(event){if(event.target.matches('.component-mode-tabs [role="tab"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=[...host.querySelectorAll('.component-mode-tabs [role="tab"]')],index=tabs.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:(index-1+tabs.length)%tabs.length;const target=tabs[next];if(target){mode=target.dataset.mode;page=1;detail=null;loadList().then(()=>requestAnimationFrame(()=>host.querySelector(`[data-component-action="mode"][data-mode="${CSS.escape(mode)}"]`)?.focus()));}return;}const dialog=event.target.closest('dialog[open]');if(!dialog)return;if(event.key==='Escape'){event.preventDefault();closeDialog(dialog);return;}if(event.key!=='Tab')return;const nodes=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(node=>node.getClientRects().length);if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}

async function loadList(){
  const request=++seq;loading=true;loadError='';paint();
  try{
    const [who,data]=await Promise.all([api.me(),mode==='reusable'?api.reusableComponents({...filter,page,pageSize:12}):api.contentComponents({...filter,page,pageSize:12})]);
    if(!active||request!==seq)return;me=who||me;items=data.items||data.components||[];total=Number(data.total??items.length);loading=false;paint();
  }catch(error){if(request!==seq)return;loading=false;loadError=error.message||'组件列表读取失败';paint();}
}
async function openDetail(id){
  detail={id};detailLoading=true;detailError='';paint();
  try{const value=await api.contentComponent(id);if(!active||Number(detail?.id)!==Number(id))return;detail=value;detailLoading=false;paint();}
  catch(error){if(Number(detail?.id)!==Number(id))return;detailLoading=false;detailError=error.message||'组件详情读取失败';paint();}
}

function paint(){if(!host)return;const pages=Math.max(1,Math.ceil(total/12));host.innerHTML=`<div class="component-library-page"><header class="stage3-page-head"><div><span>局部模式 · 版本审核</span><h2>组件库</h2><p>管理面保留草稿与审核历史；可复用面只提供当前已批准且未停用的轻量条目。</p></div><button type="button" class="stage3-primary" data-component-action="new">新建组件草稿</button></header><div class="component-mode-tabs" role="tablist" aria-label="组件库模式"><button type="button" role="tab" tabindex="${mode==='management'?'0':'-1'}" aria-selected="${mode==='management'}" class="${mode==='management'?'on':''}" data-component-action="mode" data-mode="management">管理与审核</button><button type="button" role="tab" tabindex="${mode==='reusable'?'0':'-1'}" aria-selected="${mode==='reusable'}" class="${mode==='reusable'?'on':''}" data-component-action="mode" data-mode="reusable">可复用组件</button></div>${filters()}${loading?stateBlock('正在读取组件…','管理列表与可复用白名单使用不同接口。'):loadError?errorBlock('组件列表没有读出来',loadError,'retry-list'):items.length?`<div class="component-library-layout"><div class="component-card-grid">${items.map(mode==='reusable'?reusableCard:managementCard).join('')}</div>${detailPane()}</div>`:`<div class="stage3-empty"><b>${mode==='reusable'?'暂无可复用组件':'没有符合条件的组件'}</b><p>${mode==='reusable'?'只有 active 且存在当前已批准版本的组件会出现在这里。':'可以从比较范围的局部提取建立草稿，或调整筛选条件。'}</p></div>`}<nav class="stage3-pagination" aria-label="组件分页"><span>共 ${total} 条</span><div><button type="button" data-component-action="page" data-page="${page-1}" ${page<=1?'disabled':''}>上一页</button><b>${page} / ${pages}</b><button type="button" data-component-action="page" data-page="${page+1}" ${page>=pages?'disabled':''}>下一页</button></div></nav>${editorDialog()}</div>`;}

function filters(){return `<form id="componentFilters" class="stage3-filterbar component-filters"><label><span>搜索</span><input id="componentQ" value="${esc(filter.q)}" placeholder="名称、模式或功能"></label><label><span>维度</span><select id="componentDimension"><option value="">全部维度</option>${DIMENSIONS.map(([value,label])=>`<option value="${value}" ${filter.dimensionKey===value?'selected':''}>${label}</option>`).join('')}</select></label>${mode==='management'?`<label><span>状态</span><select id="componentState"><option value="">全部状态</option>${Object.entries(STATES).map(([value,label])=>`<option value="${value}" ${filter.state===value?'selected':''}>${label}</option>`).join('')}</select></label><label><span>来源</span><select id="componentSource"><option value="">全部来源</option>${Object.entries(SOURCES).map(([value,label])=>`<option value="${value}" ${filter.source===value?'selected':''}>${label}</option>`).join('')}</select></label>`:''}<label><span>标签 ID</span><input id="componentTags" value="${esc(filter.tagIds)}" placeholder="同类 OR，跨类 AND"></label><button type="submit">应用筛选</button></form>`;}

function managementCard(item){const revision=item.displayRevision||item.latestRevision||(typeof item.revision==='object'?item.revision:{})||{},state=item.lifecycleState==='retired'?'retired':(item.state||revision.state||'draft'),current=item.currentApprovedRevision||item.currentRevision;return `<article class="component-management-card ${esc(state)}"><header><span>${esc(dimName(revision.dimensionKey||item.dimensionKey))}</span><i>${esc(STATES[state]||state)}</i></header><h3>${esc(revision.name||item.name||'未命名组件')}</h3><p>${esc(revision.patternText||revision.pattern||item.patternText||item.pattern||'尚未填写局部模式')}</p><div class="component-card-function"><small>承担功能</small><b>${esc(revision.functionText||revision.function||item.functionText||'—')}</b></div><div class="component-version-line"><span>展示 v${revision.revision||revision.id||1} · ${esc(SOURCES[revision.origin||revision.source]||revision.origin||'人工建立')}</span>${current&&String(current.id)!==String(revision.id)?`<b>当前可复用仍为 v${current.revision||current.id}</b>`:''}</div><footer><span>${fmt(revision.updatedAt||revision.createdAt||item.updatedAt)}</span><button type="button" data-component-id="${item.id}">查看历史</button></footer></article>`;}

function reusableCard(item){const revision=item.currentRevision||(typeof item.revision==='object'?item.revision:item);return `<article class="component-reusable-card"><header><span>${esc(dimName(revision.dimensionKey||item.dimensionKey))}</span><b>v${typeof item.revision==='number'?item.revision:(revision.revision||item.currentRevisionNumber||1)}</b></header><h3>${esc(revision.name||item.name||'未命名组件')}</h3><p>${esc(revision.patternText||revision.pattern||item.patternText||item.pattern||'—')}</p><dl><div><dt>承担功能</dt><dd>${esc(revision.functionText||revision.function||item.functionText||'—')}</dd></div><div><dt>适用</dt><dd>${esc(revision.applicability||item.applicability||'—')}</dd></div><div><dt>限制</dt><dd>${esc(revision.limitations||item.limitations||'—')}</dd></div><div><dt>不可照搬</dt><dd>${esc(revision.doNotCopy||item.doNotCopy||'—')}</dd></div></dl><div class="component-tags">${(revision.tags||item.tags||[]).map(tag=>`<span>${esc(tag.name||tag.label||tag)}</span>`).join('')||'<span>暂无标签</span>'}</div></article>`;}

function detailPane(){if(!detail)return '<aside class="component-detail-pane empty"><b>选择一个组件</b><p>查看不可变修订、审核决定和生命周期事件。</p></aside>';if(detailLoading)return `<aside class="component-detail-pane">${stateBlock('正在读取组件历史…','')}</aside>`;if(detailError)return `<aside class="component-detail-pane">${errorBlock('组件详情没有读出来',detailError,'retry-detail')}</aside>`;const revisions=detail.revisions||[];const lifecycle=detail.lifecycleState||detail.state||'active';const latest=revisions[0]||detail.latestRevision||{},currentApproved=detail.currentApprovedRevision||revisions.find(revision=>String(revision.id)===String(detail.currentApprovedRevisionId));const lifecycleEvents=detail.lifecycleEvents||detail.lifecycle||[];return `<aside class="component-detail-pane"><header><button type="button" data-component-action="close-detail" aria-label="关闭组件详情">×</button><span>${esc(dimName(latest.dimensionKey||detail.dimensionKey))}</span><h3>${esc(detail.name||latest.name||'组件详情')}</h3><p>稳定组件 #${detail.id} · ${lifecycle==='retired'?'已停用':'使用中'}</p></header>${currentApproved?`<section class="component-current-approved"><small>当前可复用版本</small><b>v${currentApproved.revision||currentApproved.id} · ${esc(currentApproved.name||detail.name)}</b><p>替换草稿在批准前不会影响这一版本。</p></section>`:''}<section class="component-revision-history"><h4>修订历史</h4>${revisions.length?revisions.map(revisionCard).join(''):'<p>还没有修订记录。</p>'}</section><section class="component-lifecycle"><h4>生命周期</h4>${lifecycleEvents.map(event=>`<p><b>${esc(event.event||event.type||event.eventType)}</b><span>${fmt(event.createdAt)}</span></p>`).join('')||'<p><b>activated</b><span>创建时</span></p>'}${me.role==='admin'?`<button type="button" data-component-action="lifecycle" data-event="${lifecycle==='retired'?'reactivate':'retire'}">${lifecycle==='retired'?'恢复组件':'停用组件'}</button>`:''}</section><button type="button" class="stage3-secondary component-new-revision" data-component-action="new-revision">建立替换草稿</button></aside>`;}

function revisionCard(revision){const state=revision.state||revision.decision||'draft',reviewNote=revision.reviewNote||revision.decisions?.at(-1)?.note;return `<article><header><b>v${revision.revision||revision.id}</b><span class="${esc(state)}">${esc(STATES[state]||state)}</span></header><h5>${esc(revision.name||'未命名修订')}</h5><p>${esc(revision.patternText||revision.pattern||'—')}</p><div class="revision-meta">${esc(SOURCES[revision.origin||revision.source]||revision.origin||'人工建立')} · ${fmt(revision.createdAt)}</div>${(revision.tags||[]).length?`<div class="component-tags">${revision.tags.map(tag=>`<span>${esc(tag.name||tag)}</span>`).join('')}</div>`:''}${reviewNote?`<blockquote>${esc(reviewNote)}</blockquote>`:''}<footer>${state==='draft'?`<button type="button" data-component-action="submit" data-revision-id="${revision.id}">提交审核</button>`:''}${state==='submitted'&&['reviewer','admin'].includes(me.role)?`<button type="button" data-component-action="review" data-decision="approved" data-revision-id="${revision.id}">批准并切换当前版本</button><button type="button" data-component-action="review" data-decision="changes_requested" data-revision-id="${revision.id}">要求修改</button>`:''}</footer></article>`;}

function editorDialog(){return `<dialog id="componentEditorDialog" class="stage3-dialog stage3-sheet component-editor-dialog"><form id="componentEditorForm"><header><div><span>不可变修订</span><h3>组件草稿</h3></div><button type="button" data-component-action="close-dialog" aria-label="关闭组件编辑">×</button></header><input type="hidden" name="componentId"><label class="stage3-field"><span>维度</span><select name="dimensionKey">${DIMENSIONS.map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><label class="stage3-field"><span>组件名称</span><input name="name" maxlength="200" required></label><label class="stage3-field"><span>局部模式</span><textarea name="pattern" rows="4" maxlength="4000" required></textarea></label><label class="stage3-field"><span>承担功能</span><textarea name="functionText" rows="3" maxlength="4000" required></textarea></label><label class="stage3-field"><span>适用范围</span><textarea name="applicability" rows="3" maxlength="12000" required></textarea></label><label class="stage3-field"><span>限制与边界</span><textarea name="limitations" rows="3" maxlength="12000" required></textarea></label><label class="stage3-field"><span>不可照搬</span><textarea name="doNotCopy" rows="3" maxlength="12000" required></textarea></label><label class="stage3-field"><span>来源提取 ID</span><input name="extractionIds" required placeholder="例如 18；最多 20 个，用逗号分隔"></label><label class="stage3-field"><span>版本标签 ID</span><input name="tags" inputmode="numeric" placeholder="用逗号分隔；最多 30 个"></label><div class="stage3-form-error" aria-live="polite"></div><footer><button type="button" data-component-action="close-dialog">取消</button><button type="submit" class="stage3-primary">保存草稿修订</button></footer></form></dialog>`;}

function openEditor(component,trigger,seed){const dialog=host.querySelector('#componentEditorDialog');if(!dialog)return;const form=dialog.querySelector('form');form.reset();form.querySelector('.stage3-form-error').textContent='';form.elements.componentId.value=component?.id||'';const latest=component?.revisions?.[0]||component?.latestRevision||{};const source=seed||latest;if(source){form.elements.dimensionKey.value=source.dimensionKey||component?.dimensionKey||'audience';form.elements.name.value=source.name||(source.patternText||source.pattern||'').slice(0,40)||component?.name||'';form.elements.pattern.value=source.patternText||source.pattern||'';form.elements.functionText.value=source.functionText||source.function||'';form.elements.applicability.value=source.applicability||'';form.elements.limitations.value=source.limitations||'';form.elements.doNotCopy.value=source.doNotCopy||source.avoidCopying||'';form.elements.extractionIds.value=seed?.id||((source.extractionIds||source.sources?.map(item=>item.extractionId)||[]).filter(Boolean).join(','));form.elements.tags.value=(source.tags||[]).map(tag=>tag.id||tag).filter(value=>Number.isSafeInteger(Number(value))).join(',');}returnFocus=trigger||document.activeElement;dialog.showModal();requestAnimationFrame(()=>form.elements.name.focus());}
function closeDialog(dialog){if(!dialog?.open)return;dialog.close();const target=returnFocus;returnFocus=null;requestAnimationFrame(()=>target?.isConnected&&target.focus());}

async function saveComponent(form){const data=new FormData(form),button=form.querySelector('button[type="submit"]'),componentId=Number(data.get('componentId')||0);button.disabled=true;form.querySelector('.stage3-form-error').textContent='';const parseIds=value=>String(value||'').split(/[,，]/).map(item=>item.trim()).filter(Boolean).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0);const extractionIds=parseIds(data.get('extractionIds')),tagIds=parseIds(data.get('tags'));const patternText=String(data.get('pattern')||'').trim();const payload={dimensionKey:data.get('dimensionKey'),name:String(data.get('name')||'').trim(),patternText,functionText:String(data.get('functionText')||'').trim(),applicability:String(data.get('applicability')||'').trim(),limitations:String(data.get('limitations')||'').trim(),doNotCopy:String(data.get('doNotCopy')||'').trim(),extractionIds,tagIds};try{const value=componentId?await api.contentComponentRevisionCreate(componentId,payload,idem('component-revision')):await api.contentComponentCreate(payload,idem('component'));closeDialog(form.closest('dialog'));toast('ok',componentId?'替换草稿已建立，当前批准版本未改变':'组件草稿已建立');await loadList();if(componentId)await openDetail(componentId);else if(value?.id||value?.component?.id)await openDetail(value.id||value.component.id);}catch(error){form.querySelector('.stage3-form-error').textContent=error.message||'保存失败，已填写内容仍保留';}finally{if(button.isConnected)button.disabled=false;}}
async function submitRevision(button){button.disabled=true;try{await api.contentComponentSubmit(detail.id,button.dataset.revisionId,idem('component-submit'));toast('ok','草稿已提交审核');await openDetail(detail.id);await loadList();}catch(error){toast('info',error.message||'提交审核失败');button.disabled=false;}}
async function reviewRevision(button){button.disabled=true;const decision=button.dataset.decision;const note=decision==='changes_requested'?'请补充适用边界与来源说明。':'证据与边界完整，可进入复用白名单。';try{await api.contentComponentReview(detail.id,button.dataset.revisionId,{decision,note},idem('component-review'));toast('ok',decision==='approved'?'修订已批准并成为当前版本':'已要求修改；请建立新草稿继续');await openDetail(detail.id);await loadList();}catch(error){toast('info',error.message||'审核决定保存失败');button.disabled=false;}}
async function lifecycle(button){button.disabled=true;try{await api.contentComponentLifecycle(detail.id,{action:button.dataset.event},idem('component-lifecycle'));toast('ok',button.dataset.event==='retire'?'组件已停用':'组件已恢复');await openDetail(detail.id);await loadList();}catch(error){toast('info',error.message||'生命周期更新失败');button.disabled=false;}}

function stateBlock(title,note){return `<div class="stage3-state"><i></i><b>${esc(title)}</b>${note?`<p>${esc(note)}</p>`:''}</div>`;}
function errorBlock(title,message,action){return `<div class="stage3-state error"><b>${esc(title)}</b><p>${esc(message)}</p><button type="button" data-component-action="${esc(action)}">重试</button></div>`;}
