/**
 * 内容采集工作台。
 * 浏览器只和 IdeaHub 同源接口通信；真正的 Playwright、OCR、FFmpeg 与平台登录态
 * 都留在内网 Collector 中。页面不把任务复制进 localStorage，离开页面立即停止轮询。
 */
import { api, collectorQrUrl, collectorImageUrl, collectorMediaUrl } from '../api.js';
import { $, esc, fromNow } from '../util.js';
import { ICON } from '../icons.js';
import { toast } from '../toast.js';
import { confirmAction } from '../confirm.js';

let me = null;
let active = false;
let initialized = false;
let loadGeneration = 0;
let taskTimer = null;
let loginTimer = null;
let tasks = [];
let health = null;
let login = null;
let selectedId = null;
let result = null;
let resultLoading = false;
let analysisEditing = false;
let qrDismissed = false;

const ACTIVE = new Set(['pending', 'running', 'downloading', 'processing']);
const LOGIN_ACTIVE = new Set(['opening', 'waiting_scan', 'syncing']);
const STATUS = {
  pending:['等待中','wait'], running:['采集中','run'], downloading:['下载中','run'], processing:['分析中','run'],
  done:['已完成','done'], failed:['采集失败','fail'], interrupted:['已中断','fail'],
};
const VIDEO_EDIT_KEYS = ['main_topic','target_audience','user_need','content_structure','solution','references','extensions'];
const COMMENT_EDIT_KEYS = ['main_questions','high_frequency_needs','worries','unclear_points'];

export function setMe(value) { me = value; }
const isAdmin = () => me?.role === 'admin';
const root = () => $('#v-collector');
const currentTask = () => tasks.find(item => String(item.id) === String(selectedId));

function clearTimers() {
  clearTimeout(taskTimer); clearTimeout(loginTimer);
  taskTimer = null; loginTimer = null;
}

export function leave() {
  active = false;
  clearTimers();
  closeQr();
}

function scaffold() {
  root().innerHTML = `
    <div class="page-head collector-page-head">
      <div>
        <div class="page-kicker">服务器采集工作台</div>
        <h1>内容采集</h1>
        <div class="sub">粘贴小红书或抖音分享链接，由服务器完成素材、评论与 AI 分析。</div>
      </div>
      <div class="collector-service" id="collectorService"><i></i><span>正在连接采集服务…</span></div>
    </div>

    <section class="collector-compose">
      <div class="collector-compose-main">
        <span class="collector-eyebrow">新建采集</span>
        <h2>把分享链接交给服务器</h2>
        <p>提交后可以离开当前页面，任务会留在服务器继续处理。</p>
        <form class="collector-form" id="collectorForm">
          <label class="sr-only" for="collectorUrl">小红书或抖音分享链接</label>
          <div class="collector-urlbox"><span>${ICON.clip}</span><input id="collectorUrl" type="text" inputmode="url"
            autocomplete="off" spellcheck="false" placeholder="粘贴小红书 / 抖音分享链接或分享文案"></div>
          <button class="btn btn-primary collector-start" id="collectorStart" type="submit">${ICON.sparkle}<span>开始采集</span></button>
        </form>
        <div class="collector-form-note"><span>支持 xiaohongshu.com、xhslink.com、douyin.com</span><b>单任务运行，避免占满 VPS 资源</b></div>
      </div>
      <aside class="collector-account" id="collectorAccount"><div class="collector-mini-skeleton"></div></aside>
    </section>

    <section class="collector-workspace">
      <aside class="collector-history">
        <header><div><span>采集记录</span><b id="collectorCount">0 条</b></div><button class="collector-reload" id="collectorReload" type="button" title="刷新记录">刷新</button></header>
        <div class="collector-task-list" id="collectorTaskList"><div class="collector-list-loading">正在读取采集记录…</div></div>
      </aside>
      <main class="collector-detail" id="collectorDetail">
        <div class="collector-empty-detail">${ICON.layers}<b>选择一条采集记录</b><span>已完成的任务可以查看原图、评论和 AI 分析。</span></div>
      </main>
    </section>

    <div class="collector-qr-layer" id="collectorQrLayer" aria-hidden="true">
      <button class="collector-qr-backdrop" type="button" data-qr-close aria-label="关闭二维码"></button>
      <section class="collector-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="collectorQrTitle">
        <button class="collector-qr-close" type="button" data-qr-close aria-label="关闭">${ICON.close}</button>
        <span class="collector-qr-kicker">平台账号</span><h2 id="collectorQrTitle">登录小红书</h2>
        <div id="collectorQrBody"></div>
      </section>
    </div>`;
  bind();
  initialized = true;
}

