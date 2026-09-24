/**
 * 新功能引导专项验收：npm run test:tour:ui
 *
 * 2026-09-24：第一次打开首页时一步步指出新功能（src/tour.js）。桌面和手机各走一遍：
 *   自动化浏览器默认不弹（其余 UI 测试不受打扰）→ 放开后第一次打开首页出现，桌面 7 步、手机只留看得见的
 *   → 每一步聚光框圈住目标、说明卡在屏幕内 → 走完「开始使用」关掉并记住，刷新不再出现
 *   → 头像菜单「新功能介绍」可以再看，Esc 关掉；点页面别处也会关掉
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/tour' });

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on #dashBento .dash-hero') && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}

/** 当前这一步：聚光框有没有圈住目标、说明卡是否整个在屏幕里 */
const stepState = page => page.evaluate(() => {
  const spot = document.querySelector('.tour-spot').getBoundingClientRect();
  const card = document.querySelector('.tour-card').getBoundingClientRect();
  return {
    step: document.querySelector('#tourStep').textContent,
    title: document.querySelector('#tourTitle').textContent,
    spotOk: spot.width > 10 && spot.height > 10,
    cardIn: card.left >= 0 && card.top >= 0 && card.right <= innerWidth + 0.5 && card.bottom <= innerHeight + 0.5,
    focusInCard: document.querySelector('.tour-card').contains(document.activeElement),
  };
});

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const mobile = scene === 'mobile';
    const page = await harness.newPage(scene, viewport);

    // 自动化浏览器默认不弹：其余 UI 测试不会被引导挡住
    await page.evaluate(() => localStorage.removeItem('ideahub.tour.v1'));
    await reload(page);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await page.$('.tour'), null, '自动化浏览器里不该自动弹引导');

    // 放开后，第一次打开首页出现引导
    await page.evaluate(() => sessionStorage.setItem('ideahub.qa.tour', '1'));
    await reload(page);
    await page.waitForSelector('.tour-card', { timeout: 5000 });
    let st = await stepState(page);
    const total = Number(st.step.match(/\/ (\d+)/)[1]);
    if (mobile) assert.ok(total >= 2 && total < 7, `手机上只该留看得见的步骤：${st.step}`);
    else assert.equal(total, 7, `桌面应有 7 步：${st.step}`);
    assert.deepEqual([st.title, st.spotOk, st.cardIn, st.focusInCard], ['首页改版了', true, true, true], JSON.stringify(st));
    assert.equal(await page.$eval('[data-tour="prev"]', b => b.hidden), true, '第一步没有「上一步」');
    await harness.screenshot(page, `step1-${scene}`);

    // 一步步走到最后：每一步都圈住目标、卡片不出屏
    for (let i = 2; i <= total; i++) {
      await page.click('[data-tour="next"]');
      st = await stepState(page);
      assert.ok(st.step.startsWith(`新功能 ${i} / ${total}`), JSON.stringify(st));
      assert.ok(st.spotOk && st.cardIn, `${scene} 第 ${i} 步位置不对 ${JSON.stringify(st)}`);
    }
    assert.equal(await page.$eval('[data-tour="next"]', b => b.textContent), '开始使用');
    if (!mobile) await harness.screenshot(page, `last-${scene}`);
    await page.click('[data-tour="next"]');
    assert.equal(await page.$('.tour'), null, '最后一步点「开始使用」应关掉');
    assert.equal(await page.evaluate(() => localStorage.getItem('ideahub.tour.v1')), 'done', '看完要记住');

    // 刷新不再出现
    await reload(page);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(await page.$('.tour'), null, '看过以后不该再自动出现');

    // 头像菜单可以再看一次；Esc 关掉
    await page.click('#meAvatar');
    await page.waitForFunction(() => document.querySelector('#userMenu.on'));
    await page.click('#miTour');
    await page.waitForSelector('.tour-card', { timeout: 5000 });
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.tour'), null, 'Esc 应关掉引导');

    // 点页面别处也会关掉，而且那一下点击照常生效（这里点的是待办筛选）
    await page.click('#meAvatar');
    await page.waitForFunction(() => document.querySelector('#userMenu.on'));
    await page.click('#miTour');
    await page.waitForSelector('.tour-card', { timeout: 5000 });
    await page.$eval('#dashFocusSeg', el => el.scrollIntoView({ block: 'center' }));
    await page.click('#dashFocusSeg [data-filter="client"]');
    assert.equal(await page.$('.tour'), null, '点页面别处应关掉引导');
    assert.equal(await page.$eval('#dashFocusSeg [data-filter="client"]', b => b.getAttribute('aria-pressed')), 'true', '那一下点击要照常生效');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${scene} 不该横向滚动`);

    harness.recordCheck(`${scene}-tour`, 'interaction', { steps: total });
    await page.evaluate(() => { sessionStorage.removeItem('ideahub.qa.tour'); localStorage.removeItem('ideahub.tour.v1'); });
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`新功能引导验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
