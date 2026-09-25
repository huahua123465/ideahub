/**
 * 命令面板专项验收：npm run test:palette:ui
 *
 * 2026-09-25：Ctrl K / ⌘K 在屏幕中间弹出命令面板（src/views/palette.js）。桌面和手机各走一遍：
 *   Ctrl K 打开、焦点在输入框 → ↑↓ 移动选中项（aria-activedescendant 跟着走）→ Tab 不跑出面板
 *   → 输「深色」回车就切到深色 → 输关键词能搜到全站资料、点开后面板关掉并打开那条资料
 *   → Esc 关掉、焦点回到打开前的位置；再按一次 Ctrl K 也能关
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/palette' });

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on #dashBento .dash-hero') && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}

const open = async page => {
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
};

const panel = page => page.evaluate(() => {
  const box = document.querySelector('.cmdk')?.getBoundingClientRect();
  const input = document.querySelector('#cmdkInput');
  return {
    open: !!box,
    inView: !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
    focus: document.activeElement === input,
    active: input?.getAttribute('aria-activedescendant') || '',
    selected: document.querySelector('.cmdk-item[aria-selected="true"]')?.id || '',
    items: document.querySelectorAll('.cmdk-item').length,
    first: document.querySelector('.cmdk-item span')?.textContent || '',
  };
});

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await page.evaluate(() => { localStorage.removeItem('ideahub.look'); localStorage.setItem('ideahub.theme', 'light'); });
    await reload(page);

    // Ctrl K 打开：焦点在输入框、面板整个在屏幕里、默认列出常用命令
    await page.focus('#dashFocusSeg [data-filter="all"]');
    await open(page);
    await page.waitForSelector('.cmdk');
    let st = await panel(page);
    assert.ok(st.open && st.inView && st.focus, `面板应打开并聚焦输入框 ${JSON.stringify(st)}`);
    assert.ok(st.items >= 5, `没输字时应列出常用命令 ${JSON.stringify(st)}`);
    assert.equal(st.active, 'cmdk-0');
    await harness.screenshot(page, `commands-${scene}`);

    // ↑↓ 移动选中项，Tab 不跑出面板
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    st = await panel(page);
    assert.deepEqual([st.active, st.selected], ['cmdk-2', 'cmdk-2'], JSON.stringify(st));
    await page.keyboard.press('ArrowUp');
    assert.equal((await panel(page)).active, 'cmdk-1');
    await page.keyboard.press('Tab');
    assert.equal((await panel(page)).focus, true, 'Tab 不该把焦点带到面板后面的页面');

    // Esc 关掉，焦点回到打开前的位置
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.cmdk'), null, 'Esc 应关掉面板');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.filter), 'all', '关掉后焦点应回到原处');

    // 再按一次 Ctrl K 也能关
    await open(page);
    await page.waitForSelector('.cmdk');
    await open(page);
    assert.equal(await page.$('.cmdk'), null, '再按一次 Ctrl K 应关掉');

    // 输「深色」回车：执行命令，切到深色
    await open(page);
    await page.waitForSelector('#cmdkInput');
    await page.type('#cmdkInput', '深色');
    st = await panel(page);
    assert.equal(st.first, '切换到深色', JSON.stringify(st));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.cmdk') && document.documentElement.dataset.theme === 'dark');
    await open(page);
    await page.waitForSelector('#cmdkInput');
    await page.type('#cmdkInput', '浅色');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.cmdk') && document.documentElement.dataset.theme === 'light');

    // 搜全站资料：结果排在命令后面，点开后面板关掉、那条资料打开
    await open(page);
    await page.waitForSelector('#cmdkInput');
    const title = await page.evaluate(() => (document.querySelector('#dashBento .dash-client b, #dashBento .dash-client strong')?.textContent || '').trim());
    const kw = title.slice(0, 2) || '客户';
    await page.type('#cmdkInput', kw);
    await page.waitForFunction(() => [...document.querySelectorAll('.cmdk-grp')].some(g => g.textContent === '资料')
      && !document.querySelector('.cmdk-note')?.textContent.startsWith('正在搜'), { timeout: 5000 });
    // 「资料」分组标题后面的第一条就是搜索结果
    const hit = await page.evaluate(() => {
      const grp = [...document.querySelectorAll('.cmdk-grp')].find(g => g.textContent === '资料');
      const el = grp?.nextElementSibling;
      return el?.classList.contains('cmdk-item') ? el.dataset.i : null;
    });
    assert.ok(hit !== null, `搜「${kw}」应有资料结果`);
    await harness.screenshot(page, `search-${scene}`);
    const before = await page.evaluate(() => [location.hash, document.documentElement.dataset.view].join('|'));
    await page.click(`.cmdk-item[data-i="${hit}"]`);
    await page.waitForFunction(b => !document.querySelector('.cmdk')
      && ([location.hash, document.documentElement.dataset.view].join('|') !== b || document.querySelector('.drawer.on, .modal.on, [role="dialog"][aria-modal="true"]:not([hidden])')), { timeout: 5000 }, before);

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${scene} 不该横向滚动`);
    harness.recordCheck(`${scene}-palette`, 'interaction', { keyword: kw });
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`命令面板验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
