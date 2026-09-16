/**
 * 采购申请。
 *
 * 流程：申请人提交 → 部门负责人 → 总经理 → 财务（立项完成）→ 付款 → 申请人提交交付清单（闭环）。
 * 改的时候留意这几条规则，前端、附件鉴权（routes/files.mjs）、每日提醒和测试都依赖它们：
 *
 *  1. 审批人复用报销审批的配置（部门负责人 / 总经理 / 财务 / 出纳，见 routes/expenses.mjs），
 *     每一步都按当前配置实时算。
 *  2. 能看见 = 申请人本人、经手过这张单的人、本部门负责人、总经理 / 财务 / 出纳。
 *     草稿只有申请人自己看得到。**管理员没有特权**。看不见的一律回 404。
 *  3. 立项审批的规矩和报销一样：本人那一步、同一人兼任的后一步自动跳过；金额不超过「免总经理审批额度」
 *     的小额采购总经理那一步也自动跳过（默认 2000 元，管理员在「报销审批 → 审批设置」里改）；
 *     处理人可以退回（必须写原因）；
 *     立项审批中申请人可以撤回或作废；最近一次同意的人在下一步处理前可以撤销同意。
 *  4. 财务通过后进入付款（status = executing）：
 *     一次性支付 —— 自动生成一笔全额付款，申请人填收款方账户 → 出纳转款。
 *     非一次性支付 —— 申请人按需发起付款（金额 + 收款方账户，合计不超过立项金额），每笔 财务审批 → 出纳转款。
 *     同一时间只允许一笔在途付款。财务 / 出纳可以把付款退回给申请人改账户（必须写原因）；
 *     非一次性支付的申请人可以取消还没交出去的那笔付款。
 *     财务就是申请人本人时，那一笔的财务审批自动跳过；出纳转款永远不跳过。
 *  5. 付过至少一笔、且没有在途付款时，申请人提交交付清单（文字 + 至少一份交付材料），采购完成。
 *     在那之前「待我处理」和导航徽标一直有它，每天还会收到一条站内提醒（remindPendingDeliveries）。
 *  6. 还没有转过款时，申请人可以作废（在途付款一并取消）；转过款的单子只能走到交付，不能作废。
 *  7. 所有流转都在事务里 SELECT ... FOR UPDATE 锁住采购单；前端带上 stage / paymentId / paymentStage
 *     做乐观校验，双击或两人同时点不会记两次。
 *  8. 部门取管理员在「用户管理」里分配给申请人的部门，提交时按当时的分配刷新。
 */
import { unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

import { query, tx } from '../db/index.mjs';
import {
  readJson, sendJson, q, need, badRequest, forbidden, notFound, conflict,
} from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { notifyUser } from './notifications.mjs';
import { kindOf, saveBody, fileRow, UPLOAD_DIR } from './files.mjs';
import {
  loadConfig, handlerOf, duties, liveRoundActions, actorOf, person, yuan, ymdLocal,
  parseAmount, parseDate, optText, skipsGm, gmFreeReason,
} from './expenses.mjs';

const APPROVAL_STAGES = ['leader', 'gm', 'finance'];
const STAGE_LABEL = { leader: '部门负责人', gm: '总经理', finance: '财务', account: '收款账户', cashier: '出纳' };
export const PAY_TYPES = [
  { key: 'one_time', label: '一次性支付' },
  { key: 'installment', label: '非一次性支付' },
];
const PAY_TYPE_LABEL = Object.fromEntries(PAY_TYPES.map(t => [t.key, t.label]));
const STATUS_LABEL = { draft: '草稿', returned: '已退回', withdrawn: '已撤回', completed: '已完成', cancelled: '已作废' };
const ACTION_LABEL = {
  submit: '提交立项', approve: '审批通过', skip: '自动跳过', return: '退回', revoke: '撤销同意',
  withdraw: '撤回', cancel: '作废', account: '提交收款账户', pay: '确认转款', deliver: '提交交付清单',
};
const PAYMENT_STAGE_LABEL = { account: '待填收款账户', finance: '待财务审批', cashier: '待出纳转款' };
/** 申请人能改信息、补申请材料、重新提交的状态 */
const EDITABLE = ['draft', 'returned', 'withdrawn'];
const MAX_FILES = 30;

/* ================= 读单据 ================= */

const REQUEST_SELECT = `
  SELECT r.*, a.name AS applicant_name
    FROM purchase_requests r JOIN users a ON a.id = r.applicant_id`;

async function loadActions(db, requestId) {
  const { rows } = await db.query(`
    SELECT x.*, u.name AS actor_name
      FROM purchase_actions x LEFT JOIN users u ON u.id = x.actor_id
     WHERE x.request_id = $1 ORDER BY x.id`, [requestId]);
  return rows;
}

async function loadPayments(db, requestId) {
  const { rows } = await db.query(
    'SELECT * FROM purchase_payments WHERE request_id = $1 ORDER BY seq', [requestId]);
  return rows;
}

// 列表接口的记录来自 jsonb（paymentId），详情和事务里来自数据库行（payment_id）
const paymentIdOf = a => a.payment_id ?? a.paymentId ?? null;
const approvalOnly = actions => actions.filter(a => !paymentIdOf(a));

const activePayment = payments => payments.find(p => p.status === 'pending') || null;
const hasPaid = payments => payments.some(p => p.status === 'paid');
const sumCents = list => list.reduce((s, p) => s + Number(p.amount_cents), 0);
/** 已占用的立项金额：已转款 + 在途，exceptId 那一笔不算（改那一笔的金额时用） */
const committedCents = (payments, exceptId = null) =>
  sumCents(payments.filter(p => p.status !== 'cancelled' && Number(p.id) !== Number(exceptId)));
const awaitingDelivery = (r, payments) => r.status === 'executing' && hasPaid(payments) && !activePayment(payments);

/** 在途付款现在等谁处理 */
function paymentHandler(cfg, r, p) {
  if (!p || p.status !== 'pending') return null;
  if (p.stage === 'account') return person(r.applicant_id, r.applicant_name);
  return cfg.roles[p.stage] || null;
}

/** 能不能看见这张单。规则见文件头第 2 条。 */
function canSee(r, me, cfg, actions) {
  if (Number(r.applicant_id) === me.id) return true;
  if (actions.some(a => Number(a.actor_id ?? a.actorId) === me.id)) return true;
  if (r.status === 'draft') return false;
  const { leads, roles } = duties(cfg, me);
  return roles.length > 0 || leads.has(r.dept);
}

function permissions(r, me, cfg, approvalActions, payments) {
  const mine = Number(r.applicant_id) === me.id;
  const editable = mine && EDITABLE.includes(r.status);
  const handler = r.status === 'pending' ? handlerOf(cfg, r.stage, r) : null;
  const handling = !!handler && handler.id === me.id;
  const decisive = r.status === 'pending'
    ? liveRoundActions(approvalActions).filter(a => a.action !== 'skip').at(-1) : null;
  const executing = r.status === 'executing';
  const p = executing ? activePayment(payments) : null;
  const paid = hasPaid(payments);
  const payHandler = paymentHandler(cfg, r, p);
  const payHandling = !!payHandler && payHandler.id === me.id;
  const deliver = mine && executing && paid && !p;
  return {
    edit: editable,
    submit: editable,
    remove: mine && r.status === 'draft',
    withdraw: mine && r.status === 'pending',
    cancel: mine && (['pending', 'returned', 'withdrawn'].includes(r.status) || (executing && !paid)),
    approve: handling && !mine,
    return: handling,
    revoke: decisive?.action === 'approve' && actorOf(decisive) === me.id,
    account: mine && p?.stage === 'account',
    newPayment: mine && executing && r.pay_type === 'installment' && !p
      && Number(r.amount_cents) - committedCents(payments) > 0,
    cancelPayment: mine && r.pay_type === 'installment' && p?.stage === 'account',
    approvePayment: payHandling && p.stage === 'finance' && !mine,
    returnPayment: payHandling && (p.stage === 'finance' || p.stage === 'cashier'),
    pay: payHandling && p.stage === 'cashier',
    deliver,
    upload: editable || (payHandling && p.stage === 'cashier') || deliver,
  };
}

/** 这个人现在能往哪一类附件里传东西：申请材料 / 转款凭证 / 交付材料 */
const uploadSideOf = can => (can.edit ? 'submit' : can.deliver ? 'delivery' : can.pay ? 'review' : null);

function statusLabel(r, payments) {
  if (r.status === 'pending') return `${STAGE_LABEL[r.stage]}审批中`;
  if (r.status !== 'executing') return STATUS_LABEL[r.status];
  const p = activePayment(payments);
  if (p) return { account: '待提交收款账户', finance: '付款待财务审批', cashier: '待出纳转款' }[p.stage];
  return hasPaid(payments) ? '已付款，待交付' : '立项通过，待发起付款';
}

const FLOW_STATE = { approve: 'done', skip: 'skipped', return: 'returned', withdraw: 'withdrawn' };

/** 五段进度：三步立项审批 + 付款 + 交付 */
function flowOf(r, cfg, approvalActions, payments) {
  const live = liveRoundActions(approvalActions);
  const steps = APPROVAL_STAGES.map(stage => {
    const last = live.filter(a => a.stage === stage && FLOW_STATE[a.action]).at(-1);
    let state = 'waiting';
    if (last) state = FLOW_STATE[last.action];
    else if (r.status === 'pending' && r.stage === stage) state = 'current';
    const who = last
      ? person(last.actor_id ?? last.actorId, last.actor_name ?? last.actorName)
      : handlerOf(cfg, stage, r);
    return { stage, label: STAGE_LABEL[stage], state, handler: who };
  });
  const p = r.status === 'executing' ? activePayment(payments) : null;
  const done = r.status === 'completed';
  const delivering = awaitingDelivery(r, payments);
  steps.push({
    stage: 'payment', label: '付款',
    state: done || delivering ? 'done' : r.status === 'executing' ? 'current' : 'waiting',
    handler: p ? paymentHandler(cfg, r, p) : cfg.roles.cashier || null,
  });
  steps.push({
    stage: 'delivery', label: '交付',
    state: done ? 'done' : delivering ? 'current' : 'waiting',
    handler: person(r.applicant_id, r.applicant_name),
  });
  return steps;
}

function paymentDto(p, cfg, r) {
  return {
    id: Number(p.id),
    seq: Number(p.seq),
    amount: yuan(p.amount_cents),
    amountCents: Number(p.amount_cents),
    status: p.status,
    stage: p.stage,
    statusLabel: p.status === 'paid' ? '已转款' : p.status === 'cancelled' ? '已取消' : PAYMENT_STAGE_LABEL[p.stage],
    handler: paymentHandler(cfg, r, p),
    payeeName: p.payee_name || '',
    payeeAccount: p.payee_account || '',
    payeeBank: p.payee_bank || '',
    note: p.note || '',
    paidAt: p.paid_at || null,
    createdAt: p.created_at,
  };
}

const codeOf = r => `CG-${new Date(r.created_at).getFullYear()}-${String(r.id).padStart(4, '0')}`;

function requestDto(r, me, cfg, { roundActions, payments, actions = null, files = null, fileCount = 0 }) {
  const approvalActions = approvalOnly(roundActions);
  const p = r.status === 'executing' ? activePayment(payments) : null;
  const lastReturn = approvalOnly(actions || roundActions).filter(a => a.action === 'return').at(-1);
  const paymentReturn = p?.stage === 'account'
    ? (actions || roundActions).filter(a => a.action === 'return' && Number(paymentIdOf(a)) === Number(p.id)).at(-1)
    : null;
  const seqOf = new Map(payments.map(x => [Number(x.id), Number(x.seq)]));
  const reasonOf = a => a && ({
    by: person(a.actor_id ?? a.actorId, a.actor_name ?? a.actorName),
    stageLabel: STAGE_LABEL[a.stage] || '', comment: a.comment || '',
  });
  const handler = r.status === 'pending' ? handlerOf(cfg, r.stage, r)
    : r.status === 'executing' ? (p ? paymentHandler(cfg, r, p) : person(r.applicant_id, r.applicant_name)) : null;
  return {
    id: Number(r.id),
    code: codeOf(r),
    applicant: person(r.applicant_id, r.applicant_name),
    dept: r.dept,
    payType: r.pay_type,
    payTypeLabel: PAY_TYPE_LABEL[r.pay_type] || r.pay_type,
    title: r.title,
    applyDate: r.apply_date instanceof Date ? ymdLocal(r.apply_date) : String(r.apply_date).slice(0, 10),
    amount: yuan(r.amount_cents),
    amountCents: Number(r.amount_cents),
    note: r.note || '',
    status: r.status,
    stage: r.stage,
    statusLabel: statusLabel(r, payments),
    round: r.round,
    handler,
    flow: flowOf(r, cfg, approvalActions, payments),
    returnReason: r.status === 'returned' ? reasonOf(lastReturn) || null : null,
    paymentReturn: reasonOf(paymentReturn) || null,
    payments: payments.map(x => paymentDto(x, cfg, r)),
    activePaymentId: p ? Number(p.id) : null,
    paidAmount: yuan(sumCents(payments.filter(x => x.status === 'paid'))),
    remainingAmount: yuan(Math.max(0, Number(r.amount_cents) - committedCents(payments))),
    awaitingDelivery: awaitingDelivery(r, payments),
    deliveryNote: r.delivery_note || '',
    fileCount: files ? files.length : fileCount,
    submittedAt: r.submitted_at,
    approvedAt: r.approved_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    can: permissions(r, me, cfg, approvalActions, payments),
    ...(actions ? {
      actions: actions.map(a => ({
        id: Number(a.id), round: a.round, stage: a.stage,
        stageLabel: STAGE_LABEL[a.stage] || '', action: a.action,
        actionLabel: ACTION_LABEL[a.action] || a.action,
        paymentSeq: paymentIdOf(a) ? seqOf.get(Number(paymentIdOf(a))) || null : null,
        actor: person(a.actor_id, a.actor_name), comment: a.comment || '', createdAt: a.created_at,
      })),
    } : {}),
    ...(files ? { files } : {}),
  };
}

async function loadDetail(id, me) {
  const { rows } = await query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  const r = rows[0];
  if (!r) throw notFound('没有这张采购申请');
  const [cfg, actions, payments] = await Promise.all([
    loadConfig(), loadActions({ query }, id), loadPayments({ query }, id)]);
  if (!canSee(r, me, cfg, actions)) throw notFound('没有这张采购申请');
  const { rows: files } = await query(`
    SELECT f.*, u.name AS uploader_name
      FROM attachments f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.scope = 'purchase' AND f.ref_id = $1 ORDER BY f.created_at, f.id`, [id]);
  return requestDto(r, me, cfg, {
    roundActions: actions.filter(a => a.round === r.round),
    payments, actions, files: files.map(fileRow),
  });
}

/** 事务内锁住采购单并带上判断权限需要的一切（付款都挂在这张单上，锁单即锁付款） */
async function lockRequest(db, id, me) {
  const { rows } = await db.query(`${REQUEST_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id]);
  const r = rows[0];
  if (!r) throw notFound('没有这张采购申请');
  const cfg = await loadConfig(db);
  const actions = await loadActions(db, id);
  if (!canSee(r, me, cfg, actions)) throw notFound('没有这张采购申请');
  const payments = await loadPayments(db, id);
  const approvalActions = approvalOnly(actions.filter(a => a.round === r.round));
  return { r, cfg, actions, approvalActions, payments, can: permissions(r, me, cfg, approvalActions, payments) };
}

/* ================= 附件鉴权（给 routes/files.mjs 用） ================= */

async function fileContext(file, me) {
  const { rows } = await query(`${REQUEST_SELECT} WHERE r.id = $1`, [file.ref_id]);
  const r = rows[0];
  if (!r) throw notFound('没有这个文件');
  const [cfg, actions, payments] = await Promise.all([
    loadConfig(), loadActions({ query }, r.id), loadPayments({ query }, r.id)]);
  if (!canSee(r, me, cfg, actions)) throw notFound('没有这个文件');
  return { r, cfg, actions, payments };
}

export async function assertPurchaseFileReadable(file, me) {
  await fileContext(file, me);
}

/** 删附件：只有上传者本人，且单据正处在他能往这一类附件里传东西的状态。没有管理员例外。 */
export async function assertPurchaseFileDeletable(file, me) {
  const { r, cfg, actions, payments } = await fileContext(file, me);
  if (Number(file.uploaded_by) !== me.id) throw forbidden('只有上传者本人能删除这个附件');
  const can = permissions(r, me, cfg, approvalOnly(actions.filter(a => a.round === r.round)), payments);
  if (uploadSideOf(can) !== file.side) {
    throw forbidden('这份材料已经交出去了，不能再删除；需要修改请先撤回，或让审批人退回');
  }
}

/* ================= 输入校验 ================= */

/** partial=true 时只校验传了的字段（PATCH 用）。部门不从这里来，见文件头第 8 条。 */
function parseFields(b, { partial = false } = {}) {
  const out = {};
  const has = k => !partial || b[k] !== undefined;
  if (has('payType')) {
    if (!PAY_TYPE_LABEL[b.payType]) throw badRequest('请选择支付类型');
    out.pay_type = b.payType;
  }
  if (has('title')) out.title = need(b, 'title', { max: 120, label: '采购事项' });
  if (has('applyDate')) out.apply_date = parseDate(b.applyDate);
  if (has('amount')) out.amount_cents = parseAmount(b.amount);
  if (has('note')) out.note = optText(b.note, 2000, '备注');
  return out;
}

function parseAccount(b) {
  const payeeName = need(b, 'payeeName', { max: 100, label: '收款方户名' });
  const payeeAccount = String(b.payeeAccount ?? '').replace(/\s+/g, '');
  if (!payeeAccount) throw badRequest('请填写收款账号');
  if (payeeAccount.length > 64) throw badRequest('收款账号最多 64 位');
  return {
    payee_name: payeeName,
    payee_account: payeeAccount,
    payee_bank: optText(b.payeeBank, 100, '开户行'),
    note: optText(b.note, 1000, '付款说明'),
  };
}

/* ================= 流转 ================= */

/**
 * 立项审批：从 fromIndex 的下一步往后找第一个需要人处理的步骤，途中该跳过的写 skip。
 * 三步都走完就立项完成：进入 executing，一次性支付顺手生成那一笔全额付款。
 */
async function advance(db, r, cfg, fromIndex) {
  const { rows } = await db.query(
    `SELECT stage, action, actor_id FROM purchase_actions
      WHERE request_id = $1 AND round = $2 AND payment_id IS NULL ORDER BY id`, [r.id, r.round]);
  // 被撤销的同意不算「已在前一步审批通过」
  const approved = new Set(liveRoundActions(rows).filter(a => a.action === 'approve').map(actorOf));
  for (let i = fromIndex + 1; i < APPROVAL_STAGES.length; i++) {
    const stage = APPROVAL_STAGES[i];
    const h = handlerOf(cfg, stage, r);
    // 小额免总经理审批：额度按这一刻的配置算，跳过也要留痕（h 为空是配置被删了，记录照写）
    const reason = stage === 'gm' && skipsGm(cfg, 'purchase', r.amount_cents) ? gmFreeReason(cfg, 'purchase')
      : !h ? null : h.id === Number(r.applicant_id) ? '申请人本人，自动跳过'
        : approved.has(h.id) ? '同一人已在前一步审批通过，自动跳过' : null;
    if (reason) {
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'skip',$4,$5)`, [r.id, r.round, stage, h?.id ?? null, reason]);
      continue;
    }
    await db.query(
      `UPDATE purchase_requests SET status = 'pending', stage = $2, updated_at = now() WHERE id = $1`,
      [r.id, stage]);
    return { stage, handler: h, approved: false };
  }
  await db.query(
    `UPDATE purchase_requests SET status = 'executing', stage = NULL, approved_at = now(), updated_at = now()
      WHERE id = $1`, [r.id]);
  if (r.pay_type === 'one_time') {
    await db.query(
      `INSERT INTO purchase_payments(request_id, seq, amount_cents, stage) VALUES($1, 1, $2, 'account')`,
      [r.id, r.amount_cents]);
  }
  return { stage: null, handler: null, approved: true };
}

