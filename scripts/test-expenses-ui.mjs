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
    assert.equal(list.selected, 'todo');
    assert.equal(list.cards, 2);
    assert.equal(list.badge, '2');
    assert.equal(list.badgeHidden, false);
    assert.match(list.title, /报销审批/);
    assert.equal(list.create, '发起报销');
    assert.equal(list.flowSteps, 4);
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
    await page.waitForFunction(() => document.querySelector('#expenseN')?.textContent === '1', { timeout: 5_000 });
    const after = await page.evaluate(() => ({
      approveGone: !document.querySelector('#btnExpDApprove'),
      timeline: document.querySelector('.exp-timeline li')?.textContent.replace(/\s+/g, ' '),
    }));
    assert.equal(after.approveGone, true, '同意后自己不能再审批这张单');
    assert.match(after.timeline, /陈屿 审批通过（总经理）/);

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
      await page.click('#btnExpCfgSave');
      await waitToast(page, /已保存。财务部、行政部还没选负责人，先不启用/);
      await page.waitForFunction(() => !document.querySelector('#expConfigModal.on'));
      await page.click('#v-expenses .exp-config-btn');
      await page.waitForFunction(() => document.querySelectorAll('#expCfgDepts .exp-cfg-row').length === 3
        && document.querySelector('#expCfgDepts .exp-cfg-row [data-cfg-leader]').value === '2');
      assert.deepEqual(await deptRows(), [['运营部', '2'], ['财务部', ''], ['行政部', '']]);
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
    } else {
      const h = await page.$eval(leadSel, n => n.getBoundingClientRect().height);
      assert.ok(h >= 44, `手机上负责人开关高度 ${h}`);
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
