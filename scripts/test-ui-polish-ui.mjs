/**
 * 界面细节专项验收：npm run test:ui-polish:ui
 *
 * 2026-09-23 按走查结论修的几处，锁住别再退回去。桌面和手机各走一遍：
 *   1. 可读性：主要页面上没有小于 12px 的文字；次要文字（var(--muted)）在页面底色上对比度 ≥ 4.5:1
 *   2. 首页日报表单的标签、输入框不贴卡片边（左右留出和标题一样的内边距）
 *   4. 聊天按钮往下滑收起、往上滑回来；有未读消息时不收
 *   5. 客户档案（桌面）左栏的「S 级」、「城市 · 年龄 · 来源」各占一行，不被挤折
 *   7. 顶栏搜索框的提示语完整显示，不被截断（桌面）
 * 截图和 report.json 写到 scripts/.uidiff/ui-polish/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/ui-polish' });
const VIEWS = ['home', 'pool', 'demands', 'formal', 'clients', 'reports', 'expenses', 'purchases', 'stats', 'samples'];

async function go(page, view) {
  await page.evaluate(v => document.querySelector(`[data-go="${v}"]`)?.click(), view);
  await new Promise(r => setTimeout(r, 500));
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);

    // 1. 字号与对比度
    for (const view of VIEWS) {
      await go(page, view);
      const r = await page.evaluate(() => {
        const lum = c => {
          const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number)
            .map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
          return .2126 * r + .7152 * g + .0722 * b;
        };
        const small = [];
        for (const el of document.querySelectorAll('body *')) {
          if (!el.getClientRects().length) continue;
          if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (size < 12) small.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${size}px 「${el.textContent.trim().slice(0, 12)}」`);
        }
        const probe = document.createElement('span');
        probe.style.color = 'var(--muted)';
        document.body.appendChild(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        const bg = getComputedStyle(document.body).backgroundColor;
        const [a, b] = [lum(muted), lum(bg)].sort((x, y) => y - x);
        return { small: small.slice(0, 5), smallCount: small.length, contrast: (a + .05) / (b + .05) };
      });
      assert.equal(r.smallCount, 0, `${scene}/${view} 还有 ${r.smallCount} 处小于 12px 的文字：${r.small.join('；')}`);
      assert.ok(r.contrast >= 4.5, `${scene}/${view} 次要文字对比度 ${r.contrast.toFixed(2)} < 4.5`);
    }

    // 2. 日报表单不贴边
    await go(page, 'home');
    const inset = await page.evaluate(() => {
      const card = document.querySelector('.dash-today').getBoundingClientRect();
      const items = [...document.querySelectorAll('.dash-today-body label, .dash-today-body .inp')]
        .filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect());
      return {
        left: Math.min(...items.map(b => b.left - card.left)),
        right: Math.min(...items.map(b => card.right - b.right)),
        header: document.querySelector('.dash-today>header').getBoundingClientRect().left - card.left
          + parseFloat(getComputedStyle(document.querySelector('.dash-today>header')).paddingLeft),
      };
    });
    assert.ok(inset.left >= 12 && inset.right >= 12, `日报表单贴边了 ${JSON.stringify(inset)}`);
    assert.ok(Math.abs(inset.left - inset.header) <= 2, `日报表单没和标题对齐 ${JSON.stringify(inset)}`);
    await harness.screenshot(page, `home-${scene}`);

    // 4. 聊天按钮：往下滑收起，往上滑回来；有未读时不收
    await go(page, 'pool');
    const scroller = scene === 'mobile' ? 'document.scrollingElement' : "document.querySelector('.main')";
    const scrollBy = dy => page.evaluate(`(${scroller}).scrollBy(0, ${dy}); (${scroller}).dispatchEvent(new Event('scroll'))`);
    const tucked = () => page.evaluate(() => document.querySelector('#chatBtn').classList.contains('tucked'));
    await scrollBy(400);
    await page.waitForFunction(() => document.querySelector('#chatBtn').classList.contains('tucked'));
    assert.equal(await page.$eval('#chatBtn', el => getComputedStyle(el).pointerEvents), 'none', '收起后不该还能点到');
    await scrollBy(-200);
    await page.waitForFunction(() => !document.querySelector('#chatBtn').classList.contains('tucked'));
    await scrollBy(300);
    await page.waitForFunction(() => document.querySelector('#chatBtn').classList.contains('tucked'));
    await page.waitForFunction(() => !document.querySelector('#chatBtn').classList.contains('tucked'), { timeout: 3000 });  // 停下来自己回来
    await page.evaluate(() => { document.querySelector('#chatDot').hidden = false; });
    await scrollBy(300);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await tucked(), false, '有未读消息时聊天按钮不该收起');
    await page.evaluate(() => { document.querySelector('#chatDot').hidden = true; });

    // 5. 客户档案左栏（桌面三栏布局）
    if (scene === 'desktop') {
      await go(page, 'clients');
      const lines = await page.evaluate(() => [...document.querySelectorAll('.client-card')].map(card => {
        const lh = el => { const cs = getComputedStyle(el); return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5; };
        const tier = card.querySelector('.tier-badge');
        const meta = card.querySelector('header p');
        return { name: card.querySelector('h3').textContent, tier: Math.round(tier.getBoundingClientRect().height / lh(tier)), meta: Math.round(meta.getBoundingClientRect().height / lh(meta)) };
      }));
      for (const l of lines) assert.deepEqual([l.tier, l.meta], [1, 1], `客户「${l.name}」左栏被挤折了 ${JSON.stringify(l)}`);
      await harness.screenshot(page, `clients-${scene}`);

      // 7. 搜索提示语不截断
      const fit = await page.evaluate(() => {
        const input = document.querySelector('#q, input[aria-label="全局搜索"]');
        const cs = getComputedStyle(input);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return { need: ctx.measureText(input.placeholder).width, have: input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      });
      assert.ok(fit.need <= fit.have, `搜索提示语放不下 ${JSON.stringify(fit)}`);
    }

    harness.recordCheck(`${scene}-ui-polish`, 'layout', { minFont: true, contrast: true, dashInset: true, chatTuck: true, clients: scene === 'desktop', search: scene === 'desktop' });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`界面细节验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
