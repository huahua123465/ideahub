/**
 * 采购申请接口测试：npm run test:purchases
 *
 * 需要后端已经带 ALLOW_HEADER_AUTH=1 在 TEST_BASE（默认 http://127.0.0.1:3000）上跑着，
 * 且数据库已 seed。**只能对测试库跑**：会改写审批配置（采购和报销共用），跑完按原样恢复，
 * 并删掉自己建的采购申请。
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
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const BASE = process.env.TEST_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const { query: dbq, close } = await import('../server/src/db/index.mjs');
const { remindPendingDeliveries } = await import('../server/src/routes/purchases.mjs');

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
const act = (user, rid, action, body = {}) => call(user, 'POST', `/api/purchases/${rid}/${action}`, body);
const detailOf = (user, rid) => call(user, 'GET', `/api/purchases/${rid}`);
const upload = (user, rid, name, bytes = Buffer.from('fake-image-bytes')) =>
  call(user, 'POST', `/api/purchases/${rid}/files?name=${encodeURIComponent(name)}`, bytes, { raw: true });
const notified = async (user, rid, re) => (await call(user, 'GET', '/api/notifications')).data.items
  .some(n => n.board === 'purchases' && n.refId === rid && re.test(n.title));
const ACCOUNT = { payeeName: '深圳某某电子有限公司', payeeAccount: '6222 0000 1234 5678', payeeBank: '招商银行深圳分行' };
const payRef = c => {
  const p = c.payments.find(x => x.id === c.activePaymentId);
  return { paymentId: p?.id, paymentStage: p?.stage };
};

const created = [];
async function newPurchase(user, over = {}) {
  const r = await call(user, 'POST', '/api/purchases', {
    payType: 'one_time', title: '测试·采购显示器两台', applyDate: '2026-09-10', amount: '2598.00', note: '剪辑工位', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created.push(r.data.id);
  return r.data;
}
async function submitted(user, over) {
  const c = await newPurchase(user, over);
  assert.equal((await upload(user, c.id, '报价单.pdf')).status, 201);
  const r = await act(user, c.id, 'submit');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
/** 产品部申请人的立项：部门负责人 → 总经理 → 财务依次同意 */
async function approved(user, over) {
  const c = await submitted(user, over);
  let last = c;
  for (const [u, stage] of [[LEAD_P, 'leader'], [GM, 'gm'], [FIN, 'finance']]) {
    if (last.status !== 'pending' || last.stage !== stage) continue;
    const r = await act(u, c.id, 'approve', { stage });
    assert.equal(r.status, 200, `${stage}: ${JSON.stringify(r.data)}`);
    last = r.data;
  }
  return (await detailOf(user, c.id)).data;
}
// 基线配置把「小额免总经理审批」的额度设成 0（不免审），下面的流程测试都按完整步骤走；额度本身单独测
const setConfig = (over = {}) => call(ADMIN, 'PATCH', '/api/expenses/config', {
  depts: [{ dept: '产品部', leaderId: LEAD_P }, { dept: '技术部', leaderId: LEAD_T }],
  gmId: GM, financeId: FIN, cashierId: CASH,
  expenseGmFreeAmount: '0', purchaseGmFreeAmount: '0', ...over,
});

// 跑之前把原配置和这几个人原来的部门存下来，跑完原样放回去
const snapshot = {
  depts: (await dbq('SELECT dept, leader_id, sort FROM expense_dept_leaders')).rows,
  roles: (await dbq('SELECT role, user_id FROM expense_role_holders')).rows,
  userDepts: (await dbq('SELECT id, dept FROM users WHERE id = ANY($1::bigint[])', [Object.values(id)])).rows,
  thresholds: (await dbq('SELECT kind, gm_free_cents FROM approval_thresholds')).rows,
};
const setDept = (user, dept) => call(ADMIN, 'PATCH', `/api/admin/users/${user}/dept`, { dept });
for (const [u, d] of [[APP, '产品部'], [LEAD_P, '产品部'], [CASH, '产品部'], [FIN, '产品部'], [LEAD_T, '技术部'], [OUT, '技术部']]) {
  const r = await setDept(u, d);
  if (r.status !== 200) throw new Error(`分配部门失败：${JSON.stringify(r.data)}`);
}
assert.equal((await setConfig()).status, 200);

