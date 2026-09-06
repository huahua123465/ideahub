/**
 * 录一段完整流程的演示视频：node scripts/record-demo.mjs
 * 需要后端已启动。产物是 IdeaHub演示.mp4（需要机器上有 ffmpeg）。
 *
 * 给非技术同事看的时候比截图有用得多 —— 一遍走完提交、投票、讨论、采纳、进正式库。
 */
import '../server/src/lib/env.mjs';
import puppeteer from 'puppeteer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';

const APP = process.env.UI_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const W = 1440, H = 900;
const OUT = 'scripts/.uidiff/video';
const RAW = join(OUT, 'IdeaHub-demo.webm');
const MP4_TMP = join(OUT, 'IdeaHub-demo.mp4');
const MP4 = 'IdeaHub演示.mp4';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`IdeaHub demo recorder

Usage:
  node scripts/record-demo.mjs

Requirements:
  - The IdeaHub backend is already running (or UI_BASE points to a prepared demo environment)
  - ffmpeg is available on PATH
  - The target environment may be modified by the recorded workflow

Outputs:
  - scripts/.uidiff/video/IdeaHub-demo.webm
  - IdeaHub演示.mp4`);
  process.exit(0);
}

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
if (ffmpeg.status !== 0) {
  throw new Error('录制演示需要 ffmpeg，请先安装并确认 ffmpeg 已加入 PATH。');
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ['--force-device-scale-factor=1'],
});
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// 录屏里看不到真实鼠标，画一个假的
await page.evaluateOnNewDocument(() => {
  addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = `#__cur{position:fixed;width:22px;height:22px;left:-40px;top:-40px;z-index:9999;
      pointer-events:none;transition:transform .08s}#__cur.dn{transform:scale(.82)}
      .__rip{position:fixed;width:34px;height:34px;border-radius:50%;border:2px solid #2a78d6;
      z-index:9998;pointer-events:none;animation:__r .5s ease-out forwards}
      @keyframes __r{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}
      to{transform:translate(-50%,-50%) scale(1.5);opacity:0}}`;
    document.head.appendChild(s);
    const c = document.createElement('div');
    c.id = '__cur';
    c.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M4 2l13 7.5-5.6 1.3-2.4 5.4z"
      fill="#fff" stroke="#0b0b0b" stroke-width="1.4" stroke-linejoin="round"
      style="filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))"/></svg>`;
    document.body.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; });
    addEventListener('mousedown', e => {
      c.classList.add('dn');
      const r = document.createElement('div');
      r.className = '__rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 500);
    });
    addEventListener('mouseup', () => c.classList.remove('dn'));
  });
});

let recorder;
try {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('.card', { visible: true, timeout: 20_000 });
  await wait(600);
  recorder = await page.screencast({ path: RAW, fps: 30, overwrite: true });

  let mx = W / 2, my = H / 2;
  await page.mouse.move(mx, my);

  async function moveTo(sel, dx = 0, dy = 0, index = 0) {
    const elements = await page.$$(sel);
    const element = elements[index];
    if (!element) {
      await Promise.all(elements.map(handle => handle.dispose()));
      throw new Error(`找不到演示元素：${sel}（索引 ${index}）`);
    }
    const box = await element.boundingBox();
    await Promise.all(elements.map(handle => handle.dispose()));
    if (!box) throw new Error(`演示元素当前不可见：${sel}（索引 ${index}）`);
    const tx = box.x + box.width / 2 + dx, ty = box.y + box.height / 2 + dy;
    await page.mouse.move(tx, ty, { steps: Math.max(14, Math.round(Math.hypot(tx - mx, ty - my) / 22)) });
    mx = tx; my = ty;
    await wait(220);
  }
  async function click(sel, dx = 0, dy = 0, index = 0) {
    await moveTo(sel, dx, dy, index);
    await page.mouse.down(); await wait(90); await page.mouse.up();
  }
  async function type(sel, text, ms = 46) {
    await click(sel);
    for (const ch of text) { await page.keyboard.type(ch); await wait(ms); }
  }

/* 1. 灵感池全景 */
await wait(1700);
await moveTo('.card', 0, 0, 3);
await wait(900);

/* 2. 按分类筛选，再点一次取消 */
await click('[data-f="category"][data-v="技术"]');
await wait(2000);
await click('[data-f="category"][data-v="技术"]');
await wait(1600);

/* 3. 换成按最新排序，再换回热度 */
await click('[data-f="sort"][data-v="new"]');
await wait(1700);
await click('[data-f="sort"][data-v="hot"]');
await wait(1500);

/* 4. 搜索 */
await type('#q', '周会', 110);
await wait(2100);
await page.keyboard.press('Control+A');
await page.keyboard.press('Backspace');
await wait(1600);

/* 5. 提交一个新灵感（含实时查重） */
await click('#btnNew');
await wait(700);
await type('#fTitle', '把散落各处的内部文档收敛成一个知识库', 58);
await wait(1900);
await type('#fBody', '现在文档散在飞书、语雀、群聊里，新人入职找不到东西，老人重复回答同样的问题。建议统一收口，并做一次跨部门的目录梳理。', 30);
await type('#fTags', '知识管理、效率', 56);
await wait(500);
await click('#btnSubmit');
await wait(2600);

/* 6. 卡片上直接投票 */
await click('.card .vote', 0, 0, 2);
await wait(1400);

/* 7. 打开详情，看讨论，发一条 */
await click('.card', 0, -30, 1);
await wait(2100);
await page.mouse.wheel(0, 260);
await wait(1500);
await type('#dCmtInput', '同意先跑影子模式。我这周就能把工单历史数据导出来做基线。', 34);
await wait(400);
await click('#btnComment');
await wait(1900);

/* 8. 否决一条：理由是必填的 */
await click('#btnReject');
await wait(900);
await click('#btnRejectConfirm');            // 先故意不填，看它拦下来
await wait(1700);
await type('#rejectReason', '当前工单量还不足以支撑一个模型的维护成本。等日均工单过 500 再重新评估，届时我来主动捞起这条。', 28);
await wait(600);
await click('#btnRejectConfirm');
await wait(2600);

/* 9. 采纳另一条：指定负责人 */
await click('.card', 0, -30, 1);
await wait(1800);
await click('#btnAdopt');
await wait(1200);
await moveTo('#adoptOwner');
await wait(700);
await click('#btnAdoptConfirm');
await wait(3000);

/* 10. 正式库 */
await click('#tab-formal');
await wait(3200);

/* 11. 统计看板 */
await click('#tab-stats');
await wait(4000);
await moveTo('#salesFlow');
await wait(1600);

await wait(1000);
console.log('页面报错：', errors.length ? errors : '无');
} finally {
  if (recorder) await recorder.stop().catch(() => {});
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
}

const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', RAW,
  '-vf', `scale=${W}:${H}:flags=lanczos,fps=30,format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-movflags', '+faststart', MP4_TMP]);
if (r.status !== 0) {
  fs.rmSync(MP4_TMP, { force: true });
  console.log('MP4 转码失败，原始 WebM 录像在：' + RAW);
} else {
  fs.rmSync(MP4, { force: true });
  fs.renameSync(MP4_TMP, MP4);
  console.log('已生成 ' + MP4 + '（' + (fs.statSync(MP4).size / 1e6).toFixed(1) + ' MB）');
}
