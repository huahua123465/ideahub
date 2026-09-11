/**
 * 报销审批。
 *
 * 流程固定四步：部门负责人 → 总经理 → 财务 → 出纳打款。
 * 改的时候留意这几条规则，前端、附件鉴权（routes/files.mjs）和测试都依赖它们：
 *
 *  1. 审批人不写死在单据上，每一步都按当前配置实时算
 *     （expense_dept_leaders / expense_role_holders）。有人离职，管理员改一次配置，
 *     卡在路上的单子立刻转给新的人。已经发生的审批记在 expense_claim_actions，不受影响。
 *  2. 能看见 = 申请人本人、经手过这张单的人、本部门负责人、总经理 / 财务 / 出纳。
 *     草稿只有申请人自己看得到。**管理员没有特权**：管理员只负责配置流程，
 *     不因为是管理员就能翻所有人的报销单。看不见的一律回 404，不承认单子存在。
 *  3. 本该由申请人自己审批的一步自动跳过；同一个人兼任连续两步（比如部门负责人就是总经理）
 *     时，后一步也自动跳过。出纳打款这一步永远不跳过。跳过都会留痕。
 *  4. 退回后申请人可以改信息、补附件、重新提交，从第一步重新走，round + 1；
 *     不想报了就作废。草稿可以直接删，提交过的单子只能作废不能删 —— 财务单据要留痕。
 *  5. 所有状态流转都在事务里 SELECT ... FOR UPDATE，前端还会带上 stage 做乐观校验，
 *     双击或两个人同时点不会把一步审批记两次。
 */
import { unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

import { query, tx } from '../db/index.mjs';
import {
  readJson, sendJson, q, need, badRequest, forbidden, notFound, conflict,
} from '../lib/http.mjs';
import { currentUser, assertAdmin } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { notifyUser } from './notifications.mjs';
import { kindOf, saveBody, fileRow, UPLOAD_DIR } from './files.mjs';

export const STAGES = ['leader', 'gm', 'finance', 'cashier'];
export const STAGE_LABEL = { leader: '部门负责人', gm: '总经理', finance: '财务', cashier: '出纳' };
export const CATEGORIES = [
  { key: 'office', label: '办公费' },
  { key: 'daily', label: '日用费' },
  { key: 'travel', label: '差旅费' },
  { key: 'entertainment', label: '业务招待费' },
  { key: 'other', label: '其他' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const STATUS_LABEL = { draft: '草稿', returned: '已退回', paid: '已打款', cancelled: '已作废' };
const ACTION_LABEL = {
  submit: '提交', approve: '审批通过', skip: '自动跳过', return: '退回', pay: '确认打款', cancel: '作废',
};
const MAX_FILES = 20;
const MAX_CENTS = 9_999_999_999;

/* ================= 配置 ================= */

async function loadConfig(db = { query }) {
  const [{ rows: depts }, { rows: roles }] = await Promise.all([
    db.query(`SELECT d.dept, d.leader_id, u.name AS leader_name
                FROM expense_dept_leaders d JOIN users u ON u.id = d.leader_id
               ORDER BY d.sort, d.dept`),
    db.query(`SELECT r.role, r.user_id, u.name
                FROM expense_role_holders r JOIN users u ON u.id = r.user_id`),
  ]);
  const cfg = { depts: new Map(), roles: {} };
  for (const d of depts) cfg.depts.set(d.dept, { id: Number(d.leader_id), name: d.leader_name });
  for (const r of roles) cfg.roles[r.role] = { id: Number(r.user_id), name: r.name };
  return cfg;
}

const handlerOf = (cfg, stage, c) =>
  (stage === 'leader' ? cfg.depts.get(c.dept) : cfg.roles[stage]) || null;

function duties(cfg, me) {
  const leads = new Set();
  for (const [dept, u] of cfg.depts) if (u.id === me.id) leads.add(dept);
  const roles = STAGES.slice(1).filter(s => cfg.roles[s]?.id === me.id);
  return { leads, roles };
}

function configDto(cfg, me) {
  const { leads, roles } = duties(cfg, me);
  const missing = [];
  if (!cfg.depts.size) missing.push('部门负责人');
  for (const s of STAGES.slice(1)) if (!cfg.roles[s]) missing.push(STAGE_LABEL[s]);
  return {
    categories: CATEGORIES,
    stages: STAGES.map(key => ({ key, label: STAGE_LABEL[key] })),
    depts: [...cfg.depts].map(([dept, leader]) => ({ dept, leader })),
    roles: Object.fromEntries(STAGES.slice(1).map(s => [s, cfg.roles[s] || null])),
    ready: missing.length === 0,
    missing,
    myDept: me.dept && cfg.depts.has(me.dept) ? me.dept : null,
    myDuties: { leadDepts: [...leads], roles },
  };
}

/* ================= 读单据 ================= */

const CLAIM_SELECT = `
  SELECT c.*, a.name AS applicant_name
    FROM expense_claims c JOIN users a ON a.id = c.applicant_id`;

async function loadActions(db, claimId) {
  const { rows } = await db.query(`
    SELECT x.*, u.name AS actor_name
      FROM expense_claim_actions x LEFT JOIN users u ON u.id = x.actor_id
     WHERE x.claim_id = $1 ORDER BY x.id`, [claimId]);
  return rows;
}

/** 能不能看见这张单。规则见文件头第 2 条。 */
function canSee(c, me, cfg, actions) {
  if (Number(c.applicant_id) === me.id) return true;
  if (actions.some(a => Number(a.actor_id) === me.id)) return true;
  if (c.status === 'draft') return false;
  const { leads, roles } = duties(cfg, me);
  return roles.length > 0 || leads.has(c.dept);
}

function permissions(c, me, cfg) {
  const mine = Number(c.applicant_id) === me.id;
  const editable = mine && (c.status === 'draft' || c.status === 'returned');
  const handler = c.status === 'pending' ? handlerOf(cfg, c.stage, c) : null;
  const handling = !!handler && handler.id === me.id;
  return {
    edit: editable,
    submit: editable,
    remove: mine && c.status === 'draft',
    cancel: mine && c.status === 'returned',
    approve: handling && c.stage !== 'cashier' && !mine,
    return: handling,
    pay: handling && c.stage === 'cashier',
    upload: editable || (handling && c.stage === 'cashier'),
  };
}

const person = (id, name) => (id ? { id: Number(id), name: name || '已删除的账号' } : null);
const yuan = cents => (Number(cents) / 100).toFixed(2);
const codeOf = c => `BX-${new Date(c.created_at).getFullYear()}-${String(c.id).padStart(4, '0')}`;

function statusLabel(c) {
  if (c.status !== 'pending') return STATUS_LABEL[c.status];
  return c.stage === 'cashier' ? '待出纳打款' : `${STAGE_LABEL[c.stage]}审批中`;
}

/** 当前这一轮每一步的状态，给进度条和审批时间线用 */
function flowOf(c, cfg, roundActions) {
  return STAGES.map(stage => {
    const last = roundActions.filter(a => a.stage === stage).at(-1);
    let state = 'waiting';
    if (last?.action === 'approve' || last?.action === 'pay') state = 'done';
    else if (last?.action === 'skip') state = 'skipped';
    else if (last?.action === 'return') state = 'returned';
    else if (c.status === 'pending' && c.stage === stage) state = 'current';
    const who = last
      ? person(last.actor_id ?? last.actorId, last.actor_name ?? last.actorName)
      : handlerOf(cfg, stage, c);
    return { stage, label: STAGE_LABEL[stage], state, handler: who };
  });
}

function claimDto(c, me, cfg, { roundActions, actions = null, files = null, fileCount = 0 }) {
  const handler = c.status === 'pending' ? handlerOf(cfg, c.stage, c) : null;
  const lastReturn = (actions || roundActions).filter(a => a.action === 'return').at(-1);
  return {
    id: Number(c.id),
    code: codeOf(c),
    applicant: person(c.applicant_id, c.applicant_name),
    dept: c.dept,
    category: c.category,
    categoryLabel: CATEGORY_LABEL[c.category] || c.category,
    title: c.title,
    expenseDate: c.expense_date instanceof Date
      ? ymdLocal(c.expense_date) : String(c.expense_date).slice(0, 10),
    amount: yuan(c.amount_cents),
    amountCents: Number(c.amount_cents),
    note: c.note || '',
    status: c.status,
    stage: c.stage,
    statusLabel: statusLabel(c),
    round: c.round,
    handler,
    flow: flowOf(c, cfg, roundActions),
    returnReason: c.status === 'returned' && lastReturn
      ? { by: person(lastReturn.actor_id ?? lastReturn.actorId, lastReturn.actor_name ?? lastReturn.actorName),
          stageLabel: STAGE_LABEL[lastReturn.stage] || '', comment: lastReturn.comment || '' }
      : null,
    fileCount: files ? files.length : fileCount,
    submittedAt: c.submitted_at,
    paidAt: c.paid_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    can: permissions(c, me, cfg),
    ...(actions ? {
      actions: actions.map(a => ({
        id: Number(a.id), round: a.round, stage: a.stage,
        stageLabel: STAGE_LABEL[a.stage] || '', action: a.action,
        actionLabel: ACTION_LABEL[a.action] || a.action,
        actor: person(a.actor_id, a.actor_name), comment: a.comment || '', createdAt: a.created_at,
      })),
    } : {}),
    ...(files ? { files } : {}),
  };
}

// pg 把 DATE 解析成本地零点的 Date；直接 toISOString 在东八区会差一天
function ymdLocal(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadDetail(id, me) {
  const { rows } = await query(`${CLAIM_SELECT} WHERE c.id = $1`, [id]);
  const c = rows[0];
  if (!c) throw notFound('没有这张报销单');
  const [cfg, actions] = await Promise.all([loadConfig(), loadActions({ query }, id)]);
  if (!canSee(c, me, cfg, actions)) throw notFound('没有这张报销单');
  const { rows: files } = await query(`
    SELECT f.*, u.name AS uploader_name
      FROM attachments f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.scope = 'expense' AND f.ref_id = $1 ORDER BY f.created_at, f.id`, [id]);
  return claimDto(c, me, cfg, {
    roundActions: actions.filter(a => a.round === c.round),
    actions,
    files: files.map(fileRow),
  });
}

/** 事务内锁住单据并带上判断权限需要的一切 */
async function lockClaim(db, id, me) {
  const { rows } = await db.query(
    `${CLAIM_SELECT} WHERE c.id = $1 FOR UPDATE OF c`, [id]);
  const c = rows[0];
  if (!c) throw notFound('没有这张报销单');
  const cfg = await loadConfig(db);
  const actions = await loadActions(db, id);
  if (!canSee(c, me, cfg, actions)) throw notFound('没有这张报销单');
  return { c, cfg, actions, can: permissions(c, me, cfg) };
}

/* ================= 附件鉴权（给 routes/files.mjs 用） ================= */

export async function assertExpenseFileReadable(file, me) {
  const { rows } = await query('SELECT * FROM expense_claims WHERE id = $1', [file.ref_id]);
  const c = rows[0];
  if (!c) throw notFound('没有这个文件');
  const [cfg, actions] = await Promise.all([loadConfig(), loadActions({ query }, c.id)]);
  if (!canSee(c, me, cfg, actions)) throw notFound('没有这个文件');
}

/** 删附件：只有上传者本人，且单据还处在他能改附件的状态。没有管理员例外。 */
export async function assertExpenseFileDeletable(file, me) {
  const { rows } = await query('SELECT * FROM expense_claims WHERE id = $1', [file.ref_id]);
  const c = rows[0];
  if (!c) throw notFound('没有这个文件');
  const [cfg, actions] = await Promise.all([loadConfig(), loadActions({ query }, c.id)]);
  if (!canSee(c, me, cfg, actions)) throw notFound('没有这个文件');
  if (Number(file.uploaded_by) !== me.id) throw forbidden('只有上传者本人能删除这个附件');
  if (!permissions(c, me, cfg).upload) {
    throw forbidden('报销单已经提交，附件不能再删除；需要修改请让审批人退回');
  }
}

/* ================= 输入校验 ================= */

function parseAmount(v) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) throw badRequest('金额格式不对，填数字，最多两位小数');
  const [int, frac = ''] = s.split('.');
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  if (cents <= 0) throw badRequest('金额必须大于 0');
  if (cents > MAX_CENTS) throw badRequest('金额超出上限');
  return cents;
}

function parseDate(v) {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw badRequest('日期格式不对，应为 YYYY-MM-DD');
  }
  return s;
}

function optText(v, max, label) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw badRequest(`${label}最多 ${max} 个字`);
  return s || null;
}

