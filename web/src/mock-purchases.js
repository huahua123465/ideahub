/**
 * 采购申请的演示数据与假接口（后端没起、或 ?mock=1 时使用）。
 *
 * 字段和权限规则照抄 server/src/routes/purchases.mjs 的 DTO：界面测试跑在这份数据上，
 * 两边不一致的话，测试通过也证明不了真实页面没问题。
 * 审批人和报销共用一套配置（mock-expenses.js）。演示身份「陈屿」是总经理，也是几张采购的申请人，
 * 所以「待我处理」里既有要他审批的，也有要他填收款账户、提交交付清单的。
 */
import { mockExpenseConfig, skipsGm, gmFreeReason } from './mock-expenses.js';

const STAGES = ['leader', 'gm', 'finance'];
const STAGE_LABEL = { leader: '部门负责人', gm: '总经理', finance: '财务', account: '收款账户', cashier: '出纳' };
const PAY_TYPE_LABEL = { one_time: '一次性支付', installment: '非一次性支付' };
const STATUS_LABEL = { draft: '草稿', returned: '已退回', withdrawn: '已撤回', completed: '已完成', cancelled: '已作废' };
const ACTION_LABEL = {
  submit: '提交立项', approve: '审批通过', skip: '自动跳过', return: '退回', revoke: '撤销同意',
  withdraw: '撤回', cancel: '作废', account: '提交收款账户', pay: '确认转款', deliver: '提交交付清单',
};
const PAYMENT_STAGE_LABEL = { account: '待填收款账户', finance: '待财务审批', cashier: '待出纳转款' };
const FLOW_STATE = { approve: 'done', skip: 'skipped', return: 'returned', withdraw: 'withdrawn' };
const NAMES = { 1: '陈屿', 2: '苏禾', 3: '叶昭', 4: '林知远', 6: '何叙', 7: '赵嘉一' };

const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
let seq = 20000;
const file = (name, side, by, size = 214_000) =>
  ({ id: ++seq, scope: 'purchase', side, name, mime: 'image/png', size, uploaderName: NAMES[by], createdAt: ago(30), url: '#' });
const act = (round, stage, action, actorId, comment, h, paymentId = null) =>
  ({ id: ++seq, round, stage, action, actorId, paymentId, comment: comment || '', createdAt: ago(h) });
const payment = (no, cents, status, stage, payee, paidH = null) => ({
  id: ++seq, seq: no, cents, status, stage, note: '',
  payeeName: payee?.[0] || '', payeeAccount: payee?.[1] || '', payeeBank: payee?.[2] || '',
  paidAt: paidH === null ? null : ago(paidH), createdAt: ago(40),
});