after(async () => {
  if (created.length) {
    await dbq(`DELETE FROM attachments WHERE scope = 'purchase' AND ref_id = ANY($1::bigint[])`, [created]);
    await dbq(`DELETE FROM notifications WHERE board = 'purchases' AND ref_id = ANY($1::bigint[])`, [created]);
    await dbq('DELETE FROM purchase_requests WHERE id = ANY($1::bigint[])', [created]);
  }
  await dbq('DELETE FROM expense_dept_leaders');
  await dbq('DELETE FROM expense_role_holders');
  for (const d of snapshot.depts) {
    await dbq('INSERT INTO expense_dept_leaders(dept, leader_id, sort) VALUES($1,$2,$3)', [d.dept, d.leader_id, d.sort]);
  }
  for (const r of snapshot.roles) {
    await dbq('INSERT INTO expense_role_holders(role, user_id) VALUES($1,$2)', [r.role, r.user_id]);
  }
  await dbq('DELETE FROM approval_thresholds');
  for (const t of snapshot.thresholds) {
    await dbq('INSERT INTO approval_thresholds(kind, gm_free_cents) VALUES($1,$2)', [t.kind, t.gm_free_cents]);
  }
  for (const u of snapshot.userDepts) await dbq('UPDATE users SET dept = $2 WHERE id = $1', [u.id, u.dept]);
  await close();
});

test('小额免总经理审批：默认 2000 元，额度和报销共用一份设置', async () => {
  const reset = await setConfig({ purchaseGmFreeAmount: '' });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.gmFree.purchase.amount, '2000.00');
  assert.equal(reset.data.gmFree.purchase.custom, false);

  // 正好 2000 也免审：部门负责人同意后直接到财务，总经理那一步留一条跳过记录
  const small = await submitted(APP, { amount: '2000' });
  const afterLead = await act(LEAD_P, small.id, 'approve', { stage: 'leader' });
  assert.equal(afterLead.status, 200, JSON.stringify(afterLead.data));
  assert.equal(afterLead.data.stage, 'finance');
  assert.equal(afterLead.data.handler.id, FIN);
  assert.equal(afterLead.data.flow.find(s => s.stage === 'gm').state, 'skipped');
  const skip = (await detailOf(APP, small.id)).data.actions.find(a => a.stage === 'gm' && a.action === 'skip');
  assert.match(skip.comment, /免总经理审批/);
  assert.equal((await act(GM, small.id, 'approve', {})).status, 403, '总经理这一步已经跳过');

  // 超出额度一分钱就要过总经理
  const big = await submitted(APP, { amount: '2000.01' });
  assert.equal((await act(LEAD_P, big.id, 'approve', { stage: 'leader' })).data.stage, 'gm');

  // 管理员改额度：立刻按新额度走；报销那一栏不受影响
  const raised = await setConfig({ purchaseGmFreeAmount: '5000', expenseGmFreeAmount: '' });
  assert.equal(raised.data.gmFree.purchase.amount, '5000.00');
  assert.equal(raised.data.gmFree.purchase.custom, true);
  assert.equal(raised.data.gmFree.expense.amount, '300.00');
  const mid = await submitted(APP, { amount: '4999' });
  assert.equal((await act(LEAD_P, mid.id, 'approve', { stage: 'leader' })).data.stage, 'finance');

  assert.equal((await setConfig()).data.gmFree.purchase.amountCents, 0, '回到基线：不免审');
  const zero = await submitted(APP, { amount: '1' });
  assert.equal((await act(LEAD_P, zero.id, 'approve', { stage: 'leader' })).data.stage, 'gm');
});

test('建草稿：字段校验；草稿只有申请人看得见；没申请材料不能提交', async () => {
  const bad = async (over, re) => {
    const r = await call(APP, 'POST', '/api/purchases', {
      payType: 'one_time', title: '键盘', applyDate: '2026-09-01', amount: '10', ...over,
    });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.error, re);
  };
  await bad({ payType: 'loan' }, /支付类型/);
  await bad({ amount: '0' }, /大于 0/);
  await bad({ amount: '1.234' }, /金额格式/);
  await bad({ applyDate: '2026-02-30' }, /日期/);
  await bad({ title: ' ' }, /采购事项/);

  const c = await newPurchase(APP, { amount: '1,299.5', dept: '技术部' });
  assert.equal(c.dept, '产品部', '部门取管理员分配的，请求里带的忽略');
  assert.equal(c.amount, '1299.50');
  assert.equal(c.status, 'draft');
  assert.match(c.code, /^CG-\d{4}-\d{4,}$/);
  assert.deepEqual(c.flow.map(s => s.stage), ['leader', 'gm', 'finance', 'payment', 'delivery']);
  for (const u of [LEAD_P, GM, FIN, CASH, ADMIN, OUT]) {
    assert.equal((await detailOf(u, c.id)).status, 404, `user ${u} 不该看到草稿`);
  }
  const noFile = await act(APP, c.id, 'submit');
  assert.equal(noFile.status, 400);
  assert.match(noFile.data.error, /聊天记录|采购合同|价格清单/);
  assert.equal((await call(APP, 'DELETE', `/api/purchases/${c.id}`)).status, 200);
});