/** partial=true 时只校验传了的字段（PATCH 用） */
function parseFields(b, cfg, { partial = false } = {}) {
  const out = {};
  const has = k => !partial || b[k] !== undefined;
  if (has('dept')) {
    const dept = String(b.dept ?? '').trim();
    if (!dept) throw badRequest('请选择部门');
    if (!cfg.depts.has(dept)) throw badRequest(`「${dept}」不在报销部门列表里，请联系管理员添加`);
    out.dept = dept;
  }
  if (has('category')) {
    if (!CATEGORY_LABEL[b.category]) throw badRequest('请选择报销类型');
    out.category = b.category;
  }
  if (has('title')) out.title = need(b, 'title', { max: 120, label: '报销事项' });
  if (has('expenseDate')) out.expense_date = parseDate(b.expenseDate);
  if (has('amount')) out.amount_cents = parseAmount(b.amount);
  if (has('note')) out.note = optText(b.note, 2000, '备注');
  return out;
}

/* ================= 流转 ================= */

/**
 * 从 fromIndex 的下一步开始往后找第一个需要人处理的步骤，途中该跳过的写 skip 记录。
 * 规则见文件头第 3 条。返回 { stage, handler }，handler 可能为 null（配置被删了）。
 */
async function advance(db, c, cfg, fromIndex) {
  const { rows } = await db.query(
    `SELECT actor_id FROM expense_claim_actions
      WHERE claim_id = $1 AND round = $2 AND action = 'approve'`, [c.id, c.round]);
  const approved = new Set(rows.map(r => Number(r.actor_id)));
  for (let i = fromIndex + 1; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const h = handlerOf(cfg, stage, c);
    if (stage !== 'cashier' && h) {
      const reason = h.id === Number(c.applicant_id) ? '申请人本人，自动跳过'
        : approved.has(h.id) ? '同一人已在前一步审批通过，自动跳过' : null;
      if (reason) {
        await db.query(
          `INSERT INTO expense_claim_actions(claim_id, round, stage, action, actor_id, comment)
           VALUES($1,$2,$3,'skip',$4,$5)`, [c.id, c.round, stage, h.id, reason]);
        continue;
      }
    }
    await db.query(
      `UPDATE expense_claims SET status = 'pending', stage = $2, updated_at = now() WHERE id = $1`,
      [c.id, stage]);
    return { stage, handler: h };
  }
  throw new Error('expense flow ended without cashier stage');
}