const REQUESTS = [];
{
  const push = r => { r.updatedAt = r.actions.at(-1)?.createdAt || r.createdAt; REQUESTS.push(r); };
  push({ id: 201, applicantId: 7, dept: '产品部', payType: 'one_time', title: '直播间补光灯两套', applyDate: '2026-09-10',
    cents: 368000, note: '现有灯光偏暗，影响出镜效果', status: 'pending', stage: 'gm', round: 1, createdAt: ago(30), submittedAt: ago(26),
    payments: [], deliveryNote: '',
    actions: [act(1, null, 'submit', 7, '', 26), act(1, 'leader', 'approve', 2, '确有需要', 20)],
    files: [file('供应商报价单.pdf', 'submit', 7), file('沟通聊天记录.png', 'submit', 7)] });
  const p202 = payment(1, 219900, 'pending', 'account');
  push({ id: 202, applicantId: 1, dept: '产品部', payType: 'one_time', title: '办公室彩色打印机一台', applyDate: '2026-09-08',
    cents: 219900, note: '', status: 'executing', stage: null, round: 1, createdAt: ago(80), submittedAt: ago(76), approvedAt: ago(60),
    payments: [p202], deliveryNote: '',
    actions: [act(1, null, 'submit', 1, '', 76), act(1, 'leader', 'approve', 2, '', 70),
      act(1, 'gm', 'skip', 1, '申请人本人，自动跳过', 70), act(1, 'finance', 'approve', 3, '预算内', 60)],
    files: [file('打印机采购合同.pdf', 'submit', 1)] });
  const p203 = payment(1, 600000, 'paid', null, ['杭州某某科技有限公司', '3301 0400 1234 5678', '招商银行杭州分行'], 30);
  push({ id: 203, applicantId: 1, dept: '产品部', payType: 'installment', title: '年度视频剪辑软件订阅', applyDate: '2026-09-01',
    cents: 1200000, note: '分两期付款', status: 'executing', stage: null, round: 1, createdAt: ago(300), submittedAt: ago(296), approvedAt: ago(280),
    payments: [p203], deliveryNote: '',
    actions: [act(1, null, 'submit', 1, '', 296), act(1, 'leader', 'approve', 2, '', 290),
      act(1, 'gm', 'skip', 1, '申请人本人，自动跳过', 290), act(1, 'finance', 'approve', 3, '', 280),
      act(1, 'account', 'account', 1, '', 70, p203.id), act(1, 'finance', 'approve', 3, '', 50, p203.id),
      act(1, 'cashier', 'pay', 4, '首期已转', 30, p203.id)],
    files: [file('订阅合同.pdf', 'submit', 1), file('首期转款回单.png', 'review', 4)] });
  const p204a = payment(1, 800000, 'paid', null, ['上海某某云计算有限公司', '1001 2345 6789', '工商银行上海分行'], 100);
  const p204b = payment(2, 600000, 'pending', 'finance', ['上海某某云计算有限公司', '1001 2345 6789', '工商银行上海分行']);
  push({ id: 204, applicantId: 6, dept: '技术组', payType: 'installment', title: '服务器扩容（三期付款）', applyDate: '2026-08-20',
    cents: 2000000, note: '', status: 'executing', stage: null, round: 1, createdAt: ago(400), submittedAt: ago(396), approvedAt: ago(380),
    payments: [p204a, p204b], deliveryNote: '',
    actions: [act(1, null, 'submit', 6, '', 396), act(1, 'leader', 'approve', 4, '', 390), act(1, 'gm', 'approve', 1, '', 385),
      act(1, 'finance', 'approve', 3, '', 380), act(1, 'account', 'account', 6, '', 20, p204b.id)],
    files: [file('扩容方案与报价.pdf', 'submit', 6), file('一期转款回单.png', 'review', 4)] });
  const p205 = payment(1, 45000, 'paid', null, ['某某文具店', '6222 0000 1111 2222', '农业银行'], 200);
  push({ id: 205, applicantId: 7, dept: '产品部', payType: 'one_time', title: '拍摄用绿幕布', applyDate: '2026-08-15',
    cents: 45000, note: '', status: 'completed', stage: null, round: 1, createdAt: ago(500), submittedAt: ago(496), approvedAt: ago(480),
    completedAt: ago(150), payments: [p205], deliveryNote: '绿幕布 3×6 米一块，已到货并投入使用',
    actions: [act(1, null, 'submit', 7, '', 496), act(1, 'leader', 'approve', 2, '', 490), act(1, 'gm', 'approve', 1, '', 485),
      act(1, 'finance', 'approve', 3, '', 480), act(1, 'account', 'account', 7, '', 300, p205.id),
      act(1, 'cashier', 'pay', 4, '', 200, p205.id), act(1, null, 'deliver', 7, '绿幕布 3×6 米一块，已到货并投入使用', 150)],
    files: [file('淘宝订单截图.png', 'submit', 7), file('收货照片.jpg', 'delivery', 7)] });
  push({ id: 206, applicantId: 1, dept: '产品部', payType: 'one_time', title: '会议室投影幕布', applyDate: '2026-09-12',
    cents: 88000, note: '', status: 'draft', stage: null, round: 0, createdAt: ago(3), payments: [], deliveryNote: '', actions: [], files: [] });
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const person = id => (id ? { id, name: NAMES[id] || `用户 ${id}` } : null);
const yuan = cents => (cents / 100).toFixed(2);
const cfg = () => mockExpenseConfig();
const deptLeader = dept => cfg().depts.find(d => d[0] === dept)?.[1] || null;
const handlerId = (r, stage) => (stage === 'leader' ? deptLeader(r.dept) : cfg().roles[stage] || null);
const active = r => r.payments.find(p => p.status === 'pending') || null;
const hasPaid = r => r.payments.some(p => p.status === 'paid');
const committed = (r, exceptId = null) => r.payments
  .filter(p => p.status !== 'cancelled' && p.id !== exceptId).reduce((s, p) => s + p.cents, 0);
const awaitingDelivery = r => r.status === 'executing' && hasPaid(r) && !active(r);
const payHandlerId = (r, p) => (!p || p.status !== 'pending' ? null : p.stage === 'account' ? r.applicantId : cfg().roles[p.stage] || null);

/** 当前轮次里仍然算数的立项审批记录（撤销同意之后，那一步及后面各步之前的记录不算） */
function liveApproval(r) {
  const live = [];
  for (const a of r.actions.filter(x => x.round === r.round && !x.paymentId)) {
    if (a.action !== 'revoke') { live.push(a); continue; }
    const from = STAGES.indexOf(a.stage);
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].stage && STAGES.indexOf(live[i].stage) >= from) live.splice(i, 1);
    }
  }
  return live;
}

