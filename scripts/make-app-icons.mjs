/**
 * 生成「添加到主屏幕」用的 App 图标（2026-09-26）：node scripts/make-app-icons.mjs
 *
 * 图案和浏览器标签页上的小图标（web/index.html 里的 favicon）是同一个：梅子色圆角方块 + 灯泡。
 * 输出到 web/assets/icons/，生成物提交进仓库（容器里不装浏览器，构建时不重新生成）。
 *   icon-192.png / icon-512.png   普通图标（圆角，四角透明）
 *   icon-maskable-512.png         安卓自适应图标：整块铺满底色，灯泡缩在中间 60% 的安全区里，系统裁成圆 / 方都不会切到
 *   apple-touch-icon.png          iPhone 主屏幕（180×180，iOS 自己加圆角，所以铺满不留透明角）
 * 改了图案要重跑这个脚本，并同步改 index.html 里的 favicon。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { WEB_ROOT } from './lib/web-build.mjs';

const BG = '#68455f';
const INK = '#fffaf4';
const bulb = (scale) => `<g transform="translate(10 10) scale(${scale}) translate(-10 -10.1)" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 4a4 4 0 0 0-2.5 7.1c.4.4.7.9.7 1.4h3.6c0-.5.3-1 .7-1.4A4 4 0 0 0 10 4Z"/><path d="M8.6 14.6h2.8M9 16.2h2"/></g>`;
const svg = ({ radius, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="100%" height="100%">
  <rect width="20" height="20" rx="${radius}" fill="${BG}"/>${bulb(scale)}</svg>`;

const OUT = join(WEB_ROOT, 'assets', 'icons');
const ICONS = [
  ['icon-192.png', 192, { radius: 4.2, scale: 1.0 }, true],
  ['icon-512.png', 512, { radius: 4.2, scale: 1.0 }, true],
  ['icon-maskable-512.png', 512, { radius: 0, scale: 0.92 }, false],
  ['apple-touch-icon.png', 180, { radius: 0, scale: 0.95 }, false],
];

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const [name, size, look, transparent] of ICONS) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(look)}</body></html>`);
    await page.screenshot({ path: join(OUT, name), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`web/assets/icons/${name}  ${size}×${size}`);
  }
} finally {
  await browser.close();
}