/** 付款交出去之后往哪走：非一次性先过财务（财务就是申请人本人时跳过），出纳转款永远不跳过 */
async function advancePayment(db, r, cfg, p) {
  if (r.pay_type === 'installment') {
    const fin = cfg.roles.finance;
    if (!fin || fin.id !== Number(r.applicant_id)) {
      await db.query(
        `UPDATE purchase_payments SET stage = 'finance', updated_at = now() WHERE id = $1`, [p.id]);
      return { stage: 'finance', handler: fin || null };
    }
    await db.query(
      `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id, comment)
       VALUES($1,$2,$3,'finance','skip',$4,'申请人本人，自动跳过')`, [r.id, p.id, r.round, fin.id]);
  }
  await db.query(
    `UPDATE purchase_payments SET stage = 'cashier', updated_at = now() WHERE id = $1`, [p.id]);
  return { stage: 'cashier', handler: cfg.roles.cashier || null };
}

/** 前端带着它当时看到的 stage 来，对不上说明已经被别人处理过了 */
function assertStage(r, b) {
  if (b.stage !== undefined && b.stage !== r.stage) {
    throw conflict('这张采购申请已经被处理过了，刷新看看最新状态');
  }
}

/** 付款类动作：当前在途的必须就是前端看到的那一笔、那一步 */
function assertPayment(payments, b) {
  const p = activePayment(payments);
  if (!p || (b.paymentId !== undefined && Number(b.paymentId) !== Number(p.id))
      || (b.paymentStage !== undefined && b.paymentStage !== p.stage)) {
    throw conflict('这笔付款已经被处理过了，刷新看看最新状态');
  }
  return p;
}