export async function render() {
  active = true;
  clearTimers();
  if (!initialized || !root()?.querySelector('#collectorForm')) scaffold();
  const own = ++loadGeneration;
  paintService(); paintAccount(); paintTasks(); paintDetail();
  const requests = [api.collectorHealth(), api.collectorTasks()];
  if (isAdmin()) requests.push(api.collectorLoginStatus());
  const settled = await Promise.allSettled(requests);
  if (!active || own !== loadGeneration) return;
  if (settled[0].status === 'fulfilled') health = settled[0].value;
  else health = { ok:false, collector:'down', error:settled[0].reason?.message || '无法连接采集服务' };
  if (settled[1].status === 'fulfilled') tasks = listFrom(settled[1].value);
  else toast('info', settled[1].reason?.message || '采集记录加载失败');
  if (isAdmin()) {
    if (settled[2]?.status === 'fulfilled') login = settled[2].value;
    else if (settled[2]?.reason?.status !== 403) login = { status:'failed', message:settled[2]?.reason?.message || '平台状态读取失败' };
  }
  paintService(); paintAccount(); paintTasks();
  if (selectedId && !currentTask()) { selectedId = null; result = null; }
  paintDetail();
  scheduleTaskPoll();
  scheduleLoginPoll();
}

const listFrom = payload => Array.isArray(payload) ? payload : (payload?.items || []);

function paintService() {
  const el = $('#collectorService');
  if (!el) return;
  const loading = health == null;
  const ok = health?.ok === true && health?.collector !== 'down';
  el.className = `collector-service ${loading ? 'loading' : ok ? 'up' : 'down'}`;
  el.innerHTML = `<i></i><span>${loading ? '正在连接采集服务…' : ok ? '采集服务正常' : '采集服务暂不可用'}</span>`;
  el.title = health?.error || '';
  $('#collectorStart').disabled = !ok;
}

function accountName(account = {}) { return account.nickname || account.name || account.red_id || '小红书账号'; }

function paintAccount() {
  const el = $('#collectorAccount');
  if (!el) return;
  if (!isAdmin()) {
    el.innerHTML = `<div class="collector-account-icon">${ICON.users}</div><div><small>平台登录</small><b>由管理员维护</b><span>你可以直接提交和查看自己的采集任务</span></div>`;
    return;
  }
  if (!login) {
    el.innerHTML = '<div class="collector-mini-skeleton"></div>';
    return;
  }
  const status = login.status || 'idle';
  const account = login.account || {};
  const loginPending = status === 'opening' || status === 'waiting_scan';
  if (login.saved && !loginPending) {
    const syncing = status === 'syncing';
    const hasAccount = Object.values(account).some(Boolean);
    el.innerHTML = `<div class="collector-account-avatar">${esc([...accountName(account)][0] || '小')}</div>
      <div class="collector-account-copy"><small>${syncing ? '正在同步账号' : '小红书已登录'}</small><b>${esc(accountName(account))}</b><span>${esc(login.message || (account.red_id ? `小红书号 ${account.red_id}` : (hasAccount ? '登录态已保存' : '登录有效，账号资料待同步')))}</span></div>
      <div class="collector-account-actions"><button type="button" data-account-sync ${syncing ? 'disabled' : ''}>${syncing ? '同步中…' : '同步'}</button><button type="button" data-login-switch ${syncing ? 'disabled' : ''}>切换</button></div>`;
    return;
  }
  const busy = LOGIN_ACTIVE.has(status);
  el.innerHTML = `<div class="collector-account-icon ${status === 'failed' || status === 'expired' ? 'bad' : ''}">${busy ? ICON.clock : ICON.users}</div>
    <div class="collector-account-copy"><small>小红书账号</small><b>${busy ? '等待扫码登录' : '尚未登录'}</b><span>${esc(login.message || '登录后可采集完整评论与账号信息')}</span></div>
    <button class="btn btn-ghost collector-login-btn" type="button" ${busy ? 'data-qr-open' : 'data-login-start'}>${busy ? '查看二维码' : (status === 'failed' || status === 'expired' ? '重新登录' : '扫码登录')}</button>`;
  if (busy && !qrDismissed) openQr();
}

