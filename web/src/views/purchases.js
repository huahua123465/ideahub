/**
 * 采购。
 *
 * 一页三类人：申请人发起立项、跟进付款、交付完成后提交清单；部门负责人 / 总经理 / 财务审批立项；
 * 财务审批每笔付款（非一次性支付），出纳转款。
 * 页面主角是每张单上的五段进度条（部门负责人 → 总经理 → 财务 → 付款 → 交付）——
 * 申请人最想知道「卡在谁那儿、钱付了没、还差什么」。已付款还没交付的单子在列表顶部和详情里常驻提醒，
 * 直到申请人提交交付清单。
 *
 * 权限全部以后端返回的 can.* 为准，这里只决定按钮和表单画不画；规则见 server/src/routes/purchases.mjs。
 * 视觉沿用报销审批的 exp-* 组件（同一套卡片、进度条、时间线、弹窗），只有付款和交付是 pur-* 专属。
 * 页面骨架（标题、标签栏、内容区）只搭一次：标签栏由 motion.js 统一增强，之后切标签、推送刷新都只换内容区。
 */
import { api } from '../api.js';
import { $, esc, fromNow } from '../util.js';
import { toast } from '../toast.js';
import { ICON } from '../icons.js';
import { confirmAction } from '../confirm.js';
// 免总经理审批的额度是报销那边的「审批设置」管的，文案也跟着共用一份
import { gmFreeHint } from './expenses.js';
import { uploadProgress } from '../upload-progress.js';

const TABS = [
  { key: 'todo', label: '待我处理' },
  { key: 'mine', label: '我发起的' },
  { key: 'all', label: '全部' },
];
const EMPTY = {
  todo: ['没有等你处理的采购申请', '轮到你审批、转款，或者要你填收款账户、提交交付清单时，这里和右上角的消息都会提醒你。'],
  mine: ['你还没有发起过采购', '点右上角「发起采购」，填好信息、传上聊天记录或采购合同就能提交立项。'],
  all: ['还没有你能看到的采购申请', '你发起的、经手过的，以及你负责审批的采购申请都会出现在这里。'],
};
const PAY_TYPES = [
  { key: 'one_time', label: '一次性支付', hint: '一次付清：立项通过后填收款方账户，由出纳转款。' },
  { key: 'installment', label: '非一次性支付', hint: '分多笔付款：每笔先由财务审批，再由出纳转款，合计不超过立项金额。' },
];
const SIDES = [
  { key: 'submit', label: '申请材料', empty: '还没有申请材料。提交前至少要传一份聊天记录、采购合同或价格清单。', pick: '补充申请材料' },
  { key: 'review', label: '转款凭证', empty: '还没有转款凭证。', pick: '上传转款凭证' },
  { key: 'delivery', label: '交付材料', empty: '还没有交付材料。提交交付清单前至少要传一张收货照片或使用截图。', pick: '上传收货照片或使用截图' },
];
const MAX_FILE = 20 * 1024 * 1024;
// 填单弹窗顶部那句话；小额免总经理审批的额度接在后面（额度和审批人一样由报销的「审批设置」管）
const EDIT_HINT = '填好信息、传上聊天记录、采购合同或价格清单，提交后依次由部门负责人、总经理、财务审批立项。';
const ACCEPT = 'image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx';
const AMOUNT_RE = /^\d{1,8}(\.\d{1,2})?$/;

let me = { id: 0, role: 'member' };
export const setMe = u => { me = u; };

const state = {
  tab: null,          // 第一次进来时按有没有待办决定
  items: [],
  todoCount: 0,
  deliveryCount: 0,   // 我发起的、已付款待交付的单子数，列表顶部常驻提醒
  config: null,
  loaded: false,
};
let listSeq = 0;
let detailSeq = 0;
let detail = null;           // 详情弹窗里正在看的那张单
let editing = null;          // 编辑弹窗：null = 新建，否则是那张单的详情
let pendingFiles = [];       // 编辑弹窗里选了、还没传上去的文件
let payFormOpen = false;     // 既能交付又能发起下一笔时，付款表单默认收起
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
/** 状态色沿用报销的 s-* 色板：执行中 = 琥珀，待交付单独一档，完成 = 绿 */
const statusTone = c => (c.status === 'executing' ? (c.awaitingDelivery ? 'delivering' : 'pending')
  : c.status === 'completed' ? 'paid' : c.status);
const activePayment = c => c.payments.find(p => p.id === c.activePaymentId) || null;
/** 这个人现在能往哪一类附件里传东西，和后端 uploadSideOf 一致 */
const uploadSide = c => (c.can.edit ? 'submit' : c.can.deliver ? 'delivery' : c.can.pay ? 'review' : null);
const validAmount = s => AMOUNT_RE.test(s.replace(/,/g, '')) && Number(s.replace(/,/g, '')) > 0;