/** 前端带着它当时看到的 stage 来，对不上说明已经被别人处理过了 */
function assertStage(c, b) {
  if (b.stage !== undefined && b.stage !== c.stage) {
    throw conflict('这张报销单已经被处理过了，刷新看看最新状态');
  }
}

const summaryOf = c => `${CATEGORY_LABEL[c.category]} · ¥${yuan(c.amount_cents)} · ${c.title}`;

async function notifyHandler(next, c, actorId) {
  if (!next?.handler) return;
  await notifyUser(next.handler.id, {
    actorId, kind: 'expense', board: 'expenses', refId: Number(c.id),
    title: next.stage === 'cashier'
      ? `${c.applicant_name}的报销单审批完成，等你打款`
      : `${c.applicant_name}提交了报销单，等你审批`,
    body: summaryOf(c),
  });
}

/* ================= 路由 ================= */

export function mount(router) {

  /* ---------- 配置：所有人可读（填单要选部门、看流程），管理员可改 ---------- */
  router.get('/api/expenses/config', async (req, res) => {
    const me = await currentUser(req);
    sendJson(res, 200, configDto(await loadConfig(), me));
  });

  router.patch('/api/expenses/config', async (req, res) => {
    const me = await currentUser(req);
    assertAdmin(me);
    const b = await readJson(req);
    const list = Array.isArray(b.depts) ? b.depts : [];
    if (list.length > 100) throw badRequest('部门太多了');
    const seen = new Set();
    const depts = list.map((d, i) => {
      const dept = String(d?.dept ?? '').trim();
      if (!dept) throw badRequest(`第 ${i + 1} 行的部门名称没填`);
      if (dept.length > 40) throw badRequest(`部门名称「${dept.slice(0, 10)}…」太长了`);
      if (seen.has(dept)) throw badRequest(`部门「${dept}」重复了`);
      seen.add(dept);
      const leaderId = Number(d?.leaderId);
      if (!Number.isInteger(leaderId) || leaderId <= 0) throw badRequest(`请给「${dept}」选部门负责人`);
      return { dept, leaderId };
    });
    const roleIds = {};
    for (const s of STAGES.slice(1)) {
      const v = b[`${s}Id`];
      if (v === null || v === undefined || v === '') { roleIds[s] = null; continue; }
      const id = Number(v);
      if (!Number.isInteger(id) || id <= 0) throw badRequest(`${STAGE_LABEL[s]}选得不对`);
      roleIds[s] = id;
    }
    const ids = [...new Set([...depts.map(d => d.leaderId), ...Object.values(roleIds).filter(Boolean)])];

    await tx(async db => {
      // 串行化并发的配置保存；报销单流转读配置不加锁，改完立即生效
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('expense-config', 0))`);
      if (ids.length) {
        const { rows } = await db.query('SELECT id FROM users WHERE id = ANY($1::bigint[])', [ids]);
        if (rows.length !== ids.length) throw badRequest('选中的人里有账号已经不存在了，刷新后重选');
      }
      // 删掉的部门里如果还有单子等部门负责人审批，那些单子就没人能批了
      const { rows: stuck } = await db.query(`
        SELECT dept, count(*)::int AS n FROM expense_claims
         WHERE status = 'pending' AND stage = 'leader' AND NOT (dept = ANY($1::text[]))
         GROUP BY dept`, [depts.map(d => d.dept)]);
      if (stuck.length) {
        throw conflict(`「${stuck[0].dept}」还有 ${stuck[0].n} 张报销单在等部门负责人审批，不能删除这个部门`);
      }
      await db.query('DELETE FROM expense_dept_leaders');
      for (const [i, d] of depts.entries()) {
        await db.query(
          'INSERT INTO expense_dept_leaders(dept, leader_id, sort) VALUES($1,$2,$3)',
          [d.dept, d.leaderId, i]);
      }
      for (const s of STAGES.slice(1)) {
        if (roleIds[s]) {
          await db.query(`
            INSERT INTO expense_role_holders(role, user_id) VALUES($1,$2)
            ON CONFLICT (role) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()`,
            [s, roleIds[s]]);
        } else {
          await db.query('DELETE FROM expense_role_holders WHERE role = $1', [s]);
        }
      }
    });
    sendJson(res, 200, configDto(await loadConfig(), me));
    publish('expense:updated', {});
  });

  /* ---------- 列表 ----------
     scope: mine 我发起的 | todo 待我处理 | all 我能看见的全部 */
  router.get('/api/expenses', async (req, res, _p, url) => {
    const me = await currentUser(req);
    const scope = q(url, 'scope', 'mine');
    const isLeader = `EXISTS (SELECT 1 FROM expense_dept_leaders d WHERE d.dept = c.dept AND d.leader_id = $1)`;
    const isHolder = `EXISTS (SELECT 1 FROM expense_role_holders r WHERE r.user_id = $1)`;
    const todo = `c.status = 'pending' AND (
        (c.stage = 'leader' AND ${isLeader})
     OR (c.stage <> 'leader' AND EXISTS (
           SELECT 1 FROM expense_role_holders r WHERE r.role = c.stage AND r.user_id = $1)))`;
    const where = scope === 'mine' ? 'c.applicant_id = $1'
      : scope === 'todo' ? todo
        : `(c.applicant_id = $1
            OR EXISTS (SELECT 1 FROM expense_claim_actions x WHERE x.claim_id = c.id AND x.actor_id = $1)
            OR (c.status <> 'draft' AND (${isHolder} OR ${isLeader})))`;

    const [{ rows }, { rows: count }, cfg] = await Promise.all([
      query(`
        ${CLAIM_SELECT}
        LEFT JOIN LATERAL (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'stage', x.stage, 'action', x.action, 'comment', x.comment,
                   'actorId', x.actor_id, 'actorName', u.name) ORDER BY x.id), '[]'::jsonb) AS round_actions
            FROM expense_claim_actions x LEFT JOIN users u ON u.id = x.actor_id
           WHERE x.claim_id = c.id AND x.round = c.round
        ) ra ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS file_count FROM attachments f
           WHERE f.scope = 'expense' AND f.ref_id = c.id
        ) fc ON TRUE
        WHERE ${where}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT 300`, [me.id]),
      query(`SELECT count(*)::int AS n FROM expense_claims c WHERE ${todo}`, [me.id]),
      loadConfig(),
    ]);
    sendJson(res, 200, {
      items: rows.map(c => claimDto(c, me, cfg, {
        roundActions: c.round_actions || [], fileCount: c.file_count,
      })),
      todoCount: count[0].n,
    });
  });

  router.get('/api/expenses/:id', async (req, res, params) => {
    const me = await currentUser(req);
    sendJson(res, 200, await loadDetail(Number(params.id), me));
  });

  /* ---------- 新建草稿 ---------- */
  router.post('/api/expenses', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const f = parseFields(b, await loadConfig());
    const { rows } = await query(`
      INSERT INTO expense_claims(applicant_id, dept, category, title, expense_date, amount_cents, note)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [me.id, f.dept, f.category, f.title, f.expense_date, f.amount_cents, f.note]);
    sendJson(res, 201, await loadDetail(Number(rows[0].id), me));
  });

  /* ---------- 修改：草稿或被退回时，申请人本人 ---------- */
  router.patch('/api/expenses/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    await tx(async db => {
      const { c, cfg, can } = await lockClaim(db, id, me);
      if (!can.edit) throw forbidden(Number(c.applicant_id) === me.id
        ? '报销单审批中，不能修改；需要修改请让审批人退回' : '只有申请人本人能修改报销单');
      const f = parseFields(b, cfg, { partial: true });
      const cols = Object.keys(f);
      if (!cols.length) return;
      await db.query(
        `UPDATE expense_claims SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1`, [id, ...cols.map(k => f[k])]);
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('expense:updated', {});
  });

  /* ---------- 删除：只有从没提交过的草稿 ---------- */
  router.del('/api/expenses/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const files = await tx(async db => {
      const { can } = await lockClaim(db, id, me);
      if (!can.remove) throw forbidden('只有自己的草稿能删除；提交过的报销单请作废');
      const { rows } = await db.query(
        `DELETE FROM attachments WHERE scope = 'expense' AND ref_id = $1 RETURNING stored_name`, [id]);
      await db.query('DELETE FROM expense_claims WHERE id = $1', [id]);
      return rows;
    });
    for (const f of files) await unlink(join(UPLOAD_DIR, basename(f.stored_name))).catch(() => {});
    sendJson(res, 200, { ok: true });
  });

  /* ---------- 提交 / 重新提交 ---------- */
  router.post('/api/expenses/:id/submit', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const { c, next } = await tx(async db => {
      const { c, cfg, can } = await lockClaim(db, id, me);
      if (!can.submit) {
        throw c.status === 'pending' ? conflict('这张报销单已经提交过了')
          : forbidden('只有申请人本人能提交报销单');
      }
      if (!cfg.depts.has(c.dept)) {
        throw badRequest(`「${c.dept}」还没有设置部门负责人，请联系管理员在「审批设置」里补上`);
      }
      for (const s of STAGES.slice(1)) {
        if (!cfg.roles[s]) throw badRequest(`还没有设置${STAGE_LABEL[s]}，请联系管理员在「审批设置」里补上`);
      }
      const { rows: fc } = await db.query(
        `SELECT count(*)::int AS n FROM attachments WHERE scope = 'expense' AND ref_id = $1`, [id]);
      if (!fc[0].n) throw badRequest('请至少上传一份凭证或支付截图再提交');

      c.round += 1;
      await db.query(
        `UPDATE expense_claims SET round = $2, submitted_at = now(), updated_at = now() WHERE id = $1`,
        [id, c.round]);
      await db.query(
        `INSERT INTO expense_claim_actions(claim_id, round, stage, action, actor_id)
         VALUES($1,$2,NULL,'submit',$3)`, [id, c.round, me.id]);
      return { c, next: await advance(db, c, cfg, -1) };
    });
    await notifyHandler(next, c, me.id);
    sendJson(res, 200, await loadDetail(id, me));
    publish('expense:updated', {});
  });

  /* ---------- 审批通过（部门负责人 / 总经理 / 财务） ---------- */
  router.post('/api/expenses/:id/approve', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '审批意见');
    const { c, from, next } = await tx(async db => {
      const { c, cfg, can } = await lockClaim(db, id, me);
      assertStage(c, b);
      if (c.status !== 'pending' || c.stage === 'cashier') {
        throw conflict('这张报销单当前不在审批环节，刷新看看最新状态');
      }
      if (!can.approve) {
        if (Number(c.applicant_id) === me.id) throw forbidden('不能审批自己的报销单');
        const h = handlerOf(cfg, c.stage, c);
        throw forbidden(`这一步应由${STAGE_LABEL[c.stage]}${h ? `（${h.name}）` : ''}审批`);
      }
      const from = c.stage;
      await db.query(
        `INSERT INTO expense_claim_actions(claim_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'approve',$4,$5)`, [id, c.round, from, me.id, comment]);
      return { c, from, next: await advance(db, c, cfg, STAGES.indexOf(from)) };
    });
    await notifyHandler(next, c, me.id);
    await notifyUser(c.applicant_id, {
      actorId: me.id, kind: 'expense', board: 'expenses', refId: id,
      title: `你的报销单已通过${STAGE_LABEL[from]}审批`,
      body: `${c.title} · 下一步：${next.stage === 'cashier' ? '出纳打款' : `${STAGE_LABEL[next.stage]}审批`}`
        + (next.handler ? `（${next.handler.name}）` : ''),
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('expense:updated', {});
  });

  /* ---------- 退回（任何一步的处理人都可以，必须写原因） ---------- */
  router.post('/api/expenses/:id/return', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = need(b, 'comment', { max: 1000, label: '退回原因' });
    const { c, from } = await tx(async db => {
      const { c, cfg, can } = await lockClaim(db, id, me);
      assertStage(c, b);
      if (c.status !== 'pending') throw conflict('这张报销单当前不在审批环节，刷新看看最新状态');
      if (!can.return) {
        const h = handlerOf(cfg, c.stage, c);
        throw forbidden(`这一步应由${STAGE_LABEL[c.stage]}${h ? `（${h.name}）` : ''}处理`);
      }
      const from = c.stage;
      await db.query(
        `INSERT INTO expense_claim_actions(claim_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,$3,'return',$4,$5)`, [id, c.round, from, me.id, comment]);
      await db.query(
        `UPDATE expense_claims SET status = 'returned', stage = NULL, updated_at = now() WHERE id = $1`, [id]);
      return { c, from };
    });
    await notifyUser(c.applicant_id, {
      actorId: me.id, kind: 'expense', board: 'expenses', refId: id,
      title: `你的报销单被${STAGE_LABEL[from]}退回`,
      body: `${c.title} · 原因：${comment}`,
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('expense:updated', {});
  });

  /* ---------- 出纳确认打款 ---------- */
  router.post('/api/expenses/:id/pay', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const comment = optText(b.comment, 1000, '打款备注');
    const c = await tx(async db => {
      const { c, cfg, can } = await lockClaim(db, id, me);
      assertStage(c, b);
      if (c.status !== 'pending' || c.stage !== 'cashier') {
        throw conflict('这张报销单还没走到出纳打款这一步，刷新看看最新状态');
      }
      if (!can.pay) {
        const h = handlerOf(cfg, 'cashier', c);
        throw forbidden(`打款应由出纳${h ? `（${h.name}）` : ''}确认`);
      }
      await db.query(
        `INSERT INTO expense_claim_actions(claim_id, round, stage, action, actor_id, comment)
         VALUES($1,$2,'cashier','pay',$3,$4)`, [id, c.round, me.id, comment]);
      await db.query(
        `UPDATE expense_claims SET status = 'paid', stage = NULL, paid_at = now(), updated_at = now()
          WHERE id = $1`, [id]);
      return c;
    });
    await notifyUser(c.applicant_id, {
      actorId: me.id, kind: 'expense', board: 'expenses', refId: id,
      title: '你的报销单已打款', body: summaryOf(c),
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('expense:updated', {});
  });

  /* ---------- 作废：被退回后申请人不想再报了 ---------- */
  router.post('/api/expenses/:id/cancel', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    await tx(async db => {
      const { c, can } = await lockClaim(db, id, me);
      if (!can.cancel) {
        throw c.status === 'draft' ? badRequest('草稿直接删除即可')
          : forbidden('只有被退回的报销单能由申请人作废');
      }
      await db.query(
        `INSERT INTO expense_claim_actions(claim_id, round, stage, action, actor_id)
         VALUES($1,$2,NULL,'cancel',$3)`, [id, c.round, me.id]);
      await db.query(
        `UPDATE expense_claims SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    });
    sendJson(res, 200, await loadDetail(id, me));
    publish('expense:updated', {});
  });

  /* ---------- 附件上传 ----------
     申请人在草稿 / 退回时传凭证（side=submit）；出纳在打款这一步传打款截图（side=review）。
     先无锁判一次权限，免得没权限的人也把 20MB 写进磁盘；落库前在事务里再判一次，
     防止传文件的这几秒里单子已经被提交走了。 */
  router.post('/api/expenses/:id/files', async (req, res, params, url) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const pre = await tx(db => lockClaim(db, id, me));
    if (!pre.can.upload) throw forbidden('当前状态不能上传附件');

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
        const { c, can } = await lockClaim(db, id, me);
        if (!can.upload) throw conflict('报销单状态已经变了，这个附件没有保存');
        const { rows: fc } = await db.query(
          `SELECT count(*)::int AS n FROM attachments WHERE scope = 'expense' AND ref_id = $1`, [id]);
        if (fc[0].n >= MAX_FILES) throw badRequest(`每张报销单最多 ${MAX_FILES} 个附件`);
        const side = can.edit ? 'submit' : 'review';
        const { rows } = await db.query(`
          INSERT INTO attachments(scope, ref_id, side, orig_name, stored_name, mime, size, uploaded_by)
          VALUES('expense',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [c.id, side, basename(origName), storedName, kind.mime, size, me.id]);
        return rows[0];
      });
    } catch (e) {
      await unlink(diskPath).catch(() => {});
      throw e;
    }
    sendJson(res, 201, fileRow({ ...row, uploader_name: me.name }));
    publish('expense:updated', {});
  });
}
