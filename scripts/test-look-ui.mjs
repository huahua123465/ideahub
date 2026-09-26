/**
 * 配色与外观专项验收：npm run test:look:ui
 *
 * 2026-09-24：头像菜单「配色与外观…」打开面板，配色 + 自己调色相、圆角、密度、动效，按设备记住。
 * 2026-09-25：配色按原型 1:1 —— 「跟随系统」+ 浅色主题 9 套 + 深色主题 7 套；选深色主题明暗跟着切到深色；
 *   页面底色光晕、首页名字渐变这类「简写里混了 var()」的颜色也要跟着换。
 * 2026-09-25 晚：自己调能取色（取到的主色、点缀色就是页面上的颜色，太浅的主色会被限制并提示）。
 * 2026-09-26：自己调自动存进「我的配色」（从晨雾出发就叫「我的晨雾」），刷新后还在；切走再切回来原样；
 *   森屿的点缀色是 #36DEA3；Ctrl K 能切；改名、另存一份、删除要点两次。
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
    motion: document.documentElement.dataset.motion || 'auto',
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
    await page.evaluate(() => { localStorage.removeItem('ideahub.look'); localStorage.removeItem('ideahub.theme'); localStorage.removeItem('ideahub.look.mine.v1'); });
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
    assert.deepEqual(panel, { focusInside: true, families: 17, pressed: 'default', menuClosed: true, overflow: 0, drawerFits: true }, `${scene} 面板状态 ${JSON.stringify(panel)}`);
    const paint0 = await page.evaluate(() => [getComputedStyle(document.body).backgroundImage, getComputedStyle(document.querySelector('#v-home .dash-name')).backgroundImage]);

    // 换成「晨雾」：主色变了，红色语义色不动，次要文字对比度仍达标
    await page.click('[data-look-family="mist"]');
    st = await probe(page);
    assert.equal(st.family, 'mist');
    assert.notEqual(st.blue, ORIGINAL_BLUE, '换了配色主色应该变');
    assert.equal(st.crit, 'light-dark(#b96869,#e79c9c)', '语义红色不该跟着配色变');
    assert.ok(st.contrast >= 4.5, `${scene} 晨雾浅色下次要文字对比度 ${st.contrast.toFixed(2)} < 4.5`);
    assert.equal(JSON.parse(st.stored).family, 'mist', '应记在这台设备上');
    assert.equal(await page.$eval('[data-look-family="mist"]', b => b.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', '选浅色主题，明暗切到浅色');
    // 简写里混了 var() 的颜色（页面底色光晕、首页名字渐变中段）也换了
    const paint1 = await page.evaluate(() => [getComputedStyle(document.body).backgroundImage, getComputedStyle(document.querySelector('#v-home .dash-name')).backgroundImage]);
    assert.notEqual(paint1[0], paint0[0], '页面底色光晕应跟着配色变');
    assert.notEqual(paint1[1], paint0[1], '首页名字渐变应跟着配色变');
    await harness.screenshot(page, `mist-${scene}`);

    // 深色主题：选「深海」，明暗跟着切到深色，对比度照样达标
    await page.click('[data-look-family="ocean"]');
    st = await probe(page);
    assert.deepEqual([st.family, await page.evaluate(() => document.documentElement.dataset.theme)], ['ocean', 'dark'], '选深色主题，明暗切到深色');
    assert.ok(st.contrast >= 4.5, `${scene} 深海次要文字对比度 ${st.contrast.toFixed(2)} < 4.5`);
    await harness.screenshot(page, `ocean-${scene}`);
    await page.click('[data-look-family="mist"]');

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

    // 拖主色滑块：从晨雾接手，自动存进「我的配色」（叫「我的晨雾」）并选中，不需要再点保存
    await page.$eval('#lookA', el => { el.value = '150'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForSelector('[data-look-mine][aria-pressed="true"]');
    const custom = await page.evaluate(() => ({ s: window.IdeaHubLook.get(), list: JSON.parse(localStorage.getItem('ideahub.look.mine.v1')),
      label: document.querySelector('[data-look-mine][aria-pressed="true"]').textContent.trim(), loose: !!document.querySelector('[data-look-family="custom"]') }));
    // 底色色相跟着主色转同样的角度：晨雾底色 255°、主色 268° → 主色拖到 150°，底色到 137°
    assert.deepEqual([custom.s.family, custom.s.A, custom.s.H, custom.list.length, custom.list[0].name, custom.s.mine, custom.label, custom.loose],
      ['custom', 150, 137, 1, '我的晨雾', custom.list[0].id, '我的晨雾', false], JSON.stringify(custom));
    const mineId = custom.list[0].id;
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('ideahub.look.mine.v1')));

    // 取色：浅色下取一个主色，页面上的主色就是这个颜色，并且立刻写回「我的晨雾」
    const blueNow = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim());
    const pick = (id, hex) => page.$eval(id, (el, hex) => { el.value = hex; el.dispatchEvent(new Event('input', { bubbles: true })); }, hex);
    await page.click('[data-look-mode="light"]');
    await pick('#lookPickA', '#8e2a3b');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim().startsWith('light-dark(#8e2a3b'));
    assert.equal(await page.$eval('#lookPickAHex', el => el.textContent), '#8E2A3B');
    assert.deepEqual((await stored()).map(m => [m.id, m.A, m.mode]), [[mineId, 15, 'light']], '取色要自动写回正在用的那套');
    // 太浅的主色：按钮白字会看不清，深浅被限制住并提示
    await pick('#lookPickA', '#ffd6e0');
    await page.waitForFunction(() => !document.querySelector('#lookPickNote').hidden);
    assert.ok(await page.evaluate(() => window.IdeaHubLook.get().AL <= 0.56), '太浅的主色应被限制');
    await pick('#lookPickA', '#8e2a3b');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim().startsWith('light-dark(#8e2a3b'));
    // 点缀色照取的来：「待我审核」色块正好是取的颜色
    await pick('#lookPickB', '#36dea3');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--hot').trim().startsWith('light-dark(#36dea3'));
    assert.equal(await page.$eval('#lookPickBHex', el => el.textContent), '#36DEA3');
    const savedBlue = await blueNow();
    await harness.screenshot(page, `mine-${scene}`);

    // 刷新：自己调的颜色还在，「我的晨雾」仍是选中的（09-26 用户反馈过刷新后回到默认）
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await blueNow(), savedBlue, '刷新后首屏就该是自己调的颜色');
    await page.waitForFunction(() => document.querySelector('#v-home.on')?.childElementCount > 0 && document.querySelector('#meAvatar')?.textContent.trim());
    await settleDom(page);
    await openPanel(page);
    assert.equal(await page.$eval(`[data-look-mine="${mineId}"]`, b => b.getAttribute('aria-pressed')), 'true');
    assert.match(await page.$eval('#lookMineBar', b => b.textContent), /已自动保存到「我的晨雾」/);

    // 切到别的配色再点回来：原样回来
    await page.click('[data-look-family="mist"]');
    assert.notEqual(await blueNow(), savedBlue);
    await page.click(`[data-look-mine="${mineId}"]`);
    await page.waitForFunction(b => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() === b, {}, savedBlue);

    // 森屿的点缀色（09-26 按用户要求）是薄荷绿 #36DEA3
    await page.click('[data-look-family="forest"]');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--hot').trim().startsWith('light-dark(#36dea3'));
    await page.click(`[data-look-mine="${mineId}"]`);
    await page.waitForFunction(b => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() === b, {}, savedBlue);

    // Ctrl K 里也能切到我的配色
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
    await page.waitForSelector('#cmdkInput');
    await page.type('#cmdkInput', '我的晨雾');
    assert.equal(await page.$eval('.cmdk-item span', el => el.textContent), '配色换成「我的晨雾」（我的配色）');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cmdk'));

    // 改名
    await page.click('[data-look-mine-rename]');
    await page.waitForSelector('#lookMineName');
    await page.type('#lookMineName', '酒红');
    await page.keyboard.press('Enter');
    await page.waitForFunction(id => document.querySelector(`[data-look-mine="${id}"]`)?.textContent.trim() === '酒红', {}, mineId);
    // 另存一份：起名后多一套并切到新的那套
    await page.click('[data-look-mine-copy]');
    await page.waitForSelector('#lookMineName');
    await page.$eval('#lookMineName', el => el.select());
    await page.type('#lookMineName', '酒红备份');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('[data-look-mine]').length === 2);
    const copyId = await page.evaluate(() => window.IdeaHubLook.get().mine);
    assert.notEqual(copyId, mineId, '另存后应切到新的那套');
    // 删除要点两次；删掉正在用的那套后颜色留着，可以再存
    await page.click('[data-look-mine-del]');
    assert.equal(await page.$eval('[data-look-mine-del]', b => b.textContent), '确认删除？');
    assert.equal((await stored()).length, 2, '点一次不该删');
    await page.click('[data-look-mine-del]');
    await page.waitForFunction(() => document.querySelectorAll('[data-look-mine]').length === 1);
    assert.deepEqual(await page.evaluate(() => [window.IdeaHubLook.get().family, window.IdeaHubLook.get().mine,
      document.querySelector('[data-look-family="custom"]')?.getAttribute('aria-pressed'), !!document.querySelector('[data-look-mine-copy]')]), ['custom', '', 'true', true]);
    assert.equal(await blueNow(), savedBlue, '删掉后颜色应留着');

    // 圆角、密度、动效
    await page.$eval('#lookRadius', el => { el.value = '1.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--rd-lg').trim() === '21px');
    await page.click('[data-look-density="compact"]');
    // 系统开着「减弱动态效果」（本测试就是这样模拟的）：跟随系统时动效收起，明确选「完整」就照样播
    const motionNote = () => document.querySelector('#lookMotionNote').textContent;
    assert.match(await page.evaluate(motionNote), /系统现在关着动画/, '跟随系统且系统关了动画时，应提示可以选「完整」');
    assert.equal(await page.evaluate(async () => (await import('./src/anim.js')).reduced()), true);
    await page.click('[data-look-motion="always"]');
    assert.deepEqual(await page.evaluate(async () => [document.documentElement.dataset.motion, (await import('./src/anim.js')).reduced()]), ['always', false],
      '明确选了「完整」，系统关了动画也要照样播放');
    await page.click('[data-look-motion="off"]');
    st = await probe(page);
    assert.deepEqual([st.rdLg, st.sp2xl, st.motion], ['21px', '13px', 'off'], JSON.stringify(st));
    await harness.screenshot(page, `custom-${scene}`);

    // 恢复默认：样式表原样还回去，圆角 / 间距不再被覆盖，存储清掉，明暗回到跟随系统
    await page.click('[data-look-reset]');
    st = await probe(page);
    assert.deepEqual([st.family, st.blue, st.rdLg, st.sp2xl, st.motion, st.stored], ['default', ORIGINAL_BLUE, '14px', '16px', 'auto', null], JSON.stringify(st));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'auto');

    // Esc 关面板，焦点回到头像
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#lookDrawer.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meAvatar', '关掉面板后焦点应回到头像');

    // 存储坏了：退回默认，不报错
    await page.evaluate(() => localStorage.setItem('ideahub.look', '{坏的'));
    await reload(page);
    assert.equal((await probe(page)).family, 'default', '存储内容坏了应退回默认外观');

    harness.recordCheck(`${scene}-look`, 'interaction', { families: 17, remembered: true, semanticKept: true });
    await page.evaluate(() => { localStorage.removeItem('ideahub.look'); localStorage.removeItem('ideahub.theme'); localStorage.removeItem('ideahub.look.mine.v1'); });
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
