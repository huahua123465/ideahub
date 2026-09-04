/** 详情抽屉：正文 + 讨论 + 流转记录 + 评审操作 */
import { api } from '../api.js';
import { avatarColor, initial, fromNow, esc, PILL, $ } from '../util.js';
import { countTo, pulse, ring } from '../anim.js';
import { toast } from '../toast.js';
import { STATUS_ICON } from '../icons.js';
import { SOURCE_LABEL } from '../tagstore.js';
import * as links from './links.js';
import { confirmAction } from '../confirm.js';

let cur = null;
let me = { id: 1, name: '陈屿', role: 'admin' };
export const setMe = u => { me = u; };
export const current = () => cur;

/**
 * 删除这条灵感（任务 14）。软删，后端保留记录，误删找得回来。
 * 二次确认是任务表明确要求的。
 */
export async function removeCurrent() {
  if (!cur) return;
  const ok = await confirmAction({
    eyebrow: '可恢复删除',
    title: '删除这条灵感？',
    message: `「${cur.title}」将不再出现在灵感池、正式库和全局搜索中。`,
    note: '记录仍保留在数据库中，需要时可由管理员恢复。',
    confirmLabel: '确认删除',
  });
  if (!ok) return;
  try {
    await api.ideaDelete(cur.id);
    closeDrawer();
    toast('ok', '已删除');
    events.dispatchEvent(new CustomEvent('deleted', { detail: { id: cur.id } }));
  } catch (e) {
    toast('info', e.message || '删除失败');
  }
}
export const isOpen = () => document.querySelector('#drawer.on') !== null;

/** 一条评论的 HTML。渲染和实时追加共用一份，免得两处的结构慢慢长歪 */
const commentHTML = (c, timeText) => `
  <div class="cmt-item" data-cid="${c.id}">
    <div class="av" style="background:${avatarColor(c.author.name)}">${esc(initial(c.author.name))}</div>
    <div class="cmt-body">
      <div class="n">${esc(c.author.name)}<span>${timeText ?? fromNow(c.createdAt)}</span></div>
      <div class="t">${esc(c.body)}</div>
    </div>
  </div>`;

/** 采纳/否决成功后通知外面刷新列表 */
export const events = new EventTarget();

/**
 * 打开详情抽屉。
 *
 * seed 是列表里已经有的那份数据（标题、正文、票数…）。
 * 有它就先把抽屉开出来、把能填的都填上，再去拉完整详情补评论和流转记录。
 *
 * 原来是 `await api.idea(id)` 拿到数据才开抽屉 —— 实测在 150ms 延迟的网络上
 * 点完要等 224ms 屏幕才有反应，中间毫无提示，慢一点就会被当成没点上。
 */
export async function openDrawer(id, seed) {
  if (seed) {
    cur = seed;
    paint(seed, { partial: true });
    $('#mask').classList.add('on');
    $('#drawer').classList.add('on');
  }

  const d = await api.idea(id);
  cur = d;

  paint(d, { partial: false });
  if (!seed) {
    $('#mask').classList.add('on');
    $('#drawer').classList.add('on');
  }
}

/**
 * 把一份灵感数据画进抽屉。
 * partial=true 表示这只是列表里的那份 —— 评论和流转记录还没到，
 * 先摆个占位，别把上一条灵感的评论留在那儿冒充这一条的。
 */
