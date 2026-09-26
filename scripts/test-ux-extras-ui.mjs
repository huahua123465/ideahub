/**
 * 2026-09-26 这一轮体验打磨的验收：npm run test:ux-extras:ui
 *
 *   快捷键一览：按「?」打开、焦点在「知道了」、Esc 关掉焦点回原处；头像菜单「快捷键」也能打开；输入框里按「?」不触发
 *   看板只有一两条时末尾有虚线「新增」卡，点它打开新增表单；条数多时不出现
 *   按需加载的页面：首页「框架学习」→ 学习页正常打开（代码是第一次打开时才下载的）
 *   手机首页问候卡：进度环缩到右上角，问候和说明不再被挤成一窄条
 *   「添加到主屏幕」：manifest 能读到，图标文件都在
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/ux-extras' });

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on')?.childElementCount > 0 && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}
const go = (page, key) => page.evaluate(k => document.querySelector(`#appNav [data-go="${k}"]`).click(), key);

try {
  /* ---------- 桌面 ---------- */
  const page = await harness.newPage('desktop', { width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await reload(page);

  // 快捷键一览：「?」打开，焦点在按钮上，Esc 关掉回到原处
  await page.focus('#dashFocusSeg [data-filter="all"]');
  await page.keyboard.press('?');
  await page.waitForSelector('.kbd-dialog');
  const kbd = await page.evaluate(() => ({
    rows: document.querySelectorAll('.kbd-dialog dl>div').length,
    focus: document.activeElement?.textContent,
    modal: document.querySelector('.kbd-dialog').getAttribute('aria-modal'),
    fits: (() => { const r = document.querySelector('.kbd-dialog').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(),
  }));
  assert.deepEqual([kbd.rows >= 7, kbd.focus, kbd.modal, kbd.fits], [true, '知道了', 'true', true], JSON.stringify(kbd));
  await harness.screenshot(page, 'shortcuts-desktop');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.kbd-layer'), null, 'Esc 应关掉快捷键表');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.filter), 'all', '关掉后焦点回到原处');
  // 头像菜单里的「快捷键」
  await page.click('#meAvatar');
  await page.waitForFunction(() => document.querySelector('#userMenu.on'));
  await page.click('#miKeys');
  await page.waitForSelector('.kbd-dialog');
  await page.click('.kbd-dialog [data-kbd-close]');
  assert.equal(await page.$('.kbd-layer'), null);
  // 在输入框里打「?」不触发
  await page.focus('#q');
  await page.keyboard.press('?');
  assert.equal(await page.$('.kbd-layer'), null, '打字时按「?」不该弹快捷键表');
  await page.$eval('#q', el => { el.value = ''; el.blur(); });
  harness.recordCheck('shortcuts', 'interaction', { rows: kbd.rows });

  // 看板只有一条（演示数据里的后端交付）：末尾有「新增」卡，点它打开新增表单
  await go(page, 'delivery');
  await page.waitForSelector('#v-delivery .bd-body>.record-card');
  await settleDom(page);
  const sales = await page.evaluate(() => ({ cards: document.querySelectorAll('#v-delivery .bd-body>.record-card').length, tile: !!document.querySelector('#v-delivery .board-add-tile') }));
  assert.ok(sales.cards < 3, `演示数据里后端交付应只有一两条，才能验到「新增」卡（实际 ${sales.cards}）`);
  assert.equal(sales.tile, true, '只有一两条时末尾应有「新增」卡');
  await harness.screenshot(page, 'board-add-tile');
  await page.click('#v-delivery .board-add-tile');
  await page.waitForFunction(() => [...document.querySelectorAll('.modal.on, .drawer.on, dialog[open]')].length > 0, { timeout: 5000 });
  await page.keyboard.press('Escape');
  // 条数多的看板不出现
  await go(page, 'clients');
  await page.waitForSelector('#v-clients .bd-body>.record-card');
  await settleDom(page);
  const clients = await page.evaluate(() => ({ cards: document.querySelectorAll('#v-clients .bd-body>.record-card').length, tile: !!document.querySelector('#v-clients .board-add-tile') }));
  assert.equal(clients.tile, clients.cards < 3, JSON.stringify(clients));
  harness.recordCheck('board-add-tile', 'layout', { sales, clients });

  // 按需加载的学习页：从首页「框架学习」进去
  await go(page, 'home');
  await page.waitForSelector('#v-home.on [data-dash-learning="framework"]');
  await page.click('[data-dash-learning="framework"]');
  await page.waitForFunction(() => document.querySelector('#v-learning.on') && !document.querySelector('#v-learning .lazy-wait') && document.querySelector('#v-learning').childElementCount > 0, { timeout: 8000 });
  assert.equal(await page.$('#v-learning .lazy-fail'), null, '学习页应正常打开');
  harness.recordCheck('lazy-learning', 'navigation', {});

  // 「添加到主屏幕」：manifest 能读、图标都在
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]').href;
    const m = await (await fetch(href)).json();
    const icons = await Promise.all(m.icons.map(async i => (await fetch(new URL(i.src, href))).status));
    const apple = (await fetch(document.querySelector('link[rel="apple-touch-icon"]').href)).status;
    return { name: m.short_name, display: m.display, icons, apple, maskable: m.icons.some(i => i.purpose === 'maskable') };
  });
  assert.deepEqual(manifest, { name: 'IdeaHub', display: 'standalone', icons: [200, 200, 200], apple: 200, maskable: true }, JSON.stringify(manifest));
  await page.close();

  /* ---------- 手机 ---------- */
  const phone = await harness.newPage('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true });
  await phone.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await reload(phone);
  const hero = await phone.evaluate(() => {
    const box = document.querySelector('#v-home .dash-hero').getBoundingClientRect();
    const ring = document.querySelector('#v-home .dash-ring').getBoundingClientRect();
    const p = document.querySelector('#dashHeroLine').getBoundingClientRect();
    // 量问候那几个字本身占的地方（h1 右边留了给进度环的内边距，不能量整个盒子）
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#v-home .dash-hero h1'));
    const text = [...range.getClientRects()];
    const h1Clear = text.every(r => r.right <= ring.left + 1 || r.top >= ring.bottom || r.bottom <= ring.top);
    return { ring: Math.round(ring.width), ringInside: ring.right <= box.right + 0.5 && ring.top >= box.top, pWidth: Math.round(p.width / box.width * 100), h1Clear };
  });
  await harness.screenshot(phone, 'hero-mobile');
  assert.ok(hero.ring <= 72 && hero.ringInside && hero.pWidth >= 75 && hero.h1Clear, `手机问候卡布局不对 ${JSON.stringify(hero)}`);
  // 手机上的快捷键表也不出屏
  await phone.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })));
  await phone.waitForSelector('.kbd-dialog');
  assert.ok(await phone.evaluate(() => { const r = document.querySelector('.kbd-dialog').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }), '手机上快捷键表应在屏幕内');
  await harness.screenshot(phone, 'shortcuts-mobile');
  harness.recordCheck('mobile-hero', 'layout', hero);
  await phone.close();

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`体验打磨验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