function assertConfigReady(cfg, r) {
  if (!cfg.depts.has(r.dept)) {
    throw badRequest(`「${r.dept}」还没有设置部门负责人，请联系管理员在「报销审批 → 审批设置」里补上`);
  }
  for (const s of ['gm', 'finance', 'cashier']) {
    if (!cfg.roles[s]) {
      throw badRequest(`还没有设置${STAGE_LABEL[s]}，请联系管理员在「报销审批 → 审批设置」里补上`);
    }
  }
}

const summaryOf = r => `${PAY_TYPE_LABEL[r.pay_type]} · ¥${yuan(r.amount_cents)} · ${r.title}`;
const NO_DEPT = '你还没有被分配部门，请联系管理员在「用户管理」里设置';

function note(userId, r, actorId, title, body) {
  return notifyUser(userId, {
    actorId, kind: 'purchase', board: 'purchases', refId: Number(r.id), title, body: body ?? summaryOf(r),
  });
}

/** 单子被申请人拿走（撤回 / 作废）时，告诉原本在等着处理它的人不用管了 */
async function notifyDropped(handler, r, actorId, verb) {
  if (!handler || handler.id === actorId) return;
  await note(handler.id, r, actorId, `${r.applicant_name}${verb}了采购申请，暂时不用你处理`);
}

async function notifyPaymentHandler(next, r, p, actorId) {
  if (!next?.handler) return;
  await note(next.handler.id, r, actorId, next.stage === 'cashier'
    ? `${r.applicant_name}的采购第 ${p.seq} 笔付款等你转款`
    : `${r.applicant_name}的采购第 ${p.seq} 笔付款等你审批`,
  `${r.title} · 本笔 ¥${yuan(p.amount_cents)}`);
}

/**
 * 每日提醒：已经转过款、还没提交交付清单的采购，每天给申请人发一条站内消息。
 * reminded_at 在转款那一刻写入，所以第一条提醒在转款一天后；多进程同时跑也只会有一个抢到更新。
 */
export async function remindPendingDeliveries() {
  const { rows } = await query(`
    UPDATE purchase_requests r SET reminded_at = now()
     WHERE r.status = 'executing'
       AND (r.reminded_at IS NULL OR r.reminded_at <= now() - interval '1 day')
       AND EXISTS (SELECT 1 FROM purchase_payments p WHERE p.request_id = r.id AND p.status = 'paid')
       AND NOT EXISTS (SELECT 1 FROM purchase_payments p WHERE p.request_id = r.id AND p.status = 'pending')
     RETURNING r.id, r.applicant_id, r.title`);
  for (const r of rows) {
    await notifyUser(r.applicant_id, {
      actorId: null, kind: 'purchase', board: 'purchases', refId: Number(r.id),
      title: '采购已付款，交付完成后请提交交付清单',
      body: `${r.title} · 上传收货照片、使用截图等，提交后采购流程才算完成`,
    });
  }
  if (rows.length) publish('purchase:updated', {});
  return rows.length;
}

