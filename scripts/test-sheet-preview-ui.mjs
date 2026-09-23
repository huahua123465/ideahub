/**
 * Excel / CSV 附件预览专项验收：npm run test:sheet-preview:ui
 *
 * 跑在内置演示数据上。页面里现场用 SheetJS 生成一个工作簿（多工作表、中文、换行、日期、
 * 一段恶意 HTML、2105 行的大表、空表）和一份 UTF-8 CSV，再把 fetch('/api/files/…')
 * 换成返回这些字节 —— 不碰 harness 的请求拦截。桌面和手机各走一遍：
 *   只接管该接管的链接 → 打开预览 → 转义 → 切工作表（点击 / 方向键）→ 大表截断提示
 *   → 空表 → Esc 关闭并还焦点 → CSV → 无权限文件报错 → 叠在聊天面板上且不把面板关掉
 * 截图和 report.json 写到 scripts/.uidiff/sheet-preview/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/sheet-preview' });

async function setup(page) {
  await page.evaluate(async () => {
    const XLSX = await import('/vendor/sheetjs/xlsx.min.mjs');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['选题', '负责人', '截止日期', '备注'],
      ['长期账号定位', '朱涛', new Date(Date.UTC(2026, 8, 30)), '第一行\n第二行'],
      ['<img src=x onerror="window.__xss=1">', '李敏', '', '<b>不是粗体</b>'],
    ], { cellDates: true }), '选题');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(
      Array.from({ length: 2105 }, (_, i) => [`第 ${i + 1} 行`, i])), '大表');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), '空表');
    const files = {
      901: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })),
      902: new TextEncoder().encode('﻿姓名,部门\n陈诚,财务部\n温欣颖,财务部\n'),
    };
    const realFetch = window.fetch;
    window.__fetched = [];
    window.fetch = (input, init) => {
      const m = /^\/api\/files\/(\d+)$/.exec(String(input));
      if (!m) return realFetch(input, init);
      window.__fetched.push(String(input));
      if (m[1] === '903') {
        return Promise.resolve(new Response(JSON.stringify({ error: '这是别人的私聊文件' }),
          { status: 403, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(files[m[1]], { status: 200 }));
    };
    const host = document.createElement('div');
    host.id = 'spFixture';
    host.style.cssText = 'position:fixed;left:8px;top:70px;z-index:60;display:flex;flex-direction:column;gap:6px;background:#fff;padding:6px';
    host.innerHTML = `
      <a class="chatfile" id="spXlsx" href="/api/files/901" target="_blank" rel="noopener"><span class="fname">长期账号选题优先级.xlsx</span><span class="dim">22 KB</span></a>
      <a id="spCsv" href="/api/files/902" target="_blank">名单.csv</a>
      <a id="spDenied" href="/api/files/903" target="_blank">别人的表.xlsx</a>
      <a id="spDownload" href="/api/files/901?download=1">下载</a>
      <a id="spPdf" href="/api/files/904" target="_blank">说明.txt</a>`;
    document.body.appendChild(host);
    // 记下每次点击最终有没有被拦下，再统一拦住，免得真去导航或下载
    window.__clicks = [];
    window.addEventListener('click', e => {
      const a = e.target.closest?.('#spFixture a');
      if (!a) return;
      window.__clicks.push({ id: a.id, prevented: e.defaultPrevented });
      e.preventDefault();
    });
  });
}

const open = () => !!document.querySelector('.sheet-preview')?.classList.contains('on');

async function onTop(page, sel) {
  const ok = await page.$eval(sel, el => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  assert.ok(ok, `${sel} 被别的元素盖住了`);
}

async function assertLayout(page, label) {
  const r = await page.evaluate(() => {
    const b = document.querySelector('.sp-panel').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight };
  });
  assert.ok(r.overflow <= 1, `${label} 页面横向溢出 ${r.overflow}`);
  assert.ok(r.left >= -1 && r.top >= -1 && r.right <= r.w + 1 && r.bottom <= r.h + 1, `${label} 预览超出视口 ${JSON.stringify(r)}`);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await setup(page);

    // 只接管 Excel/CSV 的普通点击；下载链接、其他格式照旧
    for (const id of ['spDownload', 'spPdf']) await page.click(`#${id}`);
    assert.equal(await page.evaluate(open), false, '下载链接和其他格式不应打开表格预览');
    assert.deepEqual(await page.evaluate(() => window.__clicks.map(c => c.prevented)), [false, false]);

    await page.click('#spXlsx');
    await page.waitForFunction(() => document.querySelector('.sp-table td'));
    await settleDom(page);
    let st = await page.evaluate(() => ({
      title: document.querySelector('#sheetPreviewTitle').textContent,
      tabs: [...document.querySelectorAll('.sp-tabs [role="tab"]')].map(t => [t.textContent.trim(), t.getAttribute('aria-selected')]),
      head: [...document.querySelectorAll('.sp-table thead th')].map(t => t.textContent),
      firstRow: [...document.querySelectorAll('.sp-table tbody tr:nth-child(2) td')].map(t => t.textContent),
      rowNo: document.querySelector('.sp-table tbody tr:nth-child(2) th').textContent,
      injected: document.querySelectorAll('.sp-body img, .sp-body td b').length,
      xss: window.__xss || 0,
      evil: document.querySelector('.sp-table tbody tr:nth-child(3) td').textContent,
      download: document.querySelector('.sp-download').getAttribute('href'),
      focus: document.activeElement?.className,
      prevented: window.__clicks.at(-1).prevented,
    }));
    assert.equal(st.title, '长期账号选题优先级.xlsx');
    assert.deepEqual(st.tabs, [['选题', 'true'], ['大表', 'false'], ['空表', 'false']]);
    assert.deepEqual(st.head, ['', 'A', 'B', 'C', 'D']);
    assert.deepEqual(st.firstRow, ['长期账号定位', '朱涛', '2026-09-30', '第一行\n第二行'], JSON.stringify(st));
    assert.equal(st.rowNo, '2');
    assert.equal(st.injected, 0, '单元格里的 HTML 不能被当成标签渲染');
    assert.equal(st.xss, 0);
    assert.match(st.evil, /^<img src=x/);
    assert.equal(st.download, '/api/files/901?download=1');
    assert.equal(st.focus, 'sp-close', '打开后焦点应在关闭按钮上');
    assert.equal(st.prevented, true);
    await assertLayout(page, scene);
    await onTop(page, '.sp-close');
    await harness.screenshot(page, `sheet-preview-${scene}`);

    // 切到大表：只画前 2000 行并提示
    await page.click('.sp-tabs [data-sheet="大表"]');
    await page.waitForFunction(() => document.querySelectorAll('.sp-table tbody tr').length === 2000);
    st = await page.evaluate(() => ({
      note: document.querySelector('.sp-note').textContent,
      noteHidden: document.querySelector('.sp-note').hidden,
      last: document.querySelector('.sp-table tbody tr:last-child td').textContent,
    }));
    assert.equal(st.noteHidden, false);
    assert.match(st.note, /共 2105 行，只显示前 2000 行/);
    assert.equal(st.last, '第 2000 行');
    await harness.screenshot(page, `sheet-preview-large-${scene}`);

    // 方向键切到空表
    await page.focus('.sp-tabs [data-sheet="大表"]');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /空的/.test(document.querySelector('.sp-body').textContent));
    assert.equal(await page.evaluate(() => document.querySelector('.sp-note').hidden), true, '空表不该留着上一张表的截断提示');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.sheet), '空表');

    // Esc 只关预览，焦点回到原链接
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.sheet-preview.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'spXlsx');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-preview-open')), false);

    // CSV（带 BOM 的 UTF-8）
    await page.click('#spCsv');
    await page.waitForFunction(() => document.querySelector('.sp-table td'));
    st = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('.sp-table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent)),
      tabsHidden: document.querySelector('.sp-tabs').hidden,
    }));
    assert.deepEqual(st.rows, [['姓名', '部门'], ['陈诚', '财务部'], ['温欣颖', '财务部']]);
    assert.equal(st.tabsHidden, true, '只有一张表时不显示工作表标签');
    await page.click('.sp-close');
    await page.waitForFunction(() => !document.querySelector('.sheet-preview.on'));

    // 没权限：把服务端的原因原样告诉用户，并给出下载的退路
    await page.click('#spDenied');
    await page.waitForFunction(() => document.querySelector('.sp-error'));
    const err = await page.$eval('.sp-error', n => n.textContent);
    assert.match(err, /这是别人的私聊文件/);
    assert.match(err, /下载/);
    await page.click('.sheet-preview', { offset: { x: 3, y: 3 } }).catch(() => {});
    if (await page.evaluate(open)) await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.sheet-preview.on'));

    // 叠在聊天面板上面，关掉预览后聊天面板还在
    await page.click('#chatBtn');
    await page.waitForFunction(() => document.querySelector('#chatPanel').classList.contains('on'));
    // 和真实情况一样，文件链接在聊天面板里面（手机上没选会话时消息区是隐藏的，放进列表）
    await page.evaluate(() => {
      const a = document.querySelector('#spXlsx').cloneNode(true);
      a.id = 'spChatXlsx';
      document.querySelector('#chatList').prepend(a);
    });
    await page.click('#spChatXlsx');
    await page.waitForFunction(() => document.querySelector('.sp-table td'));
    await onTop(page, '.sp-close');
    await page.click('.sp-close');
    await page.waitForFunction(() => !document.querySelector('.sheet-preview.on'));
    assert.equal(await page.evaluate(() => document.querySelector('#chatPanel').classList.contains('on')), true,
      '关掉预览不应连带收起聊天面板');

    harness.recordCheck(`${scene}-sheet-preview`, 'interaction', { xlsx: true, csv: true, truncated: true, denied: true, overChat: true });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`表格预览验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
