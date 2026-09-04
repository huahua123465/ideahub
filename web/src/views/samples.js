/** 内容样本库：原始归档入口 + 第二阶段内容研究工作台。 */
import { api } from '../api.js';
import { $, esc, fromNow } from '../util.js';
import { ICON } from '../icons.js';
import { toast } from '../toast.js';
import { openResearch, leaveResearch, updateResearchOptions } from './sample-research.js';
import { openComparisonLibrary, openComparisonWorkspace, leaveComparison } from './sample-comparison.js';
import { openComponentLibrary, leaveComponents } from './sample-components.js';
import { openSampleInsights, leaveSampleInsights } from './sample-insights.js';
import { openAccountResearch, leaveAccountResearch } from './account-research.js';

let active = false;
let initialized = false;
let items = [];
let total = 0;
let summary = { total:0,complete:0,incomplete:0 };
let page = 1;
const PAGE_SIZE = 24;
let selectedId = null;
let detail = null;
let loadingDetail = false;
let captureLoading = false;
let captureSeq = 0;
let loadSeq = 0;
let listSeq = 0;
let linkTimer = null;
let linkJob = null;
let intakeMode = 'link';
let intakeOpen = false;
let filtersOpen = false;
let researchConfig = null;
let researchConfigError = '';
let elementConditions = [];
let listError = '';
let listLoading = false;
let listScrollTop = 0;
let researchPaused = false;
let libraryMode = 'samples';
let comparisonBusy = false;
let comparisonDialogFocus = null;
let compareSelection = loadCompareSelection();
let requestedSampleId = null;
let requestedResearchTab = '';

const root = () => $('#v-samples');
const MISSING = {
  source_identity:'作品身份', title:'标题', body_text:'正文', account:'账号',
  published_at:'发布时间', metrics:'互动数据', cover:'封面', media:'图片/视频',
  media_archive_failed:'媒体归档失败，请重试',
};
const STATUS = {
  complete:['完整归档','complete'], usable:['可用但有缺项','usable'], partial:['部分归档','partial'],
};

export function leave() {
  active = false;
  researchPaused=Boolean(selectedId&&detail);
  leaveResearch();
  leaveComparison();
  leaveComponents();
  leaveSampleInsights();
  leaveAccountResearch();
  clearTimeout(linkTimer);
  linkTimer = null;
}

export async function render() {
  active = true;
  if (!initialized) scaffold();
  await activateLibraryMode(true);
  if (requestedSampleId) {
    const sampleId = requestedSampleId;
    requestedSampleId = null;
    selectSample(sampleId, 'elements');
  }
}

/** 记住从采集页刚归档的样本，切页后直接打开研究档案。 */
export function openSample(id) {
  const sampleId = Number(id);
  if (!Number.isSafeInteger(sampleId) || sampleId <= 0) return;
  requestedSampleId = sampleId;
  requestedResearchTab = 'elements';
  libraryMode = 'samples';
  if (active) {
    activateLibraryMode(true).then(() => {
      if (requestedSampleId !== sampleId) return;
      requestedSampleId = null;
      selectSample(sampleId, 'elements');
    });
  }
}

function scaffold() {
  root().innerHTML = `
    <nav class="sample-library-modes" role="tablist" aria-label="样本库模式">
      <button type="button" role="tab" aria-selected="true" tabindex="0" class="on" data-library-mode="samples"><b>样本</b><span>归档与单篇研究</span></button>
      <button type="button" role="tab" aria-selected="false" tabindex="-1" data-library-mode="comparisons"><b>比较记录</b><span>冻结范围与横向研究</span></button>
      <button type="button" role="tab" aria-selected="false" tabindex="-1" data-library-mode="components"><b>组件库</b><span>审核与可复用白名单</span></button>
      <button type="button" role="tab" aria-selected="false" tabindex="-1" data-library-mode="insights"><b>检索与洞察</b><span>结构匹配与描述性观察</span></button>
      <button type="button" role="tab" aria-selected="false" tabindex="-1" data-library-mode="account-research"><b>账户研究</b><span>冻结样本与跨作品证据</span></button>
    </nav>
    <section id="sampleLibrarySamples" class="sample-library-mode-panel" aria-label="样本">
    <div class="page-head samples-page-head"><div><div class="page-kicker">内容研究数据库</div><h1>样本库</h1>
      <div class="sub">先保存原始作品，再逐步拆解、比较和沉淀可复用元素。</div></div>
      <div class="samples-head-stats" id="samplesHeadStats"></div></div>

    <section class="samples-intake compact" id="samplesIntake">
      <header><button type="button" class="samples-intake-toggle" id="samplesIntakeToggle" aria-expanded="false"><span>＋</span><div><small>建立样本</small><h2>新增内容样本</h2><p>链接采集、手动录入或直接上传媒体</p></div><b>展开</b></button></header>
      <div class="samples-intake-body" id="samplesIntakePanel" hidden><nav aria-label="样本录入方式" role="tablist"><button role="tab" aria-selected="true" class="on" data-sample-mode="link">链接采集</button><button role="tab" aria-selected="false" data-sample-mode="manual">手动录入</button><button role="tab" aria-selected="false" data-sample-mode="upload">媒体上传</button></nav><div id="sampleIntakeBody"></div></div>
    </section>

    <section class="samples-toolbar">
      <label>${ICON.search}<input id="sampleQuery" placeholder="搜索标题、正文、账号或作品 ID"></label>
      <select id="samplePlatform" aria-label="平台筛选"><option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="douyin">抖音</option><option value="manual">手动归档</option></select>
      <select id="sampleArchiveStatus" aria-label="完整度筛选"><option value="">全部完整度</option><option value="complete">完整归档</option><option value="usable">可用但有缺项</option><option value="partial">部分归档</option></select>
      <button type="button" id="sampleFiltersToggle" aria-expanded="false">组合筛选</button><button type="button" id="sampleReload">刷新</button>
    </section>
    <section class="sample-filter-builder" id="sampleFilterBuilder" hidden><div class="sample-filter-loading">正在读取标签和元素字典…</div></section>
    <div class="samples-pager" id="samplesPager"></div>

    <section class="samples-workspace">
      <div class="samples-list-column">
        <header class="samples-focus-nav">
          <div><span>样本导航</span><b id="samplesFocusCount">0 篇</b></div>
          <button type="button" data-sample-nav-toggle aria-expanded="true" title="收起样本导航"><span>收起</span>«</button>
          <label>${ICON.search}<input id="sampleFocusQuery" placeholder="搜索样本标题" aria-label="搜索样本标题"></label>
        </header>
        <div class="samples-list" id="samplesList"><div class="samples-loading">正在读取样本…</div></div>
      </div>
      <aside class="samples-detail" id="samplesDetail"><div class="samples-empty">${ICON.layers}<b>选择一篇样本</b><span>查看原始正文、媒体、完整度和历次采集版本。</span></div></aside>
    </section></section>
    <section id="sampleLibraryComparisons" class="sample-library-mode-panel" aria-label="比较记录" hidden></section>
    <section id="sampleLibraryComponents" class="sample-library-mode-panel" aria-label="组件库" hidden></section>
    <section id="sampleLibraryInsights" class="sample-library-mode-panel" aria-label="检索与洞察" hidden></section>
    <section id="sampleLibraryAccountResearch" class="sample-library-mode-panel" aria-label="账户研究" hidden></section>
    <aside id="sampleComparisonTray" class="sample-comparison-tray" aria-label="比较选择托盘"></aside>
    <dialog id="sampleComparisonCreateDialog" class="stage3-dialog sample-comparison-create-dialog">
      <form id="sampleComparisonCreateForm">
        <header><div><span>固定 2–6 篇样本</span><h3>新建比较记录</h3></div><button type="button" data-comparison-dialog-close aria-label="关闭新建比较">×</button></header>
        <label class="stage3-field"><span>比较名称</span><input name="name" maxlength="200" required placeholder="例如：关系判断内容的标题与结构比较"></label>
        <label class="stage3-field"><span>研究主题</span><textarea name="topic" maxlength="160" rows="3" required placeholder="说明这次想观察什么，不预设赢家或因果结论。"></textarea></label>
        <div class="sample-comparison-create-members"></div>
        <div class="stage3-form-error" aria-live="polite"></div>
        <footer><button type="button" data-comparison-dialog-close>取消</button><button type="submit" class="stage3-primary">建立冻结范围</button></footer>
      </form>
    </dialog>`;
  bind();
  paintIntake();
  paintComparisonTray();
  initialized = true;
}

