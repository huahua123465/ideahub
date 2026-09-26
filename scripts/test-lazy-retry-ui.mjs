/**
 * 按需加载页面的「重试」验收：npm run test:lazy-retry:ui
 *
 * 2026-09-26：浏览器会记住某个 import() 失败过，同一个页面里再 import 不会重新下载，
 * 所以「重试」改成刷新整页，刷新后回到原来那一页（web/src/main.js LAZY_RETRY_KEY）。
 *   1. 点「样本库」时下载失败 → 出现「重试」→ 网络恢复后点「重试」→ 刷新并停在样本库，页面正常
 *   2. 首屏空闲后的后台预取正好断网 → 网络恢复后再点「内容采集」→ 先看到「重试」，点了能恢复
 * 这里要故意让请求失败，所以不用 harness.newPage（它会把失败的请求当成错误），自己开页面。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/lazy-retry' });
const wait = ms => new Promise(r => setTimeout(r, ms));
const LAZY_CHUNK = /\/__qa\/chunks\/(samples|collector|learning|function-tree)-/;

async function openHome() {
  const page = await harness.browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.net = 'ok';
  page.lazyRequests = 0;
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (LAZY_CHUNK.test(req.url())) {
      page.lazyRequests++;
      if (page.net === 'down') return req.abort('failed');
    }
    req.continue();
  });
  await page.goto(`${harness.origin}/?mock=1&uiqa=1`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  return page;
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('.view.on')?.childElementCount > 0 && document.querySelector('#meAvatar')?.textContent.trim(), { timeout: 15_000 });
  await settleDom(page);
}
const go = (page, name) => page.evaluate(name => document.querySelector(`[data-go="${name}"]`).click(), name);
const failShown = (page, name) => page.waitForSelector(`#v-${name}.on .lazy-fail [data-lazy-retry="${name}"]`, { timeout: 8000 });
async function retryAndCheck(page, name) {
  const before = page.lazyRequests;
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click(`#v-${name} [data-lazy-retry="${name}"]`),
  ]);
  await ready(page);
  await page.waitForFunction(name => document.querySelector(`#v-${name}.on`) && !document.querySelector(`#v-${name} .lazy-wait`)
    && !document.querySelector(`#v-${name} .lazy-fail`) && document.querySelector(`#v-${name}`).childElementCount > 0, { timeout: 8000 }, name);
  assert.ok(page.lazyRequests > before, `${name}：点「重试」后应重新下载`);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ideahub.lazyRetry')), null, '回到原页后应清掉记号');
}

try {
  // 1. 点进去时下载失败 → 重试
  let page = await openHome();
  page.net = 'down';
  await go(page, 'samples');
  await failShown(page, 'samples');
  await harness.screenshot(page, 'fail');
  page.net = 'ok';
  await retryAndCheck(page, 'samples');
  await harness.screenshot(page, 'after-retry');
  harness.recordCheck('retry-after-fail', 'interaction', { view: 'samples' });
  await page.close();

  // 2. 后台预取碰上断网：之后再点进去先给「重试」，点了能恢复
  page = await openHome();
  page.net = 'down';
  for (let t = 0; page.lazyRequests < 4; t += 200) {   // 首屏空闲 5 秒后，4 个页面一起预取
    assert.ok(t < 12_000, '首屏空闲后应在后台预取按需加载的页面');
    await wait(200);
  }
  await wait(300);
  page.net = 'ok';
  await go(page, 'collector');
  await failShown(page, 'collector');
  await retryAndCheck(page, 'collector');
  harness.recordCheck('retry-after-prefetch-fail', 'interaction', { view: 'collector' });
  await page.close();

  await harness.writeReport();
  console.log(`按需加载重试验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
