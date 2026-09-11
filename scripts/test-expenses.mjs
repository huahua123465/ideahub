/**
 * 报销审批接口测试：npm run test:expenses
 *
 * 需要后端已经带 ALLOW_HEADER_AUTH=1 在 TEST_BASE（默认 http://127.0.0.1:3000）上跑着，
 * 且数据库已 seed。**只能对测试库跑**：会改写报销审批配置，跑完按原样恢复，
 * 并删掉自己建的报销单。
 *
 * 用种子用户扮演流程里的角色（按姓名查 id，不写死数字）：
 *   管理员        陈屿   —— 只配置流程，不在审批链上，验证「管理员没有特权」
 *   产品部负责人  苏禾
 *   技术部负责人  林知远
 *   总经理        何叙
 *   财务          周未
 *   出纳          叶昭
 *   申请人        赵嘉一（产品部）
 *   无关的人      王明轩（技术部）
 * 报销单的部门取管理员给申请人分配的部门，跑之前统一分好，跑完恢复原来的部门。
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const BASE = process.env.TEST_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const { query: dbq, close } = await import('../server/src/db/index.mjs');

const NAMES = ['陈屿', '苏禾', '林知远', '何叙', '周未', '叶昭', '赵嘉一', '王明轩'];
const id = {};
{
  const { rows } = await dbq(
    'SELECT id, name FROM users WHERE name = ANY($1) AND password_hash IS NULL', [NAMES]);
  for (const r of rows) id[r.name] = Number(r.id);
  const missing = NAMES.filter(n => !id[n]);
  if (missing.length) throw new Error(`种子用户缺失：${missing.join('、')}，先 npm run db:seed`);
}
const ADMIN = id['陈屿'], LEAD_P = id['苏禾'], LEAD_T = id['林知远'], GM = id['何叙'];
const FIN = id['周未'], CASH = id['叶昭'], APP = id['赵嘉一'], OUT = id['王明轩'];

async function call(user, method, path, body, { raw } = {}) {
  const headers = { 'x-user-id': String(user) };
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 文件下载等非 JSON */ }
  return { status: r.status, data };
}
const upload = (user, claimId, name, bytes = Buffer.from('fake-image-bytes')) =>
  call(user, 'POST', `/api/expenses/${claimId}/files?name=${encodeURIComponent(name)}`, bytes, { raw: true });