function bind() {
  root().addEventListener('click', event => {
    const libraryTab=event.target.closest('[data-library-mode]');
    if(libraryTab){setLibraryMode(libraryTab.dataset.libraryMode,libraryTab);return;}
    if(event.target.closest('.sample-compare-checkbox'))return;
    const removeCompare=event.target.closest('[data-compare-remove]');
    if(removeCompare){toggleCompareSelection(Number(removeCompare.dataset.compareRemove),false,removeCompare);return;}
    if(event.target.closest('[data-compare-clear]')){compareSelection=[];saveCompareSelection();paintComparisonTray();paintList();return;}
    if(event.target.closest('[data-compare-start]')){openComparisonCreateDialog(event.target.closest('[data-compare-start]'));return;}
    if(event.target.closest('[data-comparison-dialog-close]')){closeComparisonCreateDialog();return;}
    if (event.target.closest('#samplesIntakeToggle')) { setIntakeOpen(!intakeOpen); return; }
    if (event.target.closest('#sampleFiltersToggle')) { filtersOpen=!filtersOpen;paintFilterBuilder();return; }
    if(event.target.closest('[data-filter-config-retry]')){researchConfig=null;researchConfigError='';loadResearchConfig();return;}
    const navToggle=event.target.closest('[data-sample-nav-toggle]');
    if(navToggle){const collapsed=root().classList.toggle('samples-nav-collapsed');navToggle.setAttribute('aria-expanded',String(!collapsed));navToggle.title=collapsed?'展开样本导航':'收起样本导航';navToggle.querySelector('span').textContent=collapsed?'展开':'收起';navToggle.lastChild.textContent=collapsed?'»':'«';return;}
    if (event.target.closest('[data-filter-add]')) { if(elementConditions.length<15){elementConditions.push({dimensionKey:'audience',mode:'any',facets:''});paintFilterBuilder();} return; }
    const removeCondition=event.target.closest('[data-filter-remove]');
    if(removeCondition){elementConditions.splice(Number(removeCondition.dataset.filterRemove),1);paintFilterBuilder();page=1;loadSamples();return;}
    if(event.target.closest('[data-filter-clear]')){elementConditions=[];root().querySelectorAll('[name="sampleTagIds"]:checked').forEach(input=>input.checked=false);paintFilterBuilder();page=1;loadSamples();return;}
    const mode = event.target.closest('[data-sample-mode]');
    if (mode) { intakeMode = mode.dataset.sampleMode; paintIntake(); return; }
    if (event.target.closest('[data-sample-edit]')) { intakeMode='manual'; setIntakeOpen(true); paintIntake(); root().querySelector('.samples-intake')?.scrollIntoView({behavior:'smooth'}); return; }
    if (event.target.closest('[data-sample-attach]')) { intakeMode='upload'; setIntakeOpen(true); paintIntake(); root().querySelector('.samples-intake')?.scrollIntoView({behavior:'smooth'}); return; }
    if (event.target.closest('[data-sample-back]')) { closeMobileDetail(); return; }
    const rawButton=event.target.closest('[data-capture-raw]');
    if(rawButton){loadCaptureRaw(rawButton);return;}
    if(event.target.closest('[data-captures-more]')){loadMoreCaptures();return;}
    const card = event.target.closest('[data-sample-id]');
    if (card) { selectSample(card.dataset.sampleId); return; }
    if (event.target.closest('#sampleReload')) { loadSamples(); return; }
    const pageButton=event.target.closest('[data-sample-page]');
    if(pageButton){const next=Number(pageButton.dataset.samplePage);if(Number.isSafeInteger(next)&&next>0&&next!==page){page=next;loadSamples();}return;}
  });
  root().addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'sampleComparisonCreateForm') { submitComparison(event.target); return; }
    if (event.target.id === 'sampleLinkForm') submitLink(event.target);
    if (event.target.id === 'sampleManualForm') submitManual(event.target);
    if (event.target.id === 'sampleUploadForm') submitUpload(event.target);
  });
  root().addEventListener('input', event => {
    if (event.target.id === 'sampleQuery') { const focus=$('#sampleFocusQuery');if(focus)focus.value=event.target.value;page=1;debounceLoad(); }
    if (event.target.id === 'sampleFocusQuery') { const main=$('#sampleQuery');if(main)main.value=event.target.value;page=1;debounceLoad(); }
    if(event.target.matches('[data-element-condition][data-field="facets"]')){const index=Number(event.target.dataset.index);if(elementConditions[index])elementConditions[index].facets=event.target.value;page=1;debounceLoad();}
  });
  root().addEventListener('change', event => {
    if(event.target.matches('[data-compare-toggle]')){toggleCompareSelection(Number(event.target.value),event.target.checked,event.target);return;}
    if (['samplePlatform','sampleArchiveStatus'].includes(event.target.id)) { page=1; loadSamples(); }
    if(event.target.name==='sampleTagIds'){page=1;loadSamples();}
    if(event.target.matches('[data-element-condition]')){const index=Number(event.target.dataset.index);const key=event.target.dataset.field;if(elementConditions[index]&&key)elementConditions[index][key]=event.target.value;page=1;debounceLoad();}
  });
  root().addEventListener('keydown', event=>{
    if(event.target.matches('[data-library-mode]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();const tabs=[...root().querySelectorAll('[data-library-mode]')],index=tabs.indexOf(event.target);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:(index-1+tabs.length)%tabs.length;tabs[next]?.focus();setLibraryMode(tabs[next]?.dataset.libraryMode,tabs[next]);return;
    }
    const dialog=event.target.closest('#sampleComparisonCreateDialog[open]');
    if(dialog){if(event.key==='Escape'){event.preventDefault();closeComparisonCreateDialog();return;}if(event.key==='Tab'){const nodes=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled])')].filter(node=>node.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}return;}
    if((event.key==='Enter'||event.key===' ')&&event.target.matches('.sample-card')){event.preventDefault();selectSample(event.target.dataset.sampleId);}
  });
}