function canSee(r, me) {
  if (r.applicantId === me.id || r.actions.some(a => a.actorId === me.id)) return true;
  if (r.status === 'draft') return false;
  return ['gm', 'finance', 'cashier'].some(s => cfg().roles[s] === me.id) || deptLeader(r.dept) === me.id;
}

function can(r, me) {
  const mine = r.applicantId === me.id;
  const editable = mine && ['draft', 'returned', 'withdrawn'].includes(r.status);
  const handling = r.status === 'pending' && handlerId(r, r.stage) === me.id;
  const decisive = r.status === 'pending' ? liveApproval(r).filter(a => a.action !== 'skip').at(-1) : null;
  const executing = r.status === 'executing';
  const p = executing ? active(r) : null;
  const payHandling = !!p && payHandlerId(r, p) === me.id;
  const deliver = mine && executing && hasPaid(r) && !p;
  return {
    edit: editable, submit: editable, remove: mine && r.status === 'draft',
    withdraw: mine && r.status === 'pending',
    cancel: mine && (['pending', 'returned', 'withdrawn'].includes(r.status) || (executing && !hasPaid(r))),
    approve: handling && !mine, return: handling,
    revoke: decisive?.action === 'approve' && decisive.actorId === me.id,
    account: mine && p?.stage === 'account',
    newPayment: mine && executing && r.payType === 'installment' && !p && r.cents - committed(r) > 0,
    cancelPayment: mine && r.payType === 'installment' && p?.stage === 'account',
    approvePayment: payHandling && p.stage === 'finance' && !mine,
    returnPayment: payHandling && (p.stage === 'finance' || p.stage === 'cashier'),
    pay: payHandling && p.stage === 'cashier',
    deliver,
    upload: editable || (payHandling && p.stage === 'cashier') || deliver,
  };
}

const sideOf = c => (c.edit ? 'submit' : c.deliver ? 'delivery' : c.pay ? 'review' : null);

function statusLabel(r) {
  if (r.status === 'pending') return `${STAGE_LABEL[r.stage]}审批中`;
  if (r.status !== 'executing') return STATUS_LABEL[r.status];
  const p = active(r);
  if (p) return { account: '待提交收款账户', finance: '付款待财务审批', cashier: '待出纳转款' }[p.stage];
  return hasPaid(r) ? '已付款，待交付' : '立项通过，待发起付款';
}

