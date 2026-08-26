/**
 * 右侧聊天面板：一对一 + 群聊，能发文字和文件，支持 @、撤回、编辑、删除、已读回执。
 *
 * 双栏：左边人员/群列表常驻，右边当前会话，聊着天也能随时点别人切过去。
 * 手机上放不下两栏，退回单栏（靠 CSS 的 .has-conv 切换，JS 不用管）。
 * 收起时缩成右下角一个悬浮按钮 —— 常驻展开会一直吃掉右侧一条，
 * 而这个系统主体是宽表格，最缺的就是横向空间。
 */
import { api, state } from '../api.js';
import { esc, $, fromNow, avatarColor, initial } from '../util.js';
import { toast } from '../toast.js';
import { ICON } from '../icons.js';
import * as alertBox from './alert.js';
import { confirmAction } from '../confirm.js';

let peers = [], groups = [], unreadTotal = 0, lastUnread = 0;
let openPanel = false;
let conv = null;            // { kind:'user'|'group', id, name, members? }
let msgs = [];
let members = [];           // 当前群的成员，@ 候选用
let me = { id: 0, role: 'member' };
let editingId = null;       // 正在编辑哪条消息

export const setMe = u => { me = u; };

const FMT = n => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB'
               : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

/* ---------------- 取数 ---------------- */

let refreshTimer = null;
/** 推送可能连着来好几条，合并成一次拉取 */
export function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

export async function refresh() {
  if (state.mode === 'mock') return;
  try {
    const d = await api.chatPeers();
    peers = d.items; groups = d.groups; unreadTotal = d.unreadTotal;
  } catch (e) {
    if (e.message === '请先登录') return;
    return;                       // 拉不到就静默，别打断别的事
  }
  paintBadge();

  // 未读涨了就提醒。找出是谁发来的，好在通知里写清楚
  if (unreadTotal > lastUnread) {
    const from = [...groups, ...peers].find(x => x.unread > 0);
    alertBox.update(unreadTotal, from ? {
      title: from.kind === 'group' ? `群「${from.name}」` : from.name,
      body: from.lastText || '发来一条消息',
      onClick: () => { toggle(true); openConv(from.kind, from.id); },
    } : null);
  } else {
    alertBox.update(unreadTotal, null);
  }
  lastUnread = unreadTotal;

  if (!openPanel) return;
  paintList();                       // 左栏一直在，不管有没有选人
  if (conv) await loadMsgs({ keepScroll: true });
}

async function loadMsgs({ keepScroll = false } = {}) {
  if (!conv) return;
  const box = $('#chatMsgs');
  // 本来就贴在底部才自动跟随；正在往回翻旧消息的人不该被拽回来
  const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  try {
    const d = await api.chatWith(conv.kind, conv.id);
    msgs = d.items;
  } catch (e) { toast('info', e.message || '读取失败'); return; }
  // 别人删了/自己在另一个标签页撤回了正在编辑的那条，也要退出编辑状态
  if (editingId) {
    const still = msgs.find(x => x.id === editingId);
    if (!still || still.recalled) resetEditing();
  }

  paintConv();
  if (!keepScroll || atBottom) scrollToEnd();

  // 这个会话本来就没有未读，就别发标已读的请求。
  // 以前是每次 loadMsgs 都无条件发一次，而服务端收到就广播 chat:ping，
  // 于是「推送 → 刷新 → 标已读 → 又推送」转成了死循环：静置的页面每秒 2~3 次请求，
  // 连没开聊天面板的人也被一起拖着刷。服务端那边也补了同样的判据，两头各断一次。
  const list = conv.kind === 'group' ? groups : peers;
  const it = list.find(x => x.id === conv.id);
  // 只在**确知**这条会话没有未读时才跳过。列表还没拉到、或者这是一条列表里
  // 还没出现的新会话（it === undefined）时照发不误 —— 宁可多发一次，
  // 也不能让「打开了却标不上已读」这种错误出现。
  if (it && !(it.unread > 0)) return;

  try {
    const r = await api.chatRead(conv.kind, conv.id);
    if (r?.unreadTotal != null) unreadTotal = r.unreadTotal;
    if (it) { unreadTotal -= it.unread || 0; it.unread = 0; }
    paintBadge();
  } catch { /* 标不上不影响看 */ }
}

