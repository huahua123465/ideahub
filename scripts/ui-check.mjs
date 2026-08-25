/**
 * UI 一致性验收：npm run test:ui
 *
 * 把真实应用逐屏截图，和客户确认过的演示原型（docs/UI原型-基准.html）逐像素比对，
 * 输出每一屏的差异比例和一张差异标注图。
 *
 * 需要 playwright（只是开发工具，不进生产依赖）：
 *   npm i -D playwright && npx playwright install chromium
 */
import '../server/src/lib/env.mjs';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'scripts', '.uidiff');
const APP = process.env.UI_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const BASE = 'file://' + join(ROOT, 'docs', 'UI原型-基准.html');
const VIEW = { width: 1440, height: 900 };

/** 差异容忍度：单通道差 ≤ 该值算同色（抗锯齿会带来 1-2 的抖动） */
const CHANNEL_TOL = 16;
/** 每一屏允许的差异像素占比 */
const LIMIT = 0.015;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

/** 打开一个页面，禁掉 API 浮层和一切动画，让截图稳定 */
async function page(url) {
  const p = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  await p.addInitScript(() => { window.IDEAHUB_SHOW_APILOG = false; });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.addStyleTag({ content: `*,*::before,*::after{
    animation-duration:0s!important;animation-delay:0s!important;
    transition-duration:0s!important;transition-delay:0s!important}
    /* 调用浮层是运行时状态，不参与外观比对 */
    #apilog{display:none!important}` });
  return p;
}

/** 截图前统一收尾：鼠标挪开、焦点清掉，避免 hover / focus 环造成假差异 */
async function settle(p) {
  await p.mouse.move(1435, 895);
  await p.evaluate(() => {
    document.activeElement?.blur?.();
    // 「我投过票了」是真实的用户状态，基准原型里没有。属于状态差异，不是样式差异。
    document.querySelectorAll('.vote.voted, .big-vote.voted')
      .forEach(e => e.classList.remove('voted'));
  });
  await p.waitForTimeout(180);
}

/**
 * 灵感池的卡片顺序由真实热度决定，而基准原型里是手写的固定顺序 ——
 * 这属于数据差异，不是 UI 差异。比对前按基准的标题顺序把卡片重排，
 * 这样红色差异点反映的就只有样式和布局问题。
 */
async function alignCardOrder(pApp, pBase) {
  const order = await pBase.$$eval('.card h3', els => els.map(e => e.textContent.trim()));
  await pApp.evaluate(titles => {
    const grid = document.querySelector('#poolGrid');
    const byTitle = new Map([...grid.querySelectorAll('.card')]
      .map(c => [c.querySelector('h3').textContent.trim(), c]));
    for (const t of titles) { const el = byTitle.get(t); if (el) grid.appendChild(el); }
  }, order);
}

const SCENES = [
  {
    name: '灵感池',
    async base(p) { await p.waitForTimeout(300); },
    async app(p)  { await p.waitForSelector('.card'); await p.waitForTimeout(300); },
    async afterAlign(p) { await p.waitForTimeout(120); },
  },
  {
    name: '正式库',
    async base(p) { await p.click('#tab-formal'); await p.waitForTimeout(300); },
    async app(p)  { await p.waitForSelector('.card'); },
    async afterAlign(p) { await p.click('#tab-formal'); await p.waitForSelector('#formalBody tr'); await p.waitForTimeout(300); },
  },
  {
    name: '统计看板',
    async base(p) { await p.click('#tab-stats'); await p.waitForTimeout(1400); },
    async app(p)  { await p.waitForSelector('.card'); },
    async afterAlign(p) { await p.click('#tab-stats'); await p.waitForSelector('.stat-key-card'); await p.waitForTimeout(900); },
    async normalize(p) {
      await p.evaluate(() => {
        const set = (sel, vals) => document.querySelectorAll(sel)
          .forEach((e, i) => { e.textContent = vals[i % vals.length]; });
        const r = document.querySelector('#statsRange'); if (r) r.textContent = '五类关键资料与基础销售漏斗 · 删除记录不参与统计';
        set('.stat-key-value', ['32', '18', '14', '26', '9']);
        set('.sales-value', ['26', '21', '13', '7', '3']);
      });
      await p.waitForTimeout(150);
    },
  },
  {
    name: '提交弹窗',
    async base(p) { await p.click('#btnNew'); await p.waitForTimeout(400); },
    async app(p)  { await p.waitForSelector('.card'); },
    async afterAlign(p) { await p.click('#btnNew'); await p.waitForTimeout(400); },
  },
  {
    name: '详情抽屉',
    async base(p) { await p.click('.card[data-id="7"]'); await p.waitForTimeout(500); },
    async app(p)  { await p.waitForSelector('.card'); },
    async afterAlign(p) {
      await p.locator('.card', { hasText: '用大模型自动给客服工单打标签' }).first().click();
      await p.waitForSelector('#drawer.on .cmt-item');
      await p.waitForTimeout(500);
    },
    async normalize(p) {
      // 基准原型里这条灵感的卡片写着 12 条讨论、抽屉里却只画了 3 条（静态稿的自相矛盾）。
      // 真实应用两处都是 12，是对的。比对时统一截到前 3 条，测的才是抽屉的样式而不是数据量。
      await p.evaluate(() => {
        const items = document.querySelectorAll('#dCmts .cmt-item');
        items.forEach((e, i) => { if (i >= 3) e.remove(); });
        const n = document.querySelector('#dCmtN'); if (n) n.textContent = '（12）';
        const v = document.querySelector('#dViews'); if (v) v.textContent = '147 次浏览';
      });
      await p.waitForTimeout(120);
    },
  },
];

