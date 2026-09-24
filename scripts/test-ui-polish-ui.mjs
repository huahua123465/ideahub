/**
 * 界面细节专项验收：npm run test:ui-polish:ui
 *
 * 2026-09-23 按走查结论修的几处，锁住别再退回去。桌面和手机各走一遍：
 *   0. 样式表里不写死 px 字号 / 圆角 / 间距，一律用 --fs-* / --rd-* / --sp-* 阶梯；颜色都写成 light-dark(浅, 深)（09-24）
 *   1. 可读性：主要页面上没有小于 12px 的文字；次要文字（var(--muted)）在页面底色上对比度 ≥ 4.5:1；
 *      卡片是细边框、零阴影（09-24）；阅读正文 17px 且卡片标题比它大（09-24）
 *   2. 首页日报表单的标签、输入框不贴卡片边（左右留出和标题一样的内边距）
 *   4. 聊天按钮：桌面往下滑收起、往上滑回来，有未读消息时不收；手机（≤560）搬进顶栏，滑动不收
 *   5. 客户档案（桌面）左栏的「S 级」、「城市 · 年龄 · 来源」各占一行，不被挤折
 *   7. 顶栏搜索框的提示语完整显示，不被截断（桌面）
 *   8. 首页顺序（手机：问候 → 待办 → 每日总结；桌面：问候 → 每日总结 → 数字 → 待办，待办在首屏内）；
 *      每日总结默认收成一行，点「写日报」展开并聚焦（09-24 起桌面也收）；
 *      四个快捷入口一行排满、字不折行；桌面上右下角聊天按钮不压首页卡片；
 *      数字卡片的数字紧贴在标签正下方（09-24 前数字被推到卡片最右端）；
 *      搜索框快捷键提示、手机页面说明折叠成一行、作品卡数据格每行铺满（09-24）；
 *      弹窗按钮栏始终在屏幕内、统一标签不内滚、卡片来源标签靠右、手机三格统计一行、正式库手机版式（09-24）；
 *      配色与交互：「评审中」不用主色、灵感卡无分类色条、侧栏圆点同色、卡片悬停底色变化、切页动画只有一份（09-24）
 *   9. 手机顶栏：新建按钮带短标签（「＋ 报销」），AI 按钮带「AI」，顶栏按钮互不重叠、不出屏（390 / 360 宽）
 *  10. 报销 / 采购卡片上的审批步骤名不被截断（360 宽时「部门负责人」放不下，卡片上叫「负责人」）
 * 截图和 report.json 写到 scripts/.uidiff/ui-polish/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

// 0. 字号、圆角只走 styles.css :root 的 --fs-* / --rd-* 阶梯（09-24 收拢），样式表里不许再写死 px
{
  const { readFile } = await import('node:fs/promises');
  const viewAnims = [];
  for (const f of ['styles.css', 'soft.css', 'account.css', 'login.css', 'motion.css']) {
    const css = (await readFile(new URL(`../web/${f}`, import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    const hard = css.match(/font(?:-size)?:\s*\d+(?:\.\d+)?px/g) || [];
    assert.deepEqual(hard, [], `web/${f} 里写死了字号，请改用 var(--fs-*)：${hard.slice(0, 5).join('；')}`);
    const radius = (css.match(/border-radius:[^;}]*/g) || []).filter(d => /\d+(?:\.\d+)?px/.test(d));
    assert.deepEqual(radius, [], `web/${f} 里写死了圆角，请改用 var(--rd-*)：${radius.slice(0, 5).join('；')}`);
    // 间距：2~48px 之间的 padding / margin / gap 要用 --sp-*；<2px 微调、>48px 布局尺寸、负值、calc()/env() 里的不算
    const spacing = (css.match(/(?<![\w-])(?:padding|margin)(?:-[a-z-]+)?:[^;}]*|(?<![\w-])(?:row-|column-)?gap:[^;}]*/g) || [])
      .filter(d => !d.includes('(') && (d.match(/(?<![\w.-])\d+(?:\.\d+)?px/g) || []).some(v => parseFloat(v) >= 2 && parseFloat(v) <= 48));
    assert.deepEqual(spacing, [], `web/${f} 里写死了间距，请改用 var(--sp-*)：${spacing.slice(0, 5).join('；')}`);
    viewAnims.push(...(css.match(/\.view\.on\{[^}]*animation[^}]*\}/g) || []).map(r => `${f}: ${r}`));
    // 深色模式（09-24）：每个颜色都要写成 light-dark(浅, 深)。Word / PDF 纸面、遮罩、主按钮渐变除外
    const bare = [];
    for (const [, sel, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (/docx|pdf-page/.test(sel)) continue;
      for (const [, prop, val] of body.matchAll(/([-\w]+)\s*:([^;]*)/g)) {
        if (prop.includes('mask') || prop === '--grad-primary') continue;
        const rest = val.replace(/light-dark\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, '');
        if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rest)) bare.push(`${sel.trim().slice(-40)}{${prop}:${val.trim().slice(0, 40)}}`);
      }
    }
    assert.deepEqual(bare, [], `web/${f} 有颜色没写深色值，请写成 light-dark(浅, 深)：${bare.slice(0, 4).join('；')}`);
  }
  // 切页动画全站只能有一份（09-24 前三份叠着，最慢的那份生效）
  assert.equal(viewAnims.length, 1, `切页动画定义了 ${viewAnims.length} 份：${viewAnims.join('；')}`);
}

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/ui-polish' });
const VIEWS = ['home', 'pool', 'demands', 'formal', 'clients', 'reports', 'expenses', 'purchases', 'stats', 'samples', 'cases', 'sales', 'delivery'];

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
      // 卡片是「细边框、零阴影」（09-24 用户定）：看得见一条边，没有阴影；阴影只留给弹窗、抽屉、菜单
      const cardSkin = await page.evaluate(() => [...document.querySelectorAll('.dash-panel,.dash-hero,.record-card,#poolGrid .idea-card,.panel,.stat-key-card,.card,.exp-card,.cdcard,.table,.funnel-hero,.client-detail-head')]
        .filter(el => el.getClientRects().length && el !== document.activeElement)
        .map(el => { const cs = getComputedStyle(el); return { el: el.className.split(' ')[0], shadow: cs.boxShadow, border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth) }; })
        .filter(c => c.shadow !== 'none' || c.border < 1));
      assert.deepEqual(cardSkin.slice(0, 3), [], `${scene}/${view} 有卡片带阴影或没有边框`);
      // 阅读正文 17px（09-24 用户定），而且卡片标题要比正文大，不能被正文追平
      const reading = await page.evaluate(() => [...document.querySelectorAll('.view.on :is(#poolGrid .idea-card p,.insight-card blockquote,.client-focus p,.report-summary,.playbook-body,.case-journey p)')]
        .filter(el => el.getClientRects().length)
        .map(el => { const card = el.closest('article'); const h = card?.querySelector('h2,h3');
          return { el: el.className || el.tagName, fs: parseFloat(getComputedStyle(el).fontSize), title: h ? parseFloat(getComputedStyle(h).fontSize) : 99 }; })
        .filter(r => r.fs !== 17 || r.title <= r.fs));
      assert.deepEqual(reading.slice(0, 3), [], `${scene}/${view} 阅读正文不是 17px，或卡片标题没比正文大`);
      assert.equal(r.smallCount, 0, `${scene}/${view} 还有 ${r.smallCount} 处小于 12px 的文字：${r.small.join('；')}`);
      assert.ok(r.contrast >= 4.5, `${scene}/${view} 次要文字对比度 ${r.contrast.toFixed(2)} < 4.5`);
    }

    // 2. 日报表单不贴边（默认收起，先展开再量）
    await go(page, 'home');
    await tap(page, '#dashTodayToggle');
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
    await tap(page, '#dashTodayToggle');
    await page.evaluate(() => document.activeElement?.blur());
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
    if (mobile) {
      const inBar = await page.evaluate(() => !!document.querySelector('#chatBtn').closest('.topbar')
        && getComputedStyle(document.querySelector('#chatBtn')).position !== 'fixed');
      assert.ok(inBar, '手机上聊天按钮应该在顶栏里');
      await scrollBy(400);
      await new Promise(r => setTimeout(r, 150));
      assert.equal(await tucked(), false, '顶栏里的聊天按钮不该跟着滑动收起');
      await tap(page, '#chatBtn');
      await page.waitForFunction(() => document.querySelector('#chatPanel').classList.contains('on'));
      await page.evaluate(() => document.querySelector('#chatSideClose').click());
      await page.waitForFunction(() => !document.querySelector('#chatPanel').classList.contains('on'));
      // 未读红点在顶栏里也要看得见
      await page.evaluate(() => { document.scrollingElement.scrollTop = 0; const d = document.querySelector('#chatDot'); d.hidden = false; d.textContent = '3'; });
      await harness.screenshot(page, `chat-unread-${scene}`, { clip: { x: 0, y: 0, width: viewport.width, height: 64 } });
      await page.evaluate(() => { document.querySelector('#chatDot').hidden = true; });
      // 窗口拉宽（平板横过来）要回到右下角悬浮，缩回来再进顶栏
      await page.setViewport({ ...viewport, width: 1000 });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#chatBtn')).position === 'fixed' && !document.querySelector('#chatBtn').closest('.topbar'));
      await page.setViewport(viewport);
      await page.waitForFunction(() => !!document.querySelector('#chatBtn').closest('.topbar'));
    } else {
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
    }

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
    // 桌面：问候 → 每日总结（收成一行）→ 数字 → 待办；手机：问候 → 待办 → 每日总结 → 数字
    if (mobile) assert.ok(home.hero < home.focus && home.focus < home.today && home.today < home.grid, `手机首页顺序不对 ${JSON.stringify(home)}`);
    else assert.ok(home.hero < home.today && home.today < home.grid && home.grid < home.focus && home.focus < 900, `桌面首页顺序不对，或待办没进首屏 ${JSON.stringify(home)}`);
    assert.deepEqual([home.body, home.toggle, home.status, home.label], [false, true, true, '写日报'], JSON.stringify(home));
    assert.match(home.statusText, /还没写|已写/);
    {
      await tap(page, '#dashTodayToggle');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.dash-today-body')).display !== 'none');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'dashTodayTitle', '展开后光标应在标题框里');
      assert.equal(await page.$eval('#dashTodayToggle', b => [b.textContent.trim(), b.getAttribute('aria-expanded')].join()), '收起,true');
      await harness.screenshot(page, `home-open-${scene}`);
      await tap(page, '#dashTodayToggle');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.dash-today-body')).display === 'none');
    }

    // 8b. 首页快捷入口一行排满，不横向滑动；右下角聊天按钮停着时不压住卡片
    const quick = await page.evaluate(() => {
      const box = document.querySelector('.dash-quick');
      const tops = new Set([...box.children].map(b => Math.round(b.getBoundingClientRect().top)));
      const wrapped = [...box.querySelectorAll('b')].filter(b => b.getBoundingClientRect().height > parseFloat(getComputedStyle(b).fontSize) * 1.9 || b.scrollWidth > b.clientWidth + 1).map(b => b.textContent);
      return { rows: tops.size, overflow: box.scrollWidth - box.clientWidth, count: box.children.length, wrapped };
    });
    assert.deepEqual([quick.count, quick.rows, quick.overflow <= 1, quick.wrapped], [4, 1, true, []], `快捷入口没排成一行 ${JSON.stringify(quick)}`);
    // 8d. 配色与交互（09-24）：「评审中」不用主色；灵感卡不再有分类色条 / 光晕；侧栏组名圆点同色；
    //     可点卡片悬停底色有变化（切页动画只有一份在文件开头的静态检查里）
    if (!mobile) {
      await go(page, 'pool');
      const look = await page.evaluate(() => {
        const cs = el => getComputedStyle(el);
        const pill = document.querySelector('#poolGrid .pill-reviewing');
        const brand = cs(document.querySelector('#btnNew')).backgroundImage + cs(document.querySelector('#btnNew')).backgroundColor;
        const cards = [...document.querySelectorAll('#poolGrid .idea-card')];
        const dots = [...document.querySelectorAll('.navgrp:not(.active) .navtop')].map(t => getComputedStyle(t, '::before').backgroundColor);
        return {
          pill: pill && cs(pill).color, pillIsBrand: pill ? brand.includes(cs(pill).color) : false,
          strips: cards.filter(c => !['none', 'normal'].includes(getComputedStyle(c, '::before').content) || !['none', 'normal'].includes(getComputedStyle(c, '::after').content)).length,
          dotColors: [...new Set(dots)],
        };
      });
      assert.ok(look.pill && look.pill !== 'rgb(95, 75, 91)' && !look.pillIsBrand, `「评审中」标签还在用主色 ${JSON.stringify(look)}`);
      assert.equal(look.strips, 0, '灵感卡上还有分类色条或光晕');
      assert.equal(look.dotColors.length, 1, `侧栏组名圆点颜色不一致 ${look.dotColors}`);
      const card = await page.$('#poolGrid .idea-card:nth-child(2)');
      const bg = () => card.evaluate(el => getComputedStyle(el).backgroundColor + getComputedStyle(el).backgroundImage);
      await page.mouse.move(5, 5);
      const before = await bg();
      await card.hover(); await new Promise(r => setTimeout(r, 50));
      assert.notEqual(await bg(), before, '灵感卡悬停时底色没有变化，看不出能点');
      await page.mouse.move(5, 5);
      await go(page, 'home');
    }

    // 8e. 09-24 第二轮走查：弹窗按钮栏在屏幕内、统一标签不内滚、卡片来源标签靠右、手机三格统计一行、正式库手机版式
    await go(page, 'pool');
    await page.evaluate(() => document.querySelector('#btnNew').click());
    await page.waitForFunction(() => document.querySelector('#modal.on'));
    await new Promise(r => setTimeout(r, 400));
    const modalBox = await page.evaluate(() => {
      const m = document.querySelector('#modal'), f = m.querySelector('footer'), tp = document.querySelector('#fTagPick');
      return { footerBottom: f.getBoundingClientRect().bottom, modalBottom: m.getBoundingClientRect().bottom, vh: innerHeight,
        tagInnerScroll: tp.scrollHeight - tp.clientHeight, bodyScrolls: getComputedStyle(m.querySelector('.form')).overflowY,
        // 内容区限高后，里面自带 overflow 的块（来源那组）曾被压扁到 0 高
        squashed: [...m.querySelectorAll('.form > *')].filter(el => getComputedStyle(el).display !== 'none' && el.scrollHeight > 4 && el.getBoundingClientRect().height < el.scrollHeight - 2).map(el => el.className) };
    });
    assert.ok(modalBox.footerBottom <= modalBox.vh && modalBox.modalBottom <= modalBox.vh, `${scene} 提交灵感弹窗的按钮栏跑到屏幕外了 ${JSON.stringify(modalBox)}`);
    assert.ok(modalBox.tagInnerScroll <= 1, `${scene} 统一标签又变成内滚了 ${JSON.stringify(modalBox)}`);
    assert.equal(modalBox.bodyScrolls, 'auto', '弹窗内容区应该自己能滚');
    assert.deepEqual(modalBox.squashed, [], `${scene} 弹窗里有字段被压扁了`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#modal.on'));
    await go(page, 'demands');
    const top = await page.evaluate(() => {
      const card = document.querySelector('#v-demands .record-card'), src = card.querySelector('.record-source'), menu = card.querySelector('.record-menu');
      const c = card.getBoundingClientRect(), a = src.getBoundingClientRect(), m = menu.getBoundingClientRect();
      return { gap: m.left - a.right, srcFromRight: c.right - a.right };
    });
    assert.ok(top.gap >= 0 && top.gap <= 16, `${scene} 卡片顶部来源标签没有贴着右边的菜单 ${JSON.stringify(top)}`);
    if (mobile) {
      await go(page, 'reports');
      const rows = await page.evaluate(() => new Set([...document.querySelectorAll('#v-reports .overview-cell')].map(c => Math.round(c.getBoundingClientRect().top))).size);
      assert.equal(rows, 1, '手机上三个统计格应排在同一行');
      await go(page, 'formal');
      const f = await page.evaluate(() => {
        const tr = document.querySelector('#formalBody tr'), cells = [...tr.children];
        const title = tr.querySelector('[data-label="灵感"]');
        return { titleFirst: cells.every(c => c === title || c.getBoundingClientRect().top > title.getBoundingClientRect().top + 2),
          labels: cells.filter(c => getComputedStyle(c, '::before').content !== 'none').length,
          titleSize: parseFloat(getComputedStyle(title).fontSize) };
      });
      assert.deepEqual([f.titleFirst, f.labels], [true, 0], `正式库手机卡片应以标题开头、不挂字段名 ${JSON.stringify(f)}`);
      assert.ok(f.titleSize >= 17, '正式库手机卡片的标题要比其他字大');
      await harness.screenshot(page, `formal-${scene}`);
    }
    await go(page, 'home');

    // 8f. 09-24 第三轮：搜索框快捷键提示（电脑）、手机页面说明折叠、作品卡数据格每行铺满
    if (!mobile) {
      const kbd = await page.evaluate(() => { const k = document.querySelector('#searchKbd'); return { text: k.textContent, shown: getComputedStyle(k).display !== 'none' && k.getBoundingClientRect().width > 0 }; });
      assert.ok(kbd.shown && /K$/.test(kbd.text), `搜索框里应显示快捷键提示 ${JSON.stringify(kbd)}`);
      await page.focus('#q');
      assert.equal(await page.$eval('#searchKbd', k => getComputedStyle(k).display), 'none', '点进搜索框后快捷键提示应藏起来');
      await page.evaluate(() => document.activeElement.blur());
    } else {
      await go(page, 'pool');
      const sub = () => page.evaluate(() => { const el = document.querySelector('#v-pool .page-head .sub'); const lh = parseFloat(getComputedStyle(el).lineHeight); return { lines: Math.round(el.getBoundingClientRect().height / lh), clamped: el.scrollHeight > el.clientHeight + 1 }; });
      const folded = await sub();
      assert.ok(folded.lines === 1 && folded.clamped, `手机上页面说明应先收成一行 ${JSON.stringify(folded)}`);
      await tap(page, '#v-pool .page-head .sub');
      const opened = await sub();
      assert.ok(opened.lines >= 2 && !opened.clamped, `点一下应展开完整说明 ${JSON.stringify(opened)}`);
      await tap(page, '#v-pool .page-head .sub');
      assert.equal((await sub()).lines, 1, '再点一下应收回一行');
    }
    await go(page, 'persona');
    const gaps = await page.evaluate(() => [...document.querySelectorAll('#v-persona .metric-grid')].map(g => {
      const w = g.getBoundingClientRect().width, rows = {};
      for (const c of g.children) { const r = c.getBoundingClientRect(); rows[Math.round(r.top)] = (rows[Math.round(r.top)] || 0) + r.width; }
      const gap = parseFloat(getComputedStyle(g).columnGap);
      return Object.values(rows).map(sum => Math.round(w - sum)).filter(left => left > gap * 3 + 2).length;
    }));
    assert.ok(gaps.length && gaps.every(n => n === 0), `作品卡数据格最后一行有空位 ${gaps}`);

    // 8c. 数字卡片：数字紧贴在标签正下方（左对齐），说明不压数字、不出卡片
    const cards = await page.evaluate(() => [...document.querySelectorAll('.dash-action-grid>button')].map(btn => {
      const r = sel => btn.querySelector(sel).getBoundingClientRect();
      const [card, label, num, note] = [btn.getBoundingClientRect(), r('small'), r('b'), r('em')];
      const overlap = (a, c) => a.left < c.right - .5 && a.right > c.left + .5 && a.top < c.bottom - .5 && a.bottom > c.top + .5;
      return { name: btn.querySelector('small').textContent, dx: Math.abs(num.left - label.left), gap: num.top - label.bottom,
        clash: overlap(num, note) || overlap(num, label), out: note.right > card.right + .5 || num.right > card.right + .5 };
    }));
    for (const c of cards) {
      assert.ok(c.dx <= 2 && c.gap >= -2 && c.gap <= 12 && !c.clash && !c.out, `${scene} 数字卡片「${c.name}」排版不对 ${JSON.stringify(c)}`);
    }
    await page.evaluate(() => { (document.querySelector('.main').scrollTop = 0); document.scrollingElement.scrollTop = 0; });
    await harness.screenshot(page, `home-top-${scene}`);
    if (!mobile) {
      const gap = await page.evaluate(() => {
        const fab = document.querySelector('#chatBtn').getBoundingClientRect();
        const right = Math.max(...[...document.querySelectorAll('#v-home .dash-panel, #v-home .dash-hero, #v-home .dash-action-grid')]
          .map(el => el.getBoundingClientRect().right));
        return fab.left - right;
      });
      assert.ok(gap >= 4, `聊天按钮压住了首页卡片（间距 ${gap}px）`);
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
        assert.ok(bar.items.some(i => i.startsWith('chatBtn:')), `${scene}/${view} 顶栏里没有聊天按钮 ${bar.items.join(' ')}`);
        assert.ok(bar.maxRight <= bar.vw, `${scene}/${view} 顶栏超出屏幕 ${bar.items.join(' ')}`);
        assert.deepEqual([bar.short, bar.shortVisible, bar.ai], [short, true, true], JSON.stringify(bar));
        assert.match(bar.aria, new RegExp(short));
        if (view === 'expenses' || view === 'purchases') {
          const cut = await page.evaluate(() => [...document.querySelectorAll('.exp-flow.compact .exp-flow-label')]
            .filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
          assert.deepEqual(cut, [], `${scene}/${view} 卡片上的步骤名被截断了：${cut.join('、')}`);
          const labels = await page.evaluate(() => [...new Set([...document.querySelectorAll('.exp-flow.compact .exp-flow-label')].map(el => el.textContent))]);
          assert.ok(labels.includes('负责人') && !labels.includes('部门负责人'), `卡片上应显示「负责人」：${labels.join('、')}`);
        }
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