async function activateLibraryMode(resume=false){
  root()?.querySelectorAll('.sample-library-mode-panel').forEach(panel=>{panel.hidden=panel.id!==(libraryMode==='samples'?'sampleLibrarySamples':libraryMode==='comparisons'?'sampleLibraryComparisons':libraryMode==='components'?'sampleLibraryComponents':libraryMode==='insights'?'sampleLibraryInsights':'sampleLibraryAccountResearch');});
  root()?.querySelectorAll('[data-library-mode]').forEach(button=>{const on=button.dataset.libraryMode===libraryMode;button.classList.toggle('on',on);button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;});
  root()?.classList.toggle('sample-library-stage3',libraryMode!=='samples');
  if(libraryMode==='samples'){
    loadResearchConfig();await loadSamples();paintComparisonTray();
    if(resume&&researchPaused&&selectedId&&detail){researchPaused=false;await openResearch($('#samplesDetail'),detail,researchOptions());}
    if(linkJob){paintLinkProgress();pollLinkJob(true);}
    return;
  }
  leaveResearch();root()?.classList.remove('samples-detail-mode','samples-nav-collapsed');paintComparisonTray();
  if(libraryMode==='comparisons')await openComparisonLibrary($('#sampleLibraryComparisons'),{onOpen:id=>openWorkspace(id),onNewFromSamples:()=>setLibraryMode('samples')});
  else if(libraryMode==='components')await openComponentLibrary($('#sampleLibraryComponents'),{});
  else if(libraryMode==='insights')await openSampleInsights($('#sampleLibraryInsights'));
  else await openAccountResearch($('#sampleLibraryAccountResearch'));
}

async function setLibraryMode(next,focusTarget=null){
  if(!['samples','comparisons','components','insights','account-research'].includes(next))return;
  if(next===libraryMode){focusTarget?.focus({preventScroll:true});return;}
  leaveComparison();leaveComponents();leaveSampleInsights();leaveAccountResearch();libraryMode=next;await activateLibraryMode();requestAnimationFrame(()=>focusTarget?.focus({preventScroll:true}));
}

async function openWorkspace(id){
  libraryMode='comparisons';
  root()?.querySelectorAll('.sample-library-mode-panel').forEach(panel=>panel.hidden=panel.id!=='sampleLibraryComparisons');
  paintLibraryTabs();paintComparisonTray();
  await openComparisonWorkspace($('#sampleLibraryComparisons'),id,{onOpen:id2=>openWorkspace(id2),onNewFromSamples:()=>setLibraryMode('samples'),onOpenComponents:extraction=>openComponentsFromExtraction(extraction)});
}

async function openComponentsFromExtraction(extraction){
  leaveComparison();libraryMode='components';root()?.querySelectorAll('.sample-library-mode-panel').forEach(panel=>panel.hidden=panel.id!=='sampleLibraryComponents');paintLibraryTabs();paintComparisonTray();await openComponentLibrary($('#sampleLibraryComponents'),{seed:extraction});
}

function paintLibraryTabs(){root()?.querySelectorAll('[data-library-mode]').forEach(button=>{const on=button.dataset.libraryMode===libraryMode;button.classList.toggle('on',on);button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;});root()?.classList.toggle('sample-library-stage3',libraryMode!=='samples');}

function setIntakeOpen(value){
  intakeOpen=!!value;const panel=$('#samplesIntakePanel'),toggle=$('#samplesIntakeToggle');if(panel)panel.hidden=!intakeOpen;if(toggle){toggle.setAttribute('aria-expanded',String(intakeOpen));toggle.querySelector(':scope>b').textContent=intakeOpen?'收起':'展开';}root()?.querySelector('#samplesIntake')?.classList.toggle('open',intakeOpen);if(intakeOpen)paintIntake();
}

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}
function isoFromLocalDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function paintIntake() {
  root().querySelectorAll('[data-sample-mode]').forEach(button => {const on=button.dataset.sampleMode===intakeMode;button.classList.toggle('on',on);button.setAttribute('aria-selected',String(on));});
  const body = $('#sampleIntakeBody');
  const current = selectedId && detail && Number(detail.id) === Number(selectedId) ? detail : null;
  if (intakeMode === 'link') {
    body.innerHTML = `<form id="sampleLinkForm" class="samples-intake-form"><div class="samples-form-copy"><b>交给服务器自动采集并归档</b><span>任务完成后自动进入样本库；默认公开无登录，不使用 VPS 保存的平台 Cookie。单篇最多 50 张图片，超限会拒绝并提示，不会静默截断。</span></div>
      <label class="samples-wide"><span>小红书或抖音分享链接</span><input name="url" required autocomplete="off" placeholder="粘贴分享文案或 https://…"></label>
      <label class="samples-check"><input name="publicMode" type="checkbox" checked><span><b>公开无登录</b><small>评论和部分数据可能受限</small></span></label>
      <button class="btn btn-primary" type="submit">${ICON.sparkle}<span>采集并归档</span></button>
      <div class="samples-link-progress" id="sampleLinkProgress"></div></form>`;
  } else if (intakeMode === 'manual') {
    body.innerHTML = `<form id="sampleManualForm" class="samples-intake-form samples-manual-form"><div class="samples-form-copy"><b>${current ? '补充当前样本资料' : '先建立部分样本，后续继续补齐'}</b><span>无法自动采集时也可以保留标题、正文、账号和来源，不把资料挡在系统外。</span></div>
      ${current ? `<label class="samples-check samples-wide"><input name="updateExisting" type="checkbox" value="${current.id}" checked><span><b>更新「${esc(current.title || '当前样本')}」</b><small>取消勾选会另建一篇新样本</small></span></label>` : ''}
      <label><span>标题 *</span><input name="title" required maxlength="500"></label><label><span>平台</span><select name="platform"><option value="manual">手动归档</option><option value="xiaohongshu">小红书</option><option value="douyin">抖音</option></select></label>
      <label><span>内容类型</span><select name="contentType"><option value="image_post">图文</option><option value="video">视频</option><option value="article">长文</option><option value="unknown">其他</option></select></label><label><span>发布时间</span><input name="publishedAt" type="datetime-local"></label>
      <label><span>账号</span><input name="accountName" maxlength="500"></label><label><span>原始链接</span><input name="sourceUrl" type="url" placeholder="https://…"></label>
      <label class="samples-wide"><span>原始正文</span><textarea name="bodyText" rows="6" maxlength="2000000"></textarea></label>
      <div class="samples-metrics"><label><span>点赞</span><input name="likes" inputmode="numeric"></label><label><span>收藏</span><input name="collects" inputmode="numeric"></label><label><span>评论</span><input name="comments" inputmode="numeric"></label><label><span>转发</span><input name="shares" inputmode="numeric"></label><label><span>播放</span><input name="views" inputmode="numeric"></label></div>
      <button class="btn btn-primary" type="submit">${current ? '更新样本' : '保存样本'}</button></form>`;
  } else {
    body.innerHTML = `<form id="sampleUploadForm" class="samples-intake-form samples-upload-form"><div class="samples-form-copy"><b>${current ? '给当前样本补充媒体' : '上传原始媒体建立归档'}</b><span>文件按原始字节流式保存，不进入 Git；支持图片、视频和音频，封面可单独补充。</span></div>
      ${current ? `<label class="samples-check samples-wide"><input name="sampleId" type="checkbox" value="${current.id}" checked><span><b>归档到「${esc(current.title || '当前样本')}」</b><small>取消勾选会用下面的信息另建样本</small></span></label>` : ''}
      <label><span>样本标题 *</span><input name="title" required maxlength="500"></label><label><span>平台</span><select name="platform"><option value="manual">手动归档</option><option value="xiaohongshu">小红书</option><option value="douyin">抖音</option></select></label>
      <label><span>内容类型</span><select name="contentType"><option value="video">视频</option><option value="image_post">图文</option><option value="audio">音频</option></select></label><label><span>原始链接</span><input name="sourceUrl" type="url" placeholder="https://…"></label>
      <label class="samples-file samples-wide"><span>原始媒体 *</span><input name="media" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/aac,audio/ogg" required></label>
      <label class="samples-file samples-wide"><span>封面图片（可选）</span><input name="cover" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"></label>
      <button class="btn btn-primary" type="submit">上传并归档</button></form>`;
  }
  if (current && intakeMode === 'manual') {
    const form = $('#sampleManualForm');
    form.elements.title.value = current.title || '';
    form.elements.platform.value = current.platform || 'manual';
    form.elements.contentType.value = current.contentType || 'unknown';
    form.elements.publishedAt.value = localDateTime(current.publishedAt);
    form.elements.accountName.value = current.accountName || '';
    form.elements.sourceUrl.value = current.sourceUrl || '';
    form.elements.bodyText.value = current.bodyText || '';
    for (const key of ['likes','collects','comments','shares','views']) form.elements[key].value = current.metrics?.[key] || '';
  }
  if (current && intakeMode === 'upload') {
    const form = $('#sampleUploadForm');
    form.elements.title.value = current.title || '';
    form.elements.platform.value = current.platform || 'manual';
    form.elements.contentType.value = current.contentType || 'video';
    form.elements.sourceUrl.value = current.sourceUrl || '';
  }
  if (linkJob) paintLinkProgress();
}