const created = [];
async function newClaim(user, over = {}) {
  const r = await call(user, 'POST', '/api/expenses', {
    dept: '产品部', category: 'travel', title: '测试·上海出差高铁票',
    expenseDate: '2026-09-08', amount: '553.50', note: '往返', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created.push(r.data.id);
  return r.data;
}
async function submitted(user, over) {
  const c = await newClaim(user, over);
  assert.equal((await upload(user, c.id, '发票.png')).status, 201);
  const r = await call(user, 'POST', `/api/expenses/${c.id}/submit`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const setConfig = (over = {}) => call(ADMIN, 'PATCH', '/api/expenses/config', {
  depts: [{ dept: '产品部', leaderId: LEAD_P }, { dept: '技术部', leaderId: LEAD_T }],
  gmId: GM, financeId: FIN, cashierId: CASH, ...over,
});

// 跑之前把原配置和这几个人原来的部门存下来，跑完原样放回去
const snapshot = {
  depts: (await dbq('SELECT dept, leader_id, sort FROM expense_dept_leaders')).rows,
  roles: (await dbq('SELECT role, user_id FROM expense_role_holders')).rows,
  userDepts: (await dbq('SELECT id, dept FROM users WHERE id = ANY($1::bigint[])', [Object.values(id)])).rows,
};
const setDept = (user, dept, as = ADMIN) => call(as, 'PATCH', `/api/admin/users/${user}/dept`, { dept });
for (const [u, d] of [[APP, '产品部'], [LEAD_P, '产品部'], [CASH, '产品部'], [LEAD_T, '技术部'], [OUT, '技术部']]) {
  const r = await setDept(u, d);
  if (r.status !== 200) throw new Error(`分配部门失败：${JSON.stringify(r.data)}`);
}

after(async () => {
  if (created.length) {
    await dbq(`DELETE FROM attachments WHERE scope = 'expense' AND ref_id = ANY($1::bigint[])`, [created]);
    await dbq(`DELETE FROM notifications WHERE board = 'expenses' AND ref_id = ANY($1::bigint[])`, [created]);
    await dbq('DELETE FROM expense_claims WHERE id = ANY($1::bigint[])', [created]);
  }
  await dbq('DELETE FROM expense_dept_leaders');
  await dbq('DELETE FROM expense_role_holders');
  for (const d of snapshot.depts) {
    await dbq('INSERT INTO expense_dept_leaders(dept, leader_id, sort) VALUES($1,$2,$3)', [d.dept, d.leader_id, d.sort]);
  }
  for (const r of snapshot.roles) {
    await dbq('INSERT INTO expense_role_holders(role, user_id) VALUES($1,$2)', [r.role, r.user_id]);
  }
  for (const u of snapshot.userDepts) await dbq('UPDATE users SET dept = $2 WHERE id = $1', [u.id, u.dept]);
  await close();
});

test('配置：只有管理员能改，校验输入，未配置时不能提交', async () => {
  assert.equal((await call(GM, 'PATCH', '/api/expenses/config', {})).status, 403);
  assert.equal((await setConfig({ depts: [{ dept: '产品部', leaderId: 99999999 }] })).status, 400);
  assert.equal((await setConfig({ depts: [{ dept: '产品部', leaderId: LEAD_P }, { dept: '产品部', leaderId: LEAD_T }] })).status, 400);

  // 先缺出纳，草稿能建但提交会被拦
  const partial = await setConfig({ cashierId: null });
  assert.equal(partial.status, 200);
  assert.equal(partial.data.ready, false);
  assert.deepEqual(partial.data.missing, ['出纳']);
  const c = await newClaim(APP);
  assert.equal((await upload(APP, c.id, '发票.png')).status, 201);
  const blocked = await call(APP, 'POST', `/api/expenses/${c.id}/submit`, {});
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /出纳/);

  const full = await setConfig();
  assert.equal(full.status, 200);
  assert.equal(full.data.ready, true);
  const read = await call(OUT, 'GET', '/api/expenses/config');
  assert.equal(read.status, 200, '所有登录用户都能读配置（填单要选部门）');
  assert.deepEqual(read.data.depts.map(d => d.dept), ['产品部', '技术部']);
});

test('建草稿：字段校验', async () => {
  const bad = async (over, re) => {
    const r = await call(APP, 'POST', '/api/expenses', {
      dept: '产品部', category: 'office', title: '打印纸', expenseDate: '2026-09-01', amount: '10', ...over,
    });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.error, re);
  };
  await bad({ amount: '0' }, /大于 0/);
  await bad({ amount: '12.345' }, /金额格式/);
  await bad({ amount: '-5' }, /金额格式/);
  await bad({ category: 'bribe' }, /报销类型/);
  await bad({ expenseDate: '2026-02-30' }, /日期/);
  await bad({ title: '  ' }, /报销事项/);

  // 请求里带的部门被忽略，一律用管理员给申请人分配的部门
  const c = await newClaim(APP, { amount: '1,234.5', dept: '技术部' });
  assert.equal(c.dept, '产品部');
  assert.equal(c.amount, '1234.50');
  assert.equal(c.amountCents, 123450);
  assert.equal(c.status, 'draft');
  assert.equal(c.expenseDate, '2026-09-08');
  assert.match(c.code, /^BX-\d{4}-\d{4,}$/);
  assert.deepEqual(c.flow.map(s => [s.stage, s.state, s.handler?.id]),
    [['leader', 'waiting', LEAD_P], ['gm', 'waiting', GM], ['finance', 'waiting', FIN], ['cashier', 'waiting', CASH]]);
  assert.equal(c.can.edit && c.can.submit && c.can.remove && c.can.upload, true);
});

test('部门由管理员分配：没分配不能发起，提交时按当时的部门送审', async () => {
  assert.equal((await setDept(APP, '技术部', GM)).status, 403, '非管理员不能改部门');
  assert.equal((await setDept(APP, 'x'.repeat(41))).status, 400);
  assert.equal((await setDept(99999999, '产品部')).status, 404);

  // 管理员看得到分配情况，普通人看不到
  const adminCfg = await call(ADMIN, 'GET', '/api/expenses/config');
  assert.equal(typeof adminCfg.data.unassigned, 'number');
  assert.equal(typeof adminCfg.data.deptMembers, 'object');
  const appCfg = await call(APP, 'GET', '/api/expenses/config');
  assert.equal(appCfg.data.deptMembers, undefined);
  assert.equal(appCfg.data.myDept, '产品部');
  assert.equal(appCfg.data.myDeptReady, true);

  // 没分配部门：不能发起
  assert.equal((await setDept(APP, '')).data.dept, null);
  const none = await call(APP, 'POST', '/api/expenses', {
    category: 'office', title: '打印纸', expenseDate: '2026-09-01', amount: '10',
  });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /还没有被分配部门/);
  assert.equal((await call(APP, 'GET', '/api/expenses/config')).data.myDept, null);

  // 草稿建在产品部，提交前被调到技术部 → 提交时送技术部负责人
  await setDept(APP, '产品部');
  const moved = await newClaim(APP);
  assert.equal(moved.dept, '产品部');
  assert.equal((await upload(APP, moved.id, '发票.png')).status, 201);
  await setDept(APP, '技术部');
  const sub = await call(APP, 'POST', `/api/expenses/${moved.id}/submit`, {});
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.equal(sub.data.dept, '技术部');
  assert.equal(sub.data.handler.id, LEAD_T);
  assert.equal((await call(LEAD_P, 'GET', `/api/expenses/${moved.id}`)).status, 404, '原部门负责人不再看得到');

  // 分到了一个还没设负责人的部门：草稿能建，提交被拦
  await setDept(APP, '市场部');
  const market = await newClaim(APP);
  assert.equal(market.dept, '市场部');
  assert.equal((await upload(APP, market.id, '发票.png')).status, 201);
  const blocked = await call(APP, 'POST', `/api/expenses/${market.id}/submit`, {});
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /市场部.*部门负责人/);
  await setDept(APP, '产品部');
});

