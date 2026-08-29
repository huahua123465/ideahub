/** 内容样本库第一阶段：原始作品归档、完整度与三种录入入口。 */
import { api } from '../api.js';
import { $, esc, fromNow } from '../util.js';
import { ICON } from '../icons.js';
import { toast } from '../toast.js';

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
  clearTimeout(linkTimer);
  linkTimer = null;
}

export async function render() {
  active = true;
  if (!initialized) scaffold();
  await loadSamples();
  if (linkJob) { paintLinkProgress(); pollLinkJob(true); }
}

function scaffold() {
  root().innerHTML = `
    <div class="page-head samples-page-head"><div><div class="page-kicker">内容研究数据库</div><h1>样本库</h1>
      <div class="sub">先保存原始作品，再逐步拆解、比较和沉淀可复用元素。</div></div>
      <div class="samples-head-stats" id="samplesHeadStats"></div></div>

    <section class="samples-intake">
      <header><div><span>建立样本</span><h2>三种方式进入同一套归档</h2></div>
        <nav aria-label="样本录入方式"><button class="on" data-sample-mode="link">链接采集</button><button data-sample-mode="manual">手动录入</button><button data-sample-mode="upload">媒体上传</button></nav></header>
      <div id="sampleIntakeBody"></div>
    </section>

    <section class="samples-toolbar">
      <label>${ICON.search}<input id="sampleQuery" placeholder="搜索标题、正文、账号或作品 ID"></label>
      <select id="samplePlatform" aria-label="平台筛选"><option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="douyin">抖音</option><option value="manual">手动归档</option></select>
      <select id="sampleArchiveStatus" aria-label="完整度筛选"><option value="">全部完整度</option><option value="complete">完整归档</option><option value="usable">可用但有缺项</option><option value="partial">部分归档</option></select>
      <button type="button" id="sampleReload">刷新</button>
    </section>
    <div class="samples-pager" id="samplesPager"></div>

    <section class="samples-workspace">
      <div class="samples-list" id="samplesList"><div class="samples-loading">正在读取样本…</div></div>
      <aside class="samples-detail" id="samplesDetail"><div class="samples-empty">${ICON.layers}<b>选择一篇样本</b><span>查看原始正文、媒体、完整度和历次采集版本。</span></div></aside>
    </section>`;
  bind();
  paintIntake();
  initialized = true;
}