let loadTimer = null;
function debounceLoad() { clearTimeout(loadTimer); loadTimer = setTimeout(loadSamples, 260); }

async function loadResearchConfig(){
  if(researchConfig)return;
  researchConfigError='';paintFilterBuilder();
  try{const [config,dictionary]=await Promise.all([api.sampleResearchConfig(),api.sampleTagDictionary()]);researchConfig={...config,tags:dictionary?.items||[]};paintFilterBuilder();}
  catch(error){researchConfigError=error.message||'筛选字典读取失败';paintFilterBuilder();}
}
function paintFilterBuilder(){
  const el=$('#sampleFilterBuilder');const toggle=$('#sampleFiltersToggle');if(!el)return;
  el.hidden=!filtersOpen;toggle?.setAttribute('aria-expanded',String(filtersOpen));if(!filtersOpen)return;
  if(researchConfigError){el.innerHTML=`<div class="sample-filter-error"><span>${esc(researchConfigError)}</span><button type="button" data-filter-config-retry>重试</button></div>`;return;}
  if(!researchConfig){el.innerHTML='<div class="sample-filter-loading">正在读取标签和元素字典…</div>';return;}
  const tags=researchConfig.tags||researchConfig.tagDictionary||[];const dimensions=researchConfig.dimensions||[];
  const selected=new Set([...root().querySelectorAll('[name="sampleTagIds"]:checked')].map(input=>String(input.value)));
  const groups=tags.reduce((out,tag)=>{const key=tag.kindLabel||tag.kind||'其他';(out[key]||=[]).push(tag);return out;},{});
  el.innerHTML=`<header><div><b>组合筛选</b><span>同类标签任意命中，跨类标签同时满足；不同元素条件之间也是同时满足。</span></div><button type="button" data-filter-clear>清空全部</button></header>
    <div class="sample-tag-filters">${Object.entries(groups).map(([name,list])=>`<fieldset><legend>${esc(name)} <small>任选</small></legend>${list.map(tag=>`<label><input type="checkbox" name="sampleTagIds" value="${tag.id}" ${selected.has(String(tag.id))?'checked':''}><span>${esc(tag.name)}</span></label>`).join('')}</fieldset>`).join('')||'<p>标签字典暂无可用标签。</p>'}</div>
    <div class="sample-element-filters"><header><b>元素条件</b><span>最多 15 条，条件之间同时满足</span></header>${elementConditions.map((condition,index)=>`<div class="sample-element-condition"><select data-element-condition data-index="${index}" data-field="dimensionKey" aria-label="元素维度">${dimensions.map(d=>`<option value="${esc(d.key||d.dimensionKey)}" ${(d.key||d.dimensionKey)===condition.dimensionKey?'selected':''}>${esc(d.label||d.name||d.dimensionKey)}</option>`).join('')}</select><select data-element-condition data-index="${index}" data-field="mode" aria-label="匹配方式"><option value="any" ${condition.mode==='any'?'selected':''}>任意词命中</option><option value="all" ${condition.mode==='all'?'selected':''}>全部词命中</option></select><input data-element-condition data-index="${index}" data-field="facets" value="${esc(condition.facets)}" placeholder="输入关键词，用逗号分隔" aria-label="元素关键词"><button type="button" data-filter-remove="${index}" aria-label="删除元素条件">删除</button></div>`).join('')||'<p>还没有元素条件，可以按标题机制、用户需求、内容结构等组合查询。</p>'}<button type="button" data-filter-add ${elementConditions.length>=15?'disabled':''}>＋ 添加元素条件</button></div>`;
}

function currentFilterPayload(){
  const tags=(researchConfig?.tags||researchConfig?.tagDictionary||[]);const selectedIds=new Set([...root().querySelectorAll('[name="sampleTagIds"]:checked')].map(input=>Number(input.value)));
  const tagGroups=Object.values(tags.filter(t=>selectedIds.has(Number(t.id))).reduce((out,t)=>{const key=t.kind||t.kindLabel||'other';(out[key]||={kind:key,tagIds:[]}).tagIds.push(Number(t.id));return out;},{}));
  return {q:$('#sampleQuery')?.value?.trim()||undefined,platform:$('#samplePlatform')?.value||undefined,archiveStatus:$('#sampleArchiveStatus')?.value||undefined,tagIds:tagGroups.flatMap(group=>group.tagIds),elements:elementConditions.filter(c=>String(c.facets||'').trim()).map(c=>({dimensionKey:c.dimensionKey,facetMode:c.mode,facets:String(c.facets).split(/[,，]/).map(v=>v.trim()).filter(Boolean)})),page,pageSize:PAGE_SIZE};
}