/* ================= 路由 ================= */

export function mount(router) {

  /* ---------- 列表 ----------
     scope: mine 我发起的 | todo 待我处理 | all 我能看见的全部 */
  router.get('/api/purchases', async (req, res, _p, url) => {
    const me = await currentUser(req);
    const scope = q(url, 'scope', 'mine');
    const isLeader = `EXISTS (SELECT 1 FROM expense_dept_leaders d WHERE d.dept = r.dept AND d.leader_id = $1)`;
    const holds = role => `EXISTS (SELECT 1 FROM expense_role_holders h WHERE h.role = ${role} AND h.user_id = $1)`;
    const inflight = stage => `EXISTS (SELECT 1 FROM purchase_payments p
      WHERE p.request_id = r.id AND p.status = 'pending' AND p.stage = '${stage}')`;
    const todo = `(
        (r.status = 'pending' AND ((r.stage = 'leader' AND ${isLeader}) OR (r.stage <> 'leader' AND ${holds('r.stage')})))
     OR (r.status = 'executing' AND ${inflight('finance')} AND ${holds("'finance'")})
     OR (r.status = 'executing' AND ${inflight('cashier')} AND ${holds("'cashier'")})
     OR (r.status = 'executing' AND r.applicant_id = $1 AND NOT ${inflight('finance')} AND NOT ${inflight('cashier')}))`;
    const delivering = `r.applicant_id = $1 AND r.status = 'executing'
      AND EXISTS (SELECT 1 FROM purchase_payments p WHERE p.request_id = r.id AND p.status = 'paid')
      AND NOT EXISTS (SELECT 1 FROM purchase_payments p WHERE p.request_id = r.id AND p.status = 'pending')`;
    const where = scope === 'mine' ? 'r.applicant_id = $1'
      : scope === 'todo' ? todo
        : `(r.applicant_id = $1
            OR EXISTS (SELECT 1 FROM purchase_actions x WHERE x.request_id = r.id AND x.actor_id = $1)
            OR (r.status <> 'draft' AND (EXISTS (SELECT 1 FROM expense_role_holders h WHERE h.user_id = $1) OR ${isLeader})))`;

    const [{ rows }, { rows: counts }, cfg] = await Promise.all([
      query(`
        ${REQUEST_SELECT}
        LEFT JOIN LATERAL (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'stage', x.stage, 'action', x.action, 'comment', x.comment, 'paymentId', x.payment_id,
                   'actorId', x.actor_id, 'actorName', u.name) ORDER BY x.id), '[]'::jsonb) AS round_actions
            FROM purchase_actions x LEFT JOIN users u ON u.id = x.actor_id
           WHERE x.request_id = r.id AND x.round = r.round
        ) ra ON TRUE
        LEFT JOIN LATERAL (
          SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.seq), '[]'::jsonb) AS payments
            FROM purchase_payments p WHERE p.request_id = r.id
        ) pa ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS file_count FROM attachments f
           WHERE f.scope = 'purchase' AND f.ref_id = r.id
        ) fc ON TRUE
        WHERE ${where}
        ORDER BY r.updated_at DESC, r.id DESC
        LIMIT 300`, [me.id]),
      query(`SELECT (SELECT count(*)::int FROM purchase_requests r WHERE ${todo}) AS todo,
                    (SELECT count(*)::int FROM purchase_requests r WHERE ${delivering}) AS delivering`, [me.id]),
      loadConfig(),
    ]);
    sendJson(res, 200, {
      items: rows.map(r => requestDto(r, me, cfg, {
        roundActions: r.round_actions || [], payments: r.payments || [], fileCount: r.file_count,
      })),
      todoCount: counts[0].todo,
      deliveryCount: counts[0].delivering,
    });
  });

  router.get('/api/purchases/:id', async (req, res, params) => {
    const me = await currentUser(req);
    sendJson(res, 200, await loadDetail(Number(params.id), me));
  });

  /* ---------- 新建草稿 ---------- */
  router.post('/api/purchases', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    if (!me.dept) throw badRequest(NO_DEPT);
    const f = parseFields(b);
    const { rows } = await query(`
      INSERT INTO purchase_requests(applicant_id, dept, pay_type, title, apply_date, amount_cents, note)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [me.id, me.dept, f.pay_type, f.title, f.apply_date, f.amount_cents, f.note]);
    sendJson(res, 201, await loadDetail(Number(rows[0].id), me));
  });

  /* ---------- 修改：草稿、被退回或已撤回时，申请人本人 ---------- */
  router.patch('/api/purchases/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    await tx(async db => {
      const { r, can } = await lockRequest(db, id, me);
      if (!can.edit) throw forbidden(Number(r.applicant_id) === me.id
        ? '采购申请已经提交，不能修改；需要修改请先撤回' : '只有申请人本人能修改采购申请');
      const f = parseFields(b, { partial: true });
      const cols = Object.keys(f);
      if (!cols.length) return;
      await db.query(
        `UPDATE purchase_requests SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1`, [id, ...cols.map(k => f[k])]);
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 删除：只有从没提交过的草稿 ---------- */
  router.del('/api/purchases/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const files = await tx(async db => {
      const { can } = await lockRequest(db, id, me);
      if (!can.remove) throw forbidden('只有自己的草稿能删除；提交过的采购申请请作废');
      const { rows } = await db.query(
        `DELETE FROM attachments WHERE scope = 'purchase' AND ref_id = $1 RETURNING stored_name`, [id]);
      await db.query('DELETE FROM purchase_requests WHERE id = $1', [id]);
      return rows;
    });
    for (const f of files) await unlink(join(UPLOAD_DIR, basename(f.stored_name))).catch(() => {});
    sendJson(res, 200, { ok: true });
  });

  /* ---------- 提交 / 重新提交立项 ---------- */
  router.post('/api/purchases/:id/submit', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const { r, next } = await tx(async db => {
      const { r, cfg, can } = await lockRequest(db, id, me);
      if (!can.submit) {
        throw r.status === 'pending' ? conflict('这张采购申请已经提交过了')
          : forbidden('只有申请人本人能提交采购申请');
      }
      if (!me.dept) throw badRequest(NO_DEPT);
      if (me.dept !== r.dept) {
        await db.query('UPDATE purchase_requests SET dept = $2 WHERE id = $1', [id, me.dept]);
        r.dept = me.dept;
      }
      assertConfigReady(cfg, r);
      const { rows: fc } = await db.query(
        `SELECT count(*)::int AS n FROM attachments WHERE scope = 'purchase' AND ref_id = $1 AND side = 'submit'`, [id]);
      if (!fc[0].n) throw badRequest('请至少上传一份聊天记录、采购合同或价格清单再提交');

      r.round += 1;
      await db.query(
        `UPDATE purchase_requests SET round = $2, submitted_at = now(), updated_at = now() WHERE id = $1`,
        [id, r.round]);
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id)
         VALUES($1,$2,NULL,'submit',$3)`, [id, r.round, me.id]);
      return { r, next: await advance(db, r, cfg, -1) };
    });
    if (next.handler) await note(next.handler.id, r, me.id, `${r.applicant_name}提交了采购申请，等你审批`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 立项审批通过（部门负责人 / 总经理 / 财务） ---------- */
  router.post('/api/purchases/:id/approve', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '审批意见');
    const { r, from, next } = await tx(async db => {
      const { r, cfg, can } = await lockRequest(db, id, me);
      assertStage(r, b);
      if (r.status !== 'pending') throw conflict('这张采购申请当前不在立项审批中，刷新看看最新状态');
      if (!can.approve) {
        if (Number(r.applicant_id) === me.id) throw forbidden('不能审批自己的采购申请');
        const h = handlerOf(cfg, r.stage, r);
        throw forbidden(`这一步应由${STAGE_LABEL[r.stage]}${h ? `（${h.name}）` : ''}审批`);
      }
      const from = r.stage;
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'approve',$4,$5)`, [id, r.round, from, me.id, comment]);
      return { r, from, next: await advance(db, r, cfg, APPROVAL_STAGES.indexOf(from)) };
    });
    if (next.approved) {
      await note(r.applicant_id, r, me.id, r.pay_type === 'one_time'
        ? '采购立项已通过，请提交收款方账户' : '采购立项已通过，可以发起付款');
    } else {
      if (next.handler) await note(next.handler.id, r, me.id, `${r.applicant_name}提交了采购申请，等你审批`);
      await note(r.applicant_id, r, me.id, `你的采购申请已通过${STAGE_LABEL[from]}审批`,
        `${r.title} · 下一步：${STAGE_LABEL[next.stage]}审批${next.handler ? `（${next.handler.name}）` : ''}`);
    }
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 撤销同意：最近一次同意的审批人，在下一步的人处理之前收回 ---------- */
  router.post('/api/purchases/:id/revoke', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '撤销原因');
    const { r, from, waiting } = await tx(async db => {
      const { r, cfg, approvalActions, can } = await lockRequest(db, id, me);
      assertStage(r, b);
      if (r.status !== 'pending') throw conflict('这张采购申请当前不在立项审批中，刷新看看最新状态');
      if (!can.revoke) {
        const approvedEarlier = liveRoundActions(approvalActions)
          .some(a => a.action === 'approve' && actorOf(a) === me.id);
        throw approvedEarlier ? conflict('后面的审批人已经处理过了，不能再撤销同意')
          : forbidden('只有刚刚同意的审批人能撤销自己的同意');
      }
      const from = liveRoundActions(approvalActions).filter(a => a.action === 'approve').at(-1).stage;
      const waiting = handlerOf(cfg, r.stage, r);
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'revoke',$4,$5)`, [id, r.round, from, me.id, comment]);
      await db.query(
        `UPDATE purchase_requests SET status = 'pending', stage = $2, updated_at = now() WHERE id = $1`, [id, from]);
      return { r, from, waiting };
    });
    if (waiting && waiting.id !== me.id) {
      await note(waiting.id, r, me.id, `${me.name}撤销了对${r.applicant_name}采购申请的同意，暂时不用你处理`);
    }
    await note(r.applicant_id, r, me.id, `${STAGE_LABEL[from]}撤销了同意，采购申请回到${STAGE_LABEL[from]}审批`,
      `${r.title}${comment ? ` · 原因：${comment}` : ''}`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 立项退回（这一步的处理人，必须写原因） ---------- */
  router.post('/api/purchases/:id/return', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = need(b, 'comment', { max: 1000, label: '退回原因' });
    const { r, from } = await tx(async db => {
      const { r, cfg, can } = await lockRequest(db, id, me);
      assertStage(r, b);
      if (r.status !== 'pending') throw conflict('这张采购申请当前不在立项审批中，刷新看看最新状态');
      if (!can.return) {
        const h = handlerOf(cfg, r.stage, r);
        throw forbidden(`这一步应由${STAGE_LABEL[r.stage]}${h ? `（${h.name}）` : ''}处理`);
      }
      const from = r.stage;
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'return',$4,$5)`, [id, r.round, from, me.id, comment]);
      await db.query(
        `UPDATE purchase_requests SET status = 'returned', stage = NULL, updated_at = now() WHERE id = $1`, [id]);
      return { r, from };
    });
    await note(r.applicant_id, r, me.id, `你的采购申请被${STAGE_LABEL[from]}退回`, `${r.title} · 原因：${comment}`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 撤回：立项审批中申请人把单子拿回来改 ---------- */
  router.post('/api/purchases/:id/withdraw', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '撤回原因');
    const { r, handler } = await tx(async db => {
      const { r, cfg, can } = await lockRequest(db, id, me);
      assertStage(r, b);
      if (!can.withdraw) {
        if (r.status === 'pending') throw forbidden('只有申请人本人能撤回采购申请');
        throw conflict(r.status === 'executing' || r.status === 'completed'
          ? '立项已经通过，不能再撤回' : '这张采购申请当前不在立项审批中，刷新看看最新状态');
      }
      const handler = handlerOf(cfg, r.stage, r);
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'withdraw',$4,$5)`, [id, r.round, r.stage, me.id, comment]);
      await db.query(
        `UPDATE purchase_requests SET status = 'withdrawn', stage = NULL, updated_at = now() WHERE id = $1`, [id]);
      return { r, handler };
    });
    await notifyDropped(handler, r, me.id, '撤回');
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 作废：还没转过款时，申请人不想采购了；在途付款一并取消 ---------- */
  router.post('/api/purchases/:id/cancel', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const { r, handler } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      assertStage(r, b);
      if (!can.cancel) {
        if (r.status === 'draft') throw badRequest('草稿直接删除即可');
        if (Number(r.applicant_id) !== me.id) throw forbidden('只有申请人本人能作废采购申请');
        throw conflict(r.status === 'executing' ? '已经转过款的采购不能作废，请走完交付'
          : r.status === 'completed' ? '采购已经完成，不能作废' : '这张采购申请已经作废了');
      }
      const p = activePayment(payments);
      const handler = r.status === 'pending' ? handlerOf(cfg, r.stage, r) : paymentHandler(cfg, r, p);
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id)
         VALUES($1,$2,$3,$4,'cancel',$5)`, [id, p?.id || null, r.round, r.stage || p?.stage || null, me.id]);
      await db.query(
        `UPDATE purchase_payments SET status = 'cancelled', stage = NULL, updated_at = now()
          WHERE request_id = $1 AND status = 'pending'`, [id]);
      await db.query(
        `UPDATE purchase_requests SET status = 'cancelled', stage = NULL, updated_at = now() WHERE id = $1`, [id]);
      return { r, handler };
    });
    await notifyDropped(handler, r, me.id, '作废');
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 提交收款方账户：在途付款停在「待填收款账户」时，申请人本人 ----------
     一次性支付的那一笔，或者被财务 / 出纳退回来改账户的那一笔。非一次性支付改的时候可以顺便调金额。 */
  router.post('/api/purchases/:id/account', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const account = parseAccount(b);
    const { r, p, next } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      const p = assertPayment(payments, b);
      if (!can.account) throw forbidden('只有申请人本人能提交收款方账户');
      assertConfigReady(cfg, r);
      let amount = Number(p.amount_cents);
      if (r.pay_type === 'installment' && b.amount !== undefined) {
        amount = parseAmount(b.amount);
        const left = Number(r.amount_cents) - committedCents(payments, p.id);
        if (amount > left) throw badRequest(`本笔金额超出立项剩余额度（还剩 ¥${yuan(left)}）`);
      }
      await db.query(
        `UPDATE purchase_payments SET payee_name = $2, payee_account = $3, payee_bank = $4, note = $5,
                amount_cents = $6, updated_at = now() WHERE id = $1`,
        [p.id, account.payee_name, account.payee_account, account.payee_bank, account.note, amount]);
      p.amount_cents = amount;
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id)
         VALUES($1,$2,$3,'account','account',$4)`, [id, p.id, r.round, me.id]);
      const next = await advancePayment(db, r, cfg, p);
      await db.query('UPDATE purchase_requests SET updated_at = now() WHERE id = $1', [id]);
      return { r, p, next };
    });
    await notifyPaymentHandler(next, r, p, me.id);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 发起一笔付款（非一次性支付） ---------- */
  router.post('/api/purchases/:id/payments', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const amount = parseAmount(b.amount);
    const account = parseAccount(b);
    const { r, p, next } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      if (!can.newPayment) {
        if (Number(r.applicant_id) !== me.id) throw forbidden('只有申请人本人能发起付款');
        if (r.pay_type !== 'installment') throw badRequest('一次性支付不能再发起付款');
        if (activePayment(payments)) throw conflict('上一笔付款还没处理完，处理完再发起下一笔');
        throw conflict(r.status === 'executing' ? '立项金额已经付完了' : '采购立项还没通过，不能发起付款');
      }
      assertConfigReady(cfg, r);
      const left = Number(r.amount_cents) - committedCents(payments);
      if (amount > left) throw badRequest(`本笔金额超出立项剩余额度（还剩 ¥${yuan(left)}）`);
      const seq = payments.reduce((m, x) => Math.max(m, Number(x.seq)), 0) + 1;
      const { rows } = await db.query(
        `INSERT INTO purchase_payments(request_id, seq, amount_cents, stage, payee_name, payee_account, payee_bank, note)
         VALUES($1,$2,$3,'account',$4,$5,$6,$7) RETURNING *`,
        [id, seq, amount, account.payee_name, account.payee_account, account.payee_bank, account.note]);
      const p = rows[0];
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id)
         VALUES($1,$2,$3,'account','account',$4)`, [id, p.id, r.round, me.id]);
      const next = await advancePayment(db, r, cfg, p);
      await db.query('UPDATE purchase_requests SET updated_at = now() WHERE id = $1', [id]);
      return { r, p, next };
    });
    await notifyPaymentHandler(next, r, p, me.id);
    sendJson(res, 201, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 取消一笔还没交出去的付款（非一次性支付） ---------- */
  router.post('/api/purchases/:id/payment-cancel', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    await tx(async db => {
      const { r, payments, can } = await lockRequest(db, id, me);
      const p = assertPayment(payments, b);
      if (!can.cancelPayment) {
        throw forbidden(r.pay_type === 'installment' && Number(r.applicant_id) === me.id
          ? '这笔付款已经交出去了，不能取消' : '只有非一次性支付的申请人能取消付款');
      }
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id)
         VALUES($1,$2,$3,'account','cancel',$4)`, [id, p.id, r.round, me.id]);
      await db.query(
        `UPDATE purchase_payments SET status = 'cancelled', stage = NULL, updated_at = now() WHERE id = $1`, [p.id]);
      await db.query('UPDATE purchase_requests SET updated_at = now() WHERE id = $1', [id]);
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 财务审批通过一笔付款（非一次性支付） ---------- */
  router.post('/api/purchases/:id/payment-approve', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '审批意见');
    const { r, p, next } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      const p = assertPayment(payments, b);
      if (!can.approvePayment) {
        throw p.stage !== 'finance' ? conflict('这笔付款当前不在财务审批这一步，刷新看看最新状态')
          : forbidden(`付款审批应由财务${cfg.roles.finance ? `（${cfg.roles.finance.name}）` : ''}处理`);
      }
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'finance','approve',$4,$5)`, [id, p.id, r.round, me.id, comment]);
      await db.query(
        `UPDATE purchase_payments SET stage = 'cashier', updated_at = now() WHERE id = $1`, [p.id]);
      await db.query('UPDATE purchase_requests SET updated_at = now() WHERE id = $1', [id]);
      return { r, p, next: { stage: 'cashier', handler: cfg.roles.cashier || null } };
    });
    await notifyPaymentHandler(next, r, p, me.id);
    await note(r.applicant_id, r, me.id, `采购第 ${p.seq} 笔付款已通过财务审批`,
      `${r.title} · 本笔 ¥${yuan(p.amount_cents)} · 下一步：出纳转款`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 财务 / 出纳把付款退回给申请人改（必须写原因） ---------- */
  router.post('/api/purchases/:id/payment-return', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = need(b, 'comment', { max: 1000, label: '退回原因' });
    const { r, p, from } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      const p = assertPayment(payments, b);
      if (!can.returnPayment) {
        const h = paymentHandler(cfg, r, p);
        throw forbidden(p.stage === 'account' ? '这笔付款正等申请人填收款账户'
          : `这一步应由${STAGE_LABEL[p.stage]}${h ? `（${h.name}）` : ''}处理`);
      }
      const from = p.stage;
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,$4,'return',$5,$6)`, [id, p.id, r.round, from, me.id, comment]);
      await db.query(
        `UPDATE purchase_payments SET stage = 'account', updated_at = now() WHERE id = $1`, [p.id]);
      await db.query('UPDATE purchase_requests SET updated_at = now() WHERE id = $1', [id]);
      return { r, p, from };
    });
    await note(r.applicant_id, r, me.id, `采购第 ${p.seq} 笔付款被${STAGE_LABEL[from]}退回`,
      `${r.title} · 原因：${comment}`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 出纳确认转款 ---------- */
  router.post('/api/purchases/:id/pay', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '转款备注');
    const { r, p } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      const p = assertPayment(payments, b);
      if (!can.pay) {
        throw p.stage !== 'cashier' ? conflict('这笔付款还没走到出纳转款这一步，刷新看看最新状态')
          : forbidden(`转款应由出纳${cfg.roles.cashier ? `（${cfg.roles.cashier.name}）` : ''}确认`);
      }
      await db.query(
        `INSERT INTO purchase_actions(request_id, payment_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'cashier','pay',$4,$5)`, [id, p.id, r.round, me.id, comment]);
      await db.query(
        `UPDATE purchase_payments SET status = 'paid', stage = NULL, paid_at = now(), updated_at = now()
          WHERE id = $1`, [p.id]);
      // 每日提醒从转款这一刻起算，一天后才发第一条
      await db.query(
        'UPDATE purchase_requests SET reminded_at = now(), updated_at = now() WHERE id = $1', [id]);
      return { r, p };
    });
    await note(r.applicant_id, r, me.id,
      r.pay_type === 'one_time' ? '采购款已支付完成，交付完成后请提交交付清单' : `采购第 ${p.seq} 笔付款已转款`,
      `${r.title} · 本笔 ¥${yuan(p.amount_cents)}${comment ? ` · ${comment}` : ''}`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 交付完成：申请人提交交付清单，采购闭环 ---------- */
  router.post('/api/purchases/:id/deliver', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const deliveryNote = need(b, 'deliveryNote', { max: 2000, label: '交付清单' });
    const { r, finance } = await tx(async db => {
      const { r, cfg, payments, can } = await lockRequest(db, id, me);
      if (!can.deliver) {
        if (Number(r.applicant_id) !== me.id) throw forbidden('只有申请人本人能提交交付清单');
        if (r.status === 'completed') throw conflict('这张采购已经交付完成了');
        throw conflict(activePayment(payments) ? '还有付款没处理完，处理完再提交交付清单'
          : '还没有转过款，不能提交交付清单');
      }
      const { rows: fc } = await db.query(
        `SELECT count(*)::int AS n FROM attachments WHERE scope = 'purchase' AND ref_id = $1 AND side = 'delivery'`, [id]);
      if (!fc[0].n) throw badRequest('请至少上传一张收货照片或使用截图再提交');
      await db.query(
        `INSERT INTO purchase_actions(request_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,NULL,'deliver',$3,$4)`, [id, r.round, me.id, deliveryNote.slice(0, 1000)]);
      await db.query(
        `UPDATE purchase_requests SET status = 'completed', delivery_note = $2, completed_at = now(), updated_at = now()
          WHERE id = $1`, [id, deliveryNote]);
      return { r, finance: cfg.roles.finance };
    });
    if (finance) await note(finance.id, r, me.id, `${r.applicant_name}的采购已交付完成`, `${r.title} · 交付清单已提交`);
    sendJson(res, 200, await loadDetail(id, me));
    publish('purchase:updated', {});
  });

  /* ---------- 附件上传 ----------
     申请人在草稿 / 退回 / 撤回时传申请材料（side=submit）；出纳在转款这一步传转款凭证（side=review）；
     申请人在待交付时传收货照片、使用截图（side=delivery）。先无锁判一次权限，落库前在事务里再判一次。 */
  router.post('/api/purchases/:id/files', async (req, res, params, url) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const pre = await tx(db => lockRequest(db, id, me));
    if (!uploadSideOf(pre.can)) throw forbidden('当前状态不能上传附件');

    const origName = String(q(url, 'name', '') || '').trim();
    if (!origName) throw badRequest('缺少文件名');
    if (origName.length > 200) throw badRequest('文件名太长了');
    const kind = kindOf(origName);
    const storedName = randomBytes(16).toString('hex') + kind.ext;
    const diskPath = join(UPLOAD_DIR, storedName);
    const size = await saveBody(req, diskPath);

    let row;
    try {
      row = await tx(async db => {
        const { r, can } = await lockRequest(db, id, me);
        const side = uploadSideOf(can);
        if (!side || side !== uploadSideOf(pre.can)) throw conflict('采购申请状态已经变了，这个附件没有保存');
        const { rows: fc } = await db.query(
          `SELECT count(*)::int AS n FROM attachments WHERE scope = 'purchase' AND ref_id = $1`, [id]);
        if (fc[0].n >= MAX_FILES) throw badRequest(`每张采购申请最多 ${MAX_FILES} 个附件`);
        const { rows } = await db.query(`
          INSERT INTO attachments(scope, ref_id, side, orig_name, stored_name, mime, size, uploaded_by)
          VALUES('purchase',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [r.id, side, basename(origName), storedName, kind.mime, size, me.id]);
        return rows[0];
      });
    } catch (e) {
      await unlink(diskPath).catch(() => {});
      throw e;
    }
    sendJson(res, 201, fileRow({ ...row, uploader_name: me.name }));
    publish('purchase:updated', {});
  });
}
