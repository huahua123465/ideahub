/**
 * 界面细节专项验收：npm run test:ui-polish:ui
 *
 * 2026-09-23 按走查结论修的几处，锁住别再退回去。桌面和手机各走一遍：
 *   1. 可读性：主要页面上没有小于 12px 的文字；次要文字（var(--muted)）在页面底色上对比度 ≥ 4.5:1
 *   2. 首页日报表单的标签、输入框不贴卡片边（左右留出和标题一样的内边距）
 *   4. 聊天按钮往下滑收起、往上滑回来；有未读消息时不收
 *   5. 客户档案（桌面）左栏的「S 级」、「城市 · 年龄 · 来源」各占一行，不被挤折
 *   7. 顶栏搜索框的提示语完整显示，不被截断（桌面）
 *   8. 手机首页：问候 → 待办 → 每日总结；每日总结默认收成一行，点「写日报」展开并聚焦；桌面不收
 *   9. 手机顶栏：新建按钮带短标签（「＋ 报销」），AI 按钮带「AI」，顶栏按钮互不重叠、不出屏（390 / 360 宽）
 * 截图和 report.json 写到 scripts/.uidiff/ui-polish/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/ui-polish' });
const VIEWS = ['home', 'pool', 'demands', 'formal', 'clients', 'reports', 'expenses', 'purchases', 'stats', 'samples'];

/** 先把按钮滚到屏幕中间再点：贴着屏幕底边的话会点到右下角固定的聊天按钮上 */
async function tap(page, sel) {
  await page.$eval(sel, el => el.scrollIntoView({ block: 'center' }));
  await new Promise(r => setTimeout(r, 50));
  await page.click(sel);
}

async function go(page, view) {
  await page.evaluate(v => document.querySelector(`[data-go="${v}"]`)?.click(), view);
  await new Promise(r => setTimeout(r, 500));
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
    ['mobile360', { width: 360, height: 780, isMobile: true, hasTouch: true }],
  ]) {
    const mobile = scene.startsWith('mobile');
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

    // 2. 日报表单不贴边（手机上默认收起，先展开再量）
    await go(page, 'home');
    if (mobile) await tap(page, '#dashTodayToggle');
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
    if (mobile) {
      await tap(page, '#dashTodayToggle');
      await page.evaluate(() => document.activeElement?.blur());
    }
    await harness.screenshot(page, `home-${scene}`);

    // 4. 聊天按钮：往下滑收起，往上滑回来；有未读时不收
    await go(page, 'pool');
    const scroller = mobile ? 'document.scrollingElement' : "document.querySelector('.main')";
    // 真实的一次滑动会连续触发很多个滚动事件，这里分四小步模拟
    const scrollBy = async dy => {
      for (let i = 0; i < 4; i++) {
        await page.evaluate(`(${scroller}).scrollBy(0, ${dy / 4}); (${scroller}).dispatchEvent(new Event('scroll'))`);
      }
    };
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
    if (!mobile) {
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

    // 8. 首页顺序与每日总结的收起
    await go(page, 'home');
    const home = await page.evaluate(() => {
      const top = sel => document.querySelector(sel).getBoundingClientRect().top;
      const vis = sel => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0; };
      return { hero: top('.dash-hero'), focus: top('.dash-focus'), today: top('.dash-today'), grid: top('.dash-action-grid'),
        body: vis('.dash-today-body'), toggle: vis('#dashTodayToggle'), status: vis('#dashTodayStatus'),
        label: document.querySelector('#dashTodayToggle').textContent.trim(), statusText: document.querySelector('#dashTodayStatus').textContent.trim() };
    });
    if (mobile) {
      assert.ok(home.hero < home.focus && home.focus < home.today && home.today < home.grid, `手机首页顺序不对 ${JSON.stringify(home)}`);
      assert.deepEqual([home.body, home.toggle, home.status, home.label], [false, true, true, '写日报'], JSON.stringify(home));
      assert.match(home.statusText, /还没写|已写/);
      await tap(page, '#dashTodayToggle');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.dash-today-body')).display !== 'none');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'dashTodayTitle', '展开后光标应在标题框里');
      assert.equal(await page.$eval('#dashTodayToggle', b => [b.textContent.trim(), b.getAttribute('aria-expanded')].join()), '收起,true');
      await harness.screenshot(page, `home-open-${scene}`);
      await tap(page, '#dashTodayToggle');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.dash-today-body')).display === 'none');
    } else {
      assert.deepEqual([home.body, home.toggle, home.status], [true, false, false], `桌面上每日总结不该收起 ${JSON.stringify(home)}`);
    }

    // 9. 手机顶栏按钮带字、互不重叠、不出屏
    if (mobile) {
      for (const [view, short] of [['pool', '灵感'], ['clients', '客户'], ['expenses', '报销'], ['purchases', '采购']]) {
        await go(page, view);
        const bar = await page.evaluate(() => {
          const items = [...document.querySelectorAll('.topbar > *')].filter(el => { const cs = getComputedStyle(el); return cs.display !== 'none' && !['fixed', 'absolute'].includes(cs.position) && el.getBoundingClientRect().width > 0; })   // 导航抽屉、遮罩是浮层，不参与排队
            .map(el => { const b = el.getBoundingClientRect(); return { id: el.id || el.className, l: b.left, r: b.right }; });
          const overlap = items.slice(1).some((b, i) => b.l < items[i].r - 0.5);
          return { overlap, items: items.map(i => `${i.id}:${Math.round(i.l)}-${Math.round(i.r)}`),
            maxRight: Math.max(...items.map(i => i.r)), vw: innerWidth,
            short: document.querySelector('#btnNewShort').textContent, shortVisible: getComputedStyle(document.querySelector('#btnNewShort')).display !== 'none',
            ai: getComputedStyle(document.querySelector('.smart-import-short')).display !== 'none',
            aria: document.querySelector('#btnNew').getAttribute('aria-label') };
        });
        assert.equal(bar.overlap, false, `${scene}/${view} 顶栏按钮重叠了 ${bar.items.join(' ')}`);
        assert.ok(bar.maxRight <= bar.vw, `${scene}/${view} 顶栏超出屏幕 ${bar.items.join(' ')}`);
        assert.deepEqual([bar.short, bar.shortVisible, bar.ai], [short, true, true], JSON.stringify(bar));
        assert.match(bar.aria, new RegExp(short));
      }
      await page.evaluate(() => scrollTo(0, 0));
      await harness.screenshot(page, `topbar-${scene}`);
    }

    harness.recordCheck(`${scene}-ui-polish`, 'layout', { minFont: true, contrast: true, dashInset: true, chatTuck: true, clients: !mobile, search: !mobile, homeOrder: true, topbar: mobile });
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