function dto(r, me, full) {
  const live = liveApproval(r);
  const flow = STAGES.map(stage => {
    const last = live.filter(a => a.stage === stage && FLOW_STATE[a.action]).at(-1);
    const state = last ? FLOW_STATE[last.action] : r.status === 'pending' && r.stage === stage ? 'current' : 'waiting';
    return { stage, label: STAGE_LABEL[stage], state, handler: person(last ? last.actorId : handlerId(r, stage)) };
  });
  const p = r.status === 'executing' ? active(r) : null;
  const done = r.status === 'completed';
  flow.push({ stage: 'payment', label: '付款', state: done || awaitingDelivery(r) ? 'done' : r.status === 'executing' ? 'current' : 'waiting',
    handler: person(p ? payHandlerId(r, p) : cfg().roles.cashier) });
  flow.push({ stage: 'delivery', label: '交付', state: done ? 'done' : awaitingDelivery(r) ? 'current' : 'waiting', handler: person(r.applicantId) });
  const reason = a => a && { by: person(a.actorId), stageLabel: STAGE_LABEL[a.stage] || '', comment: a.comment };
  const lastReturn = r.actions.filter(a => a.action === 'return' && !a.paymentId).at(-1);
  const payReturn = p?.stage === 'account' ? r.actions.filter(a => a.action === 'return' && a.paymentId === p.id).at(-1) : null;
  const seqOf = new Map(r.payments.map(x => [x.id, x.seq]));
  return {
    id: r.id, code: `CG-2026-${String(r.id).padStart(4, '0')}`, applicant: person(r.applicantId), dept: r.dept,
    payType: r.payType, payTypeLabel: PAY_TYPE_LABEL[r.payType], title: r.title, applyDate: r.applyDate,
    amount: yuan(r.cents), amountCents: r.cents, note: r.note || '', status: r.status, stage: r.stage,
    statusLabel: statusLabel(r), round: r.round,
    handler: person(r.status === 'pending' ? handlerId(r, r.stage) : r.status === 'executing' ? (p ? payHandlerId(r, p) : r.applicantId) : null),
    flow,
    returnReason: r.status === 'returned' ? reason(lastReturn) || null : null,
    paymentReturn: reason(payReturn) || null,
    payments: r.payments.map(x => ({
      id: x.id, seq: x.seq, amount: yuan(x.cents), amountCents: x.cents, status: x.status, stage: x.stage,
      statusLabel: x.status === 'paid' ? '已转款' : x.status === 'cancelled' ? '已取消' : PAYMENT_STAGE_LABEL[x.stage],
      handler: person(payHandlerId(r, x)), payeeName: x.payeeName, payeeAccount: x.payeeAccount, payeeBank: x.payeeBank,
      note: x.note, paidAt: x.paidAt, createdAt: x.createdAt,
    })),
    activePaymentId: p ? p.id : null,
    paidAmount: yuan(r.payments.filter(x => x.status === 'paid').reduce((s, x) => s + x.cents, 0)),
    remainingAmount: yuan(Math.max(0, r.cents - committed(r))),
    awaitingDelivery: awaitingDelivery(r), deliveryNote: r.deliveryNote || '',
    fileCount: r.files.length, submittedAt: r.submittedAt || null, approvedAt: r.approvedAt || null,
    completedAt: r.completedAt || null, createdAt: r.createdAt, updatedAt: r.updatedAt, can: can(r, me),
    ...(full ? {
      actions: r.actions.map(a => ({ ...a, stageLabel: STAGE_LABEL[a.stage] || '', actionLabel: ACTION_LABEL[a.action],
        paymentSeq: a.paymentId ? seqOf.get(a.paymentId) || null : null, actor: person(a.actorId) })),
      files: r.files.map(f => ({ ...f, refId: r.id })),
    } : {}),
  };
}

function fields(b, partial) {
  const out = {};
  const has = k => !partial || b[k] !== undefined;
  if (has('payType')) { if (!PAY_TYPE_LABEL[b.payType]) throw fail('请选择支付类型'); out.payType = b.payType; }
  if (has('title')) { if (!String(b.title || '').trim()) throw fail('采购事项 不能为空'); out.title = String(b.title).trim(); }
  if (has('applyDate')) { if (!/^\d{4}-\d{2}-\d{2}$/.test(b.applyDate || '')) throw fail('日期格式不对'); out.applyDate = b.applyDate; }
  if (has('amount')) out.cents = cents(b.amount);
  if (has('note')) out.note = String(b.note || '').trim();
  return out;
}