const scrollToEnd = () => { const b = $('#chatMsgs'); if (b) b.scrollTop = b.scrollHeight; };

/* ---------------- 渲染 ---------------- */

function paintBadge() {
  const dot = $('#chatDot');
  if (!dot) return;
  dot.hidden = unreadTotal <= 0;
  dot.textContent = unreadTotal > 99 ? '99+' : unreadTotal;
}

const convRow = (c, sub) => `
  <button class="peer${conv && conv.kind === c.kind && conv.id === c.id ? ' on' : ''}"
          data-kind="${c.kind}" data-id="${c.id}">
    <span class="av${c.kind === 'group' ? ' av-group' : ''}"
          style="background:${c.kind === 'group' ? 'var(--ink2)' : avatarColor(c.name)}">${
      c.kind === 'group' ? '群' : esc(initial(c.name))}</span>
    <span class="peer-main">
      <b>${esc(c.name)}${sub ? `<span class="dim"> · ${esc(sub)}</span>` : ''}</b>
      <span class="peer-last">${c.lastText
        ? (c.lastMine ? '我：' : (c.kind === 'group' && c.lastFrom ? esc(c.lastFrom) + '：' : ''))
          + esc(c.lastText)
        : '<span class="dim">还没聊过</span>'}</span>
    </span>
    <span class="peer-side">
      ${c.lastAt ? `<span class="dim">${esc(fromNow(c.lastAt))}</span>` : ''}
      ${c.unread ? `<span class="peer-dot">${c.unread}</span>` : ''}
    </span>
  </button>`;

/** 左栏的列表。它一直在，不随会话切换消失 */
function paintList() {
  $('#chatList').innerHTML =
    (groups.length ? `<div class="chatsec">群聊</div>` + groups.map(g => convRow(g, `${g.members} 人`)).join('') : '')
    + `<div class="chatsec">同事</div>`
    + (peers.length ? peers.map(p => convRow(p, p.dept)).join('')
       : '<div class="dim" style="padding:16px">还没有别的同事注册。</div>');
}

/** 右栏没选人时的占位 */
function paintEmpty() {
  $('#chatTitle').textContent = '聊天';
  $('#chatFoot').hidden = true;
  $('#chatMembers').hidden = true;
  $('#chatGroupDel').hidden = true;
  $('#chatMsgs').innerHTML =
    '<div class="dim" style="padding:26px;text-align:center">从左边选一个人或群开始聊。</div>';
}

const dayOf = iso => new Date(iso).toISOString().slice(0, 10);

/** 把正文里的 @某人 高亮出来 */
function renderBody(text) {
  let html = esc(text).replace(/\n/g, '<br>');
  for (const m of members) {
    const e = esc(m.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp('@' + e, 'g'), `<span class="at">@${esc(m.name)}</span>`);
  }
  return html;
}

