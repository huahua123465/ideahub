/**
 * 报销审批页面专项验收：npm run test:expenses:ui
 *
 * 跑在内置演示数据上（mock-expenses.js，演示身份陈屿 = 总经理 + 管理员），桌面和手机各走一遍：
 *   进入页面 → 默认落在「待我处理」→ 打开详情 → 退回不写原因被拦 → 同意并流转到财务
 *   → 发起报销（空表单、错误金额、没附件被拦，补附件后提交成功）→ 管理员打开审批设置
 * 同时检查页面级横向溢出、弹窗在视口内、手机触控尺寸、浏览器报错和越界请求。
 * 截图和 report.json 写到 scripts/.uidiff/expenses/。
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/expenses' });
// 1×1 透明 PNG，当作「支付截图」上传
const receipt = join(harness.outputDir, '支付截图.png');
await writeFile(receipt, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

const pageState = page => page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  activeViews: document.querySelectorAll('.view.on').length,
}));

async function modalInViewport(page, id) {
  const r = await page.$eval(`#${id}`, el => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight };
  });
  assert.ok(r.left >= -1 && r.top >= -1 && r.right <= r.w + 1 && r.bottom <= r.h + 1, `${id} 超出视口：${JSON.stringify(r)}`);
}

/** 按钮完整落在弹窗和视口里：没被裁掉、没被挤出屏幕 */
async function buttonVisible(page, modalId, buttonSel) {
  const r = await page.evaluate((m, b) => {
    const box = document.querySelector(`#${m}`).getBoundingClientRect();
    const btn = document.querySelector(b).getBoundingClientRect();
    return { btn: [btn.top, btn.bottom, btn.left, btn.right], box: [box.top, box.bottom], h: innerHeight, w: innerWidth };
  }, modalId, buttonSel);
  const [top, bottom, left, right] = r.btn;
  assert.ok(bottom - top > 0 && top >= r.box[0] - 1 && bottom <= r.box[1] + 1 && bottom <= r.h + 1 && left >= -1 && right <= r.w + 1,
    `${buttonSel} 没有完整显示在 ${modalId} 里：${JSON.stringify(r)}`);
}

async function waitToast(page, re) {
  await page.waitForFunction(src => [...document.querySelectorAll('.toast,[class*="toast"]')]
    .some(n => new RegExp(src).test(n.textContent)), { timeout: 5_000 }, re.source);
}