function paint(d, { partial }) {
  const [pc, pt] = PILL[d.status] || PILL.pending;
  $('#dPill').className = 'pill ' + pc;
  $('#dPill').innerHTML = (STATUS_ICON[d.status] || '') + esc(pt);
  $('#dCat').textContent = d.category + (d.tags?.length ? ' · ' + d.tags.map(t => '#' + t).join(' ') : '');
  $('#dTitle').textContent = d.title;
  $('#dAuthor').textContent = d.author.name;
  const av = $('#dAv');
  av.textContent = initial(d.author.name);
  av.style.background = avatarColor(d.author.name);
  $('#dTime').textContent = fromNow(d.createdAt);
  $('#dViews').textContent = d.viewCount != null ? `${d.viewCount} 次浏览` : '';
  $('#dContent').textContent = d.content;

  // 来源（任务 4）。能追回原始出处的才算有来源，所以有链接就做成可点的
  const src = $('#dSource');
  const srcLabel = SOURCE_LABEL[d.sourceType] || '人工录入';
  if (d.sourceType && d.sourceType !== 'manual') {
    src.hidden = false;
    src.innerHTML = `<span class="dim">来源</span> <span class="tag">${esc(srcLabel)}</span>`
      + (d.sourceUrl ? ` <a class="link" href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">打开原始出处 ↗</a>` : '');
  } else {
    src.hidden = !d.sourceUrl;
    src.innerHTML = d.sourceUrl
      ? `<span class="dim">来源</span> <a class="link" href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">原始出处 ↗</a>`
      : '';
  }
  $('#dVoteN').textContent = d.voteCount;
  $('#dVote').classList.toggle('voted', d.voted);

  if (partial) {
    $('#dFiles').hidden=true;
    $('#dProject').hidden = true;
    $('#dCmtN').textContent = '';
    $('#dCmts').innerHTML = '<div class="dim" style="padding:12px 0">载入中…</div>';
    $('#dTl').innerHTML = '';
  } else {
    renderIdeaFiles(d);
    renderProject(d);
    renderComments(d.comments || []);
    renderTimeline(d.activities || []);
  }

  // 人人可评审：只要还在灵感池里（pending / reviewing），谁都能采纳或否决
  const isPool = ['pending', 'reviewing'].includes(d.status);
  $('#btnReject').style.display = isPool ? '' : 'none';
  $('#btnAdopt').style.display  = isPool ? '' : 'none';
  $('#reviewHint').textContent = !isPool
    ? `当前状态：${pt.replace(/^\S+\s/, '')}${d.code ? ' · ' + d.code : ''}${
        d.promotedAt ? ' · 已转正式' : ''}`
    : '去向由大家一起决定 · 否决要写理由';

  // 删除（任务 14）：作者本人和管理员可见。后端也会再判一次，这里只是别让人白点
  const canDel = me.role === 'admin' || (d.author?.id && Number(d.author.id) === Number(me.id));
  $('#btnIdeaDel').hidden = !canDel;

  // 关联资料。列表带过来的那份数据够用了，不必等详情
  if (!partial) {
    $('#dLinks').hidden = false;
    links.mount($('#dLinks'), 'idea', d.id);
  }

  if (partial) {
    $('#dCmtInput').value = '';
    $('#cmtAnon').classList.remove('on');
    $('#cmtAnon').setAttribute('aria-checked', 'false');
    $('#dBody').scrollTop = 0;
  }
}