async function loadSamples() {
  const seq=++listSeq;
  const opts=currentFilterPayload();listLoading=true;listError='';paintList();
  try {
    const data = await api.sampleSearch(opts);
    if (!active||seq!==listSeq) return;
    items = data.items || []; total = Number(data.total || items.length);
    compareSelection=compareSelection.map(selected=>{const latest=items.find(item=>Number(item.id)===Number(selected.id));return latest?selectionSummary(latest):selected;});
    saveCompareSelection();paintComparisonTray();
    summary = data.summary || {total,complete:items.filter(item=>item.archiveStatus==='complete').length,incomplete:items.filter(item=>item.archiveStatus!=='complete').length};
    if (!items.length && total > 0 && page > 1) { page=1; return loadSamples(); }
    if(selectedId&&detail)updateResearchOptions(researchOptions());
    listLoading=false;paintStats(); paintList(); paintPager();
    if (selectedId && items.some(item => String(item.id) === String(selectedId))) paintList();
  } catch (error) { if(seq===listSeq){listLoading=false;listError=error.message||'样本读取失败';paintList();paintPager();} }
}

function paintStats() {
  $('#samplesHeadStats').innerHTML = `<span><b>${Number(summary.total||0)}</b><small>样本总数</small></span><span><b>${Number(summary.complete||0)}</b><small>完整归档</small></span><span><b>${Number(summary.incomplete||0)}</b><small>待补资料</small></span>`;
}

function paintPager(){
  const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));const start=total?((page-1)*PAGE_SIZE+1):0;const end=Math.min(total,page*PAGE_SIZE);
  $('#samplesPager').innerHTML=`<span>显示 ${start}–${end} / ${total} 条</span><div><button type="button" data-sample-page="${page-1}" ${page<=1?'disabled':''}>上一页</button><b>${page} / ${pages}</b><button type="button" data-sample-page="${page+1}" ${page>=pages?'disabled':''}>下一页</button></div>`;
}

function loadCompareSelection(){
  try{const value=JSON.parse(localStorage.getItem('ideahub.sampleComparisonSelection')||'[]');return Array.isArray(value)?value.filter(item=>Number.isSafeInteger(Number(item.id))).slice(0,6):[];}
  catch{return [];}
}
function saveCompareSelection(){
  try{localStorage.setItem('ideahub.sampleComparisonSelection',JSON.stringify(compareSelection.slice(0,6)));}catch{/* private browsing */}
}
function selectionSummary(item){return {id:Number(item.id),title:item.title||`样本 #${item.id}`,platform:item.platformLabel||item.platform||'样本',coverUrl:coverUrl(item)};}
function toggleCompareSelection(id,checked,control){
  const exists=compareSelection.some(item=>Number(item.id)===Number(id));
  if(checked&&!exists){
    if(compareSelection.length>=6){if(control)control.checked=false;toast('info','一次最多比较 6 篇样本');return;}
    const item=items.find(value=>Number(value.id)===Number(id));if(!item)return;
    compareSelection.push(selectionSummary(item));
  }else if(!checked&&exists)compareSelection=compareSelection.filter(item=>Number(item.id)!==Number(id));
  saveCompareSelection();paintComparisonTray();paintList();
  requestAnimationFrame(()=>root()?.querySelector(`[data-compare-toggle][value="${CSS.escape(String(id))}"]`)?.focus());
}
function paintComparisonTray(){
  const tray=$('#sampleComparisonTray');if(!tray)return;
  const count=compareSelection.length;
  if(libraryMode!=='samples'||count===0||root()?.classList.contains('samples-detail-mode')){tray.hidden=true;tray.innerHTML='';return;}tray.hidden=false;
  tray.innerHTML=`<div class="sample-comparison-tray-copy"><span>横向比较</span><b>${count}/6 篇</b><small>${count<2?'再选择 '+(2-count)+' 篇即可开始':count===6?'已达到本次上限':'可跨筛选和分页继续选择'}</small></div><div class="sample-comparison-tray-items">${compareSelection.map(item=>`<span><i>${esc(item.platform)}</i><b>${esc(item.title)}</b><button type="button" data-compare-remove="${item.id}" aria-label="从比较中移除：${esc(item.title)}">×</button></span>`).join('')||'<p>在卡片左上角勾选“比较”，打开样本仍由卡片本身完成。</p>'}</div><div class="sample-comparison-tray-actions">${count?'<button type="button" data-compare-clear>清空</button>':''}<button type="button" class="stage3-primary" data-compare-start ${count<2||count>6||comparisonBusy?'disabled':''}>开始比较</button></div>`;
}
function openComparisonCreateDialog(trigger){
  if(compareSelection.length<2||compareSelection.length>6){toast('info','请选择 2–6 篇样本');return;}
  const dialog=$('#sampleComparisonCreateDialog'),form=$('#sampleComparisonCreateForm');if(!dialog||!form)return;
  form.querySelector('.sample-comparison-create-members').innerHTML=`<span>本次固定成员</span><div>${compareSelection.map((item,index)=>`<p><b>${index+1}</b><span>${esc(item.title)}</span><i>${esc(item.platform)}</i></p>`).join('')}</div>`;
  form.querySelector('.stage3-form-error').textContent='';comparisonDialogFocus=trigger||document.activeElement;dialog.showModal();requestAnimationFrame(()=>form.elements.name.focus());
}
function closeComparisonCreateDialog(){const dialog=$('#sampleComparisonCreateDialog');if(!dialog?.open)return;dialog.close();const target=comparisonDialogFocus;comparisonDialogFocus=null;requestAnimationFrame(()=>target?.isConnected&&target.focus());}
async function submitComparison(form){
  if(comparisonBusy)return;const button=form.querySelector('button[type="submit"]'),data=new FormData(form),memberIds=compareSelection.map(item=>Number(item.id));comparisonBusy=true;button.disabled=true;form.querySelector('.stage3-form-error').textContent='';
  try{const title=String(data.get('name')||'').trim(),topicBasis=String(data.get('topic')||'').trim();const created=await api.sampleComparisonCreate({title,purpose:topicBasis,scope:{memberIds,topicBasis,purpose:topicBasis}},`comparison-${Date.now()}-${Math.random().toString(36).slice(2,9)}`);const id=created?.comparison?.id||created?.id;if(!id)throw new Error('服务端没有返回比较记录 ID');closeComparisonCreateDialog();compareSelection=[];saveCompareSelection();form.reset();toast('ok','比较记录和冻结范围已建立');await openWorkspace(id);}
  catch(error){form.querySelector('.stage3-form-error').textContent=error.message||'建立比较失败，已填写内容仍保留';}
  finally{comparisonBusy=false;if(button.isConnected)button.disabled=false;paintComparisonTray();}
}

function coverUrl(item) { return item.coverUrl || (item.coverAssetId ? `/api/samples/${item.id}/assets/${item.coverAssetId}` : ''); }
function statusInfo(value) { return STATUS[value] || [value || '部分归档','partial']; }
function metric(engagement, ...keys) { for (const key of keys) if (engagement?.[key] != null && engagement[key] !== '') return engagement[key]; return '—'; }
function metricBadges(engagement) {
  return [
    ['赞',metric(engagement,'likes','点赞')], ['藏',metric(engagement,'collects','收藏')],
    ['评',metric(engagement,'comments','评论')], ['转',metric(engagement,'shares','reposts','转发')],
    ['播',metric(engagement,'views','plays','播放')],
  ].filter(([,value]) => value !== '—').map(([label,value]) => `<span>${label} ${esc(value)}</span>`).join('') || '<span>互动数据待补</span>';
}

