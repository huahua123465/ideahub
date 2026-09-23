/**
 * Markdown 附件预览专项验收：npm run test:md-preview:ui
 *
 * 跑在内置演示数据上，把 fetch('/api/files/…') 换成返回现场拼的字节。桌面和手机各走一遍：
 *   只接管 .md 的普通点击 → 排版（标题 / 表格 / 任务列表 / 代码块 / 链接新窗口）
 *   → 内嵌 HTML 被消毒 → 切「原文」再切回 → GBK 文件 → 无权限报错 → Esc 关闭并还焦点
 *   → 叠在聊天面板上且不把面板关掉
 * 截图和 report.json 写到 scripts/.uidiff/md-preview/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/md-preview' });

const DOC = `# 九月选题复盘

本月共发布 **12** 条，*完播率* 提升明显。详见 [数据看板](https://example.com/board)。

## 待办

- [x] 整理素材
- [ ] 约拍第二期

| 账号 | 播放 | 备注 |
| --- | ---: | --- |
| 主号 | 12.3 万 | 稳定 |
| 小号 | 8,020 | 新号 |

> 下周例会前补齐。

\`\`\`js
console.log('<b>不是粗体</b>');
\`\`\`

<img src="data:," onerror="window.__xss=1"><script>window.__xss=2</script>
<a href="javascript:window.__xss=3">坏链接</a>
`;

async function setup(page) {
  await page.evaluate(async (doc) => {
    const gbk = new Uint8Array([0x23, 0x20, 0xB2, 0xE2, 0xCA, 0xD4]);   // "# 测试"（GBK）
    const files = { 911: new TextEncoder().encode('﻿' + doc), 912: gbk };
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const m = /^\/api\/files\/(\d+)$/.exec(String(input));
      if (!m) return realFetch(input, init);
      if (m[1] === '913') {
        return Promise.resolve(new Response(JSON.stringify({ error: '这是别人的私聊文件' }),
          { status: 403, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(files[m[1]], { status: 200 }));
    };
    const host = document.createElement('div');
    host.id = 'mdFixture';
    host.style.cssText = 'position:fixed;left:8px;top:70px;z-index:60;display:flex;flex-direction:column;gap:6px;background:#fff;padding:6px';
    host.innerHTML = `
      <a class="chatfile" id="mdDoc" href="/api/files/911" target="_blank" rel="noopener"><span class="fname">九月复盘.md</span><span class="dim">1 KB</span></a>
      <a id="mdGbk" href="/api/files/912" target="_blank">老文档.md</a>
      <a id="mdDenied" href="/api/files/913" target="_blank">别人的.md</a>
      <a id="mdDownload" href="/api/files/911?download=1">下载</a>
      <a id="mdTxt" href="/api/files/914" target="_blank">说明.txt</a>`;
    document.body.appendChild(host);
    window.__clicks = [];
    window.addEventListener('click', e => {
      const a = e.target.closest?.('#mdFixture a');
      if (!a) return;
      window.__clicks.push({ id: a.id, prevented: e.defaultPrevented });
      e.preventDefault();
    });
  }, DOC);
}

const open = () => !!document.querySelector('.md-preview')?.classList.contains('on');

async function onTop(page, sel) {
  const ok = await page.$eval(sel, el => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  assert.ok(ok, `${sel} 被别的元素盖住了`);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await setup(page);

    for (const id of ['mdDownload', 'mdTxt']) await page.click(`#${id}`);
    assert.equal(await page.evaluate(open), false, '下载链接和 txt 不应打开文档预览');
    assert.deepEqual(await page.evaluate(() => window.__clicks.map(c => c.prevented)), [false, false]);

    await page.click('#mdDoc');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));
    await settleDom(page);
    let st = await page.evaluate(() => {
      const body = document.querySelector('.md-body');
      return {
        title: document.querySelector('#mdPreviewTitle').textContent,
        h1: body.querySelector('h1').textContent,
        h2: body.querySelector('h2').textContent,
        strong: body.querySelector('strong')?.textContent,
        cells: [...body.querySelectorAll('table td')].map(td => td.textContent),
        checks: [...body.querySelectorAll('input[type=checkbox]')].map(i => i.checked),
        link: [body.querySelector('a[href^="https"]')?.target, body.querySelector('a[href^="https"]')?.rel],
        code: body.querySelector('pre code')?.textContent,
        injected: body.querySelectorAll('img[onerror], script, pre b').length,
        badHref: [...body.querySelectorAll('a')].some(a => /^javascript:/i.test(a.getAttribute('href') || '')),
        xss: window.__xss || 0,
        download: document.querySelector('.md-preview .sp-download').getAttribute('href'),
        focus: document.activeElement?.className,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(st.title, '九月复盘.md');
    assert.equal(st.h1, '九月选题复盘');
    assert.equal(st.h2, '待办');
    assert.equal(st.strong, '12');
    assert.deepEqual(st.cells, ['主号', '12.3 万', '稳定', '小号', '8,020', '新号']);
    assert.deepEqual(st.checks, [true, false]);
    assert.deepEqual(st.link, ['_blank', 'noopener noreferrer']);
    assert.match(st.code, /<b>不是粗体<\/b>/);
    assert.equal(st.injected, 0, JSON.stringify(st));
    assert.equal(st.badHref, false, 'javascript: 链接必须被去掉');
    assert.equal(st.xss, 0);
    assert.equal(st.download, '/api/files/911?download=1');
    assert.equal(st.focus, 'sp-close');
    assert.ok(st.overflow <= 1, `页面横向溢出 ${st.overflow}`);
    await onTop(page, '.md-preview .sp-close');
    await harness.screenshot(page, `md-preview-${scene}`);

    // 原文 / 排版切换
    await page.click('.md-mode');
    await page.waitForFunction(() => document.querySelector('.md-source'));
    st = await page.evaluate(() => ({
      src: document.querySelector('.md-source').textContent,
      pressed: document.querySelector('.md-mode').getAttribute('aria-pressed'),
      label: document.querySelector('.md-mode').textContent,
    }));
    assert.ok(st.src.startsWith('# 九月选题复盘'), '原文要去掉 BOM、原样显示');
    assert.deepEqual([st.pressed, st.label], ['true', '排版']);
    await harness.screenshot(page, `md-preview-source-${scene}`);
    await page.click('.md-mode');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));

    // Esc 只关预览，焦点回到原链接
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.md-preview.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'mdDoc');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-preview-open')), false);

    // GBK，且重新打开时回到排版模式
    await page.click('#mdGbk');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));
    assert.equal(await page.$eval('.md-body h1', n => n.textContent), '测试');
    await page.click('.md-preview .sp-close');
    await page.waitForFunction(() => !document.querySelector('.md-preview.on'));

    // 没权限
    await page.click('#mdDenied');
    await page.waitForFunction(() => document.querySelector('.md-preview .sp-error'));
    assert.match(await page.$eval('.md-preview .sp-error', n => n.textContent), /这是别人的私聊文件/);
    assert.equal(await page.$eval('.md-mode', b => b.disabled), true, '读不到内容时不能切原文');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.md-preview.on'));

    // 叠在聊天面板上面，关掉后聊天面板还在
    await page.click('#chatBtn');
    await page.waitForFunction(() => document.querySelector('#chatPanel').classList.contains('on'));
    await page.evaluate(() => {
      const a = document.querySelector('#mdDoc').cloneNode(true);
      a.id = 'mdChatDoc';
      document.querySelector('#chatList').prepend(a);
    });
    await page.click('#mdChatDoc');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));
    await onTop(page, '.md-preview .sp-close');
    await page.click('.md-preview .sp-close');
    await page.waitForFunction(() => !document.querySelector('.md-preview.on'));
    assert.equal(await page.evaluate(() => document.querySelector('#chatPanel').classList.contains('on')), true,
      '关掉预览不应连带收起聊天面板');

    harness.recordCheck(`${scene}-md-preview`, 'interaction', { render: true, sanitize: true, source: true, gbk: true, denied: true, overChat: true });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`文档预览验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