test('草稿只有申请人看得见；没附件不能提交；草稿可删且带走附件', async () => {
  const c = await newClaim(APP);
  for (const u of [LEAD_P, GM, FIN, ADMIN, OUT]) {
    assert.equal((await call(u, 'GET', `/api/expenses/${c.id}`)).status, 404, `user ${u} 不该看到草稿`);
  }
  const noFile = await call(APP, 'POST', `/api/expenses/${c.id}/submit`, {});
  assert.equal(noFile.status, 400);
  assert.match(noFile.data.error, /凭证/);

  assert.equal((await upload(OUT, c.id, '发票.png')).status, 404, '外人传附件 = 看不见这张单');
  assert.equal((await upload(APP, c.id, '脚本.exe')).status, 400);
  const f = await upload(APP, c.id, '发票.png');
  assert.equal(f.status, 201);
  assert.equal(f.data.side, 'submit');

  assert.equal((await call(LEAD_P, 'DELETE', `/api/expenses/${c.id}`)).status, 404);
  assert.equal((await call(APP, 'DELETE', `/api/expenses/${c.id}`)).status, 200);
  assert.equal((await call(APP, 'GET', `/api/expenses/${c.id}`)).status, 404);
  assert.equal((await call(APP, 'GET', `/api/files/${f.data.id}`)).status, 404);
});

