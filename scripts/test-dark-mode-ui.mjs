/**
 * 深色模式专项验收：npm run test:dark-mode:ui
 *
 * 2026-09-24 上线：每个颜色写成 light-dark(浅, 深)，html[data-theme] 切 color-scheme；
 * 头像菜单「外观」三选一（跟随系统 / 浅色 / 深色），记在 localStorage ideahub.theme。桌面和手机各走一遍：
 *   1. 默认跟随系统：系统深色 → 深底，系统浅色 → 浅底
 *   2. 菜单选「深色」/「浅色」：立即生效、按钮 aria-pressed 对、不关菜单、写进存储；刷新后仍然是选的那个
 *   3. 深色下逐页对比度：所有可见文字 ≥ 4.5（大字 ≥ 3），包括头像上的白字（util.js 的头像色 09-24 压暗过）
 *   4. Word / PDF 预览的纸面保持浅色（color-scheme:light）
 *   5. 登录页也跟着选择走
 * 截图写到 scripts/.uidiff/dark-mode/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/dark-mode' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEWS = ['home', 'pool', 'demands', 'formal', 'clients', 'reports', 'expenses', 'purchases', 'stats', 'funnel', 'samples', 'collector', 'tagadmin', 'cases', 'functionTree'];

/** 页面底色的亮度（0 黑 ~ 1 白） */
const pageLum = page => page.evaluate(() => {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
});
const state = page => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  stored: localStorage.getItem('ideahub.theme'),
  pressed: [...document.querySelectorAll('[data-theme-set][aria-pressed="true"]')].map(b => b.dataset.themeSet),
  menuOpen: document.querySelector('#userMenu').classList.contains('on'),
}));

/** 对比度巡检：返回不达标的文字（背景沿祖先叠加半透明层算出来） */
const AUDIT = () => {
  const parse = c => { const m = c.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return { r, g, b, a: m.length > 3 ? a : 1 }; };
  const lum = ({ r, g, b }) => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length || el.closest('.sr-only,[aria-hidden="true"],.docx-host,.learning-pdf-page')) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = parse(getComputedStyle(document.body).backgroundColor);
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const fg0 = parse(cs.color); const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + .05) / (b + .05);
    const need = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.6 && +cs.fontWeight >= 600) ? 3 : 4.5;
    if (ratio < need) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}「${el.textContent.trim().slice(0, 10)}」${ratio.toFixed(2)}`);
  }
  return out;
};

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await page.addStyleTag({ content: '.toast,#toasts,.toasts{display:none!important}' });
    await page.evaluate(() => localStorage.removeItem('ideahub.theme'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#v-home .dash-hero'));
    await page.addStyleTag({ content: '.toast,#toasts,.toasts{display:none!important}' });

    // 1. 默认跟随系统
    assert.equal((await state(page)).theme, 'auto');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.ok(await pageLum(page) < 0.15, `${scene} 系统深色时应显示深色`);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.ok(await pageLum(page) > 0.9, `${scene} 系统浅色时应显示浅色`);

    // 2. 菜单里选深色：系统仍是浅色，也要变深；菜单不关
    await page.click('#meAvatar');
    await page.waitForFunction(() => document.querySelector('#userMenu.on'));
    assert.deepEqual((await state(page)).pressed, ['auto']);
    await page.click('[data-theme-set="dark"]');
    let st = await state(page);
    assert.deepEqual([st.theme, st.stored, st.pressed, st.menuOpen], ['dark', 'dark', ['dark'], true], JSON.stringify(st));
    assert.ok(await pageLum(page) < 0.15, `${scene} 选了深色却没变深`);
    await harness.screenshot(page, `menu-${scene}`);

    // 刷新后仍是深色（<head> 里的内联脚本在样式生效前就设好）
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', '刷新后应保持深色');
    await page.waitForFunction(() => document.querySelector('#v-home .dash-hero'));
    await page.addStyleTag({ content: '.toast,#toasts,.toasts{display:none!important}' });
    await settleDom(page);
    await harness.screenshot(page, `home-${scene}`);

    // 3. 深色下逐页对比度
    const bad = [];
    for (const view of VIEWS) {
      await page.evaluate(v => document.querySelector(`#appNav [data-go="${v}"]`)?.click(), view);
      await sleep(500); await settleDom(page);
      for (const y of [0, 900]) {
        await page.evaluate(y => { const m = document.querySelector('.main'); if (m) m.scrollTop = y; document.scrollingElement.scrollTop = y; }, y);
        await sleep(80);
        for (const r of await page.evaluate(`(${AUDIT})()`)) bad.push(`${view}: ${r}`);
      }
    }
    await page.evaluate(() => document.querySelector('#appNav [data-go="pool"]').click()); await sleep(500);
    await page.evaluate(() => document.querySelector('#poolGrid .idea-card').click()); await sleep(700);
    for (const r of await page.evaluate(`(${AUDIT})()`)) bad.push(`drawer: ${r}`);
    await harness.screenshot(page, `drawer-${scene}`);
    assert.deepEqual([...new Set(bad)], [], `${scene} 深色下有文字对比度不达标`);
    await page.keyboard.press('Escape');

    // 4. Word / PDF 纸面保持浅色
    const paper = await page.evaluate(() => {
      const d = document.createElement('div'); d.className = 'docx-host'; document.body.appendChild(d);
      const cs = getComputedStyle(d); const r = { scheme: cs.colorScheme, color: cs.color }; d.remove(); return r;
    });
    assert.equal(paper.scheme, 'light', 'Word 预览纸面应保持浅色');
    assert.ok(paper.color.match(/\d+/g).slice(0, 3).every(v => +v < 90), `纸面上的字应是深色 ${paper.color}`);

    // 选浅色：系统换成深色也保持浅色
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => document.querySelector('#meAvatar').click());
    await page.waitForFunction(() => document.querySelector('#userMenu.on'));
    await page.click('[data-theme-set="light"]');
    st = await state(page);
    assert.deepEqual([st.theme, st.stored, st.pressed], ['light', 'light', ['light']]);
    assert.ok(await pageLum(page) > 0.9, `${scene} 选了浅色，系统深色时也应保持浅色`);

    // 5. 登录页跟着选择走（测试服务器只打包了主页面的脚本，login.js 会 404，这一步产生的 404 不算页面错误）
    const errorsBefore = harness.report.browserErrors.length;
    await page.evaluate(() => localStorage.setItem('ideahub.theme', 'dark'));
    await page.goto(page.url().replace(/\/(\?.*)?$/, '/login.html'), { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.ok(await pageLum(page) < 0.15, '登录页应跟着变深');
    await harness.screenshot(page, `login-${scene}`);
    const loginErrors = harness.report.browserErrors.splice(errorsBefore);
    assert.ok(loginErrors.every(e => /404/.test(e.message)), `登录页有 404 以外的错误：${JSON.stringify(loginErrors)}`);
    await page.evaluate(() => localStorage.removeItem('ideahub.theme'));
    harness.recordCheck(`${scene}-dark-mode`, 'theme', { views: VIEWS.length });
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  await harness.writeReport();
  console.log(`深色模式验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
