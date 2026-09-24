/**
 * 首页拼贴专项验收：npm run test:dashboard:ui
 *
 * 2026-09-24 首页改成拼贴布局，加了能直接在首页上做的事。桌面和手机各走一遍：
 *   8 块卡片都在、进度环从 0 开始 → 勾掉一条：划线沉底、进度环 +1、刷新后仍勾着（只记今天、只记这台设备）
 *   → 筛选「已推进」只剩它 → 漏斗切到「转化率」→ 布局编辑（桌面）：藏起、改宽度、挪位置、刷新后记住、恢复默认
 *   → 专注模式：F 进、Esc 出、离开首页自动收掉 → 搜索框命令：没字时列出常用操作、↑↓ + Enter 执行
 *   → 手机上的顺序是 问候 → 待我审核 → 待办 → 每日总结 → 数字，页面不横向滚动
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/dashboard' });
const KEYS = ['ideahub.dash.layout.v1', 'ideahub.look', 'ideahub.navRail.v1'];

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on #dashBento .dash-hero')
    && document.querySelector('#dashFocusList .dash-focus-item') && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}
const ring = page => page.$eval('#dashRingNum', el => el.textContent.trim());
const tiles = page => page.$$eval('#dashBento > [data-tile]', els => els.filter(el => !el.hidden).map(el => el.dataset.tile));

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const mobile = scene === 'mobile';
    const page = await harness.newPage(scene, viewport);
    // 减弱动态效果：FLIP、彩纸、滑入都直接到位，断言才是确定的
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(keys => {
      for (const k of keys) localStorage.removeItem(k);
      for (const k of Object.keys(localStorage)) if (k.startsWith('ideahub.dash.done.v1:')) localStorage.removeItem(k);
    }, KEYS);
    await reload(page);

    // 8 块卡片、进度环从 0 开始、待我审核那块在
    assert.deepEqual(await tiles(page), ['hero', 'hot', 'today', 'stats', 'focus', 'pipeline', 'library', 'clients']);
    const total = await page.$$eval('#dashFocusList .dash-focus-item', els => els.length);
    assert.ok(total >= 2, '演示数据里应有至少两条待办');
    assert.equal(await ring(page), `0/${total}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${scene} 首页不该横向滚动`);

    // 勾掉第一条：划线沉底、进度环 +1
    const first = await page.$eval('#dashFocusList .dash-focus-item', el => el.dataset.fid);
    await page.click(`#dashFocusList [data-fid="${first}"] .dash-check`);
    const afterCheck = await page.$$eval('#dashFocusList .dash-focus-item', els => els.map(el => ({ fid: el.dataset.fid, done: el.classList.contains('is-done') })));
    assert.deepEqual(afterCheck.at(-1), { fid: first, done: true }, '勾掉的那条应沉到最下面');
    assert.equal(await ring(page), `1/${total}`);
    assert.match(await page.$eval('#dashHeroLine', el => el.textContent), new RegExp(`还剩 ${total - 1} 件`));
    await harness.screenshot(page, `checked-${scene}`);

    // 刷新后仍勾着；筛选「已推进」只剩它
    await reload(page);
    assert.equal(await ring(page), `1/${total}`, '刷新后今天的勾选要记住');
    await page.click('#dashFocusSeg [data-filter="done"]');
    assert.deepEqual(await page.$$eval('#dashFocusList .dash-focus-item', els => els.map(el => el.dataset.fid)), [first]);
    await page.click('#dashFocusSeg [data-filter="all"]');
    await page.click(`#dashFocusList [data-fid="${first}"] .dash-check`);
    assert.equal(await ring(page), `0/${total}`, '再点一次取消勾选');

    // 漏斗切到转化率：条的宽度换成转化率
    await page.click('#dashPipeSeg [data-pipe="rate"]');
    const bars = await page.$$eval('.dash-pipeline-list i[data-w]', els => els.map(i => [i.style.width, i.dataset.r]));
    assert.ok(bars.length && bars.every(([w, r]) => w === r), `漏斗条应显示转化率 ${JSON.stringify(bars)}`);
    await page.click('#dashPipeSeg [data-pipe="count"]');

    if (!mobile) {
      // 侧栏（09-24 晚按原型改）：滑动色块对准当前页；收成窄栏只剩图标、刷新后记住、再点展开
      const aligned = () => page.waitForFunction(() => {
        const ind = document.querySelector('.nav-ind').getBoundingClientRect();
        const on = document.querySelector('.navmenu button.on').getBoundingClientRect();
        return Math.abs(ind.top - on.top) < 2 && Math.abs(ind.height - on.height) < 2 && getComputedStyle(document.querySelector('.nav-ind')).opacity === '1';
      }, { timeout: 4000 });
      await aligned();
      assert.equal(await page.$$eval('.navmenu button[data-go] .nav-ic svg', els => els.length), await page.$$eval('.navmenu button[data-go]', els => els.length), '每一项都该有图标');
      await page.click('#navRailBtn');
      await page.waitForFunction(() => document.querySelector('#appNav').getBoundingClientRect().width === 76 && parseFloat(getComputedStyle(document.querySelector('.main')).marginLeft) === 76, { timeout: 4000 });
      assert.equal(await page.$eval('.navmenu button.on .nav-label', el => getComputedStyle(el).display), 'none', '窄栏只显示图标');
      await aligned();
      await harness.screenshot(page, `rail-${scene}`);
      await reload(page);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('nav-rail')), true, '刷新后窄栏要记住');
      await page.click('#navRailBtn');
      await page.waitForFunction(() => document.querySelector('#appNav').getBoundingClientRect().width === 230, { timeout: 4000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('ideahub.navRail.v1')), '0');

      // 布局编辑：藏起「团队资产」、把「待办」改宽、把「待我审核」挪到最前面
      await page.click('#dashEditBtn');
      assert.equal(await page.$eval('#dashBento', el => el.classList.contains('editing')), true);
      assert.equal(await page.$$eval('.dash-tile-tools', els => els.length), 8);
      await page.click('[data-tile="library"] [data-tile-hide]');
      await page.click('[data-tile="focus"] [data-tile-size]');
      await page.click('[data-tile="hot"] [data-tile-move="-1"]');
      assert.deepEqual(await page.$$eval('#dashTray [data-tile-show]', els => els.map(b => b.dataset.tileShow)), ['library']);
      await harness.screenshot(page, `editing-${scene}`);
      await page.click('[data-dash-layout="done"]');
      assert.equal(await page.$$eval('.dash-tile-tools', els => els.length), 0, '完成后工具条要收掉');

      await reload(page);
      assert.deepEqual(await tiles(page), ['hot', 'hero', 'today', 'stats', 'focus', 'pipeline', 'clients'], '刷新后布局要记住');
      assert.equal(await page.$eval('[data-tile="focus"]', el => el.style.getPropertyValue('--span')), '6');
      await page.click('#dashEditBtn');
      await page.click('[data-dash-layout="reset"]');
      await page.click('[data-dash-layout="done"]');
      assert.deepEqual(await tiles(page), ['hero', 'hot', 'today', 'stats', 'focus', 'pipeline', 'library', 'clients'], '恢复默认');
    } else {
      assert.equal(await page.$eval('#dashTools', el => getComputedStyle(el).display), 'none', '手机上不显示专注 / 布局按钮');
      const top = sel => page.$eval(sel, el => el.getBoundingClientRect().top);
      const order = await Promise.all(['.dash-hero', '.dash-hot', '.dash-focus', '.dash-today', '.dash-action-grid'].map(top));
      assert.deepEqual([...order].sort((a, b) => a - b), order, `手机首页顺序不对 ${order}`);
    }

    // 专注模式：F 进、Esc 出；进着的时候离开首页也会收掉
    await page.keyboard.press('f');
    assert.equal(await page.$eval('#dashBento', el => el.classList.contains('focusing')), true, 'F 应打开专注模式');
    assert.match(await page.$eval('.dash-focusbar b', el => el.textContent), /^25:00|24:5\d$/);
    await harness.screenshot(page, `focus-${scene}`);
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.dash-focusbar'), null, 'Esc 应关掉专注模式');
    await page.keyboard.press('f');
    await page.evaluate(() => document.querySelector('[data-go="pool"]').click());
    await page.waitForFunction(() => document.querySelector('#v-pool.on'));
    assert.equal(await page.$('.dash-focusbar'), null, '离开首页要收掉专注模式');
    await page.evaluate(() => document.querySelector('[data-go="home"]').click());
    await page.waitForFunction(() => document.querySelector('#v-home.on'));

    // 搜索框里的命令（桌面：顶栏常驻搜索框）
    if (!mobile) {
      await page.click('#q');
      await page.waitForFunction(() => !document.querySelector('#searchPop').hidden && document.querySelector('.searchcmd'));
      await page.type('#q', '晨雾');
      await page.waitForFunction(() => [...document.querySelectorAll('.searchcmd')].some(b => b.textContent.includes('晨雾')));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.IdeaHubLook.get().family === 'mist');
      assert.equal(await page.$eval('#searchPop', el => el.hidden), true, '执行命令后搜索面板要收起');
      await page.evaluate(() => window.IdeaHubLook.reset());
      // 没字的时候失焦，命令列表收起，不挡住页面
      await page.click('#q');
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(() => document.querySelector('#searchPop').hidden);
    }

    harness.recordCheck(`${scene}-dashboard`, 'interaction', { tiles: 8, focusItems: total });
    await page.evaluate(keys => { for (const k of keys) localStorage.removeItem(k); }, KEYS);
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`首页拼贴验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