test('完整流程：退回修改重提 → 四级审批 → 打款，权限和留痕都对', async () => {
  const c = await submitted(APP);
  assert.equal(c.status, 'pending');
  assert.equal(c.stage, 'leader');
  assert.equal(c.statusLabel, '部门负责人审批中');
  assert.equal(c.handler.id, LEAD_P);
  assert.equal(c.can.edit, false);

  // 通知到了部门负责人
  const n = await call(LEAD_P, 'GET', '/api/notifications');
  assert.ok(n.data.items.some(x => x.board === 'expenses' && x.refId === c.id), '部门负责人应收到待审批通知');

  // 提交后：申请人不能改、不能删附件；外人和管理员看不见
  assert.equal((await call(APP, 'PATCH', `/api/expenses/${c.id}`, { amount: '1' })).status, 403);
  const detail = await call(APP, 'GET', `/api/expenses/${c.id}`);
  const fileId = detail.data.files[0].id;
  assert.equal((await call(APP, 'DELETE', `/api/files/${fileId}`)).status, 403);
  assert.equal((await call(ADMIN, 'DELETE', `/api/files/${fileId}`)).status, 404, '管理员也不能删别人报销凭证');
  for (const u of [OUT, ADMIN, LEAD_T]) {
    assert.equal((await call(u, 'GET', `/api/expenses/${c.id}`)).status, 404, `user ${u}`);
    assert.equal((await call(u, 'GET', `/api/files/${fileId}`)).status, 404, `user ${u} 不能下载凭证`);
  }
  for (const u of [LEAD_P, GM, FIN, CASH]) {
    assert.equal((await call(u, 'GET', `/api/expenses/${c.id}`)).status, 200, `审批链上的 ${u} 应能看`);
  }
  const dl = await fetch(`${BASE}/api/files/${fileId}`, { headers: { 'x-user-id': String(LEAD_P) } });
  assert.equal(dl.status, 200);

  // 不是这一步的人不能批；stage 对不上回 409
  assert.equal((await call(GM, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' })).status, 403);
  assert.equal((await call(APP, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' })).status, 403);
  assert.equal((await call(OUT, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' })).status, 404);
  assert.equal((await call(LEAD_P, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'gm' })).status, 409);
  assert.equal((await call(LEAD_P, 'POST', `/api/expenses/${c.id}/pay`, { stage: 'leader' })).status, 409);

  const a1 = await call(LEAD_P, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader', comment: '同意' });
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  assert.equal(a1.data.stage, 'gm');
  assert.equal((await call(LEAD_P, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' })).status, 409, '重复点击');

  // 待我审批
  const todoGm = await call(GM, 'GET', '/api/expenses?scope=todo');
  assert.ok(todoGm.data.items.some(x => x.id === c.id));
  assert.ok(todoGm.data.todoCount >= 1);
  const todoLead = await call(LEAD_P, 'GET', '/api/expenses?scope=todo');
  assert.ok(!todoLead.data.items.some(x => x.id === c.id));

  // 总经理退回：必须写原因
  assert.equal((await call(GM, 'POST', `/api/expenses/${c.id}/return`, { stage: 'gm' })).status, 400);
  const ret = await call(GM, 'POST', `/api/expenses/${c.id}/return`, { stage: 'gm', comment: '缺少行程单' });
  assert.equal(ret.status, 200);
  assert.equal(ret.data.status, 'returned');
  assert.equal(ret.data.returnReason.comment, '缺少行程单');
  const appN = await call(APP, 'GET', '/api/notifications');
  assert.ok(appN.data.items.some(x => x.refId === c.id && /退回/.test(x.title)));

  // 申请人修改、补附件、重新提交，从部门负责人重新走
  const mine = await call(APP, 'GET', `/api/expenses/${c.id}`);
  assert.equal(mine.data.can.edit && mine.data.can.cancel && !mine.data.can.remove, true);
  assert.equal((await call(APP, 'PATCH', `/api/expenses/${c.id}`, { amount: '600' })).data.amount, '600.00');
  assert.equal((await upload(APP, c.id, '行程单.pdf')).status, 201);
  const re = await call(APP, 'POST', `/api/expenses/${c.id}/submit`, {});
  assert.equal(re.data.round, 2);
  assert.equal(re.data.stage, 'leader');
  assert.deepEqual(re.data.flow.map(s => s.state), ['current', 'waiting', 'waiting', 'waiting']);

  for (const [u, stage] of [[LEAD_P, 'leader'], [GM, 'gm'], [FIN, 'finance']]) {
    const r = await call(u, 'POST', `/api/expenses/${c.id}/approve`, { stage });
    assert.equal(r.status, 200, `${stage}: ${JSON.stringify(r.data)}`);
  }
  const atCashier = await call(CASH, 'GET', `/api/expenses/${c.id}`);
  assert.equal(atCashier.data.stage, 'cashier');
  assert.equal(atCashier.data.statusLabel, '待出纳打款');
  assert.equal(atCashier.data.can.pay && atCashier.data.can.upload && !atCashier.data.can.approve, true);
  assert.equal((await call(FIN, 'POST', `/api/expenses/${c.id}/pay`, { stage: 'cashier' })).status, 403);
  assert.equal((await call(CASH, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'cashier' })).status, 409);
  assert.equal((await upload(APP, c.id, '补充.png')).status, 403, '审批中申请人不能再传附件');

  const proof = await upload(CASH, c.id, '打款截图.png');
  assert.equal(proof.status, 201);
  assert.equal(proof.data.side, 'review');
  const paid = await call(CASH, 'POST', `/api/expenses/${c.id}/pay`, { stage: 'cashier', comment: '已转账' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, 'paid');
  assert.ok(paid.data.paidAt);
  assert.deepEqual(paid.data.flow.map(s => s.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(
    paid.data.actions.map(a => `${a.round}:${a.stage || '-'}:${a.action}`),
    ['1:-:submit', '1:leader:approve', '1:gm:return',
      '2:-:submit', '2:leader:approve', '2:gm:approve', '2:finance:approve', '2:cashier:pay']);
  assert.equal((await call(CASH, 'DELETE', `/api/files/${proof.data.id}`)).status, 403, '打款后凭证锁定');
  assert.equal(Object.values(paid.data.can).some(Boolean), false);
});

test('自动跳过：申请人本人是负责人；同一人兼任连续两步', async () => {
  // 苏禾自己就是产品部负责人 → 直接到总经理
  const own = await submitted(LEAD_P);
  assert.equal(own.stage, 'gm');
  assert.equal(own.flow[0].state, 'skipped');
  assert.equal(own.flow[0].handler.id, LEAD_P);
  assert.match(own.actions.find(a => a.action === 'skip').comment, /申请人本人/);

  // 林知远兼任技术部负责人和总经理 → 他批完部门这一步，总经理那步自动跳过
  assert.equal((await setConfig({ gmId: LEAD_T })).status, 200);
  const tech = await submitted(OUT, { dept: '技术部' });
  assert.equal(tech.stage, 'leader');
  const a = await call(LEAD_T, 'POST', `/api/expenses/${tech.id}/approve`, { stage: 'leader' });
  assert.equal(a.data.stage, 'finance');
  assert.deepEqual(a.data.flow.map(s => s.state), ['done', 'skipped', 'current', 'waiting']);

  // 总经理自己报销 → 部门、总经理两步都跳过（总经理此刻是林知远，技术部负责人也是他）
  const gmOwn = await submitted(LEAD_T, { dept: '技术部' });
  assert.equal(gmOwn.stage, 'finance');

  // 出纳自己报销：打款这一步不跳过，仍由出纳确认
  assert.equal((await setConfig()).status, 200);
  const cashOwn = await submitted(CASH);
  for (const [u, stage] of [[LEAD_P, 'leader'], [GM, 'gm'], [FIN, 'finance']]) {
    assert.equal((await call(u, 'POST', `/api/expenses/${cashOwn.id}/approve`, { stage })).status, 200);
  }
  assert.equal((await call(CASH, 'GET', `/api/expenses/${cashOwn.id}`)).data.stage, 'cashier');
});

test('并发：同一步同时点两次，只记一次', async () => {
  const c = await submitted(APP);
  const rs = await Promise.all([
    call(LEAD_P, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' }),
    call(LEAD_P, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' }),
  ]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  const { rows } = await dbq(
    `SELECT count(*)::int AS n FROM expense_claim_actions WHERE claim_id = $1 AND action = 'approve'`, [c.id]);
  assert.equal(rows[0].n, 1);
});

test('作废、配置变更时的保护、列表可见范围', async () => {
  const c = await submitted(APP);
  // 还有单子在等部门负责人时，不能删掉那个部门
  const drop = await setConfig({ depts: [{ dept: '技术部', leaderId: LEAD_T }] });
  assert.equal(drop.status, 409);
  assert.match(drop.data.error, /产品部/);

  // 换部门负责人：卡在路上的单子立刻转给新的人
  assert.equal((await setConfig({ depts: [{ dept: '产品部', leaderId: OUT }, { dept: '技术部', leaderId: LEAD_T }] })).status, 200);
  assert.equal((await call(LEAD_P, 'POST', `/api/expenses/${c.id}/approve`, { stage: 'leader' })).status, 404,
    '旧负责人没经手过、也不再负责，看不见');
  assert.equal((await call(OUT, 'GET', `/api/expenses/${c.id}`)).data.handler.id, OUT);
  assert.equal((await setConfig()).status, 200);

  const r = await call(LEAD_P, 'POST', `/api/expenses/${c.id}/return`, { stage: 'leader', comment: '金额不对' });
  assert.equal(r.status, 200);
  assert.equal((await call(LEAD_P, 'POST', `/api/expenses/${c.id}/cancel`, {})).status, 403);
  const x = await call(APP, 'POST', `/api/expenses/${c.id}/cancel`, {});
  assert.equal(x.data.status, 'cancelled');
  assert.equal((await call(APP, 'POST', `/api/expenses/${c.id}/submit`, {})).status, 403);
  assert.equal((await call(APP, 'DELETE', `/api/expenses/${c.id}`)).status, 403, '提交过的单子不能删');

  const draft = await newClaim(APP);
  const ids = res => res.data.items.map(i => i.id);
  const finAll = await call(FIN, 'GET', '/api/expenses?scope=all');
  assert.ok(ids(finAll).includes(c.id));
  assert.ok(!ids(finAll).includes(draft.id), '财务看不到别人的草稿');
  const leadAll = await call(LEAD_P, 'GET', '/api/expenses?scope=all');
  assert.ok(ids(leadAll).includes(c.id), '经手过的单子留在经手人的「全部」里');
  for (const u of [ADMIN, OUT]) {
    const all = await call(u, 'GET', '/api/expenses?scope=all');
    assert.ok(!ids(all).includes(c.id) && !ids(all).includes(draft.id), `user ${u} 不该看到`);
  }
  const mineList = await call(APP, 'GET', '/api/expenses?scope=mine');
  assert.ok(ids(mineList).includes(c.id) && ids(mineList).includes(draft.id));
});