function flowHtml(c, { compact = false } = {}) {
  const note = s => ({
    done: s.stage === 'payment' || s.stage === 'delivery' ? '已完成' : '已通过',
    skipped: '已跳过', returned: '已退回', withdrawn: '已撤回', current: '处理中', waiting: '',
  }[s.state]);
  return `<ol class="exp-flow pur-flow${compact ? ' compact' : ''}" aria-label="采购进度">
    ${c.flow.map(s => `<li class="is-${s.state}">
      <i aria-hidden="true"></i>
      <span class="exp-flow-label">${esc(s.label)}</span>
      <small>${esc(s.handler?.name || '未设置')}${note(s) ? `<em> · ${note(s)}</em>` : ''}</small>
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
        <h1>采购</h1>
        <div class="sub">立项依次由部门负责人、总经理、财务审批；通过后付款，交付完成提交交付清单，采购才算闭环。</div>
      </div>
    </div>
    <div class="exp-setup pur-setup" hidden></div>
    <div class="board-toolbar exp-toolbar">
      <div class="bd-tabs" role="tablist" aria-label="采购申请分类">
        ${TABS.map(t => `<button class="bd-tab" type="button" data-pur-tab="${t.key}">${t.label}<span class="exp-tab-n" data-pur-tab-n="${t.key}"></span></button>`).join('')}
      </div>
      <div class="spacer"></div>
      <span class="bd-n"><b class="pur-count">0</b> 张</span>
    </div>
    <div class="bd-body exp-body pur-body" aria-live="polite"></div>`;

  root.querySelector('.bd-tabs').addEventListener('click', e => {
    const t = e.target.closest('[data-pur-tab]');
    if (!t || t.dataset.purTab === state.tab) return;
    switchTab(root, t.dataset.purTab);
  });
  root.addEventListener('click', e => {
    const open = e.target.closest('[data-pur-open]');
    if (open) return openDetail(Number(open.dataset.purOpen));
    if (e.target.closest('[data-pur-create]')) return openCreate();
    const go = e.target.closest('[data-pur-tab-go]');
    if (go) return switchTab(root, go.dataset.purTabGo);
    if (e.target.closest('[data-pur-retry]')) return loadList({ skeleton: true });
  });
}

function switchTab(root, tab) {
  state.tab = tab;
  paintTabs(root);
  loadList({ skeleton: true });
}

function paintTabs(root) {
  for (const b of root.querySelectorAll('[data-pur-tab]')) {
    const on = b.dataset.purTab === state.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const n = root.querySelector('[data-pur-tab-n="todo"]');
  if (n) n.textContent = state.todoCount ? ` ${state.todoCount}` : '';
}

function paintSetup(root) {
  const box = root.querySelector('.pur-setup');
  const parts = [];
  if (state.deliveryCount) {
    parts.push(`<div class="exp-callout warn pur-remind" role="status">
      <b>你有 ${state.deliveryCount} 个采购待提交交付清单</b>
      <span>款已经付了。交付完成后打开单子，写交付清单并上传收货照片、使用截图，采购才算闭环。</span>
      ${state.tab !== 'todo' ? '<button class="btn btn-ghost btn-mini" type="button" data-pur-tab-go="todo">去处理</button>' : ''}
    </div>`);
  }
  const cfg = state.config;
  if (cfg && !cfg.ready) {
    parts.push(`<div class="exp-callout warn"><b>审批流程还没配置完整</b><span>还缺：${esc(cfg.missing.join('、'))}。${me.role === 'admin'
      ? '采购和报销共用一套审批人，请在「报销审批 → 审批设置」里补上。'
      : '可以先填草稿，提交需要等管理员在「报销审批 → 审批设置」里补上。'}</span></div>`);
  }
  box.hidden = !parts.length;
  box.innerHTML = parts.join('');
}

function cardHtml(c) {
  const mine = c.applicant?.id === me.id;
  const pay = activePayment(c);
  const slim = (title, text) => `<div class="exp-callout warn slim"><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
  const extra = c.status === 'returned' && c.returnReason ? slim(`${c.returnReason.stageLabel}退回`, c.returnReason.comment)
    : c.paymentReturn && pay?.stage === 'account' ? slim(`第 ${pay.seq} 笔付款被${c.paymentReturn.stageLabel}退回`, c.paymentReturn.comment)
      : c.awaitingDelivery && mine ? slim('待提交交付清单', `已付 ¥${money(c.paidAmount)}，交付完成后提交清单`) : '';
  const hint = { draft: '草稿，还没提交', cancelled: '已作废', withdrawn: '已撤回，改好后可以重新提交' }[c.status];
  return `<article class="exp-card pur-card tone-${statusTone(c)}">
    <header>
      <span class="exp-code">${esc(c.code)}</span>
      <span class="exp-cat">${esc(c.payTypeLabel)}</span>
      <span class="exp-status s-${statusTone(c)}">${esc(c.statusLabel)}</span>
    </header>
    <h3><button type="button" class="exp-open" data-pur-open="${c.id}">${esc(c.title)}</button></h3>
    <div class="exp-card-amount"><small>¥</small>${money(c.amount)}${c.payType === 'installment' && ['executing', 'completed'].includes(c.status)
      ? `<span class="pur-paid">已付 ¥${money(c.paidAmount)}</span>` : ''}</div>
    <div class="exp-card-meta">
      <span>${esc(mine ? '我' : c.applicant?.name || '')} · ${esc(c.dept)}</span>
      <span>${esc(c.applyDate)}</span>
      <span class="exp-clip" title="${c.fileCount} 个附件">${ICON.clip}${c.fileCount}</span>
    </div>
    ${extra}
    ${hint ? `<div class="exp-card-hint">${hint}</div>` : flowHtml(c, { compact: true })}
  </article>`;
}

function paintList(root) {
  const body = root.querySelector('.pur-body');
  body.removeAttribute('aria-busy');
  root.querySelector('.pur-count').textContent = state.items.length;
  if (!state.items.length) {
    const [title, text] = EMPTY[state.tab];
    const canCreate = state.tab === 'mine' && state.config?.depts.length;
    body.innerHTML = `<div class="board-empty"><div class="empty">
      <b>${title}</b><span>${text}</span>
      ${canCreate ? '<button class="btn btn-primary" type="button" data-pur-create>发起采购</button>' : ''}
    </div></div>`;
    return;
  }
  body.innerHTML = `<div class="exp-grid">${state.items.map(cardHtml).join('')}</div>`;
}

function paintBadge() {
  const b = $('#purchaseN');
  if (!b) return;
  b.textContent = state.todoCount;
  b.classList.toggle('is-empty', !state.todoCount);
}

async function loadList({ skeleton = false } = {}) {
  const root = $('#v-purchases');
  const own = ++listSeq;
  const tab = state.tab;
  const body = root.querySelector('.pur-body');
  if (skeleton) {
    root.querySelector('.pur-count').textContent = '…';
    body.setAttribute('aria-busy', 'true');
    body.innerHTML = '<div class="exp-state" role="status">正在读取采购申请…</div>';
  }
  try {
    const [list, config] = await Promise.all([api.purchases({ scope: tab }), api.expenseConfig()]);
    if (own !== listSeq || tab !== state.tab) return;
    state.items = list.items;
    state.todoCount = list.todoCount;
    state.deliveryCount = list.deliveryCount;
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
    body.innerHTML = `<div class="exp-state error" role="alert">采购申请读取失败：${esc(e.message || '网络异常')}
      <button class="btn btn-ghost btn-mini" type="button" data-pur-retry>重试</button></div>`;
  }
}

