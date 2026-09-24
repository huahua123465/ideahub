/**
 * 侧栏分组收纳专项验收：npm run test:nav-collapse:ui
 *
 * 2026-09-24 用户定的规则：默认全部展开，只记住手动收起（存在这台设备的 localStorage）。
 * 收起的组把里面「待我处理」的数（报销 / 采购角标）挂在组标题上，灵感池这类总条数不算。
 * 桌面侧栏和手机抽屉共用一份开合状态，各走一遍：
 *   首次进来全展开 → 收起「团队」出现待办数、读屏名称带上数 → 刷新后仍收起 → 待办数跟着角标变
 *   → 当前页在收起的组里时组标题仍点亮 → 展开后待办数消失 → 刷新后恢复全展开
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/nav-collapse' });

const state = page => page.evaluate(() => [...document.querySelectorAll('.navgrp')].map(g => {
  const top = g.querySelector('.navtop');
  const todo = g.querySelector('.navtop-todo');
  return {
    group: g.dataset.group,
    collapsed: g.classList.contains('collapsed'),
    expanded: top.getAttribute('aria-expanded'),
    menuVisible: getComputedStyle(g.querySelector('.navmenu')).display !== 'none',
    todo: todo && !todo.hidden && getComputedStyle(todo).display !== 'none' ? todo.textContent : '',
    label: top.getAttribute('aria-label') || '',
    active: g.classList.contains('active'),
  };
}));
const team = async page => (await state(page)).find(g => g.group === 'team');

async function openNav(page, mobile) {
  if (!mobile) return;
  if (await page.$eval('#appNav', n => n.classList.contains('mobile-open'))) return;
  await page.click('#navToggle');
  await page.waitForFunction(() => document.querySelector('#appNav').classList.contains('mobile-open'));
}

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on')?.childElementCount > 0
    && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const mobile = scene === 'mobile';
    const page = await harness.newPage(scene, viewport);
    await page.evaluate(() => localStorage.removeItem('ideahub.navCollapsed.v1'));
    await reload(page);
    await openNav(page, mobile);

    // 首次进来：全部展开，ARIA 和视觉一致，组标题上没有数
    for (const g of await state(page)) {
      assert.deepEqual([g.collapsed, g.expanded, g.menuVisible, g.todo], [false, 'true', true, ''], `${scene} 默认应全部展开 ${JSON.stringify(g)}`);
    }
    const badges = await page.evaluate(() => [...document.querySelectorAll('.navgrp[data-group="team"] [data-todo]')]
      .reduce((s, b) => s + (b.classList.contains('is-empty') ? 0 : Number(b.textContent) || 0), 0));
    assert.ok(badges > 0, '演示数据里报销 / 采购应有待办，否则测不到组标题上的数');

    // 收起「团队」：列表藏起来，标题上挂待办数，读屏名称带上数
    await page.click('.navgrp[data-group="team"] .navtop');
    let t = await team(page);
    assert.deepEqual([t.collapsed, t.expanded, t.menuVisible, t.todo], [true, 'false', false, String(badges)], JSON.stringify(t));
    assert.match(t.label, new RegExp(`团队，${badges} 项待我处理`));
    // 灵感池这类总条数不算待办：收起「市场与内容」不挂数
    await page.click('.navgrp[data-group="content"] .navtop');
    assert.equal((await state(page)).find(g => g.group === 'content').todo, '', '灵感池、正式库的总条数不该算进待办');
    await harness.screenshot(page, `collapsed-${scene}`);

    // 刷新后仍收起，其余组仍展开
    await reload(page);
    await openNav(page, mobile);
    const after = await state(page);
    for (const g of after) {
      const want = ['team', 'content'].includes(g.group);
      assert.equal(g.collapsed, want, `${scene} 刷新后 ${g.group} 的开合没记住 ${JSON.stringify(g)}`);
      assert.equal(g.expanded, String(!want));
    }
    assert.equal(after.find(g => g.group === 'team').todo, String(badges), '刷新后组标题上的待办数要重新算出来');

    // 角标变了，组标题跟着变；清零后不显示
    await page.evaluate(() => { const b = document.querySelector('#expenseN'); b.textContent = '7'; b.classList.remove('is-empty'); });
    await page.waitForFunction(() => document.querySelector('.navgrp[data-group="team"] .navtop-todo').textContent !== '');
    const purchase = await page.evaluate(() => { const b = document.querySelector('#purchaseN'); return b.classList.contains('is-empty') ? 0 : Number(b.textContent) || 0; });
    assert.equal((await team(page)).todo, String(7 + purchase));
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('.navgrp[data-group="team"] [data-todo]')) { b.textContent = '0'; b.classList.add('is-empty'); }
    });
    await page.waitForFunction(() => document.querySelector('.navgrp[data-group="team"] .navtop-todo').hidden);
    assert.equal((await team(page)).label, '', '没有待办时不该改读屏名称');

    // 当前页在收起的组里：组标题照样点亮，能看出自己在哪
    await page.evaluate(() => document.querySelector('[data-go="expenses"]').click());
    await page.waitForFunction(() => document.querySelector('#v-expenses.on'));
    await openNav(page, mobile);
    t = await team(page);
    assert.deepEqual([t.collapsed, t.active], [true, true], `去了收起组里的页面，组应保持收起且标题点亮 ${JSON.stringify(t)}`);

    // 展开：列表回来，待办数消失（列表里的角标已经看得见），存储里去掉它
    await page.click('.navgrp[data-group="team"] .navtop');
    await page.click('.navgrp[data-group="content"] .navtop');
    t = await team(page);
    assert.deepEqual([t.collapsed, t.menuVisible, t.todo], [false, true, ''], JSON.stringify(t));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ideahub.navCollapsed.v1'))), []);
    await reload(page);
    for (const g of await state(page)) assert.equal(g.collapsed, false, `${scene} 全部展开后刷新应保持全展开`);

    // 存储坏了 / 不可用时退回全展开，不报错
    await page.evaluate(() => localStorage.setItem('ideahub.navCollapsed.v1', '{坏的'));
    await reload(page);
    for (const g of await state(page)) assert.equal(g.collapsed, false, '存储内容坏了应退回全展开');

    harness.recordCheck(`${scene}-nav-collapse`, 'interaction', { defaultExpanded: true, remembered: true, todoSum: badges });
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`侧栏收纳验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