function paintConv() {
  $('#chatTitle').textContent = conv.name;
  $('#chatFoot').hidden = false;
  $('#chatMembers').hidden = conv.kind !== 'group';
  // 解散群只给建群的人和管理员看到
  $('#chatGroupDel').hidden = !(conv.kind === 'group'
    && (me.role === 'admin' || Number(conv.createdBy) === Number(me.id)));

  let lastDay = '';
  $('#chatMsgs').innerHTML = msgs.length ? msgs.map(m => {
    const mine = Number(m.fromId) === Number(me.id);
    const day = dayOf(m.createdAt);
    const sep = day !== lastDay ? `<div class="chatday">${esc(day)}</div>` : '';
    lastDay = day;

    if (m.recalled) {
      return `${sep}<div class="chatrecall">${esc(mine ? '你' : m.fromName)} 撤回了一条消息</div>`;
    }

    const file = m.file ? `
      <a class="chatfile" href="${esc(m.file.url)}" target="_blank" rel="noopener">
        ${ICON.file}<span class="fname">${esc(m.file.name)}</span>
        <span class="dim">${FMT(m.file.size)}</span></a>` : '';

    // 已读回执：一对一看对方读没读，群里看几个人读过
    let receipt = '';
    if (mine) {
      receipt = conv.kind === 'group'
        ? (m.readBy > 0 ? `${m.readBy} 人已读` : '未读')
        : (m.read ? '已读' : '未读');
    }

    return `${sep}<div class="msg${mine ? ' mine' : ''}${m.pending ? ' pending' : ''}" data-mid="${m.id}">
      ${conv.kind === 'group' && !mine ? `<div class="mfrom">${esc(m.fromName)}</div>` : ''}
      <div class="brow">
        ${mine && !m.pending ? `<button class="mmore" data-more="${m.id}">${ICON.more}</button>` : ''}
        <div class="bubble">${m.body ? renderBody(m.body) : ''}${file}</div>
        ${mine || m.pending ? '' : `<button class="mmore" data-more="${m.id}">${ICON.more}</button>`}
      </div>
      <div class="mtime">${esc(fromNow(m.createdAt))}${m.edited ? ' · 已编辑' : ''}${
        receipt ? ` · ${receipt}` : ''}</div>
    </div>`;
  }).join('')
    : '<div class="dim" style="padding:16px">还没有消息，说第一句吧。</div>';
}

/* ---------------- 消息操作 ---------------- */

function showMenu(mid, anchor) {
  const m = msgs.find(x => x.id === mid);
  if (!m) return;
  m.mine = Number(m.fromId) === Number(me.id);
  const menu = $('#chatMenu');
  menu.dataset.mid = mid;
  menu.innerHTML = `
    ${m.mine && m.body && !m.recalled ? '<button data-act="edit">编辑</button>' : ''}
    ${m.mine && !m.recalled ? '<button data-act="recall">撤回</button>' : ''}
    <button data-act="delete" class="danger">删除</button>`;
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  menu.hidden = false;
}
const hideMenu = () => { $('#chatMenu').hidden = true; };

/**
 * 退出编辑状态。
 * 忘了退出会很难查：按钮还写着「保存」，之后打的字都会往一条
 * 已经撤回/删掉的消息上编辑，后端拒绝、内容被塞回输入框 ——
 * 用户看到的现象是「输入框卡住了，字打不进去」。
 */
function resetEditing() {
  editingId = null;
  $('#chatInput').value = '';
  $('#chatSend').textContent = '发送';
}

/** 点面板外面收起。草稿留着，下次打开原样还在 */
function closeFromOutside() {
  saveDraft();
  toggle(false);
}

async function act(kind, mid) {
  const m = msgs.find(x => x.id === mid);
  try {
    if (kind === 'edit') {
      editingId = mid;
      $('#chatInput').value = m.body || '';
      $('#chatSend').textContent = '保存';
      $('#chatInput').focus();
      return;
    }
    if (kind === 'recall') {
      const ok = await confirmAction({
        eyebrow: '双方都会看到',
        title: '撤回这条消息？',
        message: '消息内容会从双方的对话里消失。',
        note: '对方那边会留下一行「撤回了一条消息」，看得出你撤回过。',
        confirmLabel: '确认撤回',
      });
      if (!ok) return;
      await api.chatRecall(mid);
    }
    if (kind === 'delete') {
      const ok = await confirmAction({
        eyebrow: '只影响你自己',
        title: '从你这里删掉这条消息？',
        message: '这条消息只会从你的对话里消失。',
        note: '对方那边不受影响，仍然能看到它。要双方都看不到请用「撤回」。',
        confirmLabel: '确认删除',
      });
      if (!ok) return;
      await api.chatDelete(mid);
    }
    // 正在编辑的就是这一条的话，编辑状态必须跟着结束
    if (editingId === mid) resetEditing();
    await loadMsgs();
    refresh();
  } catch (e) { toast('info', e.message || '操作失败'); }
}

