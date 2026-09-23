/**
 * 「有新版本」提示条专项验收：npm run test:update-banner:ui
 *
 * 页面自己的版本号取自 dist/app.js?v=…；测试页（QA 模式）没有这个标签，
 * 这里塞一个不会真去加载的 <script type="text/plain" src="./dist/app.js?v=old"> 冒充旧版页面，
 * 再直接调 checkVersion() 模拟后端 hello 带来的版本号。桌面和手机各走一遍：
 *   版本一样不提示 → 不一样才提示 → 「稍后」收起、同一版本不再打扰 → 更新的版本再次提示 → 「刷新」重新加载页面
 * 另外核对后端从打包后的 index.html 里读版本号的写法。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/update-banner' });

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await page.evaluate(async () => {
      const tag = document.createElement('script');
      tag.type = 'text/plain';
      tag.setAttribute('src', './dist/app.js?v=old1');
      document.head.appendChild(tag);
      window.__ub = await import('/src/update-banner.js');
    });
    const on = () => !!document.querySelector('.update-banner.on');

    assert.equal(await page.evaluate(() => window.__ub.loadedVersion()), 'old1');
    assert.equal(await page.evaluate(() => window.__ub.checkVersion('old1')), false, '版本一样不该提示');
    assert.equal(await page.evaluate(() => window.__ub.checkVersion(null)), false, '后端没给版本号（源码模式）不该提示');
    assert.equal(await page.evaluate(on), false);

    assert.equal(await page.evaluate(() => window.__ub.checkVersion('new2')), true);
    await page.waitForFunction(() => {
      const b = document.querySelector('.update-banner.on')?.getBoundingClientRect();
      return b && b.top >= 0 && b.bottom <= innerHeight;
    });
    await settleDom(page);
    const box = await page.$eval('.update-banner', el => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: innerHeight - b.bottom, left: b.left, right: innerWidth - b.right, text: el.textContent.replace(/\s+/g, ' ').trim() };
    });
    assert.match(box.text, /有新版本/);
    assert.ok(box.left >= 8 && box.right >= 8, `提示条超出屏幕 ${JSON.stringify(box)}`);
    assert.ok(box.top >= 60 && box.top < 100, `提示条应贴在顶栏下方，不挡顶栏 ${JSON.stringify(box)}`);
    // 不和顶栏里的按钮、右下角的聊天按钮重叠
    const overlaps = await page.$eval('.update-banner', el => {
      const b = el.getBoundingClientRect();
      return [...document.querySelectorAll('.topbar button, .topbar a, .topbar input, #chatBtn')]
        .filter(n => n.getClientRects().length)
        .map(n => n.getBoundingClientRect())
        .filter(r => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top).length;
    });
    assert.equal(overlaps, 0, '提示条盖住了顶栏或聊天按钮');
    assert.equal(await page.$eval('.update-banner .ub-text', el => el.scrollWidth <= el.clientWidth + 1), true, '提示文字被截断');
    const inside = await page.$eval('.update-banner', el => {
      const b = el.getBoundingClientRect();
      return [...el.querySelectorAll('button')].every(n => { const r = n.getBoundingClientRect(); return r.left >= b.left - 0.5 && r.right <= b.right + 0.5; });
    });
    assert.equal(inside, true, '按钮挤出了提示条的深色底');
    await harness.screenshot(page, `update-banner-${scene}`);

    // 稍后：收起，同一版本不再打扰；更新的版本还会提示
    await page.click('.update-banner .ub-later');
    await page.waitForFunction(() => !document.querySelector('.update-banner.on'));
    assert.equal(await page.evaluate(() => window.__ub.checkVersion('new2')), false);
    assert.equal(await page.evaluate(() => window.__ub.checkVersion('new3')), true);

    // 刷新：重新加载页面
    await Promise.all([page.waitForNavigation(), page.click('.update-banner .ub-reload')]);
    assert.equal(await page.evaluate(() => !!document.querySelector('.update-banner')), false, '刷新后是一个新页面');

    harness.recordCheck(`${scene}-update-banner`, 'interaction', { same: true, differ: true, later: true, reload: true });
    await page.close();
  }

  // 后端读版本号：打包后的 index.html 里有 dist/app.js?v=…
  const { WEB_VERSION } = await import('../server/src/routes/events.mjs');
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const expected = /dist\/app\.js\?v=([\w-]+)/.exec(html)?.[1] || null;
  assert.equal(WEB_VERSION, expected, '后端读到的版本号应和 index.html 里的一致（源码模式下都是 null）');

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`新版本提示验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