function cents(v) {
  const s = String(v ?? '').replace(/,/g, '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw fail('金额格式不对，填数字，最多两位小数');
  return Math.round(Number(s) * 100);
}

function account(b) {
  const payeeName = String(b.payeeName || '').trim();
  const payeeAccount = String(b.payeeAccount || '').replace(/\s+/g, '');
  if (!payeeName) throw fail('收款方户名 不能为空');
  if (!payeeAccount) throw fail('请填写收款账号');
  return { payeeName, payeeAccount, payeeBank: String(b.payeeBank || '').trim(), note: String(b.note || '').trim() };
}

function advance(r, fromIndex) {
  const approved = new Set(liveApproval(r).filter(a => a.action === 'approve').map(a => a.actorId));
  for (let i = fromIndex + 1; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const h = handlerId(r, stage);
    if (stage === 'gm' && skipsGm('purchase', r.cents)) {
      r.actions.push(act(r.round, stage, 'skip', h, gmFreeReason('purchase'), 0));
      continue;
    }
    if (h && (h === r.applicantId || approved.has(h))) {
      r.actions.push(act(r.round, stage, 'skip', h, h === r.applicantId ? '申请人本人，自动跳过' : '同一人已在前一步审批通过，自动跳过', 0));
      continue;
    }
    r.status = 'pending';
    r.stage = stage;
    return;
  }
  r.status = 'executing';
  r.stage = null;
  r.approvedAt = new Date().toISOString();
  if (r.payType === 'one_time') r.payments.push(payment(1, r.cents, 'pending', 'account'));
}

function advancePayment(r, p) {
  const fin = cfg().roles.finance;
  if (r.payType === 'installment' && fin !== r.applicantId) { p.stage = 'finance'; return; }
  if (r.payType === 'installment') r.actions.push(act(r.round, 'finance', 'skip', fin, '申请人本人，自动跳过', 0, p.id));
  p.stage = 'cashier';
}

/** 命中采购接口就返回结果，不是采购接口返回 undefined，交给 mock.js 继续匹配 */
export function handlePurchases(method, p, q, body, me) {
  if (p === '/api/purchases' && method === 'GET') {
    const scope = q.get('scope') || 'mine';
    const todo = r => (r.status === 'pending' && handlerId(r, r.stage) === me.id)
      || (r.status === 'executing' && (() => {
        const x = active(r);
        return x && x.stage !== 'account' ? payHandlerId(r, x) === me.id : r.applicantId === me.id;
      })());
    const items = REQUESTS.filter(r => (scope === 'mine' ? r.applicantId === me.id : scope === 'todo' ? todo(r) : canSee(r, me)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return {
      items: items.map(r => dto(r, me, false)),
      todoCount: REQUESTS.filter(todo).length,
      deliveryCount: REQUESTS.filter(r => r.applicantId === me.id && awaitingDelivery(r)).length,
    };
  }
  if (p === '/api/purchases' && method === 'POST') {
    if (!me.dept) throw fail('你还没有被分配部门，请联系管理员在「用户管理」里设置');
    const f = fields(body || {}, false);
    const r = { id: ++seq, applicantId: me.id, dept: me.dept, status: 'draft', stage: null, round: 0, note: '',
      createdAt: new Date().toISOString(), payments: [], actions: [], files: [], deliveryNote: '', ...f };
    r.updatedAt = r.createdAt;
    REQUESTS.unshift(r);
    return dto(r, me, true);
  }

  const m = p.match(/^\/api\/purchases\/(\d+)(?:\/([a-z-]+))?$/);
  if (!m) {
    const del = p.match(/^\/api\/files\/(\d+)$/);
    if (del && method === 'DELETE') {
      const r = REQUESTS.find(x => x.files.some(f => f.id === Number(del[1])));
      if (!r) return undefined;
      const f = r.files.find(x => x.id === Number(del[1]));
      if (sideOf(can(r, me)) !== f.side) throw fail('这份材料已经交出去了，不能再删除；需要修改请先撤回，或让审批人退回', 403);
      r.files = r.files.filter(x => x !== f);
      return { ok: true };
    }
    return undefined;
  }
  const r = REQUESTS.find(x => x.id === Number(m[1]));
  if (!r || !canSee(r, me)) throw fail('没有这张采购申请', 404);
  const allowed = can(r, me);
  const now = () => new Date().toISOString();
  const touch = () => { r.updatedAt = now(); return dto(r, me, true); };
  const stageCheck = () => { if (body?.stage !== undefined && body.stage !== r.stage) throw fail('这张采购申请已经被处理过了，刷新看看最新状态', 409); };
  const paymentCheck = () => {
    const x = active(r);
    if (!x || (body?.paymentId !== undefined && body.paymentId !== x.id) || (body?.paymentStage !== undefined && body.paymentStage !== x.stage)) {
      throw fail('这笔付款已经被处理过了，刷新看看最新状态', 409);
    }
    return x;
  };
  const action = m[2];

  if (!action && method === 'GET') return dto(r, me, true);
  if (!action && method === 'PATCH') {
    if (!allowed.edit) throw fail('采购申请已经提交，不能修改；需要修改请先撤回', 403);
    Object.assign(r, fields(body || {}, true));
    return touch();
  }
  if (!action && method === 'DELETE') {
    if (!allowed.remove) throw fail('只有自己的草稿能删除', 403);
    REQUESTS.splice(REQUESTS.indexOf(r), 1);
    return { ok: true };
  }
  if (action === 'files' && method === 'POST') {
    const side = sideOf(allowed);
    if (!side) throw fail('当前状态不能上传附件', 403);
    const f = file(q.get('name') || body?.name || '附件.png', side, me.id, Number(body?.size || 1024));
    r.files.push(f);
    r.updatedAt = now();
    return { ...f, refId: r.id };
  }
  if (method !== 'POST') return undefined;

  switch (action) {
    case 'submit': {
      if (!allowed.submit) throw fail('只有申请人本人能提交采购申请', 403);
      r.dept = me.dept;
      if (!deptLeader(r.dept)) throw fail(`「${r.dept}」还没有设置部门负责人，请联系管理员在「报销审批 → 审批设置」里补上`);
      if (!r.files.some(f => f.side === 'submit')) throw fail('请至少上传一份聊天记录、采购合同或价格清单再提交');
      r.round += 1;
      r.submittedAt = now();
      r.actions.push(act(r.round, null, 'submit', me.id, '', 0));
      advance(r, -1);
      return touch();
    }
    case 'approve': {
      stageCheck();
      if (!allowed.approve) throw fail('这一步不该由你审批', 403);
      const from = r.stage;
      r.actions.push(act(r.round, from, 'approve', me.id, body?.comment, 0));
      advance(r, STAGES.indexOf(from));
      return touch();
    }
    case 'revoke': {
      stageCheck();
      if (!allowed.revoke) throw fail('只有刚刚同意的审批人能撤销自己的同意', 403);
      const from = liveApproval(r).filter(a => a.action === 'approve').at(-1).stage;
      r.actions.push(act(r.round, from, 'revoke', me.id, body?.comment, 0));
      r.stage = from;
      return touch();
    }
    case 'return': {
      stageCheck();
      if (!allowed.return) throw fail('这一步不该由你处理', 403);
      if (!String(body?.comment || '').trim()) throw fail('退回原因 不能为空');
      r.actions.push(act(r.round, r.stage, 'return', me.id, body.comment, 0));
      r.status = 'returned';
      r.stage = null;
      return touch();
    }
    case 'withdraw': {
      stageCheck();
      if (!allowed.withdraw) throw fail('只有立项审批中的采购申请能由申请人撤回', 409);
      r.actions.push(act(r.round, r.stage, 'withdraw', me.id, body?.comment, 0));
      r.status = 'withdrawn';
      r.stage = null;
      return touch();
    }
    case 'cancel': {
      stageCheck();
      if (!allowed.cancel) throw fail('只有还没转过款的采购申请能由申请人作废', 403);
      const x = active(r);
      r.actions.push(act(r.round, r.stage || x?.stage || null, 'cancel', me.id, '', 0, x?.id || null));
      for (const y of r.payments) if (y.status === 'pending') { y.status = 'cancelled'; y.stage = null; }
      r.status = 'cancelled';
      r.stage = null;
      return touch();
    }
    case 'account': {
      const x = paymentCheck();
      if (!allowed.account) throw fail('只有申请人本人能提交收款方账户', 403);
      Object.assign(x, account(body || {}));
      if (r.payType === 'installment' && body?.amount !== undefined) {
        const c = cents(body.amount);
        if (c > r.cents - committed(r, x.id)) throw fail(`本笔金额超出立项剩余额度（还剩 ¥${yuan(r.cents - committed(r, x.id))}）`);
        x.cents = c;
      }
      r.actions.push(act(r.round, 'account', 'account', me.id, '', 0, x.id));
      advancePayment(r, x);
      return touch();
    }
    case 'payments': {
      if (!allowed.newPayment) throw fail('现在不能发起付款', 409);
      const c = cents(body?.amount);
      if (c > r.cents - committed(r)) throw fail(`本笔金额超出立项剩余额度（还剩 ¥${yuan(r.cents - committed(r))}）`);
      const x = { ...payment(r.payments.reduce((n, y) => Math.max(n, y.seq), 0) + 1, c, 'pending', 'account'), ...account(body || {}) };
      r.payments.push(x);
      r.actions.push(act(r.round, 'account', 'account', me.id, '', 0, x.id));
      advancePayment(r, x);
      return touch();
    }
    case 'payment-cancel': {
      const x = paymentCheck();
      if (!allowed.cancelPayment) throw fail('这笔付款已经交出去了，不能取消', 403);
      r.actions.push(act(r.round, 'account', 'cancel', me.id, '', 0, x.id));
      x.status = 'cancelled';
      x.stage = null;
      return touch();
    }
    case 'payment-approve': {
      const x = paymentCheck();
      if (!allowed.approvePayment) throw fail('付款审批应由财务处理', 403);
      r.actions.push(act(r.round, 'finance', 'approve', me.id, body?.comment, 0, x.id));
      x.stage = 'cashier';
      return touch();
    }
    case 'payment-return': {
      const x = paymentCheck();
      if (!allowed.returnPayment) throw fail('这一步不该由你处理', 403);
      if (!String(body?.comment || '').trim()) throw fail('退回原因 不能为空');
      r.actions.push(act(r.round, x.stage, 'return', me.id, body.comment, 0, x.id));
      x.stage = 'account';
      return touch();
    }
    case 'pay': {
      const x = paymentCheck();
      if (!allowed.pay) throw fail('转款应由出纳确认', 403);
      r.actions.push(act(r.round, 'cashier', 'pay', me.id, body?.comment, 0, x.id));
      x.status = 'paid';
      x.stage = null;
      x.paidAt = now();
      return touch();
    }
    case 'deliver': {
      if (!allowed.deliver) throw fail('还没有转过款，或者还有付款没处理完', 409);
      const text = String(body?.deliveryNote || '').trim();
      if (!text) throw fail('交付清单 不能为空');
      if (!r.files.some(f => f.side === 'delivery')) throw fail('请至少上传一张收货照片或使用截图再提交');
      r.actions.push(act(r.round, null, 'deliver', me.id, text.slice(0, 1000), 0));
      r.deliveryNote = text;
      r.status = 'completed';
      r.completedAt = now();
      return touch();
    }
    default:
      return undefined;
  }
}