test('一次性支付：立项 → 收款账户 → 出纳转款 → 交付闭环', async () => {
  const c = await submitted(APP);
  assert.equal(c.statusLabel, '部门负责人审批中');
  assert.equal(c.handler.id, LEAD_P);
  assert.ok(await notified(LEAD_P, c.id, /等你审批/));
  assert.equal((await call(APP, 'PATCH', `/api/purchases/${c.id}`, { amount: '1' })).status, 403, '审批中不能改');
  for (const u of [OUT, ADMIN, LEAD_T]) assert.equal((await detailOf(u, c.id)).status, 404, `user ${u}`);

  assert.equal((await act(GM, c.id, 'approve', { stage: 'leader' })).status, 403);
  assert.equal((await act(LEAD_P, c.id, 'approve', { stage: 'gm' })).status, 409);
  assert.equal((await act(LEAD_P, c.id, 'approve', { stage: 'leader', comment: '需要' })).data.stage, 'gm');
  assert.equal((await act(GM, c.id, 'approve', { stage: 'gm' })).data.stage, 'finance');
  const fin = await act(FIN, c.id, 'approve', { stage: 'finance' });
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  assert.equal(fin.data.status, 'executing');
  assert.equal(fin.data.statusLabel, '待提交收款账户');
  assert.equal(fin.data.payments.length, 1);
  assert.equal(fin.data.payments[0].amount, '2598.00');
  assert.equal(fin.data.payments[0].stage, 'account');
  assert.ok(fin.data.approvedAt);
  assert.ok(await notified(APP, c.id, /立项已通过.*收款方账户/));

  let mine = (await detailOf(APP, c.id)).data;
  assert.equal(mine.can.account && mine.can.cancel && !mine.can.cancelPayment && !mine.can.deliver, true);
  assert.ok((await call(APP, 'GET', '/api/purchases?scope=todo')).data.items.some(x => x.id === c.id), '申请人待办里有「填收款账户」');

  // 收款账户：只有申请人，字段必填，stage 对不上回 409
  assert.equal((await act(CASH, c.id, 'pay', { ...payRef(mine), paymentStage: 'cashier' })).status, 409);
  assert.equal((await act(LEAD_P, c.id, 'account', { ...payRef(mine), ...ACCOUNT })).status, 403);
  assert.equal((await act(APP, c.id, 'account', { ...payRef(mine), payeeName: '某公司' })).status, 400);
  const acc = await act(APP, c.id, 'account', { ...payRef(mine), ...ACCOUNT, amount: '1' });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.payments[0].stage, 'cashier', '一次性支付不再过财务');
  assert.equal(acc.data.payments[0].amount, '2598.00', '一次性支付改不了金额');
  assert.equal(acc.data.payments[0].payeeAccount, '6222000012345678');
  assert.equal(acc.data.statusLabel, '待出纳转款');
  assert.ok(await notified(CASH, c.id, /等你转款/));
  assert.ok((await call(CASH, 'GET', '/api/purchases?scope=todo')).data.items.some(x => x.id === c.id));
  assert.ok(!(await call(APP, 'GET', '/api/purchases?scope=todo')).data.items.some(x => x.id === c.id));

  // 转款前：申请人不能交付、不能传交付材料；出纳能传转款凭证
  assert.equal((await act(APP, c.id, 'deliver', { deliveryNote: '到了' })).status, 409);
  assert.equal((await upload(APP, c.id, '收货.jpg')).status, 403);
  assert.equal((await act(FIN, c.id, 'pay', payRef(acc.data))).status, 403);
  const proof = await upload(CASH, c.id, '转款回单.png');
  assert.equal(proof.status, 201);
  assert.equal(proof.data.side, 'review');
  const paid = await act(CASH, c.id, 'pay', { ...payRef(acc.data), comment: '网银已转' });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.payments[0].status, 'paid');
  assert.equal(paid.data.statusLabel, '已付款，待交付');
  assert.equal(paid.data.awaitingDelivery, true);
  assert.deepEqual(paid.data.flow.map(s => s.state), ['done', 'done', 'done', 'done', 'current']);
  assert.ok(await notified(APP, c.id, /支付完成/));
  assert.equal((await act(CASH, c.id, 'pay', payRef(acc.data))).status, 409, '重复点击');

  // 待交付：待办和提醒计数里一直有它；转过款不能作废
  const todo = await call(APP, 'GET', '/api/purchases?scope=todo');
  assert.ok(todo.data.items.some(x => x.id === c.id));
  assert.ok(todo.data.deliveryCount >= 1);
  assert.equal((await act(APP, c.id, 'cancel')).status, 409);

  mine = (await detailOf(APP, c.id)).data;
  assert.equal(mine.can.deliver && mine.can.upload && !mine.can.cancel, true);
  assert.equal((await act(APP, c.id, 'deliver', {})).status, 400);
  const noPhoto = await act(APP, c.id, 'deliver', { deliveryNote: '显示器两台已到货' });
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.data.error, /收货照片|使用截图/);
  const photo = await upload(APP, c.id, '收货照片.jpg');
  assert.equal(photo.status, 201);
  assert.equal(photo.data.side, 'delivery');
  assert.equal((await act(OUT, c.id, 'deliver', { deliveryNote: 'x' })).status, 404);
  const done = await act(APP, c.id, 'deliver', { deliveryNote: '显示器两台已到货，已装到剪辑工位' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.status, 'completed');
  assert.equal(done.data.statusLabel, '已完成');
  assert.equal(done.data.deliveryNote, '显示器两台已到货，已装到剪辑工位');
  assert.deepEqual(done.data.flow.map(s => s.state), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(Object.values(done.data.can).some(Boolean), false);
  assert.deepEqual(done.data.actions.map(a => `${a.stage || '-'}:${a.action}${a.paymentSeq ? `#${a.paymentSeq}` : ''}`),
    ['-:submit', 'leader:approve', 'gm:approve', 'finance:approve', 'account:account#1', 'cashier:pay#1', '-:deliver']);
  assert.ok(!(await call(APP, 'GET', '/api/purchases?scope=todo')).data.items.some(x => x.id === c.id));

  // 交付照片锁定；外人和管理员拿不到任何材料
  assert.equal((await call(APP, 'DELETE', `/api/files/${photo.data.id}`)).status, 403);
  for (const u of [OUT, ADMIN]) {
    assert.equal((await call(u, 'GET', `/api/files/${photo.data.id}`)).status, 404, `user ${u} 不能下载交付照片`);
  }
  const dl = await fetch(`${BASE}/api/files/${proof.data.id}`, { headers: { 'x-user-id': String(FIN) } });
  assert.equal(dl.status, 200, '财务能看转款凭证');
});

test('非一次性支付：多笔付款各自过财务，额度校验，退回改账户，取消付款', async () => {
  const c = await approved(APP, { payType: 'installment', title: '测试·年度软件订阅', amount: '10000' });
  assert.equal(c.status, 'executing');
  assert.equal(c.payments.length, 0);
  assert.equal(c.statusLabel, '立项通过，待发起付款');
  assert.equal(c.can.newPayment && !c.can.deliver && c.can.cancel, true);
  assert.ok(await notified(APP, c.id, /可以发起付款/));

  assert.equal((await act(APP, c.id, 'payments', { amount: '10000.01', ...ACCOUNT })).status, 400);
  assert.equal((await act(LEAD_P, c.id, 'payments', { amount: '100', ...ACCOUNT })).status, 403);
  const p1 = await act(APP, c.id, 'payments', { amount: '4000', ...ACCOUNT, note: '首期' });
  assert.equal(p1.status, 201, JSON.stringify(p1.data));
  assert.equal(p1.data.payments[0].stage, 'finance');
  assert.equal(p1.data.statusLabel, '付款待财务审批');
  assert.equal(p1.data.remainingAmount, '6000.00');
  assert.ok(await notified(FIN, c.id, /第 1 笔付款等你审批/));
  assert.equal((await act(APP, c.id, 'payments', { amount: '100', ...ACCOUNT })).status, 409, '上一笔没处理完');

  // 财务退回改账户和金额
  assert.equal((await act(FIN, c.id, 'payment-return', payRef(p1.data))).status, 400);
  const back = await act(FIN, c.id, 'payment-return', { ...payRef(p1.data), comment: '户名和合同不一致' });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const mine = (await detailOf(APP, c.id)).data;
  assert.equal(mine.payments[0].stage, 'account');
  assert.equal(mine.paymentReturn.comment, '户名和合同不一致');
  assert.equal(mine.can.account && mine.can.cancelPayment, true);
  assert.ok(await notified(APP, c.id, /第 1 笔付款被财务退回/));
  const fixed = await act(APP, c.id, 'account', { ...payRef(mine), ...ACCOUNT, payeeName: '深圳某某软件有限公司', amount: '3000' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(fixed.data.payments[0].stage, 'finance');
  assert.equal(fixed.data.payments[0].amount, '3000.00');
  assert.equal((await act(CASH, c.id, 'payment-approve', payRef(fixed.data))).status, 403);
  const ok1 = await act(FIN, c.id, 'payment-approve', payRef(fixed.data));
  assert.equal(ok1.data.payments[0].stage, 'cashier');
  const paid1 = await act(CASH, c.id, 'pay', payRef(ok1.data));
  assert.equal(paid1.data.payments[0].status, 'paid');
  assert.equal(paid1.data.remainingAmount, '7000.00');
  assert.equal(paid1.data.can.cancel, false, '转过款不能作废');
  const both = (await detailOf(APP, c.id)).data;
  assert.equal(both.can.deliver && both.can.newPayment, true, '付过一笔后既可以交付，也可以接着发起');

  // 第二笔：出纳退回后申请人取消，额度释放
  const p2 = await act(APP, c.id, 'payments', { amount: '7000', ...ACCOUNT });
  assert.equal((await act(APP, c.id, 'payment-cancel', payRef(p2.data))).status, 403, '交出去的付款不能取消');
  assert.equal((await act(APP, c.id, 'deliver', { deliveryNote: 'x' })).status, 409, '有在途付款不能交付');
  const ok2 = await act(FIN, c.id, 'payment-approve', payRef(p2.data));
  assert.equal((await act(CASH, c.id, 'payment-return', { ...payRef(ok2.data), comment: '账号少一位' })).status, 200);
  const cancel2 = await act(APP, c.id, 'payment-cancel', payRef((await detailOf(APP, c.id)).data));
  assert.equal(cancel2.status, 200, JSON.stringify(cancel2.data));
  assert.equal(cancel2.data.payments[1].status, 'cancelled');
  assert.equal(cancel2.data.remainingAmount, '7000.00');

  // 第三笔付完剩余额度，之后不能再发起
  assert.equal((await act(APP, c.id, 'payments', { amount: '7000.01', ...ACCOUNT })).status, 400);
  const p3 = await act(APP, c.id, 'payments', { amount: '7000', ...ACCOUNT });
  assert.equal(p3.data.payments[2].seq, 3);
  await act(FIN, c.id, 'payment-approve', payRef(p3.data));
  const paid3 = await act(CASH, c.id, 'pay', payRef((await detailOf(CASH, c.id)).data));
  assert.equal(paid3.data.paidAmount, '10000.00');
  assert.equal(paid3.data.remainingAmount, '0.00');
  assert.equal(paid3.data.can.newPayment, false);
  assert.equal((await act(APP, c.id, 'payments', { amount: '1', ...ACCOUNT })).status, 409);

  assert.equal((await upload(APP, c.id, '使用截图.png')).status, 201);
  const done = await act(APP, c.id, 'deliver', { deliveryNote: '软件已开通，团队 5 个账号可用' });
  assert.equal(done.data.status, 'completed');
  assert.deepEqual(done.data.payments.map(p => `${p.seq}:${p.status}:${p.amount}`),
    ['1:paid:3000.00', '2:cancelled:7000.00', '3:paid:7000.00']);
});

test('立项阶段：撤回修改重提、撤销同意、退回、作废；还没转款时可以作废', async () => {
  const c = await submitted(APP);
  assert.equal((await act(LEAD_P, c.id, 'withdraw', { stage: 'leader' })).status, 403);
  const w = await act(APP, c.id, 'withdraw', { stage: 'leader' });
  assert.equal(w.data.status, 'withdrawn');
  assert.equal(w.data.can.edit && w.data.can.submit && w.data.can.cancel && !w.data.can.withdraw, true);
  assert.ok(await notified(LEAD_P, c.id, /撤回/));
  assert.equal((await call(APP, 'PATCH', `/api/purchases/${c.id}`, { payType: 'installment' })).data.payType, 'installment');
  const re = await act(APP, c.id, 'submit');
  assert.equal(re.data.round, 2);

  const a1 = await act(LEAD_P, c.id, 'approve', { stage: 'leader' });
  assert.equal(a1.data.can.revoke, true);
  assert.equal((await act(GM, c.id, 'revoke', { stage: 'gm' })).status, 403);
  const rv = await act(LEAD_P, c.id, 'revoke', { stage: 'gm', comment: '再确认一下规格' });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  assert.equal(rv.data.stage, 'leader');
  assert.deepEqual(rv.data.flow.slice(0, 3).map(s => s.state), ['current', 'waiting', 'waiting']);
  assert.ok(await notified(APP, c.id, /撤销了同意/));
  await act(LEAD_P, c.id, 'approve', { stage: 'leader' });
  assert.equal((await act(GM, c.id, 'return', { stage: 'gm' })).status, 400, '退回必须写原因');
  const ret = await act(GM, c.id, 'return', { stage: 'gm', comment: '预算超了' });
  assert.equal(ret.data.status, 'returned');
  assert.equal(ret.data.returnReason.comment, '预算超了');
  const x = await act(APP, c.id, 'cancel');
  assert.equal(x.data.status, 'cancelled');
  assert.equal((await act(GM, c.id, 'approve', { stage: 'gm' })).status, 409);
  assert.equal((await act(APP, c.id, 'submit')).status, 403);
  assert.equal((await call(APP, 'DELETE', `/api/purchases/${c.id}`)).status, 403, '提交过的单子不能删');

  // 立项通过、还没转款：可以作废，在途付款一并取消
  const e = await approved(APP);
  assert.equal(e.status, 'executing');
  const ex = await act(APP, e.id, 'cancel');
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  assert.equal(ex.data.status, 'cancelled');
  assert.equal(ex.data.payments[0].status, 'cancelled');
  assert.equal((await act(APP, e.id, 'account', { ...ACCOUNT })).status, 409);
});

test('财务就是申请人：立项和付款的财务审批都自动跳过，出纳转款不跳过', async () => {
  const c = await approved(FIN, { payType: 'installment', amount: '500' });
  assert.equal(c.status, 'executing');
  assert.equal(c.flow[2].state, 'skipped');
  const p = await act(FIN, c.id, 'payments', { amount: '500', ...ACCOUNT });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  assert.equal(p.data.payments[0].stage, 'cashier');
  assert.ok(p.data.actions.some(a => a.action === 'skip' && a.paymentSeq === 1 && a.stage === 'finance'));
  assert.equal((await act(CASH, c.id, 'pay', payRef(p.data))).status, 200);
});

test('每日提醒：已付款还没交付的采购，每天只提醒申请人一次', async () => {
  const c = await approved(APP);
  const mine = (await detailOf(APP, c.id)).data;
  const acc = await act(APP, c.id, 'account', { ...payRef(mine), ...ACCOUNT });
  await act(CASH, c.id, 'pay', payRef(acc.data));
  const count = async () => (await dbq(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND board = 'purchases' AND ref_id = $2 AND title LIKE '采购已付款%'`,
    [APP, c.id])).rows[0].n;

  await remindPendingDeliveries();
  assert.equal(await count(), 0, '转款当天不提醒');
  await dbq(`UPDATE purchase_requests SET reminded_at = now() - interval '25 hours' WHERE id = $1`, [c.id]);
  assert.ok(await remindPendingDeliveries() >= 1);
  assert.equal(await count(), 1);
  await remindPendingDeliveries();
  assert.equal(await count(), 1, '一天之内不重复提醒');

  assert.equal((await upload(APP, c.id, '收货.jpg')).status, 201);
  assert.equal((await act(APP, c.id, 'deliver', { deliveryNote: '已到货' })).status, 200);
  await dbq(`UPDATE purchase_requests SET reminded_at = now() - interval '3 days' WHERE id = $1`, [c.id]);
  await remindPendingDeliveries();
  assert.equal(await count(), 1, '交付完成后不再提醒');
});

test('并发：出纳同时点两次转款，只记一次', async () => {
  const c = await approved(APP);
  const mine = (await detailOf(APP, c.id)).data;
  const acc = await act(APP, c.id, 'account', { ...payRef(mine), ...ACCOUNT });
  const rs = await Promise.all([act(CASH, c.id, 'pay', payRef(acc.data)), act(CASH, c.id, 'pay', payRef(acc.data))]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  const { rows } = await dbq(`SELECT count(*)::int AS n FROM purchase_actions WHERE request_id = $1 AND action = 'pay'`, [c.id]);
  assert.equal(rows[0].n, 1);
});
