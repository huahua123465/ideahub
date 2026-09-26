/**
 * 界面偏好跟着账号走的前端验收：npm run test:prefs-sync:ui
 *
 * 2026-09-26：配色与外观、我的配色、明暗改成跟着账号走（web/src/prefs-sync.js）。
 * 演示模式下用 localStorage 里的 ideahub.mock.uiPrefs 假装服务器（mock.js），打开 ideahub.qa.prefsync 才同步：
 *   在这台电脑换成「森屿」→ 1.5 秒后推到「服务器」
 *   → 换一台电脑（清空本地的外观设置）打开 → 自动用上森屿和浅色
 *   → 在别的电脑改成「晨雾」（直接改「服务器」那份）→ 这台刷新后跟着变成晨雾
 *   → 本地改了还没推就刷新 → 以本地为准，推上去
 * 服务端接口本身由 npm run test:api:prefs 覆盖。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/prefs-sync' });
const LOCAL = ['ideahub.look', 'ideahub.theme', 'ideahub.look.mine.v1', 'ideahub.uiPrefs.meta'];

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#v-home.on')?.childElementCount > 0 && document.querySelector('#meAvatar')?.textContent.trim());
  await settleDom(page);
}
const server = page => page.evaluate(() => JSON.parse(localStorage.getItem('ideahub.mock.uiPrefs') || 'null'));
const look = page => page.evaluate(() => ({ family: window.IdeaHubLook.get().family, theme: document.documentElement.dataset.theme }));

try {
  const page = await harness.newPage('desktop', { width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(keys => { for (const k of [...keys, 'ideahub.mock.uiPrefs']) localStorage.removeItem(k); sessionStorage.setItem('ideahub.qa.prefsync', '1'); }, LOCAL);
  await reload(page);

  // 这台电脑换成森屿：停一下就推到「服务器」
  await page.click('#lookBtn');
  await page.waitForSelector('#lookDrawer.on');
  await page.click('[data-look-family="forest"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ideahub.mock.uiPrefs') || 'null')?.prefs?.look?.family === 'forest', { timeout: 5000 });
  let s = await server(page);
  assert.equal(s.prefs.theme, 'light', '明暗也要一起存上去');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('ideahub.uiPrefs.meta'))).dirty, false, '推完之后不再标记为有改动');
  harness.recordCheck('push-after-change', 'interaction', { family: s.prefs.look.family });

  // 换一台电脑：本地的外观设置全清掉，打开后自动用上服务器那份
  await page.evaluate(keys => { for (const k of keys) localStorage.removeItem(k); }, LOCAL);
  await reload(page);
  await page.waitForFunction(() => window.IdeaHubLook.get().family === 'forest', { timeout: 5000 });
  assert.deepEqual(await look(page), { family: 'forest', theme: 'light' }, '新电脑上应自动用上账号里的配色');
  await harness.screenshot(page, 'new-device');

  // 在别的电脑改成晨雾：这台刷新后跟着变
  await page.evaluate(() => {
    const cur = JSON.parse(localStorage.getItem('ideahub.mock.uiPrefs'));
    cur.prefs.look = { ...cur.prefs.look, family: 'mist' };
    cur.updatedAt = new Date(Date.now() + 1000).toISOString();
    localStorage.setItem('ideahub.mock.uiPrefs', JSON.stringify(cur));
  });
  await reload(page);
  await page.waitForFunction(() => window.IdeaHubLook.get().family === 'mist', { timeout: 5000 });
  assert.equal((await look(page)).family, 'mist', '别处改过，这里刷新后应跟着变');

  // 本地改了还没来得及推就刷新：以本地为准，打开后推上去
  await page.evaluate(() => {
    window.IdeaHubLook.set({ family: 'sakura' });
    const m = JSON.parse(localStorage.getItem('ideahub.uiPrefs.meta'));
    localStorage.setItem('ideahub.uiPrefs.meta', JSON.stringify({ ...m, dirty: true, changedAt: Date.now() }));
  });
  await reload(page);
  assert.equal((await look(page)).family, 'sakura', '本地没推的改动不该被服务器那份盖掉');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ideahub.mock.uiPrefs'))?.prefs?.look?.family === 'sakura', { timeout: 5000 });
  harness.recordCheck('conflict-local-wins', 'interaction', { family: 'sakura' });

  // 收尾
  await page.evaluate(keys => { for (const k of [...keys, 'ideahub.mock.uiPrefs']) localStorage.removeItem(k); sessionStorage.removeItem('ideahub.qa.prefsync'); }, LOCAL);
  await page.close();

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`外观跟着账号走验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