function paintList() {
  const list = $('#samplesList');
  paintFocusNav();
  if(listLoading){list.innerHTML='<div class="samples-list-state"><i></i><b>正在筛选样本…</b><span>组合条件只查询当前有效且未驳回的元素。</span></div>';return;}
  if(listError){list.innerHTML=`<div class="samples-list-state error"><b>样本列表没有读出来</b><span>${esc(listError)}</span><button type="button" id="sampleReload">重试</button></div>`;return;}
  if (!items.length) { list.innerHTML = `<div class="samples-empty-list">${ICON.layers}<b>还没有符合条件的样本</b><span>可以从链接、手动信息或媒体文件开始建立。</span></div>`; return; }
  list.innerHTML = items.map(item => {
    const status = statusInfo(item.archiveStatus);
    const missing = (item.missingFields || []).slice(0, 3).map(key => MISSING[key] || key);
    const matched=[...(item.matchedTags||[]).map(t=>t.name||t.label||t),...(item.matchedElements||[]).map(e=>`${e.dimensionLabel||e.label||dimensionLabel(e.dimensionKey)}：${formatElementValue(e.effectiveValue??e.value??e.matchedValue)}`)].filter(Boolean);
    const confirmed=item.confirmedElementCount??item.confirmedCount??null,analyzed=Number(item.analyzedElementCount??item.elementCount??(item.currentAnalysisVersionId?15:0));
    const compareOn=compareSelection.some(selected=>Number(selected.id)===Number(item.id));
    const compareLocked=compareSelection.length>=6&&!compareOn;
    return `<article class="sample-card ${String(item.id) === String(selectedId) ? 'on' : ''} ${compareOn?'compare-selected':''}" data-sample-id="${item.id}" tabindex="0" role="button" aria-pressed="${String(item.id)===String(selectedId)}" aria-label="打开样本：${esc(item.title||'未命名样本')}">
      <label class="sample-compare-checkbox" title="${compareLocked?'已达到 6 篇上限':'加入比较'}"><input type="checkbox" data-compare-toggle value="${item.id}" ${compareOn?'checked':''} ${compareLocked?'disabled':''} aria-label="${compareOn?'从比较中移除':'加入比较'}：${esc(item.title||'未命名样本')}"><span>${compareOn?'已选':'比较'}</span></label>
      <div class="sample-cover">${coverUrl(item) ? `<img loading="lazy" src="${coverUrl(item)}" alt="${esc(item.title || '样本封面')}">` : `<span>${ICON.layers}</span>`}<i>${esc(item.platformLabel || item.platform || '样本')}</i></div>
      <div class="sample-card-main"><header><span class="sample-status ${status[1]}"><i></i>${esc(status[0])}</span><b>${Number(item.completenessScore || 0)}%</b></header>
        <h3>${esc(item.title || '未命名样本')}</h3><div class="sample-compact-meta"><span>${esc(item.platformLabel||item.platform||'样本')}</span><b>${analyzed?(confirmed==null?'15维已拆解':`${confirmed}/15 已确认`):'待拆解'}</b></div><p>${esc(item.bodyExcerpt || '原始正文待补充')}</p>
        <div class="sample-meta"><span>${esc(item.accountName || '账号待补')}</span><span>${item.publishedAt ? esc(new Date(item.publishedAt).toLocaleDateString('zh-CN')) : '时间待补'}</span><span>${Number(item.assetCount || 0)} 份媒体</span>${analyzed?`<span class="sample-review-progress">${confirmed==null?'15维已拆解':`已确认 ${confirmed}/15`}</span>`:'<span class="sample-review-progress pending">待拆解</span>'}</div>
        <div class="sample-metrics">${metricBadges(item.metrics)}</div>
        ${matched.length?`<div class="sample-match-reasons"><b>命中原因</b>${matched.slice(0,4).map(value=>`<span>${esc(value)}</span>`).join('')}</div>`:''}
        ${missing.length ? `<footer>还缺：${missing.map(esc).join('、')}${(item.missingFields || []).length > 3 ? ` 等 ${item.missingFields.length} 项` : ''}</footer>` : '<footer class="done">原始档案已达到完整标准</footer>'}
      </div></article>`;
  }).join('');
}
function paintFocusNav(){const count=$('#samplesFocusCount'),focus=$('#sampleFocusQuery'),main=$('#sampleQuery');if(count)count.textContent=`${total} 篇`;if(focus&&main&&focus.value!==main.value)focus.value=main.value;}
function dimensionLabel(key){return (researchConfig?.dimensions||[]).find(d=>(d.key||d.dimensionKey)===key)?.label||key||'元素';}
function formatElementValue(value){if(value==null)return '';if(typeof value==='string')return value;if(Array.isArray(value))return value.join('、');if(typeof value==='object')return Object.values(value).join('、');return String(value);}

function selectSample(id, initialTab = '') { captureSeq+=1;captureLoading=false;listScrollTop=window.scrollY;selectedId = Number(id); detail = null;requestedResearchTab=initialTab;root()?.classList.add('samples-detail-mode');paintList();paintComparisonTray();loadDetail(selectedId); }
async function loadDetail(id, silent = false) {
  const seq = ++loadSeq;
  if (!silent) { loadingDetail = true; const el=$('#samplesDetail');if(el)el.innerHTML='<div class="samples-detail-loading"><i></i><span>正在打开研究档案…</span></div>'; }
  try {
    const data = await api.sample(id);
    if (!active || seq !== loadSeq || Number(selectedId) !== Number(id)) return;
    detail = data; loadingDetail = false;
    const options = researchOptions();
    if (requestedResearchTab) options.initialTab = requestedResearchTab;
    requestedResearchTab = '';
    await openResearch($('#samplesDetail'),detail,options);
    if (!silent && matchMedia('(max-width:1100px)').matches) $('#samplesDetail')?.scrollIntoView({behavior:'instant',block:'start'});
  } catch (error) { if (seq === loadSeq) { loadingDetail = false; const el=$('#samplesDetail');if(el)el.innerHTML=`<div class="samples-detail-error"><b>样本详情没有打开</b><span>${esc(error.message||'读取失败')}</span><button type="button" data-sample-id="${id}">重试</button><button type="button" data-sample-back>返回列表</button></div>`; } }
}

function closeMobileDetail(){
  leaveResearch();root()?.classList.remove('samples-detail-mode','samples-nav-collapsed');paintComparisonTray();if(matchMedia('(max-width:1100px)').matches){requestAnimationFrame(()=>window.scrollTo({top:listScrollTop,behavior:'instant'}));}
}
function openIntakeForSelected(mode){root()?.classList.remove('samples-detail-mode','samples-nav-collapsed');intakeMode=mode;setIntakeOpen(true);paintIntake();paintComparisonTray();requestAnimationFrame(()=>$('#samplesIntake')?.scrollIntoView({behavior:'smooth',block:'start'}));}
function adjacentSample(offset){const index=items.findIndex(item=>Number(item.id)===Number(selectedId)),next=items[index+offset];if(next)selectSample(next.id);}
function researchOptions(){const index=items.findIndex(item=>Number(item.id)===Number(selectedId));return {onBack:closeMobileDetail,onPrevious:()=>adjacentSample(-1),onNext:()=>adjacentSample(1),hasPrevious:index>0,hasNext:index>=0&&index<items.length-1,onUpdated:loadSamples,onEdit:()=>openIntakeForSelected('manual'),onAttach:()=>openIntakeForSelected('upload')};}