async function goExpenses(page, mobile) {
  if (mobile) {
    await page.click('#navToggle');
    await page.waitForFunction(() => document.querySelector('#appNav')?.classList.contains('mobile-open'));
  }
  const visible = await page.$eval('#tab-expenses', n => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden');
  if (!visible) await page.$eval('#tab-expenses', n => n.closest('.navgrp')?.querySelector('.navtop')?.click());
  await page.click('#tab-expenses');
  await page.waitForSelector('#v-expenses.on .exp-card', { visible: true, timeout: 10_000 });
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const mobile = scene === 'mobile';
    const page = await harness.newPage(scene, viewport);
    await goExpenses(page, mobile);

    // 有待办时默认落在「待我处理」，导航徽标显示待办数
    const list = await page.evaluate(() => ({
      selected: document.querySelector('#v-expenses [role="tab"][aria-selected="true"]')?.dataset.expTab,
      cards: document.querySelectorAll('#v-expenses .exp-card').length,
      badge: document.querySelector('#expenseN')?.textContent,
      badgeHidden: document.querySelector('#expenseN')?.classList.contains('is-empty'),
      title: document.title,
      create: document.querySelector('#btnNewLabel')?.textContent,
      flowSteps: document.querySelectorAll('#v-expenses .exp-card:first-child .exp-flow li').length,
    }));
    // 待我处理：两张等总经理审批，一张自己的单子等确认收款
    assert.equal(list.selected, 'todo');
    assert.equal(list.cards, 3);
    assert.equal(list.badge, '3');
    assert.equal(list.badgeHidden, false);
    assert.match(list.title, /报销审批/);
    assert.equal(list.create, '发起报销');
    assert.equal(list.flowSteps, 5);
    let st = await pageState(page);
    assert.ok(st.overflow <= 1, `列表页横向溢出 ${JSON.stringify(st)}`);
    assert.equal(st.activeViews, 1);
    await harness.screenshot(page, `expenses-list-${scene}`);
    harness.recordCheck(`${scene}-expenses-list`, 'layout', { ...list, ...st });

    // 打开第一张待办
    await page.click('#v-expenses .exp-card [data-exp-open]');
    await page.waitForSelector('#expDetailModal.on #btnExpDApprove', { visible: true });
    await settleDom(page);
    await modalInViewport(page, 'expDetailModal');
    st = await pageState(page);
    assert.ok(st.overflow <= 1, `详情弹窗打开后横向溢出 ${JSON.stringify(st)}`);
    await buttonVisible(page, 'expDetailModal', '#btnExpDApprove');
    // 审批意见框排在审批记录之前，处理人不用滚到底才找到
    assert.equal(await page.evaluate(() => {
      const act = document.querySelector('#expDetailBody .exp-act');
      const tl = document.querySelector('#expDetailBody .exp-timeline');
      return !!act && !!tl && !!(act.compareDocumentPosition(tl) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true);
    await harness.screenshot(page, `expenses-detail-${scene}`);
    if (mobile) {
      const small = await page.$$eval('#expDetailFoot .btn', ns => ns.map(n => n.getBoundingClientRect())
        .filter(b => b.width > 0 && b.height < 44).length);
      assert.equal(small, 0, '手机上详情底部按钮高度至少 44px');
    }

    // 退回不写原因：拦在前端，弹窗不关
    await page.click('#btnExpDReturn');
    await page.waitForFunction(() => /退回请写明原因/.test(document.querySelector('#expDetailErr')?.textContent || ''));
    assert.equal(await page.$eval('#expDetailModal', n => n.classList.contains('on')), true);

    // 同意：流转到财务，待办少一张
    await page.type('#expActComment', '行程合理，同意');
    await page.click('#btnExpDApprove');
    await waitToast(page, /已同意/);
    await page.waitForFunction(() => /财务审批中/.test(document.querySelector('#expDetailBody')?.textContent || ''));
    await page.waitForFunction(() => document.querySelector('#expenseN')?.textContent === '2', { timeout: 5_000 });
    const after = await page.evaluate(() => ({
      approveGone: !document.querySelector('#btnExpDApprove'),
      timeline: document.querySelector('.exp-timeline li')?.textContent.replace(/\s+/g, ' '),
    }));
    assert.equal(after.approveGone, true, '同意后自己不能再审批这张单');
    assert.match(after.timeline, /陈屿 审批通过（总经理）/);

    // 撤销同意：财务还没处理，总经理收回，单子回到总经理这一步；再同意一次继续往下走
    await page.waitForSelector('#btnExpDRevoke', { visible: true });
    await buttonVisible(page, 'expDetailModal', '#btnExpDRevoke');
    await page.click('#btnExpDRevoke');
    await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
    await page.click('#confirmSubmit');
    await page.waitForSelector('#expDetailModal.on #btnExpDApprove', { visible: true, timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector('#expenseN')?.textContent === '3', { timeout: 5_000 });
    const revoked = await page.evaluate(() => ({
      status: document.querySelector('#expDetailBody .exp-status')?.textContent,
      timeline: document.querySelector('.exp-timeline li')?.textContent.replace(/\s+/g, ' '),
      revokeGone: !document.querySelector('#btnExpDRevoke'),
    }));
    assert.match(revoked.status, /总经理审批中/);
    assert.match(revoked.timeline, /陈屿 撤销同意（总经理）/);
    assert.equal(revoked.revokeGone, true);
    await page.click('#btnExpDApprove');
    await page.waitForFunction(() => /财务审批中/.test(document.querySelector('#expDetailBody .exp-status')?.textContent || '')
      && document.querySelector('#btnExpDRevoke'), { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector('#expenseN')?.textContent === '2', { timeout: 5_000 });

    // Esc 关闭，遮罩收起
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal.on') && !document.querySelector('#mask.on'));

    // 发起报销：通过右上角按钮
    await page.click('#btnNew');
    await page.waitForSelector('#expEditModal.on', { visible: true });
    await settleDom(page);
    await modalInViewport(page, 'expEditModal');
    await page.click('#btnExpSubmit');
    await page.waitForFunction(() => /还没填/.test(document.querySelector('#expEditErr')?.textContent || ''));
    await page.select('#expCategory', 'travel');
    await page.type('#expTitle', '界面测试·出租车费');
    await page.$eval('#expAmount', n => { n.value = ''; });
    await page.type('#expAmount', '12.345');
    await page.click('#btnExpSubmit');
    await page.waitForFunction(() => /金额/.test(document.querySelector('#expEditErr')?.textContent || ''));
    await page.$eval('#expAmount', n => { n.value = ''; });
    await page.type('#expAmount', '86.5');
    // 部门只读，取管理员给演示身份分配的产品部
    assert.deepEqual(await page.$eval('#expDept', n => [n.value, n.readOnly]), ['产品部', true]);
    assert.equal(await page.$eval('#expEditDeptNote', n => n.hidden), true, '产品部已有负责人，不该提示');
    await page.click('#btnExpSubmit');
    await page.waitForFunction(() => /凭证/.test(document.querySelector('#expEditErr')?.textContent || ''), { timeout: 5_000 });
    // 草稿已经存下，删除草稿按钮出现；补附件后提交
    await page.waitForSelector('#btnExpDelete:not([hidden])');
    const input = await page.$('#expFiles');
    await input.uploadFile(receipt);
    await page.waitForFunction(() => /待上传/.test(document.querySelector('#expEditFiles')?.textContent || ''));
    // 四个按钮都在时（草稿已存），主按钮也必须完整可见
    await buttonVisible(page, 'expEditModal', '#btnExpSubmit');
    await buttonVisible(page, 'expEditModal', '#btnExpDelete');
    await harness.screenshot(page, `expenses-edit-${scene}`);
    await page.click('#btnExpSubmit');
    await waitToast(page, /已提交/);
    await page.waitForFunction(() => !document.querySelector('#expEditModal.on'));
    await page.waitForFunction(() => {
      const tab = document.querySelector('#v-expenses [role="tab"][aria-selected="true"]');
      const card = [...document.querySelectorAll('#v-expenses .exp-card')].find(n => /界面测试·出租车费/.test(n.textContent));
      // 演示身份是产品部申请人，产品部负责人是苏禾，所以停在部门负责人这一步
      return tab?.dataset.expTab === 'mine' && card && /部门负责人审批中/.test(card.textContent);
    }, { timeout: 5_000 });

    // 被退回的单子在「我发起的」里带着退回原因
    const returned = await page.$$eval('#v-expenses .exp-card', ns => ns.some(n =>
      /已退回/.test(n.textContent) && /缺少送水单照片/.test(n.textContent)));
    assert.equal(returned, true);
    st = await pageState(page);
    assert.ok(st.overflow <= 1, `我发起的横向溢出 ${JSON.stringify(st)}`);
    await harness.screenshot(page, `expenses-mine-${scene}`);

    // 撤回：自己审批中的单子（墨盒，停在财务）拿回来，能改、能重提、也能作废
    await page.$$eval('#v-expenses .exp-card', ns => ns.find(n => /打印机墨盒两套/.test(n.textContent))
      .querySelector('[data-exp-open]').click());
    await page.waitForSelector('#expDetailModal.on #btnExpDWithdraw', { visible: true });
    await settleDom(page);
    await buttonVisible(page, 'expDetailModal', '#btnExpDWithdraw');
    assert.ok(await page.$('#btnExpDCancel'), '审批中也能直接作废');
    await page.click('#btnExpDWithdraw');
    await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
    await page.click('#confirmSubmit');
    await page.waitForFunction(() => /已撤回/.test(document.querySelector('#expDetailBody .exp-status')?.textContent || ''), { timeout: 5_000 });
    const withdrawn = await page.evaluate(() => ({
      edit: !!document.querySelector('#btnExpDEdit'),
      resubmit: document.querySelector('#btnExpDSubmit')?.textContent,
      cancel: !!document.querySelector('#btnExpDCancel'),
      withdraw: !!document.querySelector('#btnExpDWithdraw'),
      timeline: document.querySelector('.exp-timeline li')?.textContent.replace(/\s+/g, ' '),
    }));
    assert.deepEqual({ ...withdrawn, timeline: undefined }, { edit: true, resubmit: '重新提交', cancel: true, withdraw: false, timeline: undefined });
    assert.match(withdrawn.timeline, /陈屿 撤回（财务）/);
    await modalInViewport(page, 'expDetailModal');
    await buttonVisible(page, 'expDetailModal', '#btnExpDSubmit');
    await harness.screenshot(page, `expenses-withdrawn-${scene}`);
    if (mobile) {
      const small = await page.$$eval('#expDetailFoot .btn', ns => ns.map(n => n.getBoundingClientRect())
        .filter(b => b.width > 0 && b.height < 44).length);
      assert.equal(small, 0, '手机上撤回后的详情底部按钮高度至少 44px');
    }
    await page.click('#btnExpDCancel');
    await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
    await page.click('#confirmSubmit');
    await page.waitForFunction(() => /已作废/.test(document.querySelector('#expDetailBody .exp-status')?.textContent || ''), { timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal.on') && !document.querySelector('#mask.on'));

    // 确认收款：自己的单子出纳已打款（会议室投屏器），卡片上有提示；详情里只能确认收到或反馈没收到
    // 作废后列表会在后台重绘，先等重绘完，否则点到的是马上被替换掉的旧卡片
    await page.waitForFunction(() => [...document.querySelectorAll('#v-expenses .exp-card')]
      .some(n => /打印机墨盒两套/.test(n.textContent) && /已作废/.test(n.textContent)), { timeout: 5_000 });
    await settleDom(page);
    assert.equal(await page.$$eval('#v-expenses .exp-card', ns => ns.some(n => /会议室投屏器/.test(n.textContent)
      && /待确认收款/.test(n.textContent) && /出纳已打款/.test(n.textContent))), true);
    await page.$$eval('#v-expenses .exp-card', ns => ns.find(n => /会议室投屏器/.test(n.textContent))
      .querySelector('[data-exp-open]').click());
    await page.waitForSelector('#expDetailModal.on #btnExpDConfirm', { visible: true });
    await settleDom(page);
    await modalInViewport(page, 'expDetailModal');
    await buttonVisible(page, 'expDetailModal', '#btnExpDConfirm');
    await buttonVisible(page, 'expDetailModal', '#btnExpDDispute');
    const awaiting = await page.evaluate(() => ({
      locked: !document.querySelector('#btnExpDWithdraw') && !document.querySelector('#btnExpDCancel'),
      steps: [...document.querySelectorAll('#expDetailBody .exp-flow li')].map(li => li.className),
      label: document.querySelector('label[for="expActComment"]')?.textContent,
    }));
    assert.equal(awaiting.locked, true, '出纳打款后不能撤回或作废');
    assert.deepEqual(awaiting.steps, ['is-done', 'is-skipped', 'is-done', 'is-done', 'is-current']);
    assert.match(awaiting.label, /收款情况/);
    st = await pageState(page);
    assert.ok(st.overflow <= 1, `确认收款详情横向溢出 ${JSON.stringify(st)}`);
    await harness.screenshot(page, `expenses-receipt-${scene}`);
    if (mobile) {
      const small = await page.$$eval('#expDetailFoot .btn', ns => ns.map(n => n.getBoundingClientRect())
        .filter(b => b.width > 0 && b.height < 44).length);
      assert.equal(small, 0, '手机上确认收款的底部按钮高度至少 44px');
    }
    const firstLog = () => page.$eval('.exp-timeline li', n => n.textContent.replace(/\s+/g, ' '));
    if (!mobile) {
      // 没收到：不写情况被拦；写了之后单子回到出纳
      await page.click('#btnExpDDispute');
      await page.waitForFunction(() => /没收到请写明情况/.test(document.querySelector('#expDetailErr')?.textContent || ''));
      await page.type('#expActComment', '工资卡没到账');
      await page.click('#btnExpDDispute');
      await waitToast(page, /已反馈给出纳/);
      await page.waitForFunction(() => /待出纳打款/.test(document.querySelector('#expDetailBody .exp-status')?.textContent || ''), { timeout: 5_000 });
      assert.match(await firstLog(), /陈屿 反馈未收到（出纳）/);
      assert.equal(await page.$('#btnExpDConfirm'), null);
    } else {
      await page.click('#btnExpDConfirm');
      await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
      await page.click('#confirmSubmit');
      await page.waitForFunction(() => /已完成/.test(document.querySelector('#expDetailBody .exp-status')?.textContent || ''), { timeout: 5_000 });
      assert.match(await firstLog(), /陈屿 确认收到/);
      assert.match(await page.$eval('#expDetailBody .exp-fields', n => n.textContent), /确认收款时间/);
      await harness.screenshot(page, 'expenses-received-mobile');
    }
    await page.waitForFunction(() => document.querySelector('#expenseN')?.textContent === '1', { timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal.on') && !document.querySelector('#mask.on'));

    // 导出记录：演示身份是管理员，能导出全公司；日期填反被拦；下载的是带 BOM 的 CSV
    // 手机上 page.click 只把按钮滚到屏幕边缘，底部的演示模式提示和聊天按钮会挡住它：先滚到中间，确认没被挡再点
    await page.$eval('#v-expenses .exp-export-btn', b => b.scrollIntoView({ block: 'center' }));
    await settleDom(page);
    const cover = await page.$eval('#v-expenses .exp-export-btn', b => {
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === b || b.contains(top) ? '' : (top?.outerHTML || '无').slice(0, 160);
    });
    assert.equal(cover, '', `导出记录按钮被挡住了：${cover}`);
    await page.click('#v-expenses .exp-export-btn');
    await page.waitForSelector('#expExportModal.on #btnExpExportClaims', { visible: true });
    await settleDom(page);
    await modalInViewport(page, 'expExportModal');
    await buttonVisible(page, 'expExportModal', '#btnExpExportClaims');
    await buttonVisible(page, 'expExportModal', '#btnExpExportActions');
    const exportView = await page.evaluate(() => ({
      scope: document.querySelector('#expExportScope').textContent,
      statuses: document.querySelectorAll('#expExportStatus option').length,
      depts: [...document.querySelectorAll('#expExportDept option')].map(o => o.value),
    }));
    assert.match(exportView.scope, /全公司/);
    assert.equal(exportView.statuses, 8);
    assert.ok(exportView.depts.includes('产品部') && exportView.depts.includes('运营部'));
    await harness.screenshot(page, `expenses-export-${scene}`);
    if (mobile) {
      const small = await page.$$eval('#expExportModal footer .btn', ns => ns.map(n => n.getBoundingClientRect())
        .filter(b => b.width > 0 && b.height < 44).length);
      assert.equal(small, 0, '手机上导出弹窗按钮高度至少 44px');
    }
    await page.$eval('#expExportFrom', n => { n.value = '2026-09-10'; });
    await page.$eval('#expExportTo', n => { n.value = '2026-09-01'; });
    await page.click('#btnExpExportClaims');
    await page.waitForFunction(() => /开始日期不能晚于结束日期/.test(document.querySelector('#expExportErr')?.textContent || ''));
    await page.$eval('#expExportFrom', n => { n.value = ''; });
    await page.$eval('#expExportTo', n => { n.value = ''; });
    // 拦下链接点击，记录下载的文件名和内容，不真的弹下载
    await page.evaluate(() => {
      window.__downloads = [];
      HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push({ name: this.download, href: this.href }); };
    });
    await page.select('#expExportStatus', 'completed');
    await page.click('#btnExpExportClaims');
    await waitToast(page, /已导出 \d+ 张报销单的单据明细/);
    await page.click('#btnExpExportActions');
    await waitToast(page, /审批记录/);
    const files = await page.evaluate(async () => Promise.all(window.__downloads.map(async d => {
      const bytes = new Uint8Array(await (await fetch(d.href)).arrayBuffer());
      return { name: d.name, bom: [...bytes.slice(0, 3)], text: new TextDecoder().decode(bytes) };
    })));
    assert.equal(files.length, 2);
    assert.match(files[0].name, /^报销单据明细-\d{8}\.csv$/);
    assert.match(files[1].name, /^报销审批记录-\d{8}\.csv$/);
    assert.deepEqual(files[0].bom, [0xef, 0xbb, 0xbf]);
    assert.match(files[0].text, /"单号","申请人"/);
    assert.match(files[0].text, /8 月杭州展会住宿.*已完成/);
    assert.doesNotMatch(files[0].text, /9 月上海客户拜访/, '按状态筛掉了审批中的单子');
    assert.match(files[1].text, /"确认打款","林知远","已银行转账"/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal.on') && !document.querySelector('#mask.on'));

    // 管理员：审批设置
    await page.click('#v-expenses .exp-config-btn');
    await page.waitForSelector('#expConfigModal.on .exp-cfg-row', { visible: true });
    await settleDom(page);
    await modalInViewport(page, 'expConfigModal');
    const deptRows = () => page.$$eval('#expCfgDepts .exp-cfg-row', rows => rows.map(r => [
      r.querySelector('[data-cfg-dept]').value, r.querySelector('[data-cfg-leader]').value]));
    const cfg = await page.evaluate(() => ({
      rows: document.querySelectorAll('#expCfgDepts .exp-cfg-row').length,
      gm: document.querySelector('#expCfgGm')?.selectedOptions[0]?.textContent,
    }));
    // 演示数据已配了 3 个部门；公司的运营部、财务部、行政部还没配，也要列出来等管理员选负责人
    assert.equal(cfg.rows, 6);
    assert.deepEqual((await deptRows()).slice(3), [['运营部', ''], ['财务部', ''], ['行政部', '']]);
    assert.match(cfg.gm, /陈屿/);
    // 管理员能看到部门分配情况，没分配的人数要醒目
    assert.match(await page.$eval('#expCfgStats', n => (n.hidden ? '' : n.textContent)), /已分配：产品部 3 人.*还有 4 人没分配部门/);
    // 小额免总经理审批：没手动设过就留空，placeholder 显示默认额度，下面一行写清当前规则
    const free = await page.evaluate(() => ({
      expense: document.querySelector('#expCfgExpenseFree').value,
      expensePh: document.querySelector('#expCfgExpenseFree').placeholder,
      purchasePh: document.querySelector('#expCfgPurchaseFree').placeholder,
      state: document.querySelector('#expCfgFreeState').textContent,
    }));
    assert.equal(free.expense, '');
    assert.equal(free.expensePh, '默认 300');
    assert.equal(free.purchasePh, '默认 2000');
    assert.match(free.state, /报销：不超过 ¥300 免总经理审批（默认）/);
    assert.match(free.state, /采购：不超过 ¥2000 免总经理审批（默认）/);
    await buttonVisible(page, 'expConfigModal', '#btnExpCfgSave');
    await harness.screenshot(page, `expenses-config-${scene}`);
    if (mobile) {
      const small = await page.$$eval('#expConfigModal footer .btn, #expConfigModal .exp-cfg-del', ns =>
        ns.map(n => n.getBoundingClientRect()).filter(b => b.width > 0 && (b.height < 44 || b.width < 44)).length);
      assert.equal(small, 0, '手机上设置弹窗的按钮至少 44×44');
    }

    // 报错必须滚到看得见的地方：选了负责人却没填部门名称
    await page.click('#btnExpCfgAddDept');
    await page.select('#expCfgDepts .exp-cfg-row:last-child [data-cfg-leader]', '2');
    await page.click('#btnExpCfgSave');
    await page.waitForFunction(() => /没填部门名称/.test(document.querySelector('#expCfgErr')?.textContent || ''));
    await settleDom(page);
    const errBox = await page.evaluate(() => {
      const e = document.querySelector('#expCfgErr').getBoundingClientRect();
      const body = document.querySelector('#expConfigModal > .form').getBoundingClientRect();
      return { top: e.top, bottom: e.bottom, bodyTop: body.top, bodyBottom: body.bottom };
    });
    assert.ok(errBox.top >= errBox.bodyTop - 1 && errBox.bottom <= errBox.bodyBottom + 1, `报错没有滚进可见区域：${JSON.stringify(errBox)}`);
    await page.click('#expCfgDepts .exp-cfg-row:last-child [data-cfg-del]');

    // 用户实际遇到的情况：只给一个部门选了负责人就保存 —— 要能保存成功，其余部门先不启用
    if (!mobile) {
      for (let i = 0; i < 3; i++) await page.click('#expCfgDepts .exp-cfg-row:first-child [data-cfg-del]');
      assert.deepEqual((await deptRows()).map(r => r[0]), ['运营部', '财务部', '行政部']);
      await page.select('#expCfgDepts .exp-cfg-row:first-child [data-cfg-leader]', '2');
      await page.type('#expCfgExpenseFree', '500');
      await page.click('#btnExpCfgSave');
      await waitToast(page, /已保存。财务部、行政部还没选负责人，先不启用/);
      await page.waitForFunction(() => !document.querySelector('#expConfigModal.on'));
      await page.click('#v-expenses .exp-config-btn');
      await page.waitForFunction(() => document.querySelectorAll('#expCfgDepts .exp-cfg-row').length === 3
        && document.querySelector('#expCfgDepts .exp-cfg-row [data-cfg-leader]').value === '2');
      assert.deepEqual(await deptRows(), [['运营部', '2'], ['财务部', ''], ['行政部', '']]);
      // 手动填过的额度回填进输入框，说明那一行也跟着变；采购没动，还是默认值
      assert.equal(await page.$eval('#expCfgExpenseFree', n => n.value), '500');
      const saved = await page.$eval('#expCfgFreeState', n => n.textContent);
      assert.match(saved, /报销：不超过 ¥500 免总经理审批/);
      assert.doesNotMatch(saved, /报销：不超过 ¥500 免总经理审批（默认）/);
      assert.match(saved, /采购：不超过 ¥2000 免总经理审批（默认）/);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal.on'));

    // 用户管理：每个人一行部门下拉，选项含公司部门，当前部门选中；手机上不溢出
    await page.click('#meAvatar');
    await page.waitForSelector('#miUsers', { visible: true });
    await page.click('#miUsers');
    await page.waitForSelector('#usersModal.on [data-dept-user]', { visible: true });
    await settleDom(page);
    const users = await page.$eval('#usersModal [data-dept-user]', sel => ({
      value: sel.value, label: sel.getAttribute('aria-label'),
      options: [...sel.options].map(o => o.textContent),
    }));
    assert.equal(users.value, '产品部');
    assert.match(users.label, /的部门$/);
    assert.deepEqual(users.options.slice(0, 1), ['未分配部门']);
    // 「（未设负责人）」标记跟着实时审批配置走（桌面这轮前面刚改过配置），这里只核对部门名称齐全
    const names = users.options.map(o => o.replace('（未设负责人）', ''));
    assert.ok(['运营部', '财务部', '行政部', '产品部'].every(o => names.includes(o)), JSON.stringify(users.options));
    // 部门负责人开关：设为负责人 → 按下并出现标签；再点一次确认取消
    const leadSel = '#usersModal [data-lead-user]';
    assert.equal(await page.$eval(leadSel, b => b.disabled), false);
    // 职能下拉：演示身份陈屿是总经理；普通成员 + 三个职能，别人担任的带上现任名字
    const dutySel = '#usersModal [data-duty-user]';
    const dutyView = await page.$eval(dutySel, s => ({
      value: s.value, label: s.getAttribute('aria-label'), options: [...s.options].map(o => o.textContent),
    }));
    assert.equal(dutyView.value, 'gm');
    assert.match(dutyView.label, /的职能$/);
    assert.deepEqual(dutyView.options, ['普通成员', '总经理', '财务（叶昭）', '出纳（林知远）']);
    if (!mobile) {
      const pressed = () => page.$eval(leadSel, b => b.getAttribute('aria-pressed'));
      if (await pressed() === 'true') {
        await page.click(leadSel);
        await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
        await page.click('#confirmSubmit');
        await page.waitForFunction(s => document.querySelector(s)?.getAttribute('aria-pressed') === 'false', {}, leadSel);
      }
      await page.click(leadSel);
      // 产品部原来若有别的负责人，会先确认是否更换
      await page.waitForFunction(s => document.querySelector('#confirmLayer.on')
        || document.querySelector(s)?.getAttribute('aria-pressed') === 'true', { timeout: 5_000 }, leadSel);
      if (await page.$('#confirmLayer.on')) {
        assert.match(await page.$eval('#confirmTitle', n => n.textContent).catch(() => '更换'), /更换|换成/);
        await page.click('#confirmSubmit');
      }
      await page.waitForFunction(s => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', { timeout: 5_000 }, leadSel);
      assert.match(await page.$eval('#usersModal .urow .uduties', n => n.textContent), /产品部负责人/);
      await harness.screenshot(page, 'expenses-users-leader-desktop');
      // 前面刚提交的「界面测试·出租车费」还在等产品部负责人：取消要被拦下，开关保持按下
      await page.click(leadSel);
      await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
      await page.click('#confirmSubmit');
      await waitToast(page, /先指定新的负责人/);
      await page.waitForFunction(s => document.querySelector(s)?.getAttribute('aria-pressed') === 'true'
        && !document.querySelector(s).disabled, { timeout: 5_000 }, leadSel);
      // 改职能：总经理这一步还有单子在等，改成财务会让总经理空着 → 先确认（会写清换掉谁），提交后被拦下，下拉回到总经理
      await page.select(dutySel, 'finance');
      await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
      assert.match(await page.$eval('#confirmLayer', n => n.textContent), /从叶昭换成陈屿.*不再担任总经理/);
      await page.click('#confirmSubmit');
      await waitToast(page, /等总经理处理/);
      await page.waitForFunction(s => document.querySelector(s)?.value === 'gm' && !document.querySelector(s).disabled,
        { timeout: 5_000 }, dutySel);
    } else {
      const h = await page.$eval(leadSel, n => n.getBoundingClientRect().height);
      assert.ok(h >= 44, `手机上负责人开关高度 ${h}`);
      const dh = await page.$eval(dutySel, n => n.getBoundingClientRect().height);
      assert.ok(dh >= 44, `手机上职能下拉高度 ${dh}`);
    }
    await modalInViewport(page, 'usersModal');
    st = await pageState(page);
    assert.ok(st.overflow <= 1, `用户管理横向溢出 ${JSON.stringify(st)}`);
    if (mobile) {
      const h = await page.$eval('#usersModal [data-dept-user]', n => n.getBoundingClientRect().height);
      assert.ok(h >= 44, `手机上部门下拉高度 ${h}`);
    }
    await harness.screenshot(page, `expenses-users-${scene}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal.on'));

    harness.recordCheck(`${scene}-expenses-flow`, 'interaction', { approved: true, submitted: true, config: cfg });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`报销页面验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
