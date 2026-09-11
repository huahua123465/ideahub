/**
 * 报销审批。
 *
 * 一页三件事：申请人发起 / 跟进自己的报销，审批人处理轮到自己的单子，管理员配置审批人。
 * 页面的主角是每张单上那条四段进度条（部门负责人 → 总经理 → 财务 → 出纳）——
 * 申请人最想知道的就是「卡在谁那儿了」，审批人一眼能看出前面谁批过。
 *
 * 权限全部以后端返回的 can.* 为准，这里只决定按钮画不画；规则见 server/src/routes/expenses.mjs。
 *
 * 页面骨架（标题、标签栏、内容区）只搭一次：标签栏由 motion.js 统一增强成可键盘切换的 tablist，
 * 整块重绘会把那层增强冲掉。之后切标签、推送刷新都只换 .bd-body 里的内容。
 */
import { api } from '../api.js';
import { $, esc, fromNow } from '../util.js';
import { toast } from '../toast.js';
import { ICON } from '../icons.js';
import { confirmAction } from '../confirm.js';

const TABS = [
  { key: 'todo', label: '待我处理' },
  { key: 'mine', label: '我发起的' },
  { key: 'all', label: '全部' },
];
const EMPTY = {
  todo: ['没有等你处理的报销单', '轮到你审批或打款时，这里和右上角的消息都会提醒你。'],
  mine: ['你还没有发起过报销', '点右上角「发起报销」，填好信息、传上凭证就能提交。'],
  all: ['还没有你能看到的报销单', '你发起的、经手过的，以及你负责审批的报销单都会出现在这里。'],
};
const MAX_FILE = 20 * 1024 * 1024;

let me = { id: 0, role: 'member' };
export const setMe = u => { me = u; };

const state = {
  tab: null,          // 第一次进来时按有没有待办决定
  items: [],
  todoCount: 0,
  config: null,
  loaded: false,
};
let listSeq = 0;
let detailSeq = 0;
let detail = null;           // 详情弹窗里正在看的那张单
let editing = null;          // 编辑弹窗：null = 新建，否则是那张单的详情
let pendingFiles = [];       // 编辑弹窗里选了、还没传上去的文件
let busy = false;

/* ================= 小工具 ================= */

const money = v => Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sizeOf = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const timeText = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const statusTone = c => ({ draft: 'draft', pending: 'pending', returned: 'returned', paid: 'paid', cancelled: 'cancelled' }[c.status]);

function flowHtml(c, { compact = false } = {}) {
  const note = { done: '已通过', skipped: '已跳过', returned: '已退回', current: '处理中', waiting: '' };
  return `<ol class="exp-flow${compact ? ' compact' : ''}" aria-label="审批进度">
    ${c.flow.map(s => `<li class="is-${s.state}">
      <i aria-hidden="true"></i>
      <span class="exp-flow-label">${esc(s.label)}</span>
      <small>${esc(s.handler?.name || '未设置')}${note[s.state] ? `<em> · ${note[s.state]}</em>` : ''}</small>
    </li>`).join('')}
  </ol>`;
}

/* ================= 列表页 ================= */

