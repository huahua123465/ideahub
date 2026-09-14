/**
 * 采购页面专项验收：npm run test:purchases:ui
 *
 * 跑在内置演示数据上（mock-purchases.js，演示身份陈屿 = 总经理，也是两张采购的申请人），桌面和手机各走一遍：
 *   进入页面 → 默认落在「待我处理」、顶部有待交付提醒 → 审批立项（同意、撤销同意、再同意）
 *   → 一次性支付填收款账户 → 非一次性支付提交交付清单（填到一半传照片不丢字）
 *   → 发起采购（空表单、没申请材料被拦，补材料后提交成功）
 * 同时检查页面级横向溢出、弹窗在视口内、手机触控尺寸、浏览器报错和越界请求。
 * 截图和 report.json 写到 scripts/.uidiff/purchases/。
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/purchases' });
// 1×1 透明 PNG，当作「收货照片」「报价单」上传
const photo = join(harness.outputDir, '收货照片.png');
await writeFile(photo, Buffer.from(
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

async function footButtonsTouchable(page, label) {
  const small = await page.$$eval('#purDetailFoot .btn', ns => ns.map(n => n.getBoundingClientRect())
    .filter(b => b.width > 0 && b.height < 44).length);
  assert.equal(small, 0, `手机上${label}底部按钮高度至少 44px`);
}

const detailStatus = page => page.$eval('#purDetailBody .exp-status', n => n.textContent).catch(() => '');
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src)
  .test(document.querySelector('#purDetailBody .exp-status')?.textContent || ''), { timeout: 5_000 }, re.source);
const waitBadge = (page, n) => page.waitForFunction(v => document.querySelector('#purchaseN')?.textContent === v, { timeout: 5_000 }, String(n));
const waitError = (page, re) => page.waitForFunction(src => new RegExp(src)
  .test(document.querySelector('#purDetailErr')?.textContent || ''), { timeout: 5_000 }, re.source);

async function confirm(page) {
  await page.waitForSelector('#confirmLayer.on #confirmSubmit', { visible: true });
  await page.click('#confirmSubmit');
}

async function openCard(page, title) {
  await page.$$eval('#v-purchases .exp-card', (ns, t) => ns.find(n => n.textContent.includes(t))
    .querySelector('[data-pur-open]').click(), title);
  await page.waitForFunction(t => document.querySelector('#purDetailModal.on #purDetailTitle')?.textContent === t
    && document.querySelector('#purDetailFoot .btn'), { timeout: 5_000 }, title);
  await settleDom(page);
}

async function closeDetail(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal.on') && !document.querySelector('#mask.on'));
}

async function goPurchases(page, mobile) {
  if (mobile) {
    await page.click('#navToggle');
    await page.waitForFunction(() => document.querySelector('#appNav')?.classList.contains('mobile-open'));
  }
  const visible = await page.$eval('#tab-purchases', n => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden');
  if (!visible) await page.$eval('#tab-purchases', n => n.closest('.navgrp')?.querySelector('.navtop')?.click());
  await page.click('#tab-purchases');
  await page.waitForSelector('#v-purchases.on .exp-card', { visible: true, timeout: 10_000 });
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const mobile = scene === 'mobile';
    const page = await harness.newPage(scene, viewport);
    await goPurchases(page, mobile);

    // 有待办时默认落在「待我处理」；导航徽标是待办数；顶部常驻待交付提醒
    const list = await page.evaluate(() => ({
      selected: document.querySelector('#v-purchases [role="tab"][aria-selected="true"]')?.dataset.purTab,
      cards: document.querySelectorAll('#v-purchases .exp-card').length,
      badge: document.querySelector('#purchaseN')?.textContent,
      title: document.title,
      create: document.querySelector('#btnNewLabel')?.textContent,
      flowSteps: [...document.querySelectorAll('#v-purchases .exp-card')].find(n => n.querySelector('.pur-flow'))
        ?.querySelectorAll('.pur-flow li').length,
      remind: document.querySelector('#v-purchases .pur-remind')?.textContent.replace(/\s+/g, ' ') || '',
    }));
    assert.equal(list.selected, 'todo');
    assert.equal(list.cards, 3);
    assert.equal(list.badge, '3');
    assert.match(list.title, /采购/);
    assert.equal(list.create, '发起采购');
    assert.equal(list.flowSteps, 5);
    assert.match(list.remind, /你有 1 个采购待提交交付清单/);
    let st = await pageState(page);
    assert.ok(st.overflow <= 1, `列表页横向溢出 ${JSON.stringify(st)}`);
    assert.equal(st.activeViews, 1);
    await harness.screenshot(page, `purchases-list-${scene}`);
    harness.recordCheck(`${scene}-purchases-list`, 'layout', { ...list, ...st });

    // 立项审批：同意 → 撤销同意 → 再同意，流转到财务
    await openCard(page, '直播间补光灯两套');
    await page.waitForSelector('#btnPurDApprove', { visible: true });
    await modalInViewport(page, 'purDetailModal');
    await buttonVisible(page, 'purDetailModal', '#btnPurDApprove');
    assert.equal(await page.evaluate(() => {
      const box = document.querySelector('#purDetailBody .exp-act');
      const tl = document.querySelector('#purDetailBody .exp-timeline');
      return !!box && !!tl && !!(box.compareDocumentPosition(tl) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true, '审批意见框排在流转记录之前');
    await harness.screenshot(page, `purchases-approve-${scene}`);
    if (mobile) await footButtonsTouchable(page, '审批详情');
    await page.click('#btnPurDReturn');
    await waitError(page, /退回请写明原因/);
    await page.type('#purActComment', '灯光确实需要换');
    await page.click('#btnPurDApprove');
    await waitStatus(page, /财务审批中/);
    await waitBadge(page, 2);
    await page.waitForSelector('#btnPurDRevoke', { visible: true });
    await page.click('#btnPurDRevoke');
    await confirm(page);
    await waitStatus(page, /总经理审批中/);
    await waitBadge(page, 3);
    assert.match(await page.$eval('#purDetailBody .exp-timeline li', n => n.textContent.replace(/\s+/g, ' ')), /陈屿 撤销同意（总经理）/);
    await page.click('#btnPurDApprove');
    await waitStatus(page, /财务审批中/);
    await waitBadge(page, 2);
    await closeDetail(page);

    // 一次性支付：填收款方账户，交给出纳
    await openCard(page, '办公室彩色打印机一台');
    await page.waitForSelector('#purDetailBody .pur-form #purPayeeName', { visible: true });
    assert.equal(await page.$('#purPayAmount'), null, '一次性支付不能改金额');
    await buttonVisible(page, 'purDetailModal', '#btnPurDAccount');
    await page.click('#btnPurDAccount');
    await waitError(page, /还没填：收款方户名、收款账号/);
    await page.type('#purPayeeName', '某某办公设备有限公司');
    await page.type('#purPayeeAccount', '6222 0000 1234 5678');
    await page.type('#purPayeeBank', '建设银行');
    await harness.screenshot(page, `purchases-account-${scene}`);
    st = await pageState(page);
    assert.ok(st.overflow <= 1, `收款账户表单横向溢出 ${JSON.stringify(st)}`);
    if (mobile) {
      const small = await page.$$eval('#purDetailBody .pur-form .inp', ns => ns.filter(n => n.getBoundingClientRect().height < 44).length);
      assert.equal(small, 0, '手机上收款账户输入框高度至少 44px');
    }
    await page.click('#btnPurDAccount');
    await waitStatus(page, /待出纳转款/);
    await waitBadge(page, 1);
    assert.match(await page.$eval('#purDetailBody .pur-pay', n => n.textContent.replace(/\s+/g, ' ')), /第 1 笔.*待出纳转款.*某某办公设备有限公司.*6222000012345678/);
    await closeDetail(page);

    // 非一次性支付、已付首期：可以发起下一笔，也可以提交交付清单
    await openCard(page, '年度视频剪辑软件订阅');
    await page.waitForSelector('#purDeliveryNote', { visible: true });
    assert.match(await page.$eval('#purDetailBody', n => n.textContent), /已付款，待提交交付清单/);
    await page.click('#btnPurDShowPay');
    await page.waitForSelector('#purPayAmount', { visible: true });
    assert.match(await page.$eval('#purFormTitle', n => n.textContent), /发起第 2 笔付款.*还可发起 ¥6,000\.00/);
    assert.equal(await page.$eval('#purPayeeName', n => n.value), '杭州某某科技有限公司', '收款方默认沿用上一笔');
    await page.click('#btnPurDHidePay');
    await page.waitForSelector('#purDeliveryNote', { visible: true });
    await page.click('#btnPurDDeliver');
    await waitError(page, /请写交付清单/);
    await page.type('#purDeliveryNote', '软件已开通，剪辑组 5 个账号可用');
    await page.click('#btnPurDDeliver');
    await waitError(page, /交付材料/);
    // 填到一半先传照片：重画详情后刚写的交付清单还在
    const input = await page.$('#purDetailBody [data-pur-upload="delivery"]');
    await input.uploadFile(photo);
    await page.waitForFunction(() => [...document.querySelectorAll('#purDetailBody .exp-file a')].some(a => a.textContent === '收货照片.png'), { timeout: 5_000 });
    assert.equal(await page.$eval('#purDeliveryNote', n => n.value), '软件已开通，剪辑组 5 个账号可用');
    await harness.screenshot(page, `purchases-deliver-${scene}`);
    if (mobile) await footButtonsTouchable(page, '交付详情');
    await page.click('#btnPurDDeliver');
    await waitStatus(page, /已完成/);
    await waitBadge(page, 0);
    assert.match(await page.$eval('#purDetailBody .pur-delivery-note', n => n.textContent), /剪辑组 5 个账号可用/);
    await closeDetail(page);
    await page.waitForFunction(() => !document.querySelector('#v-purchases .pur-remind'), { timeout: 5_000 });

    // 发起采购：通过右上角按钮
    await page.click('#btnNew');
    await page.waitForSelector('#purEditModal.on', { visible: true });
    await settleDom(page);
    await modalInViewport(page, 'purEditModal');
    await page.click('#btnPurSubmit');
    await page.waitForFunction(() => /还没填/.test(document.querySelector('#purEditErr')?.textContent || ''));
    await page.select('#purPayType', 'installment');
    assert.match(await page.$eval('#purPayTypeHint', n => n.textContent), /每笔先由财务审批/);
    await page.select('#purPayType', 'one_time');
    await page.type('#purTitle', '界面测试·采购机械键盘');
    await page.type('#purAmount', '399');
    assert.deepEqual(await page.$eval('#purDept', n => [n.value, n.readOnly]), ['产品部', true]);
    await page.click('#btnPurSubmit');
    await page.waitForFunction(() => /聊天记录|采购合同|价格清单/.test(document.querySelector('#purEditErr')?.textContent || ''), { timeout: 5_000 });
    await page.waitForSelector('#btnPurDelete:not([hidden])');
    await (await page.$('#purFiles')).uploadFile(photo);
    await page.waitForFunction(() => /待上传/.test(document.querySelector('#purEditFiles')?.textContent || ''));
    await buttonVisible(page, 'purEditModal', '#btnPurSubmit');
    await harness.screenshot(page, `purchases-edit-${scene}`);
    await page.click('#btnPurSubmit');
    await page.waitForFunction(() => !document.querySelector('#purEditModal.on'), { timeout: 5_000 });
    await page.waitForFunction(() => {
      const tab = document.querySelector('#v-purchases [role="tab"][aria-selected="true"]');
      const card = [...document.querySelectorAll('#v-purchases .exp-card')].find(n => /界面测试·采购机械键盘/.test(n.textContent));
      return tab?.dataset.purTab === 'mine' && card && /部门负责人审批中/.test(card.textContent);
    }, { timeout: 5_000 });
    st = await pageState(page);
    assert.ok(st.overflow <= 1, `我发起的横向溢出 ${JSON.stringify(st)}`);
    await harness.screenshot(page, `purchases-mine-${scene}`);

    harness.recordCheck(`${scene}-purchases-flow`, 'interaction', { approved: true, account: true, delivered: true, created: true });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`采购页面验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