function bind() {
  root().addEventListener('click', event => {
    const mode = event.target.closest('[data-sample-mode]');
    if (mode) { intakeMode = mode.dataset.sampleMode; paintIntake(); return; }
    if (event.target.closest('[data-sample-edit]')) { intakeMode='manual'; paintIntake(); root().querySelector('.samples-intake')?.scrollIntoView({behavior:'smooth'}); return; }
    if (event.target.closest('[data-sample-attach]')) { intakeMode='upload'; paintIntake(); root().querySelector('.samples-intake')?.scrollIntoView({behavior:'smooth'}); return; }
    if (event.target.closest('[data-sample-back]')) { $('#samplesList')?.scrollIntoView({behavior:'smooth'}); return; }
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
    if (event.target.id === 'sampleLinkForm') submitLink(event.target);
    if (event.target.id === 'sampleManualForm') submitManual(event.target);
    if (event.target.id === 'sampleUploadForm') submitUpload(event.target);
  });
  root().addEventListener('input', event => {
    if (event.target.id === 'sampleQuery') { page=1; debounceLoad(); }
  });
  root().addEventListener('change', event => {
    if (['samplePlatform','sampleArchiveStatus'].includes(event.target.id)) { page=1; loadSamples(); }
  });
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
  root().querySelectorAll('[data-sample-mode]').forEach(button => button.classList.toggle('on', button.dataset.sampleMode === intakeMode));
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

async function loadSamples() {
  const seq=++listSeq;
  const opts = {
    q:$('#sampleQuery')?.value?.trim() || undefined,
    platform:$('#samplePlatform')?.value || undefined,
    archiveStatus:$('#sampleArchiveStatus')?.value || undefined,
    page,
    pageSize:PAGE_SIZE,
  };
  try {
    const data = await api.samples(opts);
    if (!active||seq!==listSeq) return;
    items = data.items || []; total = Number(data.total || items.length);
    summary = data.summary || {total,complete:items.filter(item=>item.archiveStatus==='complete').length,incomplete:items.filter(item=>item.archiveStatus!=='complete').length};
    if (!items.length && total > 0 && page > 1) { page=1; return loadSamples(); }
    paintStats(); paintList(); paintPager();
    if (selectedId && items.some(item => String(item.id) === String(selectedId))) loadDetail(selectedId, true);
    else if (selectedId) { selectedId = null; detail = null; paintDetail(); }
  } catch (error) { if(seq===listSeq)toast('info', error.message || '样本读取失败'); }
}

function paintStats() {
  $('#samplesHeadStats').innerHTML = `<span><b>${Number(summary.total||0)}</b><small>样本总数</small></span><span><b>${Number(summary.complete||0)}</b><small>完整归档</small></span><span><b>${Number(summary.incomplete||0)}</b><small>待补资料</small></span>`;
}

function paintPager(){
  const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));const start=total?((page-1)*PAGE_SIZE+1):0;const end=Math.min(total,page*PAGE_SIZE);
  $('#samplesPager').innerHTML=`<span>显示 ${start}–${end} / ${total} 条</span><div><button type="button" data-sample-page="${page-1}" ${page<=1?'disabled':''}>上一页</button><b>${page} / ${pages}</b><button type="button" data-sample-page="${page+1}" ${page>=pages?'disabled':''}>下一页</button></div>`;
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
  if (!items.length) { list.innerHTML = `<div class="samples-empty-list">${ICON.layers}<b>还没有符合条件的样本</b><span>可以从链接、手动信息或媒体文件开始建立。</span></div>`; return; }
  list.innerHTML = items.map(item => {
    const status = statusInfo(item.archiveStatus);
    const missing = (item.missingFields || []).slice(0, 3).map(key => MISSING[key] || key);
    return `<article class="sample-card ${String(item.id) === String(selectedId) ? 'on' : ''}" data-sample-id="${item.id}" tabindex="0">
      <div class="sample-cover">${coverUrl(item) ? `<img loading="lazy" src="${coverUrl(item)}" alt="${esc(item.title || '样本封面')}">` : `<span>${ICON.layers}</span>`}<i>${esc(item.platformLabel || item.platform || '样本')}</i></div>
      <div class="sample-card-main"><header><span class="sample-status ${status[1]}"><i></i>${esc(status[0])}</span><b>${Number(item.completenessScore || 0)}%</b></header>
        <h3>${esc(item.title || '未命名样本')}</h3><p>${esc(item.bodyExcerpt || '原始正文待补充')}</p>
        <div class="sample-meta"><span>${esc(item.accountName || '账号待补')}</span><span>${item.publishedAt ? esc(new Date(item.publishedAt).toLocaleDateString('zh-CN')) : '时间待补'}</span><span>${Number(item.assetCount || 0)} 份媒体</span></div>
        <div class="sample-metrics">${metricBadges(item.metrics)}</div>
        ${missing.length ? `<footer>还缺：${missing.map(esc).join('、')}${(item.missingFields || []).length > 3 ? ` 等 ${item.missingFields.length} 项` : ''}</footer>` : '<footer class="done">原始档案已达到完整标准</footer>'}
      </div></article>`;
  }).join('');
}

function selectSample(id) { captureSeq+=1;captureLoading=false;selectedId = Number(id); detail = null; paintList(); loadDetail(selectedId); }
async function loadDetail(id, silent = false) {
  const seq = ++loadSeq;
  if (!silent) { loadingDetail = true; paintDetail(); }
  try {
    const data = await api.sample(id);
    if (!active || seq !== loadSeq || Number(selectedId) !== Number(id)) return;
    detail = data; loadingDetail = false; paintDetail();
    if (!silent && matchMedia('(max-width:1100px)').matches) $('#samplesDetail')?.scrollIntoView({behavior:'smooth',block:'start'});
  } catch (error) { if (seq === loadSeq) { loadingDetail = false; paintDetail(); toast('info', error.message || '样本详情读取失败'); } }
}

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
      try{const coverInfo=await mediaMetadata(cover);await api.sampleAssetUpload(uploaded.sampleId,cover,{kind:'cover',archiveQuality:'user_upload',...coverInfo});}
      catch(error){form.reset();await loadSamples();selectSample(uploaded.sampleId);toast('info',`原始媒体已保存，但封面失败：${error.message||'请稍后补传'}`);return;}
    }
    form.reset();if(!targetId)page=1;await loadSamples();selectSample(uploaded.sampleId);toast('ok',targetId?'媒体已补充到当前样本':'原始媒体已经永久归档');
  }catch(error){
    if(uploaded?.sampleId){await loadSamples();selectSample(uploaded.sampleId);toast('info','原始媒体已保存，后续步骤失败，可继续补充');}
    else toast('info',error.message||'媒体归档失败');
  }finally{button.disabled=false;button.textContent='上传并归档';}
}
