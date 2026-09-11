/**
 * 报销审批的演示数据与假接口（后端没起、或 ?mock=1 时使用）。
 *
 * 字段和权限规则照抄 server/src/routes/expenses.mjs 的 DTO：界面测试跑在这份数据上，
 * 两边不一致的话，测试通过也证明不了真实页面没问题。演示身份是「陈屿」，担任总经理，
 * 所以「待我处理」里有单子可点。
 */
const STAGES = ['leader', 'gm', 'finance', 'cashier'];
const STAGE_LABEL = { leader: '部门负责人', gm: '总经理', finance: '财务', cashier: '出纳' };
const CATEGORIES = [
  { key: 'office', label: '办公费' }, { key: 'daily', label: '日用费' }, { key: 'travel', label: '差旅费' },
  { key: 'entertainment', label: '业务招待费' }, { key: 'other', label: '其他' },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const ACTION_LABEL = { submit: '提交', approve: '审批通过', skip: '自动跳过', return: '退回', pay: '确认打款', cancel: '作废' };
const NAMES = { 1: '陈屿', 2: '苏禾', 3: '叶昭', 4: '林知远', 6: '何叙', 7: '赵嘉一' };

const CFG = {
  depts: [['产品部', 2], ['内容组', 2], ['技术组', 4]],
  roles: { gm: 1, finance: 3, cashier: 4 },
};

const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
let seq = 9000;
const file = (name, side, by, size = 186_000) =>
  ({ id: ++seq, scope: 'expense', side, name, mime: 'image/png', size, uploaderName: NAMES[by], createdAt: ago(30), url: '#' });
const act = (round, stage, action, actorId, comment, h) =>
  ({ id: ++seq, round, stage, action, actorId, comment: comment || '', createdAt: ago(h) });

const CLAIMS = [
  { id: 101, applicantId: 7, dept: '产品部', category: 'travel', title: '9 月上海客户拜访，高铁往返', expenseDate: '2026-09-08',
    cents: 55350, note: '同行：何叙', status: 'pending', stage: 'gm', round: 1, createdAt: ago(30), submittedAt: ago(26),
    actions: [act(1, null, 'submit', 7, '', 26), act(1, 'leader', 'approve', 2, '行程已核对', 20)],
    files: [file('高铁电子发票.pdf', 'submit', 7), file('行程单截图.png', 'submit', 7)] },
  { id: 102, applicantId: 6, dept: '技术组', category: 'entertainment', title: '合作方技术交流晚餐', expenseDate: '2026-09-05',
    cents: 128000, note: '招待对象：某合作方技术团队 4 人', status: 'pending', stage: 'gm', round: 1, createdAt: ago(50), submittedAt: ago(48),
    actions: [act(1, null, 'submit', 6, '', 48), act(1, 'leader', 'approve', 4, '', 40)],
    files: [file('餐饮发票.jpg', 'submit', 6), file('支付截图.png', 'submit', 6)] },
  { id: 103, applicantId: 1, dept: '产品部', category: 'office', title: '打印机墨盒两套', expenseDate: '2026-09-03',
    cents: 38600, note: '', status: 'pending', stage: 'finance', round: 1, createdAt: ago(80), submittedAt: ago(76),
    actions: [act(1, null, 'submit', 1, '', 76), act(1, 'leader', 'approve', 2, '', 70), act(1, 'gm', 'skip', 1, '申请人本人，自动跳过', 70)],
    files: [file('墨盒发票.pdf', 'submit', 1)] },
  { id: 104, applicantId: 1, dept: '产品部', category: 'daily', title: '办公室桶装饮用水', expenseDate: '2026-09-01',
    cents: 9600, note: '', status: 'returned', stage: null, round: 1, createdAt: ago(120), submittedAt: ago(118),
    actions: [act(1, null, 'submit', 1, '', 118), act(1, 'leader', 'return', 2, '缺少送水单照片，补上后重新提交', 100)],
    files: [file('支付截图.png', 'submit', 1)] },
  { id: 105, applicantId: 7, dept: '产品部', category: 'travel', title: '8 月杭州展会住宿', expenseDate: '2026-08-22',
    cents: 214000, note: '', status: 'paid', stage: null, round: 1, createdAt: ago(400), submittedAt: ago(396), paidAt: ago(300),
    actions: [act(1, null, 'submit', 7, '', 396), act(1, 'leader', 'approve', 2, '', 380), act(1, 'gm', 'approve', 1, '', 360),
      act(1, 'finance', 'approve', 3, '票据齐全', 330), act(1, 'cashier', 'pay', 4, '已银行转账', 300)],
    files: [file('酒店发票.pdf', 'submit', 7), file('打款回单.png', 'review', 4)] },
  { id: 106, applicantId: 1, dept: '产品部', category: 'other', title: '团建场地定金', expenseDate: '2026-09-10',
    cents: 80000, note: '', status: 'draft', stage: null, round: 0, createdAt: ago(3), actions: [], files: [] },
];
for (const c of CLAIMS) c.updatedAt = c.actions.at(-1)?.createdAt || c.createdAt;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const person = id => (id ? { id, name: NAMES[id] || `用户 ${id}` } : null);
const deptLeader = dept => CFG.depts.find(d => d[0] === dept)?.[1] || null;
const handlerId = (c, stage) => (stage === 'leader' ? deptLeader(c.dept) : CFG.roles[stage] || null);

function configDto(me) {
  const missing = [];
  if (!CFG.depts.length) missing.push('部门负责人');
  for (const s of STAGES.slice(1)) if (!CFG.roles[s]) missing.push(STAGE_LABEL[s]);
  return {
    categories: CATEGORIES,
    stages: STAGES.map(key => ({ key, label: STAGE_LABEL[key] })),
    depts: CFG.depts.map(([dept, id]) => ({ dept, leader: person(id) })),
    roles: Object.fromEntries(STAGES.slice(1).map(s => [s, person(CFG.roles[s])])),
    ready: !missing.length, missing,
    myDept: CFG.depts.some(d => d[0] === me.dept) ? me.dept : null,
    myDuties: { leadDepts: CFG.depts.filter(d => d[1] === me.id).map(d => d[0]),
      roles: STAGES.slice(1).filter(s => CFG.roles[s] === me.id) },
  };
}

function canSee(c, me) {
  if (c.applicantId === me.id || c.actions.some(a => a.actorId === me.id)) return true;
  if (c.status === 'draft') return false;
  return STAGES.slice(1).some(s => CFG.roles[s] === me.id) || deptLeader(c.dept) === me.id;
}

function can(c, me) {
  const mine = c.applicantId === me.id;
  const editable = mine && (c.status === 'draft' || c.status === 'returned');
  const handling = c.status === 'pending' && handlerId(c, c.stage) === me.id;
  return {
    edit: editable, submit: editable, remove: mine && c.status === 'draft', cancel: mine && c.status === 'returned',
    approve: handling && c.stage !== 'cashier' && !mine, return: handling,
    pay: handling && c.stage === 'cashier', upload: editable || (handling && c.stage === 'cashier'),
  };
}

function dto(c, me, full) {
  const roundActions = c.actions.filter(a => a.round === c.round);
  const flow = STAGES.map(stage => {
    const last = roundActions.filter(a => a.stage === stage).at(-1);
    const state = last?.action === 'approve' || last?.action === 'pay' ? 'done'
      : last?.action === 'skip' ? 'skipped' : last?.action === 'return' ? 'returned'
        : c.status === 'pending' && c.stage === stage ? 'current' : 'waiting';
    return { stage, label: STAGE_LABEL[stage], state, handler: person(last ? last.actorId : handlerId(c, stage)) };
  });
  const ret = c.actions.filter(a => a.action === 'return').at(-1);
  return {
    id: c.id, code: `BX-2026-${String(c.id).padStart(4, '0')}`, applicant: person(c.applicantId), dept: c.dept,
    category: c.category, categoryLabel: CAT[c.category], title: c.title, expenseDate: c.expenseDate,
    amount: (c.cents / 100).toFixed(2), amountCents: c.cents, note: c.note || '', status: c.status, stage: c.stage,
    statusLabel: c.status === 'pending' ? (c.stage === 'cashier' ? '待出纳打款' : `${STAGE_LABEL[c.stage]}审批中`)
      : { draft: '草稿', returned: '已退回', paid: '已打款', cancelled: '已作废' }[c.status],
    round: c.round, handler: c.status === 'pending' ? person(handlerId(c, c.stage)) : null, flow,
    returnReason: c.status === 'returned' && ret
      ? { by: person(ret.actorId), stageLabel: STAGE_LABEL[ret.stage], comment: ret.comment } : null,
    fileCount: c.files.length, submittedAt: c.submittedAt || null, paidAt: c.paidAt || null,
    createdAt: c.createdAt, updatedAt: c.updatedAt, can: can(c, me),
    ...(full ? {
      actions: c.actions.map(a => ({ ...a, stageLabel: STAGE_LABEL[a.stage] || '', actionLabel: ACTION_LABEL[a.action],
        actor: person(a.actorId) })),
      files: c.files.map(f => ({ ...f, refId: c.id })),
    } : {}),
  };
}

function fields(b, partial) {
  const out = {};
  const has = k => !partial || b[k] !== undefined;
  if (has('dept')) { if (!deptLeader(b.dept)) throw fail('请选择部门'); out.dept = b.dept; }
  if (has('category')) { if (!CAT[b.category]) throw fail('请选择报销类型'); out.category = b.category; }
  if (has('title')) { if (!String(b.title || '').trim()) throw fail('报销事项 不能为空'); out.title = String(b.title).trim(); }
  if (has('expenseDate')) { if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expenseDate || '')) throw fail('日期格式不对'); out.expenseDate = b.expenseDate; }
  if (has('amount')) {
    const s = String(b.amount ?? '').replace(/,/g, '');
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw fail('金额格式不对，填数字，最多两位小数');
    out.cents = Math.round(Number(s) * 100);
  }
  if (has('note')) out.note = String(b.note || '').trim();
  return out;
}