/* ---------------- @ 提示 ---------------- */

function paintAt(kw) {
  const box = $('#chatAt');
  const list = members.filter(u => Number(u.id) !== Number(me.id)
    && (!kw || u.name.includes(kw)));
  if (!list.length) { box.hidden = true; return; }
  box.innerHTML = list.map(u => `<button data-at="${esc(u.name)}">${esc(u.name)}</button>`).join('');
  box.hidden = false;
}

function onInput() {
  if (conv?.kind !== 'group') return;
  const inp = $('#chatInput');
  const upto = inp.value.slice(0, inp.selectionStart);
  // 只在光标前最近一个 @ 之后没有空格时才算「正在 @」
  const m = upto.match(/@([^\s@]*)$/);
  if (m) paintAt(m[1]); else $('#chatAt').hidden = true;
}

function insertAt(name) {
  const inp = $('#chatInput');
  const pos = inp.selectionStart;
  const before = inp.value.slice(0, pos).replace(/@[^\s@]*$/, '');
  inp.value = before + '@' + name + ' ' + inp.value.slice(pos);
  $('#chatAt').hidden = true;
  inp.focus();
}

/* ---------------- 交互 ---------------- */

export function toggle(force) {
  openPanel = force ?? !openPanel;
  $('#chatPanel').classList.toggle('on', openPanel);
  if (openPanel) { refresh(); paintList(); conv ? paintConv() : paintEmpty(); }
  else hideMenu();
}
export const close = () => { saveDraft(); toggle(false); };

/** 每个会话各自的草稿。切走再切回来、关掉面板再打开，打了一半的字都还在 */
const drafts = new Map();
const draftKey = c => c && `${c.kind}:${c.id}`;

function saveDraft() {
  if (!conv) return;
  const v = $('#chatInput')?.value || '';
  v.trim() ? drafts.set(draftKey(conv), v) : drafts.delete(draftKey(conv));
}

async function openConv(kind, id) {
  const list = kind === 'group' ? groups : peers;
  const c = list.find(x => x.id === id);
  if (!c) return;
  saveDraft();
  conv = { kind, id, name: c.name, createdBy: c.createdBy };
  resetEditing();
  members = [];
  if (kind === 'group') {
    try { members = (await api.chatGroupMembers(id)).items; } catch { /* 拿不到就不做 @ 提示 */ }
  }
  $('#chatInput').value = drafts.get(draftKey(conv)) || '';
  $('#chatPanel').classList.add('has-conv');    // 手机上靠它切到会话视图
  paintList();                                   // 重画左栏，让选中态跟上
  $('#chatMsgs').innerHTML = '<div class="dim" style="padding:16px">加载中…</div>';
  paintConv();
  await loadMsgs();
}

let tempSeq = 0;

/**
 * 发消息。
 *
 * 气泡先画上去再发请求 —— 原来是「发请求 → 等回来 → 整段重拉 → 再重拉会话列表」，
 * 三个来回之后字才出现，网络稍慢就像点了没反应。
 * 现在本地先渲染（半透明表示发送中），服务端回来了把临时那条替换掉；
 * 失败就把内容还给输入框并把临时气泡撤下。
 */
