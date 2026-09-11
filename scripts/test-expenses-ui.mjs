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
    // 部门默认带出演示身份所在的产品部
    assert.equal(await page.$eval('#expDept', n => n.value), '产品部');
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
    const cfg = await page.evaluate(() => ({
      rows: document.querySelectorAll('#expCfgDepts .exp-cfg-row').length,
      gm: document.querySelector('#expCfgGm')?.selectedOptions[0]?.textContent,
    }));
    assert.equal(cfg.rows, 3);
    assert.match(cfg.gm, /陈屿/);
    await buttonVisible(page, 'expConfigModal', '#btnExpCfgSave');
    await harness.screenshot(page, `expenses-config-${scene}`);
    if (mobile) {
      const small = await page.$$eval('#expConfigModal footer .btn, #expConfigModal .exp-cfg-del', ns =>
        ns.map(n => n.getBoundingClientRect()).filter(b => b.width > 0 && (b.height < 44 || b.width < 44)).length);
      assert.equal(small, 0, '手机上设置弹窗的按钮至少 44×44');
    }
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