function paintTasks() {
  const list = $('#collectorTaskList');
  if (!list) return;
  $('#collectorCount').textContent = `${tasks.length} 条`;
  if (!tasks.length) {
    list.innerHTML = `<div class="collector-task-empty">${ICON.clip}<b>还没有采集记录</b><span>在上方粘贴一条分享链接开始。</span></div>`;
    return;
  }
  list.innerHTML = tasks.map(taskCard).join('');
}

function taskCard(task) {
  const status = task.refresh_status || task.status || 'pending';
  const info = task.refresh_status ? ['更新中','run'] : (STATUS[status] || [status,'wait']);
  const activeTask = ACTIVE.has(status);
  const progress = Math.max(0, Math.min(100, Number(task.refresh_progress ?? task.progress ?? 0)));
  const selected = String(task.id) === String(selectedId);
  return `<article class="collector-task ${selected ? 'on' : ''}" data-collector-task="${esc(task.id)}" tabindex="0" role="button" aria-pressed="${selected}">
    <div class="collector-task-top"><span class="collector-platform ${esc(task.source || '')}">${task.source === 'douyin' ? '抖音' : '小红书'}</span><span class="collector-status ${info[1]}"><i></i>${esc(info[0])}</span></div>
    <h3>${esc(task.title || (activeTask ? '正在识别内容…' : '未命名内容'))}</h3>
    <p>${esc(task.account_name || (task.error_msg ? task.error_msg : task.message || '等待服务器返回账号信息'))}</p>
    ${activeTask ? `<div class="collector-progress"><i style="width:${Math.max(4, progress)}%"></i></div><small>${progress ? `${progress}% · ` : ''}${esc(task.message || '正在处理…')}</small>` : ''}
    <footer><time>${esc(fromNow(task.created_at))}</time><span>
      ${['failed','interrupted'].includes(task.status) ? '<button type="button" data-task-retry>重试</button>' : ''}
      ${isAdmin() && !activeTask ? `<button class="danger" type="button" data-task-delete>${ICON.trash}<span>删除</span></button>` : ''}
    </span></footer>
  </article>`;
}

function selectTask(id) {
  if (String(selectedId) === String(id)) return;
  selectedId = id; result = null; resultLoading = false; analysisEditing = false;
  paintTasks(); paintDetail();
  if (currentTask()?.status === 'done') loadResult(id);
}

function paintDetail() {
  const el = $('#collectorDetail');
  if (!el) return;
  const task = currentTask();
  if (!task) {
    el.innerHTML = `<div class="collector-empty-detail">${ICON.layers}<b>选择一条采集记录</b><span>已完成的任务可以查看原图、评论和 AI 分析。</span></div>`;
    return;
  }
  if (task.status !== 'done') {
    const info = STATUS[task.status] || [task.status,'wait'];
    const retry = ['failed','interrupted'].includes(task.status);
    el.innerHTML = `<div class="collector-state-detail ${info[1]}"><span class="collector-state-mark">${retry ? ICON.warn : ICON.clock}</span>
      <small>${esc(info[0])}</small><h2>${esc(task.title || '正在采集内容')}</h2><p>${esc(task.error_msg || task.message || '服务器正在处理这条任务，请稍候。')}</p>
      ${retry ? '<button class="btn btn-primary" type="button" data-detail-retry>重新采集</button>' : `<div class="collector-detail-progress"><i style="width:${Math.max(5, Number(task.progress || 0))}%"></i></div>`}</div>`;
    return;
  }
  if (resultLoading || !result || String(result.task_id) !== String(task.id)) {
    el.innerHTML = `<div class="collector-result-loading"><i></i><b>正在打开采集结果…</b><span>图片会按需加载，文字与分析会先出现。</span></div>`;
    return;
  }
  el.innerHTML = resultHTML(task, result);
}