async function send() {
  const inp = $('#chatInput');
  const text = inp.value.trim();
  if (!text || !conv) return;
  inp.value = '';
  $('#chatAt').hidden = true;

  if (editingId) {
    const id = editingId;
    resetEditing();
    // 编辑也先改本地，看起来是立刻生效的
    const local = msgs.find(x => x.id === id);
    const old = local?.body;
    if (local) { local.body = text; local.edited = true; paintConv(); }
    try { await api.chatEdit(id, text); }
    catch (e) {
      if (local) { local.body = old; paintConv(); }
      toast('info', e.message || '保存失败');
    }
    return;
  }

  const tempId = 'tmp' + (++tempSeq);
  msgs.push({
    id: tempId, fromId: me.id, fromName: me.name || '我',
    body: text, file: null, mentions: [], recalled: false, edited: false,
    read: false, readBy: 0, createdAt: new Date().toISOString(), pending: true,
  });
  paintConv();
  scrollToEnd();

  try {
    const saved = await api.chatSend(conv.kind, conv.id, text);
    const i = msgs.findIndex(x => x.id === tempId);
    if (i >= 0) msgs[i] = saved;
    paintConv();
    scrollToEnd();
    bumpPreview(text);            // 左栏预览就地改，不用为一条消息重拉整个列表
  } catch (e) {
    msgs = msgs.filter(x => x.id !== tempId);
    paintConv();
    inp.value = text;             // 发失败把内容还给用户，别让他重打
    toast('info', e.message || '发送失败');
  }
}

/** 把左栏里当前这个会话的预览和排序就地更新掉 */
function bumpPreview(text) {
  const list = conv.kind === 'group' ? groups : peers;
  const it = list.find(x => x.id === conv.id);
  if (!it) return;
  it.lastText = text;
  it.lastAt = new Date().toISOString();
  it.lastMine = true;
  list.splice(list.indexOf(it), 1);
  list.unshift(it);
  paintList();
}

/* ---------------- 建群 / 拉人 ---------------- */
/* 原来是一个个 `confirm('把 XX 拉进群？')`，五个人还能忍，十个人就是灾难。
   改成一次勾完的弹窗。建群和拉人共用它，只差要不要填群名。 */

let picked = new Set();
let pickMode = 'create';        // create | invite

function paintPick(list) {
  $('#groupPick').innerHTML = list.length ? list.map(u => `
    <button class="pick${picked.has(u.id) ? ' on' : ''}" data-pick="${u.id}">
      <span class="box">${picked.has(u.id) ? ICON.check : ''}</span>
      <span class="av" style="background:${avatarColor(u.name)}">${esc(initial(u.name))}</span>
      <span><b>${esc(u.name)}</b>${u.dept ? `<span class="dim"> · ${esc(u.dept)}</span>` : ''}</span>
    </button>`).join('')
    : '<div class="dim" style="padding:12px">没有可选的人。</div>';
  $('#groupCount').textContent = `已选 ${picked.size} 人`;
}

function openPick(mode, list) {
  pickMode = mode;
  picked = new Set();
  $('#groupTitle').textContent = mode === 'create' ? '建群' : `拉人进「${conv.name}」`;
  $('#groupNameField').hidden = mode !== 'create';
  $('#groupName').value = '';
  paintPick(list);
  $('#mask').classList.add('on');
  $('#groupModal').classList.add('on');
}

export function closePick() {
  $('#groupModal').classList.remove('on');
  $('#mask').classList.remove('on');
}

async function confirmPick() {
  if (!picked.size) return toast('info', '至少勾一个人');
  const btn = $('#groupOk');
  btn.disabled = true;
  try {
    if (pickMode === 'create') {
      const name = $('#groupName').value.trim();
      if (!name) { toast('info', '给群起个名字'); return; }
      await api.chatGroupCreate(name, [...picked]);
      toast('ok', '群建好了');
      closePick();
      conv = null;
      await refresh();
      paintList();
    } else {
      await api.chatGroupInvite(conv.id, [...picked]);
      members = (await api.chatGroupMembers(conv.id)).items;
      toast('ok', `已拉 ${picked.size} 人进群`);
      closePick();
      refresh();
    }
  } catch (e) {
    toast('info', e.message || '操作失败');
  } finally {
    btn.disabled = false;
  }
}