function paintDetail() {
  const el = $('#samplesDetail');
  if (!selectedId) { el.innerHTML = `<div class="samples-empty">${ICON.layers}<b>选择一篇样本</b><span>查看原始正文、媒体、完整度和历次采集版本。</span></div>`; return; }
  if (loadingDetail || !detail) { el.innerHTML = '<div class="samples-detail-loading"><i></i><span>正在打开原始档案…</span></div>'; return; }
  const status = statusInfo(detail.archiveStatus);
  const assets = detail.assets || [];
  const missing = detail.missingFields || [];
  el.innerHTML = `<div class="sample-detail-head"><div><span>${esc(detail.platformLabel || detail.platform || '样本')} · 原始档案</span><h2>${esc(detail.title || '未命名样本')}</h2><p>${esc(detail.accountName || '账号待补')}${detail.publishedAt ? ` · ${esc(new Date(detail.publishedAt).toLocaleString('zh-CN'))}` : ''}</p></div>
      <div class="sample-detail-actions"><button type="button" class="sample-back" data-sample-back>返回列表</button>${detail.sourceUrl ? `<a href="${esc(detail.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原作品 ↗</a>` : ''}<button type="button" data-sample-edit>补充资料</button><button type="button" data-sample-attach>补媒体</button></div></div>
    <div class="sample-completeness"><div><span class="sample-status ${status[1]}"><i></i>${esc(status[0])}</span><b>${Number(detail.completenessScore || 0)}%</b></div><progress max="100" value="${Number(detail.completenessScore || 0)}"></progress>
      <p>${missing.length ? `缺失：${missing.map(key => esc(MISSING[key] || key)).join('、')}` : '标题、正文、账号、时间、互动、封面与媒体均已归档。'}</p></div>
    <section class="sample-original"><header><span>原始正文</span><b>${(detail.bodyText || '').length.toLocaleString('zh-CN')} 字</b></header><div>${esc(detail.bodyText || '正文尚未采集或录入。')}</div></section>
    <section class="sample-assets"><header><span>图片 / 视频 / 封面</span><b>${assets.length} 份</b></header><div>${assets.length ? assets.map(assetHtml).join('') : '<p class="samples-soft-empty">媒体尚未归档，可以通过“媒体上传”继续补充。</p>'}</div></section>
    <section class="sample-facts"><div><span>作品 ID</span><b>${esc(detail.platformContentId || '待补')}</b></div><div><span>采集方式</span><b>${esc(detail.lastIngestMethod || '—')}</b></div><div><span>采集版本</span><b>${Number(detail.captureCount || 0)} 次</b></div><div><span>互动</span><b class="sample-fact-metrics">${metricBadges(detail.metrics)}</b></div></section>
    <section class="sample-captures"><header><span>历次原始采集</span><div><b>${Number(detail.captureTotal ?? detail.captureCount ?? (detail.captures||[]).length)} 版 · 已显示 ${(detail.captures||[]).length} 版</b>${Number(detail.captureTotal||0)>(detail.captures||[]).length?`<button type="button" data-captures-more ${captureLoading?'disabled':''}>${captureLoading?'读取中…':'加载更早版本'}</button>`:''}</div></header>${(detail.captures || []).map(captureHtml).join('')}</section>`;
}

function assetHtml(asset) {
  const url = asset.contentUrl;
  if (String(asset.mimeType).startsWith('image/')) return `<figure><img loading="lazy" src="${url}" alt="${esc(asset.originalName || asset.kind)}"><figcaption>${esc(asset.kind)} · ${formatBytes(asset.byteSize)}</figcaption></figure>`;
  if (String(asset.mimeType).startsWith('video/')) return `<figure class="video"><video controls preload="metadata" src="${url}"></video><figcaption>视频归档 · ${formatBytes(asset.byteSize)}${asset.archiveQuality ? ` · ${esc(asset.archiveQuality)}` : ''}</figcaption></figure>`;
  if (String(asset.mimeType).startsWith('audio/')) return `<figure class="audio"><audio controls preload="metadata" src="${url}"></audio><figcaption>${esc(asset.originalName || '音频')}</figcaption></figure>`;
  return `<a class="sample-asset-file" href="${url}" target="_blank">${ICON.clip}<span>${esc(asset.originalName || '归档文件')} · ${formatBytes(asset.byteSize)}</span></a>`;
}
function captureHtml(capture) {
  const missing = capture.missingFields || [];
  const rawUrl=`/api/samples/${selectedId}/captures/${capture.id}/raw`;
  return `<details><summary><b>${esc(capture.captureType || '采集')}</b><span>${esc(fromNow(capture.capturedAt || capture.createdAt))} · 完整度 ${Number(capture.completenessScore || 0)}%${missing.length ? ` · 缺 ${missing.length} 项` : ''}</span></summary><div class="sample-raw"><div><button type="button" data-capture-raw="${capture.id}">按需读取原始 JSON</button><a href="${rawUrl}" target="_blank" rel="noopener">打开完整 JSON ↗</a></div><pre>尚未读取，避免打开详情时一次下载全部历史大文件。</pre></div></details>`;
}
async function loadCaptureRaw(button){
  const captureId=Number(button.dataset.captureRaw);if(!selectedId||!captureId)return;
  const box=button.closest('.sample-raw');button.disabled=true;button.textContent='读取中…';
  try{const raw=await api.sampleCaptureRaw(selectedId,captureId);const text=JSON.stringify(raw,null,2);box.querySelector('pre').textContent=text.length>200000?`${text.slice(0,200000)}\n\n……页面仅预览前 20 万字，请点击“打开完整 JSON”查看全部。`:text;button.remove();}
  catch(error){button.disabled=false;button.textContent='重新读取原始 JSON';toast('info',error.message||'原始采集读取失败');}
}
async function loadMoreCaptures(){
  if(!detail||captureLoading)return;const sampleId=Number(detail.id);const seq=++captureSeq;const shown=(detail.captures||[]).length;captureLoading=true;paintDetail();
  try{const nextPage=Math.floor(shown/20)+1;const data=await api.sampleCaptures(sampleId,{page:nextPage,pageSize:20});if(!active||seq!==captureSeq||Number(selectedId)!==sampleId||Number(detail?.id)!==sampleId)return;const known=new Set((detail.captures||[]).map(item=>Number(item.id)));detail.captures=[...(detail.captures||[]),...(data.items||[]).filter(item=>!known.has(Number(item.id)))];detail.captureTotal=Number(data.total||detail.captureTotal||detail.captures.length);}
  catch(error){if(seq===captureSeq&&Number(selectedId)===sampleId)toast('info',error.message||'更早采集版本读取失败');}
  finally{if(seq===captureSeq){captureLoading=false;paintDetail();}}
}
function formatBytes(value) { const n=Number(value||0); return n>=1048576 ? `${(n/1048576).toFixed(1)} MB` : n>=1024 ? `${(n/1024).toFixed(0)} KB` : `${n} B`; }

async function submitLink(form) {
  const button = form.querySelector('button[type="submit"]');
  const url = String(new FormData(form).get('url') || '').trim();
  if (!url) return;
  button.disabled = true; button.querySelector('span').textContent = '正在提交…';
  try {
    const mode = form.elements.publicMode.checked ? 'public' : 'saved';
    const created = await api.collectorCreate(url, mode, true);
    linkJob = { taskId:created.task_id, status:created.status || 'pending', progress:0, archiveFailures:0, message:'等待服务器采集并归档…' };
    form.elements.url.value = ''; paintLinkProgress(); pollLinkJob(true);
    toast('ok', '链接采集已提交，完成后会自动进入样本库');
  } catch (error) { toast('info', error.message || '链接采集提交失败'); }
  finally { button.disabled = false; button.querySelector('span').textContent = '采集并归档'; }
}

function paintLinkProgress() {
  const el = $('#sampleLinkProgress'); if (!el || !linkJob) return;
  el.innerHTML = `<i style="width:${Math.max(4, Number(linkJob.progress || 0))}%"></i><span>${esc(linkJob.message || linkJob.status)}</span>`;
}
function pollLinkJob(immediate = false) { clearTimeout(linkTimer); if (!active || !linkJob) return; linkTimer=setTimeout(runLinkPoll, immediate?120:1800); }
async function runLinkPoll() {
  if (!active || !linkJob) return;
  try {
    const status = await api.collectorTaskStatus(linkJob.taskId);
    Object.assign(linkJob, status); paintLinkProgress();
    if (status.status === 'done') {
      let result = await api.collectorResult(linkJob.taskId);
      if (result.sample_archive?.status !== 'done') {
        const archived = await api.collectorArchive(linkJob.taskId);
        result = { ...result, sample_archive:{
          status:archived.status || 'done',
          sample_id:archived.sample_id || archived.sampleId,
          capture_id:archived.capture_id || archived.captureId,
        } };
      }
      const sampleId = result.sample_archive?.sample_id;
      linkJob = null; page=1; await loadSamples();
      if (sampleId) selectSample(sampleId);
      toast('ok', '作品已经归档到样本库'); return;
    }
    if (status.status === 'failed' || status.status === 'interrupted') { toast('info', status.message || '采集未完成'); linkJob=null; paintIntake(); return; }
  } catch (error) {
    if (!linkJob) return;
    if (linkJob.status === 'done') {
      linkJob.archiveFailures = Number(linkJob.archiveFailures || 0) + 1;
      linkJob.message = `采集已完成，媒体归档重试 ${linkJob.archiveFailures}/3：${error.message || '归档失败'}`;
      paintLinkProgress();
      await loadSamples();
      const partialId = error.data?.sampleId;
      if (partialId) selectSample(partialId);
      if (linkJob.archiveFailures >= 3) {
        toast('info','作品资料已保留为部分归档，请稍后在采集记录中重试归档');
        linkJob=null; paintIntake(); return;
      }
    } else {
      linkJob.message = error.message || '状态读取失败'; paintLinkProgress();
    }
  }
  pollLinkJob();
}

async function submitManual(form) {
  const button=form.querySelector('button[type="submit"]'); const originalLabel=button.textContent; button.disabled=true; button.textContent='保存中…';
  const data=new FormData(form); const metrics={};
  for(const key of ['likes','collects','comments','shares','views']){const value=String(data.get(key)||'').trim();if(value)metrics[key]=value;}
  const payload={ingestMethod:'manual',title:data.get('title'),bodyText:data.get('bodyText'),platform:data.get('platform'),contentType:data.get('contentType'),publishedAt:isoFromLocalDateTime(String(data.get('publishedAt')||'')),accountName:data.get('accountName'),sourceUrl:data.get('sourceUrl'),metrics};
  payload.rawPayload={source:'manual_form',title:payload.title,bodyText:payload.bodyText,platform:payload.platform,contentType:payload.contentType,publishedAt:payload.publishedAt,accountName:payload.accountName,sourceUrl:payload.sourceUrl,metrics:{...metrics}};
  const targetId=data.get('updateExisting')?Number(data.get('updateExisting')):null;
  try{
    const response=targetId?await api.samplePatch(targetId,payload):await api.sampleCreate(payload);
    form.reset(); if(!targetId)page=1; await loadSamples(); selectSample(response.sample.id); toast('ok',targetId?'样本资料已更新':'手动样本已保存，可以继续补媒体');
  }catch(error){toast('info',error.message||'样本保存失败');}finally{button.disabled=false;button.textContent=originalLabel;}
}

async function mediaMetadata(file) {
  if (!file) return {};
  const url=URL.createObjectURL(file);
  try {
    if(file.type.startsWith('image/')) return await new Promise(resolve=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>resolve({});image.src=url;});
    if(file.type.startsWith('video/')||file.type.startsWith('audio/')) return await new Promise(resolve=>{const media=document.createElement(file.type.startsWith('video/')?'video':'audio');media.onloadedmetadata=()=>resolve({width:media.videoWidth||'',height:media.videoHeight||'',durationMs:Number.isFinite(media.duration)?Math.round(media.duration*1000):''});media.onerror=()=>resolve({});media.src=url;});
    return {};
  } finally { setTimeout(()=>URL.revokeObjectURL(url),0); }
}

async function submitUpload(form) {
  const button=form.querySelector('button[type="submit"]'); const data=new FormData(form); const media=data.get('media'); const cover=data.get('cover');
  if(!(media instanceof File)||!media.size)return;
  button.disabled=true;button.textContent='上传中…';
  let uploaded=null;
  try{
    const info=await mediaMetadata(media); const kind=media.type.startsWith('image/')?'image':media.type.startsWith('video/')?'video':media.type.startsWith('audio/')?'audio':'other';
    const targetId=data.get('sampleId')?Number(data.get('sampleId')):null;
    uploaded=await api.sampleAssetUpload(targetId,media,{title:data.get('title'),platform:data.get('platform'),contentType:data.get('contentType'),sourceUrl:data.get('sourceUrl'),kind,archiveQuality:'user_upload',...info});
    if(cover instanceof File&&cover.size){
      try{const coverInfo=await mediaMetadata(cover);await api.sampleAssetUpload(uploaded.sampleId,cover,{kind:'cover',captureId:uploaded.captureId,archiveQuality:'user_upload',...coverInfo});}
      catch(error){form.reset();await loadSamples();selectSample(uploaded.sampleId);toast('info',`原始媒体已保存，但封面失败：${error.message||'请稍后补传'}`);return;}
    }
    form.reset();if(!targetId)page=1;await loadSamples();selectSample(uploaded.sampleId);toast('ok',targetId?'媒体已补充到当前样本':'原始媒体已经永久归档');
  }catch(error){
    if(uploaded?.sampleId){await loadSamples();selectSample(uploaded.sampleId);toast('info','原始媒体已保存，后续步骤失败，可继续补充');}
    else toast('info',error.message||'媒体归档失败');
  }finally{button.disabled=false;button.textContent='上传并归档';}
}
