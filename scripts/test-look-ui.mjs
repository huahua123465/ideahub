/**
 * 配色与外观专项验收：npm run test:look:ui
 *
 * 2026-09-24：头像菜单「配色与外观…」打开面板，12 套配色 + 自己调色相、圆角、密度、动效，按设备记住。
 * 引擎在 index.html <head>（window.IdeaHubLook），就地改写样式表里的品牌色和中性色，语义色不动。桌面和手机各走一遍：
 *   默认不碰样式表 → 打开面板、焦点进面板 → 换「晨雾」：主色变、红色语义色不变、次要文字对比度仍 ≥ 4.5（浅 / 深都查）
 *   → 刷新后第一时间就是晨雾（不闪默认色）→ 拖主色滑块变成「自定义」→ 圆角 / 密度 / 动效 → 恢复默认完全还原
 *   → Esc 关面板、焦点回头像；手机上面板不撑出横向滚动
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/look' });

const ORIGINAL_BLUE = 'light-dark(#796375,#c3a6bb)';
const probe = page => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const lum = c => {
    const [r, g, b] = c.match(/[\d.]+/g).map(Number).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const probeEl = document.createElement('span');
  probeEl.style.color = 'var(--muted)';
  document.body.appendChild(probeEl);
  const muted = getComputedStyle(probeEl).color;
  probeEl.remove();
  const [a, b] = [lum(muted), lum(getComputedStyle(document.body).backgroundColor)].sort((x, y) => y - x);
  return {
    family: window.IdeaHubLook?.get().family,
    blue: cs.getPropertyValue('--blue').trim(),
    crit: cs.getPropertyValue('--crit').trim(),
    rdLg: cs.getPropertyValue('--rd-lg').trim(),
    sp2xl: cs.getPropertyValue('--sp-2xl').trim(),
    motion: document.documentElement.dataset.motion || 'full',
    stored: localStorage.getItem('ideahub.look'),
    contrast: (a + 0.05) / (b + 0.05),
  };
});

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on')?.childElementCount > 0
    && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}

async function openPanel(page) {
  await page.click('#meAvatar');
  await page.waitForFunction(() => document.querySelector('#userMenu.on'));
  await page.click('#miLook');
  await page.waitForFunction(() => document.querySelector('#lookDrawer.on'));
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    // 圆形扩散走 View Transitions，是异步的；减弱动态效果下直接换，断言才是确定的
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
    await page.evaluate(() => { localStorage.removeItem('ideahub.look'); localStorage.removeItem('ideahub.theme'); });
    await reload(page);

    // 默认：引擎在，但没有改动样式表
    let st = await probe(page);
    assert.deepEqual([st.family, st.blue, st.stored], ['default', ORIGINAL_BLUE, null], `${scene} 默认外观不对 ${JSON.stringify(st)}`);

    // 打开面板：焦点进面板，默认配色是选中态，自定义色板先藏着
    await openPanel(page);
    const panel = await page.evaluate(() => ({
      focusInside: document.querySelector('#lookDrawer').contains(document.activeElement),
      families: [...document.querySelectorAll('[data-look-family]')].filter(b => !b.hidden).length,
      pressed: document.querySelector('[data-look-family][aria-pressed="true"]')?.dataset.lookFamily,
      menuClosed: !document.querySelector('#userMenu.on'),
      overflow: document.documentElement.scrollWidth - innerWidth,
      drawerFits: document.querySelector('#lookDrawer').getBoundingClientRect().width <= innerWidth + 0.5,
    }));
    assert.deepEqual(panel, { focusInside: true, families: 12, pressed: 'default', menuClosed: true, overflow: 0, drawerFits: true }, `${scene} 面板状态 ${JSON.stringify(panel)}`);

    // 换成「晨雾」：主色变了，红色语义色不动，次要文字对比度仍达标
    await page.click('[data-look-family="mist"]');
    st = await probe(page);
    assert.equal(st.family, 'mist');
    assert.notEqual(st.blue, ORIGINAL_BLUE, '换了配色主色应该变');
    assert.equal(st.crit, 'light-dark(#b96869,#e79c9c)', '语义红色不该跟着配色变');
    assert.ok(st.contrast >= 4.5, `${scene} 晨雾浅色下次要文字对比度 ${st.contrast.toFixed(2)} < 4.5`);
    assert.equal(JSON.parse(st.stored).family, 'mist', '应记在这台设备上');
    assert.equal(await page.$eval('[data-look-family="mist"]', b => b.getAttribute('aria-pressed')), 'true');
    await harness.screenshot(page, `mist-${scene}`);

    // 面板里切深色：头像菜单里的三选一同步，对比度照样达标
    await page.click('[data-look-mode="dark"]');
    st = await probe(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.deepEqual(await page.$$eval('[data-theme-set][aria-pressed="true"]', bs => bs.map(b => b.dataset.themeSet)), ['dark']);
    assert.ok(st.contrast >= 4.5, `${scene} 晨雾深色下次要文字对比度 ${st.contrast.toFixed(2)} < 4.5`);
    await harness.screenshot(page, `mist-dark-${scene}`);

    // 刷新：在页面脚本跑之前（<head> 里）就已经是晨雾，不会先闪一下默认的梅子色
    await page.reload({ waitUntil: 'domcontentloaded' });
    const early = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim());
    assert.notEqual(early, ORIGINAL_BLUE, '刷新后首屏就该是保存的配色');
    await page.waitForFunction(() => document.querySelector('#v-home.on')?.childElementCount > 0 && document.querySelector('#meAvatar')?.textContent.trim());
    await settleDom(page);
    await openPanel(page);

    // 拖主色滑块：接手成「自定义」，自定义色板出现并选中
    await page.$eval('#lookA', el => { el.value = '150'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => window.IdeaHubLook.get().family === 'custom');
    const custom = await page.evaluate(() => ({ s: window.IdeaHubLook.get(), shown: !document.querySelector('[data-look-family="custom"]').hidden,
      pressed: document.querySelector('[data-look-family="custom"]').getAttribute('aria-pressed') }));
    assert.deepEqual([custom.s.A, custom.s.H, custom.shown, custom.pressed], [150, 150, true, 'true'], JSON.stringify(custom));

    // 圆角、密度、动效
    await page.$eval('#lookRadius', el => { el.value = '1.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--rd-lg').trim() === '21px');
    await page.click('[data-look-density="compact"]');
    await page.click('[data-look-motion="off"]');
    st = await probe(page);
    assert.deepEqual([st.rdLg, st.sp2xl, st.motion], ['21px', '13px', 'off'], JSON.stringify(st));
    await harness.screenshot(page, `custom-${scene}`);

    // 恢复默认：样式表原样还回去，圆角 / 间距不再被覆盖，存储清掉，明暗回到跟随系统
    await page.click('[data-look-reset]');
    st = await probe(page);
    assert.deepEqual([st.family, st.blue, st.rdLg, st.sp2xl, st.motion, st.stored], ['default', ORIGINAL_BLUE, '14px', '16px', 'full', null], JSON.stringify(st));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'auto');

    // Esc 关面板，焦点回到头像
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#lookDrawer.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meAvatar', '关掉面板后焦点应回到头像');

    // 存储坏了：退回默认，不报错
    await page.evaluate(() => localStorage.setItem('ideahub.look', '{坏的'));
    await reload(page);
    assert.equal((await probe(page)).family, 'default', '存储内容坏了应退回默认外观');

    harness.recordCheck(`${scene}-look`, 'interaction', { families: 12, remembered: true, semanticKept: true });
    await page.evaluate(() => { localStorage.removeItem('ideahub.look'); localStorage.removeItem('ideahub.theme'); });
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`配色与外观验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