async function loadResult(id, silent = false) {
  const own = ++loadGeneration;
  if (!silent) { resultLoading = true; paintDetail(); }
  try {
    const data = await api.collectorResult(id);
    if (!active || own !== loadGeneration || String(selectedId) !== String(id)) return;
    result = data; resultLoading = false; paintDetail();
  } catch (error) {
    if (!active || own !== loadGeneration) return;
    resultLoading = false; paintDetail();
    toast('info', error.message || '采集结果加载失败');
  }
}

function safeHref(value) {
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : '#'; }
  catch { return '#'; }
}

function imageSrc(taskId, image) {
  if (String(image?.url || '').startsWith('data:image/')) return image.url;
  if (image?.filename && image?.stored_locally !== false) return collectorImageUrl(taskId, image.filename);
  return safeHref(image?.source_url || image?.url || '');
}

function resultHTML(task, data) {
  const account = data.account || {};
  const engagement = data.engagement || {};
  const images = data.images || [];
  const comments = data.comments || [];
  const video = data.media_assets?.video || {};
  const mediaStatus = data.collection_status?.media || {};
  const refreshing = !!task.refresh_status;
  return `<div class="collector-result">
    <header class="collector-result-head">
      <div><span>${data.platform === 'douyin' ? '抖音' : '小红书'} · 采集结果</span><h2>${esc(data.display_title || data.title || task.title || '未命名内容')}</h2>
        <p>${esc(accountName(account))}${data.data_updated_at ? ` · 更新于 ${esc(fromNow(data.data_updated_at))}` : ''}</p></div>
      <a href="${esc(safeHref(data.source_url || task.url))}" target="_blank" rel="noopener noreferrer">查看原内容 ↗</a>
    </header>
    <div class="collector-result-actions">
      <button class="btn btn-ghost" type="button" data-result-refresh ${refreshing ? 'disabled' : ''}>${ICON.clock}<span>${refreshing ? '正在更新…' : '更新数据'}</span></button>
      <span class="collector-action-divider"></span>
      <button class="btn btn-ghost" type="button" data-result-push="persona">推送到真人作品</button>
      <button class="btn btn-primary" type="button" data-result-push="matrix">推送到矩阵作品</button>
    </div>
    <div class="collector-stat-grid">
      <div><span>点赞</span><b>${esc(engagement.likes || '—')}</b></div><div><span>收藏</span><b>${esc(engagement.collects || '—')}</b></div>
      <div><span>评论</span><b>${esc(engagement.comments || comments.length || '—')}</b></div><div><span>正文图片</span><b>${images.length}</b></div>
    </div>
    <div class="collector-summary-grid">
      <article><span>账号信息</span><h3>${esc(accountName(account))}</h3><p>${esc(account.bio || account.description || '账号简介暂未获取')}</p>
        <div class="collector-account-metrics"><b>${esc(account.follower_count || '—')}<small>粉丝</small></b><b>${esc(account.likes_and_collections_count || '—')}<small>获赞与收藏</small></b></div></article>
      <article><span>内容摘要</span><h3>${esc(data.post_title || data.title || '内容正文')}</h3><p>${esc(data.post_description || data.description || data.page_text || '正文摘要暂未获取')}</p>
        <div class="collector-topics">${(data.topics || []).map(x => `<i>#${esc(x)}</i>`).join('') || '<i>暂无话题</i>'}</div></article>
    </div>
    ${video.filename ? `<section class="collector-section"><header><div><span>视频素材</span><h3>服务器留存视频</h3></div></header><video class="collector-video" controls preload="metadata" src="${esc(collectorMediaUrl(task.id, video.filename))}"></video></section>` : ''}
    ${images.length ? `<section class="collector-section"><header><div><span>正文素材</span><h3>图片与画面文字</h3></div><b>${images.length} 张</b></header><div class="collector-gallery">${images.map(image => `<figure><img loading="lazy" src="${esc(imageSrc(task.id, image))}" alt="第 ${Number(image.index || 0)} 张采集图片"><figcaption><b>第 ${Number(image.index || 0)} 张</b><span>${esc(image.text || '未识别到画面文字')}</span></figcaption></figure>`).join('')}</div></section>` : ''}
    ${data.media_type === 'image_post' && !images.length ? `<section class="collector-section"><header><div><span>正文素材</span><h3>暂未保存到图片</h3></div></header><div class="collector-soft-empty">${esc(mediaStatus.message || '平台没有返回可验证的正文图片，可稍后更新数据重试。')}</div></section>` : ''}
    ${data.video_text ? `<section class="collector-section"><header><div><span>视频识别</span><h3>字幕与画面文字</h3></div></header><div class="collector-longtext">${esc(data.video_text)}</div></section>` : ''}
    ${analysisHTML(data.ai_analysis || {})}
    <section class="collector-section"><header><div><span>原始证据</span><h3>评论样本</h3></div><b>${comments.length} 条</b></header>
      <div class="collector-comments">${comments.length ? comments.slice(0, 80).map(comment => `<article><div><b>${esc(comment.author || '匿名用户')}</b><span>${Number(comment.like_count || 0).toLocaleString('zh-CN')} 赞</span></div><p>${esc(comment.text || '')}</p></article>`).join('') : '<div class="collector-soft-empty">暂未采集到可展示评论</div>'}</div>
    </section>
  </div>`;
}

function analysisHTML(ai) {
  const videoItems = ai.video?.items || {};
  const commentItems = ai.comments?.items || {};
  const editable = VIDEO_EDIT_KEYS.some(key => videoItems[key]) || COMMENT_EDIT_KEYS.some(key => commentItems[key]);
  const editMeta = ai.manual_edit?.edited_at ? `上次编辑 ${fromNow(ai.manual_edit.edited_at)}` : '只可修改 AI 结论，评论原话保持不变';
  const item = (scope, key, value) => `<article class="collector-ai-item"><span>${esc(value.label || key)}</span>${analysisEditing
    ? `<textarea maxlength="6000" data-analysis-scope="${scope}" data-analysis-key="${key}">${esc(value.summary || '')}</textarea>`
    : `<p>${esc(value.summary || '—')}</p>`}</article>`;
  const keys = commentItems.key_comments?.entries || [];
  const topics = commentItems.topic_extensions?.entries || [];
  return `<section class="collector-section collector-ai"><header><div><span>AI 辅助分析</span><h3>内容与评论洞察</h3><small>${esc(editMeta)}</small></div>
      <div class="collector-ai-actions">${analysisEditing ? '<button type="button" data-analysis-cancel>取消</button><button class="primary" type="button" data-analysis-save>保存修改</button>' : `<button type="button" data-analysis-edit ${editable ? '' : 'disabled'}>${ICON.pencil}<span>编辑结论</span></button>`}</div></header>
    <div class="collector-ai-notice">${esc(ai.notice || 'AI 分析仅作辅助整理，请结合原始证据判断。')}</div>
    <div class="collector-ai-group"><h4>内容分析</h4><div class="collector-ai-grid">${VIDEO_EDIT_KEYS.filter(key => videoItems[key]).map(key => item('video', key, videoItems[key])).join('') || '<div class="collector-soft-empty">暂未生成内容分析</div>'}</div></div>
    <div class="collector-ai-group"><h4>评论需求</h4><div class="collector-ai-grid">${COMMENT_EDIT_KEYS.filter(key => commentItems[key]).map(key => item('comments', key, commentItems[key])).join('') || '<div class="collector-soft-empty">暂未生成评论分析</div>'}</div></div>
    ${(keys.length || topics.length) ? `<div class="collector-ai-grid collector-ai-lists">
      <article class="collector-ai-item"><span>${esc(commentItems.key_comments?.label || '重点评论')}</span>${keys.map((entry, index) => analysisEditing
        ? `<textarea maxlength="6000" data-analysis-list="key_comments" data-analysis-index="${index}">${esc(entry.reason || '')}</textarea>` : `<p>${esc(entry.reason || '')}</p>`).join('')}</article>
      <article class="collector-ai-item"><span>${esc(commentItems.topic_extensions?.label || '延伸选题')}</span>${topics.map((entry, index) => analysisEditing
        ? `<textarea maxlength="6000" data-analysis-list="topic_extensions" data-analysis-index="${index}">${esc(entry.idea || '')}</textarea>` : `<p>${esc(entry.idea || '')}</p>`).join('')}</article>
    </div>` : ''}
  </section>`;
}

function bind() {
  root().addEventListener('submit', event => {
    if (event.target.id !== 'collectorForm') return;
    event.preventDefault(); submitTask($('#collectorUrl').value);
  });
  root().addEventListener('keydown', event => {
    const card = event.target.closest('[data-collector-task]');
    if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectTask(card.dataset.collectorTask); }
  });
  root().addEventListener('click', event => {
    const target = event.target;
    if (target.closest('[data-qr-close]')) { qrDismissed = true; closeQr(); return; }
    if (target.closest('[data-login-start]')) return startLogin(false, target.closest('button'));
    if (target.closest('[data-login-switch]')) return startLogin(true, target.closest('button'));
    if (target.closest('[data-qr-open]')) { qrDismissed = false; openQr(); return; }
    if (target.closest('[data-account-sync]')) return syncAccount(target.closest('button'));
    if (target.closest('#collectorReload')) return reloadTasks(target.closest('button'));
    const taskEl = target.closest('[data-collector-task]');
    if (target.closest('[data-task-delete]')) return removeTask(taskEl?.dataset.collectorTask, target.closest('button'));
    if (target.closest('[data-task-retry]') || target.closest('[data-detail-retry]')) return retryTask(taskEl?.dataset.collectorTask || selectedId, target.closest('button'));
    if (taskEl) { selectTask(taskEl.dataset.collectorTask); return; }
    if (target.closest('[data-result-refresh]')) return refreshTask(target.closest('button'));
    const push = target.closest('[data-result-push]');
    if (push) return pushTask(push.dataset.resultPush, push);
    if (target.closest('[data-analysis-edit]')) { analysisEditing = true; paintDetail(); requestAnimationFrame(() => root().querySelector('.collector-ai textarea')?.focus()); return; }
    if (target.closest('[data-analysis-cancel]')) { analysisEditing = false; paintDetail(); return; }
    if (target.closest('[data-analysis-save]')) return saveAnalysis(target.closest('button'));
  });
}

function validShareText(value) { return /(xiaohongshu\.com|xhslink\.(?:com|cn)|douyin\.com|v\.douyin\.com)/i.test(value); }

async function submitTask(value, button = $('#collectorStart')) {
  const url = String(value || '').trim();
  if (!url) { toast('info', '请先粘贴分享链接'); $('#collectorUrl').focus(); return; }
  if (!validShareText(url)) { toast('info', '目前只支持小红书或抖音分享链接'); $('#collectorUrl').focus(); return; }
  busy(button, true, '正在提交…');
  try {
    const created = await api.collectorCreate(url);
    const id = created.task_id || created.id;
    tasks = [{ id, url, source:/douyin/i.test(url) ? 'douyin' : 'xiaohongshu', title:'正在识别内容…', owner_id:created.owner_id || me?.id,
      status:created.status || 'pending', progress:0, message:'等待服务器处理…', created_at:new Date().toISOString() }, ...tasks.filter(task => String(task.id) !== String(id))];
    selectedId = id; result = null; $('#collectorUrl').value = '';
    paintTasks(); paintDetail(); scheduleTaskPoll(true);
    toast('ok', created.status === 'done' ? '已有采集结果，正在为你打开' : '任务已提交，服务器会继续处理');
    if (created.status === 'done') loadResult(id);
  } catch (error) { toast('info', error.message || '任务提交失败'); }
  finally { busy(button, false); paintService(); }
}

async function retryTask(id, button) {
  const task = tasks.find(item => String(item.id) === String(id));
  if (!task) return;
  await submitTask(task.url, button);
}

async function reloadTasks(button) {
  busy(button, true, '刷新中…');
  try { tasks = listFrom(await api.collectorTasks()); paintTasks(); paintDetail(); scheduleTaskPoll(true); }
  catch (error) { toast('info', error.message || '刷新失败'); }
  finally { busy(button, false); }
}

function scheduleTaskPoll(immediate = false) {
  clearTimeout(taskTimer);
  if (!active || !tasks.some(task => ACTIVE.has(task.status) || task.refresh_status)) return;
  taskTimer = setTimeout(pollTasks, immediate ? 120 : 1800);
}

async function pollTasks() {
  if (!active) return;
  const polling = tasks.filter(task => ACTIVE.has(task.status) || task.refresh_status);
  await Promise.all(polling.map(async task => {
    try {
      const status = await api.collectorTaskStatus(task.id);
      if (!active) return;
      if (task.refresh_status) {
        task.refresh_status = ACTIVE.has(status.status) ? status.status : null;
        task.refresh_progress = status.progress;
        task.refresh_message = status.message;
        if (!task.refresh_status && String(selectedId) === String(task.id)) await loadResult(task.id, true);
      } else {
        task.status = status.status; task.progress = status.progress; task.message = status.message;
        if (status.status === 'failed') task.error_msg = status.message;
        if (status.status === 'done' && String(selectedId) === String(task.id)) await loadResult(task.id, true);
      }
    } catch (error) { task.message = error.message || '状态读取失败'; }
  }));
  try { tasks = listFrom(await api.collectorTasks()); } catch { /* 状态卡仍保留最后一次可用结果 */ }
  if (!active) return;
  paintTasks(); paintDetail(); scheduleTaskPoll();
}

async function refreshTask(button) {
  const task = currentTask();
  if (!task || task.status !== 'done') return;
  task.refresh_status = 'pending'; task.refresh_progress = 0;
  paintTasks(); paintDetail(); busy(button, true, '正在提交…');
  try { await api.collectorRefresh(task.id); toast('ok', '已开始更新最新互动和评论'); scheduleTaskPoll(true); }
  catch (error) { task.refresh_status = null; paintTasks(); paintDetail(); toast('info', error.message || '更新失败'); }
  finally { busy(button, false); }
}

async function pushTask(channel, button) {
  const task = currentTask();
  if (!task || task.status !== 'done') return;
  const label = channel === 'persona' ? '真人作品' : '矩阵作品';
  busy(button, true, '正在推送…');
  try {
    const response = await api.collectorPush(task.id, channel);
    const record = response.record_id || response.id || response.item?.id;
    toast('ok', `已推送到${response.destination || label}${record ? `（记录 ${record}）` : ''}`);
  } catch (error) { toast('info', error.message || `推送到${label}失败，可以稍后重试`); }
  finally { busy(button, false); }
}

async function removeTask(id, button) {
  if (!isAdmin() || !id) return;
  const task = tasks.find(item => String(item.id) === String(id));
  const ok = await confirmAction({ eyebrow:'删除采集记录', title:'确定永久删除？',
    message:`“${task?.title || '这条采集记录'}”的历史、图片、视频与分析文件都会一起删除。`,
    note:'文件删除后无法恢复；已经推送到 IdeaHub 作品库的记录不受影响。', confirmLabel:'永久删除' });
  if (!ok) return;
  busy(button, true, '删除中…');
  try {
    await api.collectorDelete(id);
    tasks = tasks.filter(item => String(item.id) !== String(id));
    if (String(selectedId) === String(id)) { selectedId = null; result = null; analysisEditing = false; }
    paintTasks(); paintDetail(); toast('ok', '采集记录和关联文件已删除');
  } catch (error) { toast('info', error.message || '删除失败，记录已保留'); busy(button, false); }
}

function collectAnalysisEdits() {
  const payload = { video:{}, comments:{} };
  root().querySelectorAll('[data-analysis-scope]').forEach(input => { payload[input.dataset.analysisScope][input.dataset.analysisKey] = input.value; });
  root().querySelectorAll('[data-analysis-list]').forEach(input => {
    (payload[input.dataset.analysisList] ||= [])[Number(input.dataset.analysisIndex)] = input.value;
  });
  return payload;
}

async function saveAnalysis(button) {
  const task = currentTask();
  if (!analysisEditing || !task || task.status !== 'done') return;
  const payload = collectAnalysisEdits();
  busy(button, true, '正在保存…');
  root().querySelectorAll('.collector-ai textarea,[data-analysis-cancel]').forEach(el => { el.disabled = true; });
  try {
    const response = await api.collectorAnalysis(task.id, payload);
    result.ai_analysis = response.ai_analysis;
    analysisEditing = false; paintDetail(); toast('ok', 'AI 分析已保存，评论原话没有改动');
  } catch (error) {
    root().querySelectorAll('.collector-ai textarea,[data-analysis-cancel]').forEach(el => { el.disabled = false; });
    busy(button, false); toast('info', error.message || '保存失败，输入内容已为你保留');
  }
}

async function startLogin(switchAccount, button) {
  if (!isAdmin()) return;
  qrDismissed = false; busy(button, true, '正在打开…');
  try { login = await api.collectorLoginStart(switchAccount); paintAccount(); openQr(); scheduleLoginPoll(true); }
  catch (error) { toast('info', error.message || '无法发起登录'); }
  finally { busy(button, false); }
}

async function syncAccount(button) {
  if (!isAdmin()) return;
  busy(button, true, '同步中…');
  try { login = { ...login, status:'syncing', message:'正在读取当前账号…' }; paintAccount(); login = await api.collectorAccountSync(); paintAccount(); toast('ok', '小红书账号信息已同步'); }
  catch (error) { toast('info', error.message || '账号同步失败'); try { login = await api.collectorLoginStatus(); paintAccount(); } catch { /* 保留原状态 */ } }
  finally { busy(button, false); }
}

function scheduleLoginPoll(immediate = false) {
  clearTimeout(loginTimer);
  if (!active || !isAdmin() || !LOGIN_ACTIVE.has(login?.status)) return;
  loginTimer = setTimeout(pollLogin, immediate ? 120 : 1600);
}

async function pollLogin() {
  if (!active || !isAdmin()) return;
  try { login = await api.collectorLoginStatus(); paintAccount(); paintQr(); }
  catch (error) { login = { ...login, status:'failed', message:error.message || '登录状态读取失败' }; paintAccount(); paintQr(); }
  scheduleLoginPoll();
}

function openQr() {
  const layer = $('#collectorQrLayer');
  if (!layer) return;
  layer.classList.add('on'); layer.setAttribute('aria-hidden','false'); paintQr();
}
function closeQr() {
  const layer = $('#collectorQrLayer');
  if (!layer) return;
  layer.classList.remove('on'); layer.setAttribute('aria-hidden','true');
}
function paintQr() {
  const body = $('#collectorQrBody');
  if (!body || !$('#collectorQrLayer')?.classList.contains('on')) return;
  const status = login?.status || 'idle';
  if (status === 'waiting_scan' && login?.qr_available) {
    const expires = login.expires_at ? Math.max(0, Number(login.expires_at) - Math.floor(Date.now() / 1000)) : 180;
    body.innerHTML = `<div class="collector-qr-image"><img src="${collectorQrUrl()}" alt="小红书登录二维码"></div><b>使用小红书扫码</b><p>${esc(login.message || '扫码后请在手机上确认登录')}</p><span>二维码约 ${Math.ceil(expires / 60)} 分钟内有效</span>`;
  } else if (status === 'opening' || status === 'syncing') {
    body.innerHTML = `<div class="collector-qr-loading"><i></i></div><b>${status === 'syncing' ? '正在保存登录账号' : '正在生成二维码'}</b><p>${esc(login?.message || '服务器正在打开安全登录页面…')}</p>`;
  } else if ((login?.saved || status === 'saved' || status === 'done') && login?.account) {
    body.innerHTML = `<div class="collector-qr-success">${ICON.check}</div><b>登录成功</b><p>${esc(accountName(login.account))}</p><button class="btn btn-primary" type="button" data-qr-close>完成</button>`;
  } else {
    body.innerHTML = `<div class="collector-qr-error">${ICON.warn}</div><b>${status === 'expired' ? '二维码已过期' : '登录没有完成'}</b><p>${esc(login?.message || '请重新发起扫码登录')}</p><button class="btn btn-primary" type="button" data-login-start>重新登录</button>`;
  }
}

function busy(button, on, text = '') {
  if (!button) return;
  if (on) {
    if (!button.dataset.busyHtml) button.dataset.busyHtml = button.innerHTML;
    button.disabled = true; button.classList.add('is-busy');
    if (text) button.innerHTML = `<i class="collector-spin"></i><span>${esc(text)}</span>`;
  } else {
    button.disabled = false; button.classList.remove('is-busy');
    if (button.dataset.busyHtml) { button.innerHTML = button.dataset.busyHtml; delete button.dataset.busyHtml; }
  }
}