function fileSize(value){const n=Number(value||0);return n>=1024*1024?`${(n/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;}
function renderIdeaFiles(d){
  const box=$('#dFiles'),files=d.files||[];box.hidden=!files.length&&!d.canManageFiles;
  if(box.hidden)return;
  box.innerHTML=`<div class="sec-title">附件${files.length?` · ${files.length}`:''}</div>${files.length?`<div class="idea-drawer-file-list">${files.map(file=>`<div class="idea-drawer-file"><i>${esc(file.name.split('.').pop()?.toUpperCase()||'FILE')}</i><a href="${esc(file.url)}" target="_blank" rel="noopener">${esc(file.name)}</a><small>${fileSize(file.size)}</small><a class="idea-file-download" href="${esc(file.url)}?download=1">下载</a>${d.canManageFiles?`<button type="button" data-idea-file-delete="${file.id}" aria-label="删除 ${esc(file.name)}">×</button>`:''}</div>`).join('')}</div>`:'<p class="dim">还没有附件。</p>'}${d.canManageFiles?`<label class="idea-drawer-upload"><input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx"><span>＋ 继续上传 PDF / Word / Excel</span></label><p class="dim" data-idea-file-status></p>`:''}`;
  const input=box.querySelector('input[type="file"]');
  input?.addEventListener('change',async event=>{
    const selected=[...(event.target.files||[])];if(!selected.length)return;
    const status=box.querySelector('[data-idea-file-status]');let uploaded=0,failed=0;
    for(const [index,file]of selected.entries()){
      status.textContent=`正在上传 ${file.name}（${index+1}/${selected.length}）`;
      try{await api.ideaFileUpload(d.id,file);uploaded+=1;}catch(error){failed+=1;toast('info',`${file.name}：${error.message}`);}
    }
    const fresh=await api.idea(d.id);cur=fresh;paint(fresh,{partial:false});
    if(uploaded)toast(failed?'info':'ok',failed?`已上传 ${uploaded} 个，${failed} 个失败`:'附件已更新');
  });
  box.querySelectorAll('[data-idea-file-delete]').forEach(button=>button.addEventListener('click',async()=>{
    const file=files.find(item=>Number(item.id)===Number(button.dataset.ideaFileDelete));
    const ok=await confirmAction({eyebrow:'不可恢复操作',title:'删除这个附件？',message:`「${file?.name||'附件'}」会从这条灵感中移除。`,note:'文件本体会一起删除。',confirmLabel:'确认删除'});
    if(!ok)return;
    try{await api.fileDelete(Number(button.dataset.ideaFileDelete));const fresh=await api.idea(d.id);cur=fresh;paint(fresh,{partial:false});toast('ok','附件已删除');}catch(error){toast('info',error.message||'删除失败');}
  }));
}

/**
 * 立项管理块：进度滑块 + 方案文档。
 *
 * 只在「已采纳」且当前用户是负责人或管理员时才出现 —— 其他人看正式库那一栏就够了。
 * 匿名灵感采纳后负责人是空的，那就只有管理员能填，直到有人被指派。
 */
async function renderProject(d) {
  const box = $('#dProject');
  // 作者、负责人、管理员都能改。作者必须算进来 —— 否则负责人一旦指派错，
  // 真正该管这件事的人连把负责人改回来的入口都看不到。
  const mine = id => id != null && Number(id) === Number(me.id);
  const canEdit = d.status === 'adopted'
    && (me.role === 'admin' || mine(d.owner?.id) || mine(d.author?.id));

  box.hidden = !canEdit;
  if (!canEdit) return;

  setProgress(d.progress || 0);
  $('#dDocUrl').value = d.docUrl || '';

  // 负责人候选每次重新拉。缓存过一次的教训：新同事注册、或者刚改完谁的角色，
  // 不刷新页面就永远看不到变化，结果是「选不到自己」。
  try {
    const { items } = await api.people();
    $('#dOwner').innerHTML = '<option value="">未指派</option>' +
      items.map(u => `<option value="${u.id}"${
        d.owner && Number(d.owner.id) === u.id ? ' selected' : ''}>${esc(u.name)}${
        u.dept ? ' · ' + esc(u.dept) : ''}</option>`).join('');
  } catch {
    // 拉不到就至少把当前负责人显出来，别让下拉框空着看起来像没人负责
    $('#dOwner').innerHTML = d.owner
      ? `<option value="${d.owner.id}" selected>${esc(d.owner.name)}</option>`
      : '<option value="">未指派</option>';
  }

  const raw = $('#dProjectHint').dataset.raw;
  $('#dProjectHint').textContent = raw || '';
}

/** 当前选中的进度。按钮上的 .on 是显示，这个才是要提交的值 */
let projectProgress = 0;

function setProgress(v) {
  projectProgress = Math.max(0, Math.min(100, Number(v) | 0));
  let matched = false;
  for (const b of $('#dStages').querySelectorAll('.stage')) {
    const on = Number(b.dataset.v) === projectProgress;
    b.classList.toggle('on', on);
    if (on) matched = true;
  }
  // 历史数据可能落在七个档位之外（比如以前直接调接口写进去的 63%）。
  // 那种情况一个都不点亮，并把真实数字显示出来 —— 悄悄吸附到最近的档位
  // 会在用户没察觉的情况下改掉他的数据。
  $('#dProjectHint').dataset.raw = matched ? '' : `当前 ${projectProgress}%（非标准档位）`;
}

/** 点某一档。只改选中态，不发请求 —— 保存是显式动作 */
export function onStageClick(e) {
  const b = e.target.closest('.stage');
  if (b) setProgress(b.dataset.v);
}

export async function saveProject() {
  if (!cur) return;
  const btn = $('#btnSaveProject');
  const progress = projectProgress;
  const docUrl = $('#dDocUrl').value.trim();
  const ownerId = $('#dOwner').value ? Number($('#dOwner').value) : null;

  btn.disabled = true;
  try {
    const updated = await api.patch(cur.id, { progress, docUrl, ownerId });
    cur.progress = updated.progress;
    cur.docUrl = updated.docUrl;
    cur.owner = updated.owner;
    setProgress(updated.progress);
    toast('ok', updated.owner
      ? `已保存 · 进度 ${updated.progress}% · 负责人 ${updated.owner.name}`
      : `已保存 · 进度 ${updated.progress}% · 负责人未指派`);
    // 流转记录里会多一条「谁把进度更新到 X%」，重新拉一次让它当场可见
    const fresh = await api.idea(cur.id);
    renderTimeline(fresh.activities || []);
    events.dispatchEvent(new CustomEvent('project', { detail: { id: cur.id } }));
  } catch (e) {
    toast('info', e.message || '保存失败');
  } finally {
    btn.disabled = false;
  }
}

function renderComments(list) {
  $('#dCmtN').textContent = `（${list.length}）`;
  $('#dCmts').innerHTML = list.length ? list.map(c => commentHTML(c)).join('')
    : `<div class="empty sm">
         <svg viewBox="0 0 120 96" aria-hidden="true">
           <path d="M24 24h72v40H58L40 78V64H24V24Z"/>
           <path d="M40 40h40M40 52h26" class="ray"/>
         </svg>
         <span>还没有人讨论，来说第一句。</span>
       </div>`;
}

function renderTimeline(list) {
  $('#dTl').innerHTML = list.map(a => `
    <div class="tl${a.highlight ? ' hi' : ''}">${esc(a.text)}<span>${fromNow(a.createdAt)}</span>
      ${a.reason ? `<div style="color:var(--muted);margin-top:2px">理由：${esc(a.reason)}</div>` : ''}
    </div>`).join('');
}

export function closeDrawer() {
  $('#drawer').classList.remove('on');
  $('#mask').classList.remove('on');
}

export async function voteHere() {
  const btn = $('#dVote');
  const before = { voted: cur.voted, voteCount: cur.voteCount };
  const guess = { voted: !before.voted, voteCount: before.voteCount + (before.voted ? -1 : 1) };

  // 先动起来再发请求，失败回滚 —— 和灵感池里的卡片是同一套手感
  paint(guess, true);
  if (guess.voted) ring(btn);

  try {
    const r = await api.vote(cur.id);
    paint(r, r.voteCount !== guess.voteCount);
    events.dispatchEvent(new CustomEvent('vote', { detail: { id: cur.id, ...r } }));
  } catch (e) {
    paint(before, false);
    toast('info', e.message || '投票失败，请重试');
  }

  function paint({ voted, voteCount }, animate) {
    cur.voted = voted;
    cur.voteCount = voteCount;
    btn.classList.toggle('voted', voted);
    if (animate) { countTo($('#dVoteN'), voteCount, { ms: 300 }); pulse(btn, 'bump', 420); }
    else $('#dVoteN').textContent = voteCount;
  }
}

export async function postComment() {
  const inp = $('#dCmtInput');
  const text = inp.value.trim();
  if (!text) return;
  const anon = $('#cmtAnon');
  const isAnonymous = anon.classList.contains('on');
  inp.value = '';
  // 匿名是「这一条」的选择，发完就复位 —— 留着的话下一条会不知不觉也匿了
  anon.classList.remove('on');

  const c = await api.comment(cur.id, text, isAnonymous);
  const box = $('#dCmts');
  if (box.querySelector('.empty')) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', commentHTML(c, '刚刚').replace('class="cmt-item"', 'class="cmt-item enter"'));
  cur.commentCount = c.commentCount;
  $('#dCmtN').textContent = `（${c.commentCount}）`;
  $('#dBody').scrollTop = $('#dBody').scrollHeight;
  events.dispatchEvent(new CustomEvent('comment', { detail: { id: cur.id, count: c.commentCount } }));
}

/**
 * 别人在同一条灵感下发了评论：只追加缺的那几条。
 *
 * 不重建整个 #dCmts —— 重建会打断正在选中/复制文字的人。
 * 更要紧的是绝不碰 #dCmtInput：正在打字的内容一个字都不能动。
 */
export async function syncComments(ideaId) {
  if (!cur || cur.id !== ideaId || !isOpen()) return;

  const { items } = await api.comments(ideaId);
  const box = $('#dCmts');
  const have = new Set([...box.querySelectorAll('[data-cid]')].map(el => Number(el.dataset.cid)));
  const missing = items.filter(c => !have.has(c.id));
  if (!missing.length) return;

  // 追加前先看用户是不是本来就贴在底部。是才跟着滚，
  // 否则他正在往回翻旧讨论，页面自己跳走比不更新更烦人。
  const body = $('#dBody');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

  if (box.querySelector('.empty')) box.innerHTML = '';
  for (const c of missing) box.insertAdjacentHTML('beforeend', commentHTML(c));

  cur.commentCount = items.length;
  $('#dCmtN').textContent = `（${items.length}）`;
  if (atBottom) body.scrollTop = body.scrollHeight;
}

/**
 * 别人投了票：只改票数。
 * voted 是「我投没投」，服务端推的事件里根本没有这个字段，高亮态保留自己的。
 */
export function syncVote(ideaId, voteCount) {
  if (!cur || cur.id !== ideaId || !isOpen() || !Number.isFinite(voteCount)) return;
  cur.voteCount = voteCount;
  countTo($('#dVoteN'), voteCount, { ms: 300 });
}

/* 采纳和否决都要填东西（负责人 / 理由），交给 review.js 的弹窗处理 */
export function requestAdopt() { events.dispatchEvent(new CustomEvent('want-adopt', { detail: cur })); }
export function requestReject() { events.dispatchEvent(new CustomEvent('want-reject', { detail: cur })); }