console.log(`\n\x1b[90m（比对基于种子数据的初始状态。数据被改过的话先跑 npm run db:seed）\x1b[0m`);
console.log(`\n基准：${BASE.replace('file://', '')}`);
console.log(`应用：${APP}\n`);

let worst = 0, failed = 0;
const report = [];

for (const s of SCENES) {
  const [pb, pa] = await Promise.all([page(BASE), page(APP)]);
  await s.app(pa);
  await alignCardOrder(pa, pb);
  await s.base(pb);
  if (s.afterAlign) await s.afterAlign(pa);
  // 数字和条长是数据，不是 UI。归一化后再比，红点反映的才是样式问题。
  if (s.normalize) { await s.normalize(pb); await s.normalize(pa); }
  await Promise.all([settle(pb), settle(pa)]);
  const [a, b] = await Promise.all([pb.screenshot(), pa.screenshot()]);
  await Promise.all([pb.close(), pa.close()]);

  const { pct, diffPng } = await compare(a, b);
  const ok = pct <= LIMIT * 100;
  worst = Math.max(worst, pct);
  if (!ok) failed++;

  const slug = s.name.replace(/\s/g, '');
  await writeFile(join(OUT, `${slug}-基准.png`), a);
  await writeFile(join(OUT, `${slug}-实际.png`), b);
  await writeFile(join(OUT, `${slug}-差异.png`), diffPng);

  report.push({ name: s.name, pct, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${s.name.padEnd(6)} 差异 ${pct.toFixed(3)}%${ok ? '' : `   ← 超过 ${LIMIT * 100}% 阈值`}`);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`  最大差异 ${worst.toFixed(3)}%   不通过 ${failed} 屏`);
console.log(`  截图与差异图：scripts/.uidiff/`);
console.log(`${'─'.repeat(46)}\n`);

await browser.close();
process.exit(failed ? 1 : 0);

/** 逐像素比对，返回差异比例和一张把差异标红的图 */
async function compare(pngA, pngB) {
  const toRaw = async png => {
    const img = sharp(png).ensureAlpha().raw();
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    return { data, info };
  };
  const A = await toRaw(pngA), B = await toRaw(pngB);
  const w = Math.min(A.info.width, B.info.width);
  const h = Math.min(A.info.height, B.info.height);
  const out = Buffer.alloc(w * h * 4);
  let diff = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * A.info.width + x) * 4;
      const ib = (y * B.info.width + x) * 4;
      const io = (y * w + x) * 4;
      const d = Math.max(
        Math.abs(A.data[ia]     - B.data[ib]),
        Math.abs(A.data[ia + 1] - B.data[ib + 1]),
        Math.abs(A.data[ia + 2] - B.data[ib + 2]));
      if (d > CHANNEL_TOL) {
        diff++;
        out[io] = 255; out[io + 1] = 0; out[io + 2] = 0; out[io + 3] = 255;
      } else {
        // 相同的地方压成浅灰底，让红点显眼
        const g = 235 + Math.round(A.data[ia] * 0.06);
        out[io] = g; out[io + 1] = g; out[io + 2] = g; out[io + 3] = 255;
      }
    }
  }
  const diffPng = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { pct: diff / (w * h) * 100, diffPng };
}