export async function render() {
  const root = $('#v-purchases');
  if (!root.dataset.built) build(root);
  if (!state.tab) {
    // 第一次进来：有待办先看待办，否则看自己发起的
    try {
      const todo = await api.purchases({ scope: 'todo' });
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
    const r = await api.purchases({ scope: 'todo' });
    state.todoCount = r.todoCount;
    state.deliveryCount = r.deliveryCount;
    paintBadge();
    const root = $('#v-purchases');
    if (root?.dataset.built) { paintTabs(root); paintSetup(root); }
  } catch { /* 数字晚点更新没关系 */ }
}

/** 推送来了：刷新徽标；页面开着就静默刷新列表；详情开着且没在填东西就刷新详情 */
export async function refresh(view) {
  if (view !== 'purchases') return refreshBadge();
  if (!state.loaded) return;
  await loadList();
  if (detail && $('#purDetailModal').classList.contains('on') && !detailBusy()) {
    await openDetail(detail.id, { quiet: true });
  }
}

/* ================= 详情 ================= */

/** 详情里的表单只要被动过（或正在输入），推送刷新就不重画，免得把人填到一半的内容冲掉 */
function detailBusy() {
  return busy || [...document.querySelectorAll('#purDetailBody [data-draft]')]
    .some(n => n.value !== n.defaultValue || n === document.activeElement);
}

function readDrafts() {
  const out = {};
  for (const n of document.querySelectorAll('#purDetailBody [data-draft]')) {
    if (n.value !== n.defaultValue) out[n.dataset.draft] = n.value;
  }
  return out;
}

function fileItemHtml(f, deletable) {
  const kind = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return `<li class="exp-file">
    <i aria-hidden="true">${esc(kind)}</i>
    <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>
    <small>${esc(f.uploaderName || '')} · ${sizeOf(f.size)}</small>
    ${deletable ? `<button type="button" class="exp-file-del" data-pur-file-del="${f.id}" aria-label="删除附件 ${esc(f.name)}">×</button>` : ''}
  </li>`;
}

const field = (id, label, input, required = true) => `<div class="field">
  <label for="${id}">${label} ${required ? '<span>*</span>' : '<span class="opt">选填</span>'}</label>${input}</div>`;

function accountFields(p = {}) {
  return `<div class="row2">
    ${field('purPayeeName', '收款方户名', `<input class="inp" id="purPayeeName" data-draft="payeeName" maxlength="100" autocomplete="off" placeholder="公司或个人全称" value="${esc(p.payeeName || '')}">`)}
    ${field('purPayeeAccount', '收款账号', `<input class="inp pur-acc-inp" id="purPayeeAccount" data-draft="payeeAccount" maxlength="80" inputmode="numeric" autocomplete="off" value="${esc(p.payeeAccount || '')}">`)}
  </div>
  <div class="row2">
    ${field('purPayeeBank', '开户行', `<input class="inp" id="purPayeeBank" data-draft="payeeBank" maxlength="100" placeholder="例如：招商银行杭州分行" value="${esc(p.payeeBank || '')}">`, false)}
    ${field('purPayNote', '付款说明', `<input class="inp" id="purPayNote" data-draft="payNote" maxlength="1000" placeholder="比如：首期 50%、尾款" value="${esc(p.note || '')}">`, false)}
  </div>`;
}

const amountField = (value, max) => field('purPayAmount', '本笔金额（元）',
  `<input class="inp exp-amount-inp" id="purPayAmount" data-draft="payAmount" inputmode="decimal" autocomplete="off" placeholder="最多 ${money(max)}" value="${esc(value)}">`);

/** 详情里正在轮到申请人做的那件事：填收款账户 / 发起付款 / 提交交付清单 */
function formHtml(c, pay) {
  if (c.can.account && pay) {
    const max = Number(c.remainingAmount) + Number(pay.amount);
    return `<section class="exp-sec pur-form" aria-labelledby="purFormTitle">
      <h3 id="purFormTitle">填写收款方账户<small>第 ${pay.seq} 笔 · ¥${money(pay.amount)}</small></h3>
      <p class="exp-muted">${c.payType === 'one_time' ? '填好后交给出纳转款。' : '填好后先由财务审批，再由出纳转款。'}</p>
      ${c.payType === 'installment' ? amountField(pay.amount, max) : ''}
      ${accountFields(pay)}
    </section>`;
  }
  const showPay = c.can.newPayment && (!c.can.deliver || payFormOpen);
  if (showPay) {
    const last = c.payments.filter(p => p.status !== 'cancelled').at(-1);
    const next = c.payments.reduce((n, p) => Math.max(n, p.seq), 0) + 1;
    return `<section class="exp-sec pur-form" aria-labelledby="purFormTitle">
      <h3 id="purFormTitle">发起第 ${next} 笔付款<small>还可发起 ¥${money(c.remainingAmount)}</small></h3>
      <p class="exp-muted">每笔先由财务审批，再由出纳转款；上一笔处理完才能发起下一笔。</p>
      ${amountField('', c.remainingAmount)}
      ${accountFields(last ? { payeeName: last.payeeName, payeeAccount: last.payeeAccount, payeeBank: last.payeeBank } : {})}
    </section>`;
  }
  if (c.can.deliver) {
    return `<section class="exp-sec pur-form" aria-labelledby="purFormTitle">
      <h3 id="purFormTitle">提交交付清单</h3>
      <p class="exp-muted">交付完成后写明到货清单或使用情况，并在下方「交付材料」里上传收货照片、使用截图。提交后采购流程完成。</p>
      ${field('purDeliveryNote', '交付清单', '<textarea class="inp" id="purDeliveryNote" data-draft="deliveryNote" maxlength="2000" placeholder="例如：打印机 1 台已到货，安装调试完成，已投入使用"></textarea>')}
    </section>`;
  }
  return '';
}

function paymentsHtml(c) {
  return `<section class="exp-sec">
    <h3>付款记录<small>已付 ¥${money(c.paidAmount)}${c.payType === 'installment' ? ` · 剩余可发起 ¥${money(c.remainingAmount)}` : ''}</small></h3>
    <ol class="pur-pays">${c.payments.map(p => {
      const tone = p.status === 'paid' ? 'paid' : p.status === 'cancelled' ? 'cancelled' : 'pending';
      const meta = [
        p.status === 'pending' && p.handler ? `等${p.handler.name}处理` : '',
        p.paidAt ? `转款时间 ${timeText(p.paidAt)}` : '',
        p.note,
      ].filter(Boolean).join(' · ');
      return `<li class="pur-pay s-${p.status}${p.id === c.activePaymentId ? ' is-active' : ''}">
        <div class="pur-pay-head"><b>第 ${p.seq} 笔</b><span class="pur-pay-amount">¥${money(p.amount)}</span>
          <span class="exp-status s-${tone}">${esc(p.statusLabel)}</span></div>
        ${p.payeeName || p.payeeAccount ? `<div class="pur-pay-acc">${esc(p.payeeName)}${p.payeeAccount
          ? ` · <span class="pur-acc-no">${esc(p.payeeAccount)}</span>` : ''}${p.payeeBank ? ` · ${esc(p.payeeBank)}` : ''}</div>` : ''}
        ${meta ? `<div class="pur-pay-meta">${esc(meta)}</div>` : ''}
      </li>`;
    }).join('')}</ol>
  </section>`;
}

function filesHtml(c, side) {
  return SIDES.map(s => {
    const list = c.files.filter(f => f.side === s.key);
    const canPick = side === s.key;
    if (!list.length && !canPick && s.key !== 'submit') return '';
    return `<section class="exp-sec">
      <h3>${s.label}<small>${list.length} 个</small></h3>
      ${list.length ? `<ul class="exp-files">${list.map(f => fileItemHtml(f, canPick)).join('')}</ul>` : `<div class="exp-muted">${s.empty}</div>`}
      ${canPick ? `<label class="idea-file-picker exp-file-picker slim">
        <input type="file" data-pur-upload="${s.key}" multiple accept="${ACCEPT}">
        <b>${s.pick}</b><span>单个不超过 20MB</span></label>` : ''}
    </section>`;
  }).join('');
}

function paintDetail(c) {
  const body = $('#purDetailBody');
  const drafts = body.dataset.purId === String(c.id) ? readDrafts() : {};
  body.dataset.purId = String(c.id);
  $('#purDetailCode').textContent = `${c.code} · ${c.payTypeLabel}`;
  $('#purDetailTitle').textContent = c.title;
  const pay = activePayment(c);
  const side = uploadSide(c);
  const mine = c.applicant?.id === me.id;
  const commentFor = c.can.pay ? '转款备注' : c.can.approvePayment ? '付款审批意见' : c.can.returnPayment ? '退回原因' : c.can.approve || c.can.return ? '审批意见' : '';
  const commentOpt = c.can.return || c.can.returnPayment ? (c.can.approve || c.can.approvePayment || c.can.pay ? '通过时选填，退回时必填' : '必填') : '选填';
  const timeline = c.actions.slice().reverse();
  const callout = (title, text) => `<div class="exp-callout warn"><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
  const showPayToggle = c.can.newPayment && c.can.deliver;

  body.innerHTML = `
    <div class="exp-summary">
      <div class="exp-amount"><small>${c.payType === 'installment' ? '立项金额' : '采购金额'}</small><b>¥${money(c.amount)}</b></div>
      <span class="exp-status s-${statusTone(c)}">${esc(c.statusLabel)}</span>
    </div>
    ${c.status === 'returned' && c.returnReason ? callout(`${c.returnReason.stageLabel}（${c.returnReason.by?.name || ''}）退回`, c.returnReason.comment) : ''}
    ${c.status === 'withdrawn' && c.can.edit ? callout('已撤回，审批暂停', '修改信息或补充申请材料后可以重新提交，从部门负责人重新审批；不再采购可以作废。') : ''}
    ${c.paymentReturn && c.can.account ? callout(`第 ${pay?.seq} 笔付款被${c.paymentReturn.stageLabel}（${c.paymentReturn.by?.name || ''}）退回`, c.paymentReturn.comment) : ''}
    ${c.awaitingDelivery && mine ? callout('已付款，待提交交付清单', '交付完成前这里会一直提醒你，每天还会收到一条站内消息。') : ''}
    <dl class="exp-fields">
      <div><dt>申请人</dt><dd>${esc(c.applicant?.name || '')}</dd></div>
      <div><dt>部门</dt><dd>${esc(c.dept)}</dd></div>
      <div><dt>支付类型</dt><dd>${esc(c.payTypeLabel)}</dd></div>
      <div><dt>申请日期</dt><dd>${esc(c.applyDate)}</dd></div>
      ${c.submittedAt ? `<div><dt>提交时间</dt><dd>${esc(timeText(c.submittedAt))}</dd></div>` : ''}
      ${c.approvedAt ? `<div><dt>立项通过</dt><dd>${esc(timeText(c.approvedAt))}</dd></div>` : ''}
      ${['executing', 'completed'].includes(c.status) ? `<div><dt>已付金额</dt><dd>¥${money(c.paidAmount)}</dd></div>` : ''}
      ${c.completedAt ? `<div><dt>完成时间</dt><dd>${esc(timeText(c.completedAt))}</dd></div>` : ''}
      ${c.note ? `<div class="wide"><dt>备注</dt><dd>${esc(c.note)}</dd></div>` : ''}
    </dl>
    ${c.status === 'draft' || c.status === 'cancelled' ? '' : `<section class="exp-sec">
      <h3>采购进度${c.round > 1 ? `<small>第 ${c.round} 次提交立项</small>` : ''}</h3>
      ${flowHtml(c)}
    </section>`}
    ${formHtml(c, pay)}
    ${commentFor ? `<section class="exp-sec exp-act">
      <label for="purActComment">${commentFor} <span class="opt">${commentOpt}</span></label>
      <textarea class="inp" id="purActComment" data-draft="comment" maxlength="1000" placeholder="写给申请人和后面经手人看的话"></textarea>
    </section>` : ''}
    ${c.payments.length ? paymentsHtml(c) : ''}
    ${c.status === 'completed' && c.deliveryNote ? `<section class="exp-sec"><h3>交付清单</h3>
      <div class="pur-delivery-note">${esc(c.deliveryNote)}</div></section>` : ''}
    ${filesHtml(c, side)}
    ${timeline.length ? `<section class="exp-sec">
      <h3>流转记录</h3>
      <ol class="exp-timeline">${timeline.map(a => `<li class="a-${esc(a.action)}">
        <div><b>${esc(a.actor?.name || '系统')}</b> ${esc(a.actionLabel)}${a.paymentSeq
          ? `<span>（第 ${a.paymentSeq} 笔${a.stageLabel && a.stage !== 'account' ? ` · ${esc(a.stageLabel)}` : ''}）</span>`
          : a.stageLabel ? `<span>（${esc(a.stageLabel)}）</span>` : ''}</div>
        ${a.comment ? `<p>${esc(a.comment)}</p>` : ''}
        <time datetime="${esc(a.createdAt)}" title="${esc(timeText(a.createdAt))}">${esc(fromNow(a.createdAt))}</time>
      </li>`).join('')}</ol>
    </section>` : ''}
    <div class="up-progress" id="purDetailProgress" role="status" aria-live="polite" hidden></div>
    <div class="exp-error" id="purDetailErr" role="alert" aria-live="polite"></div>`;

  for (const [key, value] of Object.entries(drafts)) {
    const n = body.querySelector(`[data-draft="${key}"]`);
    if (n) n.value = value;
  }

  const btn = (id, cls, label) => `<button class="btn ${cls}" type="button" id="${id}">${label}</button>`;
  const payOpen = c.can.newPayment && (!c.can.deliver || payFormOpen);
  const primary = c.can.edit || c.can.approve || c.can.approvePayment || c.can.pay || c.can.account || c.can.newPayment || c.can.deliver;
  $('#purDetailFoot').innerHTML = [
    c.can.remove ? btn('btnPurDRemove', 'btn-crit', '删除草稿') : '',
    c.can.cancel ? btn('btnPurDCancel', 'btn-crit', '作废') : '',
    c.can.return ? btn('btnPurDReturn', 'btn-crit', '退回') : '',
    c.can.returnPayment ? btn('btnPurDPayReturn', 'btn-crit', '退回付款') : '',
    c.can.cancelPayment ? btn('btnPurDPayCancel', 'btn-crit', '取消这笔付款') : '',
    '<div class="spacer"></div>',
    c.can.withdraw ? btn('btnPurDWithdraw', 'btn-ghost', '撤回') : '',
    c.can.revoke ? btn('btnPurDRevoke', 'btn-ghost', '撤销同意') : '',
    c.can.edit ? btn('btnPurDEdit', 'btn-ghost', '修改') : '',
    c.can.submit ? btn('btnPurDSubmit', 'btn-primary', c.status === 'draft' ? '提交立项' : '重新提交') : '',
    c.can.approve ? btn('btnPurDApprove', 'btn-primary', '同意') : '',
    c.can.approvePayment ? btn('btnPurDPayApprove', 'btn-primary', '同意付款') : '',
    c.can.pay ? btn('btnPurDPay', 'btn-primary', '确认已转款') : '',
    c.can.account ? btn('btnPurDAccount', 'btn-primary', '提交收款账户') : '',
    showPayToggle ? btn(payFormOpen ? 'btnPurDHidePay' : 'btnPurDShowPay', 'btn-ghost', payFormOpen ? '先不付款' : '发起下一笔付款') : '',
    payOpen ? btn('btnPurDNewPay', 'btn-primary', '提交付款申请') : '',
    c.can.deliver && !payOpen ? btn('btnPurDDeliver', 'btn-primary', '提交交付清单') : '',
    !primary ? '<button class="btn btn-ghost" type="button" data-close>关闭</button>' : '',
  ].join('');
}

export async function openDetail(id, { quiet = false } = {}) {
  const own = ++detailSeq;
  if (!quiet) {
    closeModals();
    detail = null;
    payFormOpen = false;
    $('#purDetailBody').dataset.purId = '';
    $('#purDetailCode').textContent = '';
    $('#purDetailTitle').textContent = '采购申请';
    $('#purDetailBody').innerHTML = '<div class="exp-state" role="status">正在读取采购申请…</div>';
    $('#purDetailFoot').innerHTML = '<div class="spacer"></div><button class="btn btn-ghost" type="button" data-close>关闭</button>';
    $('#purDetailModal').classList.add('on');
    $('#mask').classList.add('on');
  }
  try {
    const c = await api.purchase(id);
    if (own !== detailSeq) return;
    detail = c;
    paintDetail(c);
  } catch (e) {
    if (own !== detailSeq || e.message === '请先登录') return;
    if (quiet) return;
    $('#purDetailBody').innerHTML = `<div class="exp-state error" role="alert">${esc(
      e.status === 404 ? '这张采购申请不存在，或者你没有查看权限。' : `读取失败：${e.message || '网络异常'}`)}</div>`;
  }
}

/** 报错区都在可滚动内容的底部：出错时滚过去，否则手机上看起来就是「点了没反应」 */
function showError(box, msg) {
  if (!box) return;
  box.textContent = msg;
  box.classList.toggle('on', !!msg);
  if (msg) box.scrollIntoView({ block: 'nearest' });
}

const detailError = msg => showError($('#purDetailErr'), msg);

/** 详情里所有会改状态的动作都走这里：锁按钮、报错不关窗、409 时拉最新 */
async function act(button, fn, okMsg, busyText = '正在处理…') {
  if (busy || !detail) return;
  busy = true;
  const buttons = [...$('#purDetailFoot').querySelectorAll('button')];
  const original = button.textContent;
  buttons.forEach(b => { b.disabled = true; });
  button.textContent = busyText;
  detailError('');
  try {
    const out = await fn();
    toast('ok', okMsg);
    busy = false;
    if (out === 'closed') closeModals();
    else if (out) {
      detail = out;
      payFormOpen = false;
      $('#purDetailBody').dataset.purId = '';   // 动作成功后表单换了一套，不再恢复旧草稿
      paintDetail(out);
    }
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
  if ($('#v-purchases')?.classList.contains('on') && state.loaded) loadList();
}

const val = id => $(`#${id}`)?.value.trim() || '';
const comment = () => val('purActComment');

/** 读收款账户表单；缺东西就在详情里报错、聚焦到第一个没填的框，返回 null */
function readAccount(withAmount) {
  const out = { payeeName: val('purPayeeName'), payeeAccount: val('purPayeeAccount'), payeeBank: val('purPayeeBank'), note: val('purPayNote') };
  const missing = [];
  if (withAmount) {
    out.amount = val('purPayAmount');
    if (!out.amount) missing.push(['本笔金额', 'purPayAmount']);
    else if (!validAmount(out.amount)) {
      detailError('本笔金额填数字，大于 0，最多两位小数');
      $('#purPayAmount').focus();
      return null;
    }
  }
  if (!out.payeeName) missing.push(['收款方户名', 'purPayeeName']);
  if (!out.payeeAccount) missing.push(['收款账号', 'purPayeeAccount']);
  if (missing.length) {
    detailError(`还没填：${missing.map(m => m[0]).join('、')}`);
    $(`#${missing[0][1]}`).focus();
    return null;
  }
  return out;
}

function bindDetail() {
  $('#purDetailFoot').addEventListener('click', async e => {
    const b = e.target.closest('button[id]');
    if (!b || !detail) return;
    const c = detail;
    const pay = activePayment(c);
    const payRef = { paymentId: pay?.id, paymentStage: pay?.stage };
    const confirmed = opts => confirmAction(opts);

    switch (b.id) {
      case 'btnPurDApprove':
        return act(b, () => api.purchaseAct(c.id, 'approve', { stage: c.stage, comment: comment() }), '已同意，流转到下一步', '正在同意…');
      case 'btnPurDReturn':
        if (!comment()) { detailError('退回请写明原因，申请人会看到'); $('#purActComment')?.focus(); return; }
        return act(b, () => api.purchaseAct(c.id, 'return', { stage: c.stage, comment: comment() }), '已退回给申请人', '正在退回…');
      case 'btnPurDRevoke':
        if (!await confirmed({ eyebrow: '撤销同意', title: '撤销你对这张采购申请的同意？',
          message: '单子会回到你这一步，由你重新同意或退回；下一步的审批人暂时不用处理。', confirmLabel: '撤销同意' })) return;
        return act(b, () => api.purchaseAct(c.id, 'revoke', { stage: c.stage }), '已撤销同意，单子回到你这一步', '正在撤销…');
      case 'btnPurDWithdraw':
        if (!await confirmed({ eyebrow: '撤回采购申请', title: '撤回这张采购申请？',
          message: '撤回后立项审批暂停，当前审批人不用再处理。你可以修改信息、补材料后重新提交（从部门负责人重新审批），也可以直接作废。',
          confirmLabel: '撤回' })) return;
        return act(b, () => api.purchaseAct(c.id, 'withdraw', { stage: c.stage }), '已撤回，可以修改后重新提交', '正在撤回…');
      case 'btnPurDCancel':
        if (!await confirmed({ eyebrow: '作废采购申请', title: '作废这张采购申请？',
          message: c.status === 'executing' ? '还没转过款，作废后进行中的付款一并取消，单子不能再提交。流转记录会保留。'
            : c.status === 'pending' ? '作废后立项审批立即结束，当前审批人不用再处理，单子不能再提交。流转记录会保留。'
              : '作废后不能再提交，流转记录会保留。',
          confirmLabel: '作废' })) return;
        return act(b, () => api.purchaseAct(c.id, 'cancel', { stage: c.stage }), '采购申请已作废', '正在作废…');
      case 'btnPurDSubmit':
        return act(b, () => api.purchaseAct(c.id, 'submit'), '已提交立项，等待审批', '正在提交…');
      case 'btnPurDEdit':
        return openEdit(c);
      case 'btnPurDRemove':
        if (!await confirmed({ eyebrow: '删除草稿', title: '删除这张采购草稿？', message: '草稿和已经传上的材料会一起删除。', confirmLabel: '删除' })) return;
        return act(b, async () => { await api.purchaseDelete(c.id); return 'closed'; }, '草稿已删除', '正在删除…');
      case 'btnPurDPayApprove':
        return act(b, () => api.purchaseAct(c.id, 'payment-approve', { ...payRef, comment: comment() }), '已同意付款，交给出纳转款', '正在同意…');
      case 'btnPurDPayReturn':
        if (!comment()) { detailError('退回请写明原因，申请人会看到'); $('#purActComment')?.focus(); return; }
        return act(b, () => api.purchaseAct(c.id, 'payment-return', { ...payRef, comment: comment() }), '已把这笔付款退回给申请人', '正在退回…');
      case 'btnPurDPay':
        if (!await confirmed({ eyebrow: '确认转款', title: `确认已向${pay?.payeeName || '收款方'}转款 ¥${money(pay?.amount || 0)}？`,
          message: '确认后这笔付款标记为已转款，申请人会收到通知，这一步不能撤销。', confirmLabel: '确认已转款' })) return;
        return act(b, () => api.purchaseAct(c.id, 'pay', { ...payRef, comment: comment() }), '已确认转款', '正在确认…');
      case 'btnPurDPayCancel':
        if (!await confirmed({ eyebrow: '取消付款', title: `取消第 ${pay?.seq} 笔付款？`,
          message: '这笔付款不再发起，占用的额度会释放出来，之后可以重新发起。', confirmLabel: '取消这笔付款' })) return;
        return act(b, () => api.purchaseAct(c.id, 'payment-cancel', payRef), '这笔付款已取消', '正在取消…');
      case 'btnPurDAccount': {
        const account = readAccount(c.payType === 'installment');
        if (!account) return;
        return act(b, () => api.purchaseAct(c.id, 'account', { ...payRef, ...account }),
          c.payType === 'one_time' ? '已提交收款账户，等待出纳转款' : '已提交，等待财务审批', '正在提交…');
      }
      case 'btnPurDShowPay':
      case 'btnPurDHidePay':
        payFormOpen = b.id === 'btnPurDShowPay';
        paintDetail(c);
        if (payFormOpen) $('#purPayAmount')?.focus();
        return;
      case 'btnPurDNewPay': {
        const account = readAccount(true);
        if (!account) return;
        return act(b, () => api.purchaseAct(c.id, 'payments', account), '付款申请已提交，等待财务审批', '正在提交…');
      }
      case 'btnPurDDeliver': {
        const text = val('purDeliveryNote');
        if (!text) { detailError('请写交付清单：到了什么、数量多少、是否已投入使用'); $('#purDeliveryNote')?.focus(); return; }
        if (!c.files.some(f => f.side === 'delivery')) {
          detailError('请先在「交付材料」里上传至少一张收货照片或使用截图');
          $('#purDetailBody [data-pur-upload="delivery"]')?.closest('label')?.scrollIntoView({ block: 'nearest' });
          return;
        }
        return act(b, () => api.purchaseAct(c.id, 'deliver', { deliveryNote: text }), '交付清单已提交，采购完成', '正在提交…');
      }
      default:
        return undefined;
    }
  });

  $('#purDetailBody').addEventListener('change', async e => {
    const input = e.target.closest('[data-pur-upload]');
    if (!input || !detail) return;
    const files = [...input.files];
    input.value = '';
    const id = detail.id;
    busy = true;                       // 传的过程中别让 Esc / 点遮罩把弹窗关掉
    try { await uploadAll(id, files, detailError, '#purDetailProgress'); }
    finally { busy = false; }
    await openDetail(id, { quiet: true });
    loadListIfOpen();
  });
  $('#purDetailBody').addEventListener('click', async e => {
    const del = e.target.closest('[data-pur-file-del]');
    if (!del || !detail) return;
    del.disabled = true;
    try {
      await api.fileDelete(Number(del.dataset.purFileDel));
      await openDetail(detail.id, { quiet: true });
      loadListIfOpen();
    } catch (err) {
      del.disabled = false;
      detailError(err.message || '删除失败');
    }
  });
}

/**
 * 逐个上传，返回没传上的；失败原因写到 onError，boxSel 是进度条容器。
 * 进度条是必须的：手机传照片要好几秒，没有它用户会以为卡住了，
 * 反复点提交或者直接关掉页面，材料就真的没传上去。
 */
async function uploadAll(id, files, onError, boxSel) {
  const failed = files.filter(f => f.size > MAX_FILE).map(f => `${f.name}：超过 20MB`);
  const queue = files.filter(f => f.size <= MAX_FILE);
  const progress = uploadProgress($(boxSel));
  progress.start(queue);
  try {
    for (const [i, f] of queue.entries()) {
      progress.tick(i, 0);
      try { await api.purchaseUpload(id, f, r => progress.tick(i, r)); }
      catch (e) { failed.push(`${f.name}：${e.message || '上传失败'}`); }
    }
  } finally {
    progress.stop();
  }
  onError(failed.length ? `有 ${failed.length} 个附件没传上 —— ${failed.join('；')}` : '');
  return failed;
}

/* ================= 发起 / 修改 ================= */

const editError = msg => showError($('#purEditErr'), msg);

function paintEditFiles() {
  const existing = editing?.files || [];
  $('#purEditFiles').innerHTML = [
    ...existing.filter(f => f.side === 'submit').map(f => `<div class="idea-pending-file">
      <i>${esc((f.name.split('.').pop() || '').slice(0, 4).toUpperCase())}</i><span>${esc(f.name)}</span>
      <small>已上传 · ${sizeOf(f.size)}</small>
      <button type="button" data-pur-existing-del="${f.id}" aria-label="删除附件 ${esc(f.name)}">×</button></div>`),
    ...pendingFiles.map((f, i) => `<div class="idea-pending-file">
      <i>${esc((f.name.split('.').pop() || '').slice(0, 4).toUpperCase())}</i><span>${esc(f.name)}</span>
      <small>${f.size > MAX_FILE ? '超过 20MB' : `待上传 · ${sizeOf(f.size)}`}</small>
      <button type="button" data-pur-pending-del="${i}" aria-label="移除 ${esc(f.name)}">×</button></div>`),
  ].join('');
}

function paintTypeHint() {
  $('#purPayTypeHint').textContent = PAY_TYPES.find(t => t.key === $('#purPayType').value)?.hint || '一次性付清选「一次性支付」，分期付款选「非一次性支付」。';
}

function fillOptions(cfg, c) {
  // 部门只读：取管理员分配的部门，提交时后端也按这一刻的分配走
  $('#purDept').value = me.dept || '未分配部门';
  const note = $('#purEditDeptNote');
  const ready = cfg.depts.some(d => d.dept === me.dept);
  note.hidden = ready;
  note.innerHTML = ready ? '' : `<b>「${esc(me.dept)}」还没有设置部门负责人</b><span>可以先存草稿，提交需要管理员在「报销审批 → 审批设置」里给这个部门选负责人。</span>`;
  $('#purPayType').innerHTML = `<option value="">请选择支付类型</option>${PAY_TYPES.map(t =>
    `<option value="${t.key}"${t.key === c?.payType ? ' selected' : ''}>${t.label}</option>`).join('')}`;
  paintTypeHint();
}

export async function openCreate() {
  if (!me.dept) {
    toast('info', me.role === 'admin'
      ? '先在头像菜单「用户管理」里给自己分配部门，才能发起采购'
      : '你还没有被分配部门，请联系管理员在「用户管理」里设置');
    return;
  }
  let cfg;
  try { cfg = state.config = await api.expenseConfig(); }
  catch (e) { toast('info', e.message || '读取审批设置失败'); return; }
  openEditor(null, cfg);
}

async function openEdit(c) {
  let cfg;
  try { cfg = state.config || (state.config = await api.expenseConfig()); }
  catch (e) { toast('info', e.message || '读取审批设置失败'); return; }
  openEditor(c, cfg);
}

function openEditor(c, cfg) {
  closeModals();
  editing = c;
  pendingFiles = [];
  fillOptions(cfg, c);
  $('#purEditTitle').textContent = c ? `修改采购申请 · ${c.code}` : '发起采购';
  $('#purEditHint').textContent = `${EDIT_HINT}${gmFreeHint(cfg, 'purchase')}`;
  $('#purTitle').value = c?.title || '';
  $('#purDate').value = c?.applyDate || today();
  $('#purAmount').value = c?.amount || '';
  $('#purNote').value = c?.note || '';
  const ret = $('#purEditReturn');
  ret.hidden = !(c?.status === 'returned' && c.returnReason);
  ret.innerHTML = ret.hidden ? '' : `<b>${esc(c.returnReason.stageLabel)}退回：</b><span>${esc(c.returnReason.comment)}</span>`;
  $('#btnPurDelete').hidden = !c?.can.remove;
  $('#btnPurSubmit').textContent = c && c.status !== 'draft' ? '重新提交' : '提交立项';
  editError('');
  paintEditFiles();
  $('#purEditModal').classList.add('on');
  $('#mask').classList.add('on');
}

function readForm() {
  const payload = {
    payType: $('#purPayType').value,
    title: $('#purTitle').value.trim(),
    applyDate: $('#purDate').value,
    amount: $('#purAmount').value.trim(),
    note: $('#purNote').value.trim(),
  };
  const missing = [
    [!payload.payType, '支付类型', '#purPayType'],
    [!payload.title, '采购事项', '#purTitle'],
    [!payload.applyDate, '申请日期', '#purDate'],
    [!payload.amount, '金额', '#purAmount'],
  ].filter(x => x[0]);
  if (missing.length) {
    editError(`还没填：${missing.map(x => x[1]).join('、')}`);
    $(missing[0][2]).focus();
    return null;
  }
  if (!validAmount(payload.amount)) {
    editError('金额填数字，大于 0，最多两位小数');
    $('#purAmount').focus();
    return null;
  }
  return payload;
}

async function saveEditor(submit) {
  if (busy) return;
  const payload = readForm();
  if (!payload) return;
  const btn = submit ? $('#btnPurSubmit') : $('#btnPurSaveDraft');
  const original = btn.textContent;
  const buttons = [$('#btnPurSubmit'), $('#btnPurSaveDraft'), $('#btnPurDelete')];
  busy = true;
  buttons.forEach(b => { b.disabled = true; });
  btn.textContent = submit ? '正在提交…' : '正在保存…';
  editError('');
  try {
    const saved = editing ? await api.purchasePatch(editing.id, payload) : await api.purchaseCreate(payload);
    // 先记下来：后面附件或提交失败时，再点一次是改这张，不会重复建单
    editing = saved;
    const files = pendingFiles.filter(f => f.size <= MAX_FILE);
    if (files.length) btn.textContent = '正在上传材料…';
    const failed = await uploadAll(saved.id, files, editError, '#purUploadProgress');
    btn.textContent = submit ? '正在提交…' : '正在保存…';
    pendingFiles = pendingFiles.filter(f => f.size > MAX_FILE || failed.some(m => m.startsWith(`${f.name}：`)));
    const fresh = await api.purchase(saved.id);
    editing = fresh;
    paintEditFiles();
    if (failed.length) {
      $('#btnPurDelete').hidden = !fresh.can.remove;
      return;   // 错误已经写在弹窗里，草稿已保存，用户可以重试
    }
    if (submit) {
      await api.purchaseAct(saved.id, 'submit');
      toast('ok', '已提交立项，等待部门负责人审批');
    } else {
      toast('ok', '草稿已保存');
    }
    closeModals();
    state.tab = 'mine';
    if ($('#v-purchases').classList.contains('on')) { paintTabs($('#v-purchases')); loadList({ skeleton: true }); }
    refreshBadge();
  } catch (e) {
    editError(e.message || '保存失败，请重试');
    if (editing) $('#btnPurDelete').hidden = !editing.can?.remove;
  } finally {
    busy = false;
    buttons.forEach(b => { b.disabled = false; });
    btn.textContent = original;
  }
}

function bindEditor() {
  $('#purPayType').addEventListener('change', paintTypeHint);
  $('#purFiles').addEventListener('change', e => {
    pendingFiles.push(...e.target.files);
    e.target.value = '';
    paintEditFiles();
  });
  $('#purEditFiles').addEventListener('click', async e => {
    const p = e.target.closest('[data-pur-pending-del]');
    if (p) { pendingFiles.splice(Number(p.dataset.purPendingDel), 1); paintEditFiles(); return; }
    const x = e.target.closest('[data-pur-existing-del]');
    if (!x || !editing) return;
    x.disabled = true;
    try {
      await api.fileDelete(Number(x.dataset.purExistingDel));
      editing = await api.purchase(editing.id);
      paintEditFiles();
    } catch (err) {
      x.disabled = false;
      editError(err.message || '删除失败');
    }
  });
  $('#btnPurSaveDraft').addEventListener('click', () => saveEditor(false));
  $('#btnPurSubmit').addEventListener('click', () => saveEditor(true));
  $('#btnPurDelete').addEventListener('click', async () => {
    if (!editing?.can.remove || busy) return;
    const ok = await confirmAction({
      eyebrow: '删除草稿', title: '删除这张采购草稿？', message: '草稿和已经传上的材料会一起删除。', confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await api.purchaseDelete(editing.id);
      toast('ok', '草稿已删除');
      closeModals();
      loadListIfOpen();
    } catch (e) { editError(e.message || '删除失败'); }
  });
}

/* ================= 生命周期 ================= */

let bound = false;
export function bind() {
  if (bound) return;
  bound = true;
  bindDetail();
  bindEditor();
}

/** 关掉本模块的弹窗；没有别的弹窗 / 抽屉开着时顺手收起遮罩 */
function closeModals() {
  for (const id of ['purEditModal', 'purDetailModal']) $(`#${id}`).classList.remove('on');
  if (!document.querySelector('.modal.on,.drawer.on')) $('#mask').classList.remove('on');
}

/** 给 main.js 的 closeAll 用（Esc / 点遮罩）。正在提交时不让关，免得用户以为没提交上 */
export function close() {
  const open = ['purEditModal', 'purDetailModal'].some(id => $(`#${id}`).classList.contains('on'));
  if (!open) return;
  if (busy) {
    $('#mask').classList.add('on');
    toast('info', '正在提交，请稍等');
    return;
  }
  closeModals();
  detail = null;
  editing = null;
  pendingFiles = [];
  payFormOpen = false;
}
