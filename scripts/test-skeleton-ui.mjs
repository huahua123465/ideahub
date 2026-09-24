/**
 * 骨架屏专项验收：npm run test:skeleton:ui
 *
 * 2026-09-24 起全站列表 / 页面第一次加载统一用 anim.js 的 skeleton()。这里把对应接口在 mock 里拖慢
 * （mock.js 的 __IDEAHUB_ACCOUNT_RESEARCH_DELAYS__ 按路径加延迟，对所有接口都生效），桌面和手机各走一遍：
 *   加载中：出现骨架（role=status、读屏文字对、有扫光块）、不撑出横向滚动
 *   数据回来：骨架消失、真实内容出现
 * 覆盖：首页（无缓存时）、报销、采购、样本库、内容采集记录、标签与对接、客户详情、聊天消息。
 * 截图写到 scripts/.uidiff/skeleton/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/skeleton' });
const DELAY = 4000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setDelays = (page, paths) => page.evaluate((paths, ms) => {
  globalThis.__IDEAHUB_ACCOUNT_RESEARCH_DELAYS__ = Object.fromEntries(paths.map(p => [p, ms]));
}, paths, DELAY);
const go = (page, view) => page.evaluate(v => document.querySelector(`#appNav [data-go="${v}"]`)?.click(), view);

/** 在 host 里等到骨架，量一遍，截图；再等骨架消失、ready 选择器出现 */
async function expectSkeleton(page, scene, name, host, label, ready) {
  await page.waitForFunction(h => document.querySelector(`${h} .sk-group`), { timeout: 3000 }, host);
  const sk = await page.evaluate(h => {
    const g = document.querySelector(`${h} .sk-group`);
    const lines = [...g.querySelectorAll('.sk-line')].filter(l => { const r = l.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
    const root = document.scrollingElement;
    return { role: g.getAttribute('role'), busy: g.getAttribute('aria-busy'), label: g.querySelector('.sr-only')?.textContent,
      lines: lines.length, anim: getComputedStyle(lines[0] || g).animationName,
      overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - innerWidth };
  }, host);
  assert.equal(sk.role, 'status', `${scene}/${name} 骨架没有 role=status`);
  assert.equal(sk.busy, 'true');
  assert.equal(sk.label, label, `${scene}/${name} 读屏文字不对`);
  assert.ok(sk.lines >= 3, `${scene}/${name} 骨架里看得见的占位块太少：${sk.lines}`);
  assert.ok(sk.overflow <= 1, `${scene}/${name} 骨架撑出了横向滚动 ${sk.overflow}px`);
  await harness.screenshot(page, `${scene}-${name}`);
  await page.waitForFunction((h, r) => !document.querySelector(`${h} .sk-group`) && document.querySelector(r),
    { timeout: DELAY + 6000 }, host, ready);
  harness.recordCheck(`${scene}-${name}`, 'skeleton', sk);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);

    // 首页：只有没缓存、第一次进来才画骨架（有缓存直接先画上次的数据）
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('ideahub-dashboard-v2:')) localStorage.removeItem(k); });
    await page.evaluateOnNewDocument(ms => { globalThis.__IDEAHUB_ACCOUNT_RESEARCH_DELAYS__ = { '/api/stats/overview': ms }; }, DELAY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectSkeleton(page, scene, 'home', '#v-home', '正在整理今天的工作…', '#v-home .dash-hero');
    await settleDom(page);

    await setDelays(page, ['/api/expenses']);
    await go(page, 'expenses');
    await expectSkeleton(page, scene, 'expenses', '#v-expenses', '正在读取报销单…', '#v-expenses .exp-body > :not(.sk-group)');

    await setDelays(page, ['/api/purchases']);
    await go(page, 'purchases');
    await expectSkeleton(page, scene, 'purchases', '#v-purchases', '正在读取采购申请…', '#v-purchases .pur-body > :not(.sk-group)');

    await setDelays(page, ['/api/samples']);
    await go(page, 'samples');
    await expectSkeleton(page, scene, 'samples', '#samplesList', '正在读取样本…', '#samplesList > :not(.sk-group)');

    await setDelays(page, ['/api/collector/tasks']);
    await go(page, 'collector');
    await expectSkeleton(page, scene, 'collector', '#collectorTaskList', '正在读取采集记录…', '#collectorTaskList > :not(.sk-group)');

    await setDelays(page, ['/api/tags']);
    await go(page, 'tagadmin');
    await expectSkeleton(page, scene, 'tagadmin', '#taRoot', '正在读取标签字典…', '#taRoot > :not(.sk-group)');

    await setDelays(page, []);
    await go(page, 'clients');
    await page.waitForFunction(() => document.querySelector('#v-clients .record-card[data-id]'));
    const ids = await page.evaluate(() => [...document.querySelectorAll('#v-clients .record-card[data-id]')].map(c => c.dataset.id));
    await setDelays(page, ids.map(id => `/api/clients/${id}`));
    await page.evaluate(() => document.querySelector('#v-clients .record-card[data-id] [data-open], #v-clients .record-card[data-id] .client-open, #v-clients .record-card[data-id]')?.click());
    await expectSkeleton(page, scene, 'client', '#v-clientDetail', '正在读取客户档案…', '#v-clientDetail h1');

    // 聊天：mock 里没有真人会话（/api/chat/peers 固定返回空），点不开。chat.js 那边只是把「加载中…」换成
    // skeleton('chat')，这里直接把同一段骨架放进打开的消息区，量外观和读屏文字
    await page.evaluate(() => document.querySelector('#chatBtn').click());
    await page.waitForFunction(() => document.querySelector('#chatPanel.on'));
    await page.evaluate(async () => {
      const { skeleton } = await import('/src/anim.js');
      document.querySelector('#chatPanel').classList.add('has-conv');
      document.querySelector('#chatMsgs').innerHTML = skeleton('chat', { n: 4, label: '正在读取消息…' });
      setTimeout(() => { document.querySelector('#chatMsgs').innerHTML = '<div class="msg"><div class="bubble">好的</div></div>'; }, 800);
    });
    await expectSkeleton(page, scene, 'chat', '#chatMsgs', '正在读取消息…', '#chatMsgs .msg');
    await setDelays(page, []);
    await page.close();
  }
  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`骨架屏验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
