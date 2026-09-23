/**
 * Markdown / Word / PPT / PDF 附件预览专项验收：npm run test:doc-preview:ui
 *
 * 跑在内置演示数据上，把 fetch('/api/files/…') 换成返回现场拼的字节。桌面和手机各走一遍：
 *   只接管 .md / .docx / .doc / .pptx / .ppt / .pdf 的普通点击（.txt、.html、下载链接照旧）
 *   → Markdown 排版（标题 / 表格 / 任务列表 / 代码块 / 链接新窗口）→ 内嵌 HTML 被消毒
 *   → 切「原文」再切回 → GBK 文件 → 无权限报错 → Esc 关闭并还焦点
 *   → Word 分页渲染（标题 / 粗体 / 表格 / 外链新窗口 / javascript: 链接被去掉 / 手机上缩放不横向溢出）
 *   → 坏的 docx 报错 → PPT 走服务端转好的 PDF（这里直接回一份手写的两页 PDF）、转换失败报错
 *   → PDF 直接取原文件显示
 *   → 叠在聊天面板上且不把面板关掉
 * 截图和 report.json 写到 scripts/.uidiff/doc-preview/。
 * Word 样例用 JSZip 现场拼一个最小的 .docx（开发依赖，跑测试的机器上一定有）。
 */
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/doc-preview' });

async function makeDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const p = (runs, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`;
  const r = (t, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const cell = t => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(r(t))}</w:tc>`;
  const row = cells => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b => `<w:${b} w:val="single" w:sz="4" w:color="999999"/>`).join('');
  const body = [
    p(r('合作方案'), 'Heading1'),
    p(r('本季度目标：') + r('签约 5 家', true) + r('，&lt;b&gt;不是粗体&lt;/b&gt;')),
    `<w:tbl><w:tblPr><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${row(['阶段', '负责人'])}${row(['洽谈', '朱涛'])}</w:tbl>`,
    p(`<w:hyperlink r:id="rIdGood">${r('官网')}</w:hyperlink>`),
    p(`<w:hyperlink r:id="rIdBad">${r('坏链接')}</w:hyperlink>`),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  ].join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdGood" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/><Relationship Id="rIdBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.__xss=5" TargetMode="External"/></Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}
const DOCX_B64 = await makeDocx();

