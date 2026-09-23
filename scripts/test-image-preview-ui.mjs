/**
 * 图片附件在页面里看大图的专项验收：npm run test:image-preview:ui
 *
 * 跑在内置演示数据上，图片由测试服务器直接回（<img> 不走页面里的 fetch 桩）。桌面和手机各走一遍：
 *   只接管图片附件的普通点击（HEIC、下载链接照旧，PDF 归文档预览）
 *   → 同一列表里的图成组、方向键 / 滑动翻页 → 下载按钮指向原文件
 *   → 打不开的图给出说明 → Esc 关闭并还焦点 → 叠在聊天面板上、点灯箱里的按钮不把面板关掉
 * 截图和 report.json 写到 scripts/.uidiff/image-preview/。
 */
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

/** 生成一张纯色 PNG */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => {
    let c = 0xFFFFFFFF;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8 位 RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const DENIED = '/api/files/955';
const harness = await createUiHarness({
  outputDir: 'scripts/.uidiff/image-preview',
  fixtures: {
    '/api/files/951': { body: png(640, 420, [89, 102, 217]), type: 'image/png' },
    '/api/files/952': { body: png(420, 640, [230, 150, 60]), type: 'image/png' },
    [DENIED]: { status: 403, body: Buffer.from('{"error":"这是别人的私聊文件"}'), type: 'application/json' },
  },
});

async function setup(page) {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'imgFixture';
    host.style.cssText = 'position:fixed;left:8px;top:70px;z-index:60;background:#fff;padding:6px';
    host.innerHTML = `
      <ul class="exp-files" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px">
        <li><a id="imgA" href="/api/files/951" target="_blank" rel="noopener">高铁电子发票截图.png</a></li>
        <li><a id="imgDoc" href="/api/files/953" target="_blank" rel="noopener">合同.docx</a></li>
        <li><a id="imgB" href="/api/files/952" target="_blank" rel="noopener">支付记录.jpg</a></li>
        <li><a id="imgHeic" href="/api/files/954" target="_blank" rel="noopener">iPhone 原图.heic</a></li>
        <li><a id="imgDl" href="/api/files/951?download=1">下载</a></li>
      </ul>
      <p><a id="imgDenied" href="${'/api/files/955'}" target="_blank">别人的截图.png</a></p>`;
    document.body.appendChild(host);
    window.__clicks = [];
    window.addEventListener('click', e => {
      const a = e.target.closest?.('#imgFixture a, #imgChat a');
      if (!a) return;
      window.__clicks.push({ id: a.id, prevented: e.defaultPrevented });
      e.preventDefault();
    });
  });
}

const lb = () => ({
  on: !!document.querySelector('.lightbox')?.classList.contains('on'),
  count: document.querySelector('.lightbox .lb-count')?.textContent,
  name: document.querySelector('.lightbox .lb-name')?.textContent,
  src: document.querySelector('.lightbox .lb-img')?.getAttribute('src'),
  loaded: document.querySelector('.lightbox .lb-img')?.naturalWidth || 0,
  download: (d => d && !d.hidden ? d.getAttribute('href') : null)(document.querySelector('.lightbox .lb-download')),
  broken: !!document.querySelector('.lightbox')?.classList.contains('broken'),
  focus: document.activeElement?.className,
});

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await setup(page);

    // HEIC、下载链接不接管
    for (const id of ['imgHeic', 'imgDl']) await page.click(`#${id}`);
    assert.equal((await page.evaluate(lb)).on, false);
    assert.deepEqual(await page.evaluate(() => window.__clicks.map(c => c.prevented)), [false, false]);

    // 打开第一张：同一列表里的两张图成一组，Word 不算进来
    await page.click('#imgA');
    await page.waitForFunction(() => document.querySelector('.lightbox .lb-img')?.naturalWidth > 0);
    await settleDom(page);
    let st = await page.evaluate(lb);
    assert.deepEqual({ ...st, loaded: st.loaded > 0 }, {
      on: true, count: '1 / 2', name: '高铁电子发票截图.png', src: '/api/files/951', loaded: true,
      download: '/api/files/951?download=1', broken: false, focus: 'lb-close',
    }, JSON.stringify(st));
    assert.equal(await page.evaluate(() => window.__clicks.at(-1).prevented), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, true);
    await harness.screenshot(page, `image-preview-${scene}`);

    // 翻到第二张：桌面用方向键，手机用手指滑
    if (scene === 'mobile') {
      await page.touchscreen.touchStart(320, 420);
      await page.touchscreen.touchMove(120, 430);
      await page.touchscreen.touchEnd();
    } else {
      await page.keyboard.press('ArrowRight');
    }
    await page.waitForFunction(() => document.querySelector('.lightbox .lb-count').textContent === '2 / 2');
    st = await page.evaluate(lb);
    assert.equal(st.name, '支付记录.jpg');
    assert.equal(st.download, '/api/files/952?download=1');

    // Esc 关闭，焦点回到点开时的链接
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.lightbox.on'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'imgA');

    // 打不开的图：说明原因，不是一块黑框
    await page.click('#imgDenied');
    await page.waitForFunction(() => document.querySelector('.lightbox.broken'));
    st = await page.evaluate(lb);
    assert.equal(st.count, '1 / 1');
    assert.equal(await page.$eval('.lightbox .lb-error', n => getComputedStyle(n).display), 'block');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.lightbox.on'));

    // 在聊天面板里点开，点灯箱里的按钮（翻页、关闭）都不能把聊天面板收起来
    await page.click('#chatBtn');
    await page.waitForFunction(() => document.querySelector('#chatPanel').classList.contains('on'));
    await page.evaluate(() => {
      const ul = document.createElement('ul');
      ul.id = 'imgChat';
      ul.innerHTML = `<li><a id="chatImgA" href="/api/files/951">群里的截图.png</a></li>
                      <li><a id="chatImgB" href="/api/files/952">第二张.png</a></li>`;
      document.querySelector('#chatList').prepend(ul);
    });
    await page.click('#chatImgA');
    await page.waitForFunction(() => document.querySelector('.lightbox.on'));
    await page.click('.lightbox .lb-next');
    await page.waitForFunction(() => document.querySelector('.lightbox .lb-count').textContent === '2 / 2');
    assert.equal(await page.evaluate(() => document.querySelector('#chatPanel').classList.contains('on')), true,
      '在灯箱里翻页不应收起聊天面板');
    await page.click('.lightbox .lb-close');
    await page.waitForFunction(() => !document.querySelector('.lightbox.on'));
    assert.equal(await page.evaluate(() => document.querySelector('#chatPanel').classList.contains('on')), true,
      '关掉灯箱不应收起聊天面板');

    harness.recordCheck(`${scene}-image-preview`, 'interaction', { group: true, flip: true, download: true, broken: true, overChat: true });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors.filter(e => !e.message.includes('403')), [],
    JSON.stringify(harness.report.browserErrors));
  // 「打不开的图」那一步是故意的 403，其余不许有网络错误
  assert.deepEqual(harness.report.networkErrors.filter(e => !e.url.endsWith(DENIED)), [],
    JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`图片预览验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