function advance(c, fromIndex) {
  const approved = new Set(c.actions.filter(a => a.round === c.round && a.action === 'approve').map(a => a.actorId));
  for (let i = fromIndex + 1; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const h = handlerId(c, stage);
    if (stage !== 'cashier' && h && (h === c.applicantId || approved.has(h))) {
      c.actions.push(act(c.round, stage, 'skip', h, h === c.applicantId ? '申请人本人，自动跳过' : '同一人已在前一步审批通过，自动跳过', 0));
      continue;
    }
    c.status = 'pending';
    c.stage = stage;
    return;
  }
}

/** 命中报销接口就返回结果，不是报销接口返回 undefined，交给 mock.js 继续匹配 */
export function handleExpenses(method, p, q, body, me) {
  if (p === '/api/expenses/config' && method === 'GET') return configDto(me);
  if (p === '/api/expenses/config' && method === 'PATCH') {
    if (me.role !== 'admin') throw fail('只有管理员可以做这个操作', 403);
    CFG.depts = (body.depts || []).map(d => {
      if (!String(d.dept || '').trim()) throw fail('部门名称没填');
      if (!d.leaderId) throw fail(`请给「${d.dept}」选部门负责人`);
      return [String(d.dept).trim(), Number(d.leaderId)];
    });
    for (const s of STAGES.slice(1)) CFG.roles[s] = body[`${s}Id`] ? Number(body[`${s}Id`]) : null;
    return configDto(me);
  }
  if (p === '/api/expenses' && method === 'GET') {
    const scope = q.get('scope') || 'mine';
    const todo = c => c.status === 'pending' && handlerId(c, c.stage) === me.id;
    const items = CLAIMS.filter(c => (scope === 'mine' ? c.applicantId === me.id : scope === 'todo' ? todo(c) : canSee(c, me)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { items: items.map(c => dto(c, me, false)), todoCount: CLAIMS.filter(todo).length };
  }
  if (p === '/api/expenses' && method === 'POST') {
    const f = fields(body || {}, false);
    const c = { id: ++seq, applicantId: me.id, status: 'draft', stage: null, round: 0, createdAt: new Date().toISOString(),
      actions: [], files: [], note: '', ...f };
    c.updatedAt = c.createdAt;
    CLAIMS.unshift(c);
    return dto(c, me, true);
  }

  const m = p.match(/^\/api\/expenses\/(\d+)(?:\/(submit|approve|return|pay|cancel|files))?$/);
  if (!m) {
    const del = p.match(/^\/api\/files\/(\d+)$/);
    if (del && method === 'DELETE') {
      const c = CLAIMS.find(x => x.files.some(f => f.id === Number(del[1])));
      if (!c) return undefined;
      if (!can(c, me).upload) throw fail('报销单已经提交，附件不能再删除；需要修改请让审批人退回', 403);
      c.files = c.files.filter(f => f.id !== Number(del[1]));
      return { ok: true };
    }
    return undefined;
  }
  const c = CLAIMS.find(x => x.id === Number(m[1]));
  if (!c || !canSee(c, me)) throw fail('没有这张报销单', 404);
  const allowed = can(c, me);
  const touch = () => { c.updatedAt = new Date().toISOString(); return dto(c, me, true); };
  const stageCheck = () => { if (body?.stage !== undefined && body.stage !== c.stage) throw fail('这张报销单已经被处理过了，刷新看看最新状态', 409); };

  if (!m[2] && method === 'GET') return dto(c, me, true);
  if (!m[2] && method === 'PATCH') {
    if (!allowed.edit) throw fail('报销单审批中，不能修改', 403);
    Object.assign(c, fields(body || {}, true));
    return touch();
  }
  if (!m[2] && method === 'DELETE') {
    if (!allowed.remove) throw fail('只有自己的草稿能删除', 403);
    CLAIMS.splice(CLAIMS.indexOf(c), 1);
    return { ok: true };
  }
  if (m[2] === 'files' && method === 'POST') {
    if (!allowed.upload) throw fail('当前状态不能上传附件', 403);
    const f = file(q.get('name') || body?.name || '附件.png', allowed.edit ? 'submit' : 'review', me.id, Number(body?.size || 1024));
    c.files.push(f);
    c.updatedAt = new Date().toISOString();
    return { ...f, refId: c.id };
  }
  if (method !== 'POST') return undefined;
  if (m[2] === 'submit') {
    if (!allowed.submit) throw fail('只有申请人本人能提交报销单', 403);
    if (!c.files.length) throw fail('请至少上传一份凭证或支付截图再提交');
    c.round += 1;
    c.submittedAt = new Date().toISOString();
    c.actions.push(act(c.round, null, 'submit', me.id, '', 0));
    advance(c, -1);
    return touch();
  }
  if (m[2] === 'approve') {
    stageCheck();
    if (!allowed.approve) throw fail('这一步不该由你审批', 403);
    const from = c.stage;
    c.actions.push(act(c.round, from, 'approve', me.id, body?.comment, 0));
    advance(c, STAGES.indexOf(from));
    return touch();
  }
  if (m[2] === 'return') {
    stageCheck();
    if (!allowed.return) throw fail('这一步不该由你处理', 403);
    if (!String(body?.comment || '').trim()) throw fail('退回原因 不能为空');
    c.actions.push(act(c.round, c.stage, 'return', me.id, body.comment, 0));
    c.status = 'returned';
    c.stage = null;
    return touch();
  }
  if (m[2] === 'pay') {
    stageCheck();
    if (!allowed.pay) throw fail('打款应由出纳确认', 403);
    c.actions.push(act(c.round, 'cashier', 'pay', me.id, body?.comment, 0));
    c.status = 'paid';
    c.stage = null;
    c.paidAt = new Date().toISOString();
    return touch();
  }
  if (m[2] === 'cancel') {
    if (!allowed.cancel) throw fail('只有被退回的报销单能由申请人作废', 403);
    c.actions.push(act(c.round, null, 'cancel', me.id, '', 0));
    c.status = 'cancelled';
    return touch();
  }
  return undefined;
}