export function bind() {
  $('#chatBtn').addEventListener('click', () => toggle());
  $('#chatClose').addEventListener('click', () => close());
  $('#chatSideClose').addEventListener('click', () => close());

  // 点面板以外的地方就收起。之前刻意没做这条，理由是「关掉正在打的字很烦」——
  // 现在草稿会留着，那个理由不成立了，而点外面关掉才是大家对浮层的预期。
  document.addEventListener('mousedown', e => {
    if (!openPanel) return;
    if (e.target.closest('#chatPanel') || e.target.closest('#chatBtn')) return;
    // 建群弹窗、消息菜单是聊天的一部分，点它们不算点外面
    if (e.target.closest('#groupModal') || e.target.closest('#chatMenu')) return;
    closeFromOutside();
  });
  // 「返回」只在手机的单栏模式下出现，桌面双栏用不上它
  $('#chatBack').addEventListener('click', () => {
    conv = null; resetEditing();
    $('#chatPanel').classList.remove('has-conv');
    paintList(); paintEmpty();
  });
  $('#chatNewGroup').addEventListener('click', () => openPick('create', peers));

  $('#chatMembers').addEventListener('click', () => {
    if (conv?.kind !== 'group') return;
    const outside = peers.filter(p => !members.some(m => Number(m.id) === Number(p.id)));
    if (!outside.length) {
      return toast('info', `群成员：${members.map(m => m.name).join('、')}`);
    }
    openPick('invite', outside);
  });

  $('#groupPick').addEventListener('click', e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const id = Number(b.dataset.pick);
    picked.has(id) ? picked.delete(id) : picked.add(id);
    // 重画整份而不是只改这一行：列表很短，省下的复杂度比省下的重绘值钱
    paintPick(pickMode === 'create'
      ? peers
      : peers.filter(p => !members.some(m => Number(m.id) === Number(p.id))));
  });
  $('#groupOk').addEventListener('click', confirmPick);

  $('#chatGroupDel').addEventListener('click', async () => {
    if (conv?.kind !== 'group') return;
    const ok = await confirmAction({
      eyebrow: '不可恢复操作',
      title: `解散「${conv.name}」？`,
      message: '群里的聊天记录和文件会一起删掉，所有成员都将看不到。',
      note: '这一步无法撤销，也没有任何人能恢复。',
      confirmLabel: '确认解散',
    });
    if (!ok) return;
    try {
      await api.chatGroupDelete(conv.id);
      toast('ok', '群已解散');
      conv = null;
      $('#chatPanel').classList.remove('has-conv');
      await refresh();
      paintList(); paintEmpty();
    } catch (e) { toast('info', e.message || '解散失败'); }
  });

  $('#chatList').addEventListener('click', e => {
    const b = e.target.closest('[data-kind]');
    if (b) openConv(b.dataset.kind, Number(b.dataset.id));
  });

  $('#chatMsgs').addEventListener('click', e => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); showMenu(Number(more.dataset.more), more); }
  });

  $('#chatMenu').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const mid = Number($('#chatMenu').dataset.mid);
    hideMenu();
    act(btn.dataset.act, mid);
  });
  document.addEventListener('click', e => {
    if (!$('#chatMenu').hidden && !e.target.closest('#chatMenu')) hideMenu();
  });

  $('#chatAt').addEventListener('click', e => {
    const b = e.target.closest('[data-at]');
    if (b) insertAt(b.dataset.at);
  });

  $('#chatSend').addEventListener('click', send);
  $('#chatInput').addEventListener('input', onInput);
  $('#chatInput').addEventListener('keydown', e => {
    // Enter 发送、Shift+Enter 换行 —— 聊天窗里这是肌肉记忆
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && editingId) resetEditing();
  });

  $('#chatFile').addEventListener('change', async e => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || !conv) return;
    for (const f of files) {
      try { await api.chatSendFile(conv.kind, conv.id, f); }
      catch (err) { toast('info', `${f.name}：${err.message || '发送失败'}`); }
    }
    await loadMsgs();
    scrollToEnd();
    refresh();
  });
}