function build(root) {
  root.dataset.built = '1';
  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-kicker">团队协作</div>
        <h1>报销审批</h1>
        <div class="sub">提交后依次由部门负责人、总经理、财务审批，最后由出纳打款。每一步都会通知到人。</div>
      </div>
    </div>
    <div class="exp-setup" hidden></div>
    <div class="board-toolbar exp-toolbar">
      <div class="bd-tabs" role="tablist" aria-label="报销单分类">
        ${TABS.map(t => `<button class="bd-tab" type="button" data-exp-tab="${t.key}">${t.label}<span class="exp-tab-n" data-exp-tab-n="${t.key}"></span></button>`).join('')}
      </div>
      <div class="spacer"></div>
      <span class="bd-n"><b class="exp-count">0</b> 张</span>
      ${me.role === 'admin' ? '<button class="board-tool exp-config-btn" type="button">审批设置</button>' : ''}
    </div>
    <div class="bd-body exp-body" aria-live="polite"></div>`;

  root.querySelector('.bd-tabs').addEventListener('click', e => {
    const t = e.target.closest('[data-exp-tab]');
    if (!t || t.dataset.expTab === state.tab) return;
    state.tab = t.dataset.expTab;
    paintTabs(root);
    loadList({ skeleton: true });
  });
  root.querySelector('.exp-config-btn')?.addEventListener('click', openConfig);
  root.addEventListener('click', e => {
    const open = e.target.closest('[data-exp-open]');
    if (open) return openDetail(Number(open.dataset.expOpen));
    if (e.target.closest('[data-exp-create]')) return openCreate();
    if (e.target.closest('[data-exp-config]')) return openConfig();
    if (e.target.closest('[data-exp-retry]')) return loadList({ skeleton: true });
  });
}

function paintTabs(root) {
  for (const b of root.querySelectorAll('[data-exp-tab]')) {
    const on = b.dataset.expTab === state.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const n = root.querySelector('[data-exp-tab-n="todo"]');
  if (n) n.textContent = state.todoCount ? ` ${state.todoCount}` : '';
}

function paintSetup(root) {
  const box = root.querySelector('.exp-setup');
  const cfg = state.config;
  if (!cfg || cfg.ready) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const missing = cfg.missing.join('、');
  box.innerHTML = me.role === 'admin'
    ? `<div class="exp-callout warn"><b>审批流程还没配置完整</b><span>还缺：${esc(missing)}。配置好之前，大家可以先填草稿，但提交不了。</span><button class="btn btn-primary btn-mini" type="button" data-exp-config>去设置</button></div>`
    : `<div class="exp-callout warn"><b>审批流程还没配置完整</b><span>还缺：${esc(missing)}。可以先填草稿，提交需要等管理员在「审批设置」里补上。</span></div>`;
}

function cardHtml(c) {
  const mine = c.applicant?.id === me.id;
  return `<article class="exp-card tone-${statusTone(c)}">
    <header>
      <span class="exp-code">${esc(c.code)}</span>
      <span class="exp-cat">${esc(c.categoryLabel)}</span>
      <span class="exp-status s-${statusTone(c)}">${esc(c.statusLabel)}</span>
    </header>
    <h3><button type="button" class="exp-open" data-exp-open="${c.id}">${esc(c.title)}</button></h3>
    <div class="exp-card-amount"><small>¥</small>${money(c.amount)}</div>
    <div class="exp-card-meta">
      <span>${esc(mine ? '我' : c.applicant?.name || '')} · ${esc(c.dept)}</span>
      <span>${esc(c.expenseDate)}</span>
      <span class="exp-clip" title="${c.fileCount} 个附件">${ICON.clip}${c.fileCount}</span>
    </div>
    ${c.status === 'returned' && c.returnReason
      ? `<div class="exp-callout warn slim"><b>${esc(c.returnReason.stageLabel)}退回</b><span>${esc(c.returnReason.comment)}</span></div>`
      : ''}
    ${c.status === 'draft' ? '<div class="exp-card-hint">草稿，还没提交</div>'
      : c.status === 'cancelled' ? '<div class="exp-card-hint">已作废</div>' : flowHtml(c, { compact: true })}
  </article>`;
}

function paintList(root) {
  const body = root.querySelector('.exp-body');
  body.removeAttribute('aria-busy');
  root.querySelector('.exp-count').textContent = state.items.length;
  if (!state.items.length) {
    const [title, text] = EMPTY[state.tab];
    const canCreate = state.tab === 'mine' && state.config?.depts.length;
    body.innerHTML = `<div class="board-empty"><div class="empty">
      <b>${title}</b><span>${text}</span>
      ${canCreate ? '<button class="btn btn-primary" type="button" data-exp-create>发起报销</button>' : ''}
    </div></div>`;
    return;
  }
  body.innerHTML = `<div class="exp-grid">${state.items.map(cardHtml).join('')}</div>`;
}

function paintBadge() {
  const b = $('#expenseN');
  if (!b) return;
  b.textContent = state.todoCount;
  b.classList.toggle('is-empty', !state.todoCount);
}

async function loadList({ skeleton = false } = {}) {
  const root = $('#v-expenses');
  const own = ++listSeq;
  const tab = state.tab;
  const body = root.querySelector('.exp-body');
  if (skeleton) {
    root.querySelector('.exp-count').textContent = '…';
    body.setAttribute('aria-busy', 'true');
    body.innerHTML = '<div class="exp-state" role="status">正在读取报销单…</div>';
  }
  try {
    const [list, config] = await Promise.all([api.expenses({ scope: tab }), api.expenseConfig()]);
    if (own !== listSeq || tab !== state.tab) return;
    state.items = list.items;
    state.todoCount = list.todoCount;
    state.config = config;
    paintTabs(root);
    paintSetup(root);
    paintList(root);
    paintBadge();
  } catch (e) {
    if (own !== listSeq || e.message === '请先登录') return;
    body.removeAttribute('aria-busy');
    // 已经有内容顶着的话，后台刷新失败不打扰人
    if (!skeleton && state.items.length) return;
    body.innerHTML = `<div class="exp-state error" role="alert">报销单读取失败：${esc(e.message || '网络异常')}
      <button class="btn btn-ghost btn-mini" type="button" data-exp-retry>重试</button></div>`;
  }
}

export async function render() {
  const root = $('#v-expenses');
  if (!root.dataset.built) build(root);
  if (!state.tab) {
    // 第一次进来：有待办先看待办，否则看自己发起的
    try {
      const todo = await api.expenses({ scope: 'todo' });
      state.todoCount = todo.todoCount;
      state.tab = todo.todoCount ? 'todo' : 'mine';
    } catch { state.tab = 'mine'; }
  }
  paintTabs(root);
  await loadList({ skeleton: !state.loaded });
  state.loaded = true;
}

/** 导航上的待办数字。启动时、有推送时调 */
export async function refreshBadge() {
  try {
    const r = await api.expenses({ scope: 'todo' });
    state.todoCount = r.todoCount;
    paintBadge();
    const root = $('#v-expenses');
    if (root?.dataset.built) paintTabs(root);
  } catch { /* 数字晚点更新没关系 */ }
}

/** 推送来了：刷新徽标；页面开着就静默刷新列表；详情开着且没在打字就刷新详情 */
export async function refresh(view) {
  if (view !== 'expenses') return refreshBadge();
  if (!state.loaded) return;
  await loadList();
  if (detail && $('#expDetailModal').classList.contains('on') && !detailBusy()) {
    await openDetail(detail.id, { quiet: true });
  }
}

/* ================= 详情 ================= */

function detailBusy() {
  const box = $('#expActComment');
  return busy || (box && (box.value.trim() || box === document.activeElement));
}

function fileItemHtml(f, deletable) {
  const kind = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return `<li class="exp-file">
    <i aria-hidden="true">${esc(kind)}</i>
    <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>
    <small>${f.side === 'review' ? '打款凭证 · ' : ''}${esc(f.uploaderName || '')} · ${sizeOf(f.size)}</small>
    ${deletable ? `<button type="button" class="exp-file-del" data-exp-file-del="${f.id}" aria-label="删除附件 ${esc(f.name)}">×</button>` : ''}
  </li>`;
}

function paintDetail(c) {
  $('#expDetailCode').textContent = `${c.code} · ${c.categoryLabel}`;
  $('#expDetailTitle').textContent = c.title;
  const canAct = c.can.approve || c.can.return || c.can.pay;
  // 附件能删的前提：单子处在我能改附件的状态，且是我这一侧传的（申请人删凭证 / 出纳删打款截图）
  const mySide = c.can.edit ? 'submit' : c.can.pay ? 'review' : null;
  const timeline = c.actions.slice().reverse();

  $('#expDetailBody').innerHTML = `
    <div class="exp-summary">
      <div class="exp-amount"><small>报销金额</small><b>¥${money(c.amount)}</b></div>
      <span class="exp-status s-${statusTone(c)}">${esc(c.statusLabel)}</span>
    </div>
    ${c.status === 'returned' && c.returnReason ? `<div class="exp-callout warn">
      <b>${esc(c.returnReason.stageLabel)}（${esc(c.returnReason.by?.name || '')}）退回</b>
      <span>${esc(c.returnReason.comment)}</span></div>` : ''}
    <dl class="exp-fields">
      <div><dt>申请人</dt><dd>${esc(c.applicant?.name || '')}</dd></div>
      <div><dt>部门</dt><dd>${esc(c.dept)}</dd></div>
      <div><dt>报销类型</dt><dd>${esc(c.categoryLabel)}</dd></div>
      <div><dt>发生日期</dt><dd>${esc(c.expenseDate)}</dd></div>
      ${c.submittedAt ? `<div><dt>提交时间</dt><dd>${esc(timeText(c.submittedAt))}</dd></div>` : ''}
      ${c.paidAt ? `<div><dt>打款时间</dt><dd>${esc(timeText(c.paidAt))}</dd></div>` : ''}
      ${c.note ? `<div class="wide"><dt>备注</dt><dd>${esc(c.note)}</dd></div>` : ''}
    </dl>
    ${c.status === 'draft' || c.status === 'cancelled' ? '' : `<section class="exp-sec">
      <h3>审批进度${c.round > 1 ? `<small>第 ${c.round} 次提交</small>` : ''}</h3>
      ${flowHtml(c)}
    </section>`}
    <section class="exp-sec">
      <h3>凭证与附件<small>${c.files.length} 个</small></h3>
      ${c.files.length
        ? `<ul class="exp-files">${c.files.map(f => fileItemHtml(f, mySide && f.side === mySide)).join('')}</ul>`
        : '<div class="exp-muted">还没有附件。提交前至少要传一份凭证或支付截图。</div>'}
      ${c.can.upload ? `<label class="idea-file-picker exp-file-picker slim">
        <input type="file" id="expDetailUpload" multiple accept="image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx">
        <b>${c.can.pay ? '上传打款截图' : '补充附件'}</b><span>单个不超过 20MB</span></label>` : ''}
    </section>
    ${canAct ? `<section class="exp-sec exp-act">
      <label for="expActComment">${c.can.pay ? '打款备注' : '审批意见'} <span class="opt">通过时选填，退回时必填</span></label>
      <textarea class="inp" id="expActComment" maxlength="1000" placeholder="${c.can.pay ? '比如：已通过银行转账' : '写给申请人和后面审批人看的话'}"></textarea>
    </section>` : ''}
    ${timeline.length ? `<section class="exp-sec">
      <h3>审批记录</h3>
      <ol class="exp-timeline">${timeline.map(a => `<li class="a-${esc(a.action)}">
        <div><b>${esc(a.actor?.name || '系统')}</b> ${esc(a.actionLabel)}${a.stageLabel ? `<span>（${esc(a.stageLabel)}）</span>` : ''}</div>
        ${a.comment ? `<p>${esc(a.comment)}</p>` : ''}
        <time datetime="${esc(a.createdAt)}" title="${esc(timeText(a.createdAt))}">${esc(fromNow(a.createdAt))}</time>
      </li>`).join('')}</ol>
    </section>` : ''}
    <div class="exp-error" id="expDetailErr" role="alert" aria-live="polite"></div>`;

  const btn = (id, cls, label) => `<button class="btn ${cls}" type="button" id="${id}">${label}</button>`;
  $('#expDetailFoot').innerHTML = [
    c.can.remove ? btn('btnExpDRemove', 'btn-crit', '删除草稿') : '',
    c.can.cancel ? btn('btnExpDCancel', 'btn-crit', '作废') : '',
    c.can.return ? btn('btnExpDReturn', 'btn-crit', '退回') : '',
    '<div class="spacer"></div>',
    c.can.edit ? btn('btnExpDEdit', 'btn-ghost', '修改') : '',
    c.can.submit ? btn('btnExpDSubmit', 'btn-primary', c.status === 'returned' ? '重新提交' : '提交审批') : '',
    c.can.approve ? btn('btnExpDApprove', 'btn-primary', '同意') : '',
    c.can.pay ? btn('btnExpDPay', 'btn-primary', '确认已打款') : '',
    !(c.can.edit || c.can.approve || c.can.pay) ? '<button class="btn btn-ghost" type="button" data-close>关闭</button>' : '',
  ].join('');
}

export async function openDetail(id, { quiet = false } = {}) {
  const own = ++detailSeq;
  if (!quiet) {
    closeModals();
    detail = null;
    $('#expDetailCode').textContent = '';
    $('#expDetailTitle').textContent = '报销单';
    $('#expDetailBody').innerHTML = '<div class="exp-state" role="status">正在读取报销单…</div>';
    $('#expDetailFoot').innerHTML = '<div class="spacer"></div><button class="btn btn-ghost" type="button" data-close>关闭</button>';
    $('#expDetailModal').classList.add('on');
    $('#mask').classList.add('on');
  }
  try {
    const c = await api.expense(id);
    if (own !== detailSeq) return;
    detail = c;
    paintDetail(c);
  } catch (e) {
    if (own !== detailSeq || e.message === '请先登录') return;
    if (quiet) return;
    $('#expDetailBody').innerHTML = `<div class="exp-state error" role="alert">${esc(
      e.status === 404 ? '这张报销单不存在，或者你没有查看权限。' : `读取失败：${e.message || '网络异常'}`)}</div>`;
  }
}

/** 报错区都在可滚动内容的底部：出错时滚过去，否则手机上看起来就是「点了没反应」 */
function showError(box, msg) {
  if (!box) return;
  box.textContent = msg;
  box.classList.toggle('on', !!msg);
  if (msg) box.scrollIntoView({ block: 'nearest' });
}

function detailError(msg) {
  showError($('#expDetailErr'), msg);
}

/** 详情里所有会改状态的动作都走这里：锁按钮、报错不关窗、409 时拉最新 */
async function act(button, fn, okMsg, busyText = '正在处理…') {
  if (busy || !detail) return;
  busy = true;
  const buttons = [...$('#expDetailFoot').querySelectorAll('button')];
  const original = button.textContent;
  buttons.forEach(b => { b.disabled = true; });
  button.textContent = busyText;
  detailError('');
  try {
    const out = await fn();
    toast('ok', okMsg);
    busy = false;
    if (out === 'closed') closeModals();
    else if (out) { detail = out; paintDetail(out); }
    loadListIfOpen();
    refreshBadge();
  } catch (e) {
    busy = false;
    buttons.forEach(b => { b.disabled = false; });
    button.textContent = original;
    if (e.status === 409) {
      toast('info', e.message);
      await openDetail(detail.id, { quiet: true });
      return;
    }
    detailError(e.message || '操作失败，请重试');
  }
}

function loadListIfOpen() {
  if ($('#v-expenses')?.classList.contains('on') && state.loaded) loadList();
}

const comment = () => $('#expActComment')?.value.trim() || '';

function bindDetail() {
  $('#expDetailFoot').addEventListener('click', async e => {
    const b = e.target.closest('button[id]');
    if (!b || !detail) return;
    const c = detail;
    if (b.id === 'btnExpDApprove') {
      return act(b, () => api.expenseAct(c.id, 'approve', { stage: c.stage, comment: comment() }), '已同意，流转到下一步', '正在同意…');
    }
    if (b.id === 'btnExpDReturn') {
      if (!comment()) { detailError('退回请写明原因，申请人会看到'); $('#expActComment')?.focus(); return; }
      return act(b, () => api.expenseAct(c.id, 'return', { stage: c.stage, comment: comment() }), '已退回给申请人', '正在退回…');
    }
    if (b.id === 'btnExpDPay') {
      const ok = await confirmAction({
        eyebrow: '确认打款', title: `确认已向${c.applicant?.name || '申请人'}打款 ¥${money(c.amount)}？`,
        message: '确认后报销单标记为已打款，申请人会收到通知，这一步不能撤销。', confirmLabel: '确认已打款',
      });
      if (!ok) return;
      return act(b, () => api.expenseAct(c.id, 'pay', { stage: c.stage, comment: comment() }), '已确认打款', '正在确认…');
    }
    if (b.id === 'btnExpDSubmit') {
      return act(b, () => api.expenseAct(c.id, 'submit'), '已提交，等待审批', '正在提交…');
    }
    if (b.id === 'btnExpDEdit') return openEdit(c);
    if (b.id === 'btnExpDRemove') {
      const ok = await confirmAction({
        eyebrow: '删除草稿', title: '删除这张报销草稿？', message: '草稿和已经传上的附件会一起删除。', confirmLabel: '删除',
      });
      if (!ok) return;
      return act(b, async () => { await api.expenseDelete(c.id); return 'closed'; }, '草稿已删除', '正在删除…');
    }
    if (b.id === 'btnExpDCancel') {
      const ok = await confirmAction({
        eyebrow: '作废报销单', title: '作废这张报销单？', message: '作废后不能再提交，审批记录会保留。', confirmLabel: '作废',
      });
      if (!ok) return;
      return act(b, () => api.expenseAct(c.id, 'cancel'), '报销单已作废', '正在作废…');
    }
  });

  $('#expDetailBody').addEventListener('change', async e => {
    if (e.target.id !== 'expDetailUpload' || !detail) return;
    const files = [...e.target.files];
    e.target.value = '';
    await uploadAll(detail.id, files, detailError);
    await openDetail(detail.id, { quiet: true });
    loadListIfOpen();
  });
  $('#expDetailBody').addEventListener('click', async e => {
    const del = e.target.closest('[data-exp-file-del]');
    if (!del || !detail) return;
    del.disabled = true;
    try {
      await api.fileDelete(Number(del.dataset.expFileDel));
      await openDetail(detail.id, { quiet: true });
      loadListIfOpen();
    } catch (err) {
      del.disabled = false;
      detailError(err.message || '删除失败');
    }
  });
}

/** 逐个上传，返回没传上的；失败原因写到 onError */
async function uploadAll(id, files, onError) {
  const failed = [];
  for (const f of files) {
    if (f.size > MAX_FILE) { failed.push(`${f.name}：超过 20MB`); continue; }
    try { await api.expenseUpload(id, f); }
    catch (e) { failed.push(`${f.name}：${e.message || '上传失败'}`); }
  }
  onError(failed.length ? `有 ${failed.length} 个附件没传上 —— ${failed.join('；')}` : '');
  return failed;
}

/* ================= 发起 / 修改 ================= */

async function ensureConfig() {
  if (state.config) return state.config;
  state.config = await api.expenseConfig();
  return state.config;
}

function editError(msg) {
  showError($('#expEditErr'), msg);
}

function paintEditFiles() {
  const existing = editing?.files || [];
  $('#expEditFiles').innerHTML = [
    ...existing.filter(f => f.side === 'submit').map(f => `<div class="idea-pending-file">
      <i>${esc((f.name.split('.').pop() || '').slice(0, 4).toUpperCase())}</i><span>${esc(f.name)}</span>
      <small>已上传 · ${sizeOf(f.size)}</small>
      <button type="button" data-exp-existing-del="${f.id}" aria-label="删除附件 ${esc(f.name)}">×</button></div>`),
    ...pendingFiles.map((f, i) => `<div class="idea-pending-file">
      <i>${esc((f.name.split('.').pop() || '').slice(0, 4).toUpperCase())}</i><span>${esc(f.name)}</span>
      <small>${f.size > MAX_FILE ? '超过 20MB' : `待上传 · ${sizeOf(f.size)}`}</small>
      <button type="button" data-exp-pending-del="${i}" aria-label="移除 ${esc(f.name)}">×</button></div>`),
  ].join('');
}

function fillOptions(cfg, c) {
  // 部门只读：取管理员分配的部门，提交时后端也按这一刻的分配走（不是单子上次存的部门）
  $('#expDept').value = me.dept || '未分配部门';
  const note = $('#expEditDeptNote');
  const ready = cfg.depts.some(d => d.dept === me.dept);
  note.hidden = ready;
  note.innerHTML = ready ? '' : `<b>「${esc(me.dept)}」还没有设置部门负责人</b><span>可以先存草稿，提交需要管理员在「审批设置」里给这个部门选负责人。</span>`;
  $('#expCategory').innerHTML = `<option value="">请选择类型</option>${cfg.categories.map(k =>
    `<option value="${k.key}"${k.key === c?.category ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}`;
}

export async function openCreate() {
  // 报销单送给哪个部门负责人，取决于管理员给你分的部门；没分就没法发起
  if (!me.dept) {
    toast('info', me.role === 'admin'
      ? '先在头像菜单「用户管理」里给自己分配部门，才能发起报销'
      : '你还没有被分配部门，请联系管理员在「用户管理」里设置');
    return;
  }
  let cfg;
  try { cfg = state.config = await api.expenseConfig(); }
  catch (e) { toast('info', e.message || '读取报销设置失败'); return; }
  openEditor(null, cfg);
}

async function openEdit(c) {
  let cfg;
  try { cfg = await ensureConfig(); }
  catch (e) { toast('info', e.message || '读取报销设置失败'); return; }
  openEditor(c, cfg);
}

function openEditor(c, cfg) {
  closeModals();
  editing = c;
  pendingFiles = [];
  fillOptions(cfg, c);
  $('#expEditTitle').textContent = c ? `修改报销单 · ${c.code}` : '发起报销';
  $('#expTitle').value = c?.title || '';
  $('#expDate').value = c?.expenseDate || today();
  $('#expDate').max = today();
  $('#expAmount').value = c?.amount || '';
  $('#expNote').value = c?.note || '';
  const ret = $('#expEditReturn');
  ret.hidden = !(c?.status === 'returned' && c.returnReason);
  ret.innerHTML = ret.hidden ? '' : `<b>${esc(c.returnReason.stageLabel)}退回：</b><span>${esc(c.returnReason.comment)}</span>`;
  $('#btnExpDelete').hidden = !c?.can.remove;
  $('#btnExpSubmit').textContent = c?.status === 'returned' ? '重新提交' : '提交审批';
  editError('');
  paintEditFiles();
  $('#expEditModal').classList.add('on');
  $('#mask').classList.add('on');
}

function readForm() {
  const payload = {
    category: $('#expCategory').value,
    title: $('#expTitle').value.trim(),
    expenseDate: $('#expDate').value,
    amount: $('#expAmount').value.trim(),
    note: $('#expNote').value.trim(),
  };
  const missing = [
    [!payload.category, '报销类型', '#expCategory'],
    [!payload.title, '报销事项', '#expTitle'], [!payload.expenseDate, '发生日期', '#expDate'],
    [!payload.amount, '金额', '#expAmount'],
  ].filter(x => x[0]);
  if (missing.length) {
    editError(`还没填：${missing.map(x => x[1]).join('、')}`);
    $(missing[0][2]).focus();
    return null;
  }
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(payload.amount.replace(/,/g, '')) || Number(payload.amount.replace(/,/g, '')) <= 0) {
    editError('金额填数字，大于 0，最多两位小数');
    $('#expAmount').focus();
    return null;
  }
  return payload;
}

async function saveEditor(submit) {
  if (busy) return;
  const payload = readForm();
  if (!payload) return;
  const btn = submit ? $('#btnExpSubmit') : $('#btnExpSaveDraft');
  const original = btn.textContent;
  const buttons = [$('#btnExpSubmit'), $('#btnExpSaveDraft'), $('#btnExpDelete')];
  busy = true;
  buttons.forEach(b => { b.disabled = true; });
  btn.textContent = submit ? '正在提交…' : '正在保存…';
  editError('');
  try {
    const saved = editing ? await api.expensePatch(editing.id, payload) : await api.expenseCreate(payload);
    // 先记下来：后面附件或提交失败时，再点一次是改这张，不会重复建单
    editing = saved;
    const files = pendingFiles.filter(f => f.size <= MAX_FILE);
    const failed = await uploadAll(saved.id, files, editError);
    pendingFiles = pendingFiles.filter(f => f.size > MAX_FILE || failed.some(m => m.startsWith(`${f.name}：`)));
    const fresh = await api.expense(saved.id);
    editing = fresh;
    paintEditFiles();
    if (failed.length) {
      $('#btnExpDelete').hidden = !fresh.can.remove;
      return;   // 错误已经写在弹窗里，草稿已保存，用户可以重试
    }
    if (submit) {
      await api.expenseAct(saved.id, 'submit');
      toast('ok', '已提交，等待部门负责人审批');
    } else {
      toast('ok', '草稿已保存');
    }
    closeModals();
    state.tab = 'mine';
    if ($('#v-expenses').classList.contains('on')) { paintTabs($('#v-expenses')); loadList({ skeleton: true }); }
    refreshBadge();
  } catch (e) {
    editError(e.message || '保存失败，请重试');
    if (editing) $('#btnExpDelete').hidden = !editing.can?.remove;
  } finally {
    busy = false;
    buttons.forEach(b => { b.disabled = false; });
    btn.textContent = original;
  }
}

function bindEditor() {
  $('#expFiles').addEventListener('change', e => {
    pendingFiles.push(...e.target.files);
    e.target.value = '';
    paintEditFiles();
  });
  $('#expEditFiles').addEventListener('click', async e => {
    const p = e.target.closest('[data-exp-pending-del]');
    if (p) { pendingFiles.splice(Number(p.dataset.expPendingDel), 1); paintEditFiles(); return; }
    const x = e.target.closest('[data-exp-existing-del]');
    if (!x || !editing) return;
    x.disabled = true;
    try {
      await api.fileDelete(Number(x.dataset.expExistingDel));
      editing = await api.expense(editing.id);
      paintEditFiles();
    } catch (err) {
      x.disabled = false;
      editError(err.message || '删除失败');
    }
  });
  $('#btnExpSaveDraft').addEventListener('click', () => saveEditor(false));
  $('#btnExpSubmit').addEventListener('click', () => saveEditor(true));
  $('#btnExpDelete').addEventListener('click', async () => {
    if (!editing?.can.remove || busy) return;
    const ok = await confirmAction({
      eyebrow: '删除草稿', title: '删除这张报销草稿？', message: '草稿和已经传上的附件会一起删除。', confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await api.expenseDelete(editing.id);
      toast('ok', '草稿已删除');
      closeModals();
      loadListIfOpen();
    } catch (e) { editError(e.message || '删除失败'); }
  });
}

/* ================= 审批设置（管理员） ================= */

let people = [];
/** 公司现有的部门。设置里总会列出这几行，管理员只需要给每个部门选负责人；
    没选负责人的部门先不启用，可以分几次配完。以后有新部门用「添加部门」补。 */
export const DEFAULT_DEPTS = ['运营部', '财务部', '行政部'];

function cfgRowHtml(d = { dept: '', leader: null }) {
  return `<div class="exp-cfg-row">
    <input class="inp" maxlength="40" aria-label="部门名称" placeholder="部门名称" value="${esc(d.dept)}" data-cfg-dept>
    <select class="inp" aria-label="${esc(d.dept || '这个部门')}的负责人" data-cfg-leader>${personOptions(d.leader?.id, '选择部门负责人')}</select>
    <button type="button" class="exp-cfg-del" aria-label="删除部门 ${esc(d.dept)}" data-cfg-del>×</button>
  </div>`;
}

function personOptions(selected, placeholder) {
  const list = people.slice();
  if (selected && !list.some(p => p.id === selected)) list.unshift({ id: selected, name: `（账号 ${selected}）` });
  return `<option value="">${placeholder}</option>${list.map(p =>
    `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}${p.dept ? ` · ${esc(p.dept)}` : ''}</option>`).join('')}`;
}

function cfgError(msg) {
  showError($('#expCfgErr'), msg);
}

export async function openConfig() {
  if (me.role !== 'admin') return;
  closeModals();
  cfgError('');
  $('#expCfgDepts').innerHTML = '<div class="exp-state" role="status">正在读取…</div>';
  $('#expConfigModal').classList.add('on');
  $('#mask').classList.add('on');
  try {
    const [cfg, users] = await Promise.all([api.expenseConfig(), api.people()]);
    state.config = cfg;
    people = users.items || [];
    const stats = $('#expCfgStats');
    const members = cfg.deptMembers || {};
    const assigned = Object.entries(members).map(([d, n]) => `${esc(d)} ${n} 人`).join('、');
    stats.hidden = !cfg.deptMembers;
    stats.innerHTML = `报销单按申请人所在部门送审。${assigned ? `已分配：${assigned}。` : ''}${cfg.unassigned
      ? `<b>还有 ${cfg.unassigned} 人没分配部门</b>，他们暂时不能发起报销，在头像菜单「用户管理」里设置。`
      : '所有人都已分配部门。'}`;
    const rows = [...cfg.depts, ...DEFAULT_DEPTS
      .filter(dept => !cfg.depts.some(d => d.dept === dept)).map(dept => ({ dept, leader: null }))];
    $('#expCfgDepts').innerHTML = rows.map(cfgRowHtml).join('');
    $('#expCfgGm').innerHTML = personOptions(cfg.roles.gm?.id, '选择总经理');
    $('#expCfgFinance').innerHTML = personOptions(cfg.roles.finance?.id, '选择财务');
    $('#expCfgCashier').innerHTML = personOptions(cfg.roles.cashier?.id, '选择出纳');
  } catch (e) {
    $('#expCfgDepts').innerHTML = '';
    cfgError(`读取失败：${e.message || '网络异常'}`);
  }
}

function bindConfig() {
  $('#btnExpCfgAddDept').addEventListener('click', () => {
    $('#expCfgDepts').querySelector('.exp-state')?.remove();
    $('#expCfgDepts').insertAdjacentHTML('beforeend', cfgRowHtml());
    $('#expCfgDepts').lastElementChild.querySelector('input').focus();
  });
  $('#expCfgDepts').addEventListener('click', e => {
    const del = e.target.closest('[data-cfg-del]');
    if (!del) return;
    del.closest('.exp-cfg-row').remove();
    $('#btnExpCfgAddDept').focus();
  });
  $('#btnExpCfgSave').addEventListener('click', async () => {
    const btn = $('#btnExpCfgSave');
    const rows = [...$('#expCfgDepts').querySelectorAll('.exp-cfg-row')]
      .map(r => ({ dept: r.querySelector('[data-cfg-dept]').value.trim(), leaderId: Number(r.querySelector('[data-cfg-leader]').value) || null }));
    if (rows.some(r => !r.dept && r.leaderId)) {
      cfgError('有一行选了负责人但没填部门名称，补上名称或删掉这一行');
      return;
    }
    // 没选负责人的部门先不启用：后端要求每个启用的部门都有负责人，一起发过去会整张表保存失败
    const skipped = rows.filter(r => r.dept && !r.leaderId).map(r => r.dept);
    const payload = {
      depts: rows.filter(r => r.dept && r.leaderId).map(r => ({ dept: r.dept, leaderId: r.leaderId })),
      gmId: Number($('#expCfgGm').value) || null,
      financeId: Number($('#expCfgFinance').value) || null,
      cashierId: Number($('#expCfgCashier').value) || null,
    };
    btn.disabled = true;
    btn.textContent = '正在保存…';
    cfgError('');
    try {
      state.config = await api.expenseConfigSave(payload);
      const notes = [
        skipped.length ? `${skipped.join('、')}还没选负责人，先不启用` : '',
        state.config.ready ? '' : `流程还缺：${state.config.missing.join('、')}`,
      ].filter(Boolean);
      toast('ok', notes.length ? `已保存。${notes.join('；')}` : '审批设置已保存');
      closeModals();
      loadListIfOpen();
    } catch (e) {
      cfgError(e.message || '保存失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存设置';
    }
  });
}

/* ================= 生命周期 ================= */

let bound = false;
export function bind() {
  if (bound) return;
  bound = true;
  bindDetail();
  bindEditor();
  bindConfig();
}

/** 关掉本模块的弹窗；没有别的弹窗 / 抽屉开着时顺手收起遮罩（打开下一个弹窗时会再加回来） */
function closeModals() {
  for (const id of ['expEditModal', 'expDetailModal', 'expConfigModal']) $(`#${id}`).classList.remove('on');
  if (!document.querySelector('.modal.on,.drawer.on')) $('#mask').classList.remove('on');
}

/** 给 main.js 的 closeAll 用（Esc / 点遮罩）。正在提交时不让关，免得用户以为没提交上 */
export function close() {
  const open = ['expEditModal', 'expDetailModal', 'expConfigModal'].some(id => $(`#${id}`).classList.contains('on'));
  if (!open) return;
  if (busy) {
    // closeAll 里排在前面的模块已经把遮罩收了，这里补回来，弹窗不能悬空
    $('#mask').classList.add('on');
    toast('info', '正在提交，请稍等');
    return;
  }
  closeModals();
  detail = null;
  editing = null;
  pendingFiles = [];
}