/** 手写一份两页的最小 PDF，冒充服务端 LibreOffice 转出来的结果 */
function makePdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 36 Tf 60 200 Td (Slide preview) Tj ET';
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}
const PDF_B64 = makePdf();

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
  await page.evaluate(async (doc, docxB64, pdfB64) => {
    const gbk = new Uint8Array([0x23, 0x20, 0xB2, 0xE2, 0xCA, 0xD4]);   // "# 测试"（GBK）
    const files = {
      911: new TextEncoder().encode('\uFEFF' + doc), 912: gbk,
      921: Uint8Array.from(atob(docxB64), c => c.charCodeAt(0)),
      922: new TextEncoder().encode('这不是 zip'),
      '931/preview': Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0)),
      941: Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0)),
    };
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const m = /^\/api\/files\/(\d+(?:\/preview)?)$/.exec(String(input));
      if (!m) return realFetch(input, init);
      window.__fetched = [...(window.__fetched || []), m[1]];
      if (m[1] === '932/preview') {
        return Promise.resolve(new Response(JSON.stringify({ error: '这个文件转换失败了，可能已损坏' }),
          { status: 422, headers: { 'content-type': 'application/json' } }));
      }
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
      <a id="mdTxt" href="/api/files/914" target="_blank">说明.txt</a>
      <a class="chatfile" id="docx" href="/api/files/921" target="_blank"><span class="fname">合作方案.docx</span></a>
      <a id="docxBroken" href="/api/files/922" target="_blank">坏文件.docx</a>
      <a id="docHtml" href="/api/files/923" target="_blank">分析报告.html</a>
      <a class="chatfile" id="pdf" href="/api/files/941" target="_blank"><span class="fname">高铁电子发票.pdf</span></a>
      <a class="chatfile" id="ppt" href="/api/files/931" target="_blank"><span class="fname">九月复盘.pptx</span></a>
      <a id="pptBroken" href="/api/files/932" target="_blank">坏的.ppt</a>`;
    document.body.appendChild(host);
    window.__clicks = [];
    window.addEventListener('click', e => {
      const a = e.target.closest?.('#mdFixture a');
      if (!a) return;
      window.__clicks.push({ id: a.id, prevented: e.defaultPrevented });
      e.preventDefault();
    });
  }, DOC, DOCX_B64, PDF_B64);
}

const open = () => !!document.querySelector('.doc-preview')?.classList.contains('on');

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

    for (const id of ['mdDownload', 'mdTxt', 'docHtml']) await page.click(`#${id}`);
    assert.equal(await page.evaluate(open), false, '下载链接、txt、html 报告不应打开文档预览');
    assert.deepEqual(await page.evaluate(() => window.__clicks.map(c => c.prevented)), [false, false, false]);

    await page.click('#mdDoc');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));
    await settleDom(page);
    let st = await page.evaluate(() => {
      const body = document.querySelector('.md-body');
      return {
        title: document.querySelector('#docPreviewTitle').textContent,
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
        download: document.querySelector('.doc-preview .sp-download').getAttribute('href'),
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
    await onTop(page, '.doc-preview .sp-close');
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
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'mdDoc');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-preview-open')), false);

    // GBK，且重新打开时回到排版模式
    await page.click('#mdGbk');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));
    assert.equal(await page.$eval('.md-body h1', n => n.textContent), '测试');
    await page.click('.doc-preview .sp-close');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));

    // 没权限
    await page.click('#mdDenied');
    await page.waitForFunction(() => document.querySelector('.doc-preview .sp-error'));
    assert.match(await page.$eval('.doc-preview .sp-error', n => n.textContent), /这是别人的私聊文件/);
    assert.equal(await page.$eval('.md-mode', b => b.disabled), true, '读不到内容时不能切原文');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));

    // Word：分页渲染、链接消毒、手机上缩放到不横向溢出
    await page.click('#docx');
    await page.waitForFunction(() => document.querySelector('.docx-host section.docx'));
    await settleDom(page);
    st = await page.evaluate(() => {
      const host = document.querySelector('.docx-host');
      const body = document.querySelector('.doc-preview .sp-body');
      const links = [...host.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href'), a.target]);
      return {
        kind: document.querySelector('.doc-kind').textContent,
        modeHidden: document.querySelector('.md-mode').hidden,
        text: host.querySelector('section.docx').textContent,
        bold: [...host.querySelectorAll('span')].some(s => s.textContent === '签约 5 家' && Number(getComputedStyle(s).fontWeight) >= 600),
        cells: [...host.querySelectorAll('td')].map(td => td.textContent.trim()),
        links,
        injected: host.querySelectorAll('b').length,
        xss: window.__xss || 0,
        hOverflow: body.scrollWidth - body.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(st.kind, 'Word 预览');
    assert.equal(st.modeHidden, true, 'Word 没有原文模式');
    assert.match(st.text, /合作方案/);
    assert.match(st.text, /<b>不是粗体<\/b>/);
    assert.equal(st.injected, 0);
    assert.equal(st.bold, true, JSON.stringify(st));
    assert.deepEqual(st.cells, ['阶段', '负责人', '洽谈', '朱涛']);
    assert.deepEqual(st.links, [['官网', 'https://example.com/', '_blank'], ['坏链接', null, '']], JSON.stringify(st.links));
    assert.equal(st.xss, 0);
    assert.ok(st.hOverflow <= 1, `Word 预览横向溢出 ${st.hOverflow}`);
    assert.ok(st.pageOverflow <= 1);
    await onTop(page, '.doc-preview .sp-close');
    await harness.screenshot(page, `docx-preview-${scene}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'docx');

    // 再打开 Markdown，「原文」按钮要回来
    await page.click('#mdGbk');
    await page.waitForFunction(() => document.querySelector('.md-body h1'));
    assert.equal(await page.$eval('.md-mode', b => b.hidden), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));

    // 坏的 docx
    await page.click('#docxBroken');
    await page.waitForFunction(() => document.querySelector('.doc-preview .sp-error'));
    assert.match(await page.$eval('.doc-preview .sp-error', n => n.textContent), /不是 Word 文档/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));

    // PPT：取服务端转好的 PDF，用分页阅读器显示
    await page.click('#ppt');
    await page.waitForFunction(() => document.querySelectorAll('.doc-preview .learning-pdf-page canvas').length === 2);
    await settleDom(page);
    st = await page.evaluate(() => ({
      kind: document.querySelector('.doc-kind').textContent,
      modeHidden: document.querySelector('.md-mode').hidden,
      fetched: window.__fetched.at(-1),
      download: document.querySelector('.doc-preview .sp-download').getAttribute('href'),
      pages: document.querySelectorAll('.doc-preview .learning-pdf-page').length,
      hOverflow: (b => b.scrollWidth - b.clientWidth)(document.querySelector('.doc-preview .sp-body')),
    }));
    assert.deepEqual(st, { kind: 'PPT 预览', modeHidden: true, fetched: '931/preview',
      download: '/api/files/931?download=1', pages: 2, hOverflow: 0 }, JSON.stringify(st));
    await onTop(page, '.doc-preview .sp-close');
    await harness.screenshot(page, `ppt-preview-${scene}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ppt');

    // 转换失败：把服务端的原因告诉用户
    await page.click('#pptBroken');
    await page.waitForFunction(() => document.querySelector('.doc-preview .sp-error'));
    assert.match(await page.$eval('.doc-preview .sp-error', n => n.textContent), /转换失败/);
    assert.equal(await page.$eval('.doc-kind', n => n.textContent), 'PPT 预览');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));

    // PDF：直接取原文件（不走 /preview 转换），同一套分页阅读器
    await page.click('#pdf');
    await page.waitForFunction(() => document.querySelectorAll('.doc-preview .learning-pdf-page canvas').length === 2);
    st = await page.evaluate(() => ({
      kind: document.querySelector('.doc-kind').textContent,
      fetched: window.__fetched.at(-1),
      download: document.querySelector('.doc-preview .sp-download').getAttribute('href'),
      hOverflow: (b => b.scrollWidth - b.clientWidth)(document.querySelector('.doc-preview .sp-body')),
    }));
    assert.deepEqual(st, { kind: 'PDF 预览', fetched: '941', download: '/api/files/941?download=1', hOverflow: 0 }, JSON.stringify(st));
    await harness.screenshot(page, `pdf-preview-${scene}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pdf');

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
    await onTop(page, '.doc-preview .sp-close');
    await page.click('.doc-preview .sp-close');
    await page.waitForFunction(() => !document.querySelector('.doc-preview.on'));
    assert.equal(await page.evaluate(() => document.querySelector('#chatPanel').classList.contains('on')), true,
      '关掉预览不应连带收起聊天面板');

    harness.recordCheck(`${scene}-doc-preview`, 'interaction', { render: true, sanitize: true, source: true, gbk: true, denied: true, docx: true, docxBroken: true, ppt: true, pptBroken: true, pdf: true, overChat: true });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`文档预览（Markdown / Word / PPT / PDF）验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
