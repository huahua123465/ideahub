/**
 * IdeaHub UI 基础验收：npm run test:ui
 *
 * 目标不是把已经持续演进的产品强行与早期静态原型逐像素对齐，而是建立稳定、
 * 可重复的产品级 UI 合同：生产 bundle 能构建，核心页面能打开，桌面和手机无
 * 页面级横向溢出，关键弹窗留在视口内，并且浏览器没有脚本或 console 错误。
 *
 * 截图和机器可读报告写入 scripts/.uidiff/（已忽略，不进入 Git）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const LEARNING = join(ROOT, 'server', 'content', 'learning');
const OUT = join(ROOT, 'scripts', '.uidiff');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const report = {
  generatedAt: new Date().toISOString(),
  bundleBytes: 0,
  checks: [],
  screenshots: [],
  browserErrors: [],
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 在内存中构建与生产相同的 ESM bundle。这样 test:ui 能验证构建，又不会为了一个
// 测试改写被 Git 跟踪的 web/index.html cache-busting 版本号。
const buildResult = await build({
  entryPoints: [join(WEB, 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  write: false,
  outfile: 'app.js',
  logLevel: 'warning',
});
const bundleFile = buildResult.outputFiles?.find(file => file.path.endsWith('app.js'));
assert.ok(bundleFile, 'esbuild did not produce app.js');
const bundle = Buffer.from(bundleFile.contents);
report.bundleBytes = bundle.length;

const sourceHtml = await readFile(join(WEB, 'index.html'), 'utf8');
const qaHtml = sourceHtml
  .replace(
    /<link rel="modulepreload"[\s\S]*?<!-- \/modulepreload -->/,
    '<!-- UI QA uses one in-memory production bundle -->',
  )
  .replace(
    /<script type="module" src="\.\/(?:src\/main\.js|dist\/app\.js[^"]*)"><\/script>/,
    '<script type="module" src="/__qa/app.js"></script>',
  );
assert.match(qaHtml, /src="\/__qa\/app\.js"/, 'index.html entry script was not recognized');

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);

    if (pathname === '/__qa/app.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': bundle.length,
        'cache-control': 'no-store',
      }).end(bundle);
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    const learning = /^\/api\/learning\/(framework|detail)\/([^/]+\.pdf)$/.exec(pathname);
    if (learning) {
      const file = join(LEARNING, learning[1], learning[2]);
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': body.length,
        'cache-control': 'no-store',
      }).end(body);
      return;
    }

    // mock 模式不应误用静态 HTML 伪装成 API JSON。
    if (pathname.startsWith('/api/')) {
      const body = Buffer.from(JSON.stringify({ error: 'UI QA runs with local mock data' }));
      res.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
      }).end(body);
      return;
    }

    let rel = normalize(pathname).replace(/^([/\\])+/, '');
    if (!rel || rel.endsWith('/') || rel === 'index.html') {
      const body = Buffer.from(qaHtml);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      }).end(body);
      return;
    }

    const webRoot = resolve(WEB) + sep;
    const file = resolve(WEB, rel);
    if (!file.startsWith(webRoot)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(file)).isDirectory()) throw new Error('directory');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    const body = Buffer.from('Not Found');
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    }).end(body);
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/?mock=1&uiqa=1`;

let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  await runDesktop(browser);
  await runMobile(browser);

  assert.deepEqual(
    report.browserErrors,
    [],
    `browser errors must fail UI QA:\n${report.browserErrors.map(item => `${item.scene}: ${item.message}`).join('\n')}`,
  );

  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`UI QA passed: ${report.checks.length} checks, ${report.screenshots.length} screenshots`);
  console.log(`Bundle: ${Math.round(report.bundleBytes / 1024)} KB`);
  console.log(`Evidence: ${OUT}`);
} catch (error) {
  report.failure = error?.stack || String(error);
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}

async function newPage(browserInstance, scene, viewport) {
  const page = await browserInstance.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', error => {
    report.browserErrors.push({ scene, type: 'pageerror', message: error.message });
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      report.browserErrors.push({ scene, type: 'console', message: message.text() });
    }
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForSelector('#v-home.on .dash-hero', { timeout: 15_000 });
  await page.addStyleTag({
    content: `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}`,
  });
  await wait(80);
  return page;
}

async function go(page, tab, view, ready) {
  const mobile = await page.evaluate(() => innerWidth <= 1180);
  if (mobile) {
    const open = await page.$eval('#appNav', node => node.classList.contains('mobile-open'));
    if (!open) {
      await page.click('#navToggle');
      await page.waitForSelector('#appNav.mobile-open');
    }
  }
  await page.click(`#tab-${tab}`);
  await page.waitForSelector(`#v-${view}.on`);
  if (ready) await page.waitForSelector(ready, { timeout: 15_000 });
  await wait(80);
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  const overflow = Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.clientWidth;
  assert.ok(overflow <= 1, `${label} has ${overflow}px horizontal page overflow: ${JSON.stringify(metrics)}`);
  report.checks.push({ label, kind: 'horizontal-overflow', passed: true, metrics });
}

async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push(name);
}

async function runDesktop(browserInstance) {
  const page = await newPage(browserInstance, 'desktop', { width: 1440, height: 900 });
  try {
    const home = await page.evaluate(() => ({
      context: document.querySelector('#pageContext')?.textContent.trim(),
      navItems: document.querySelectorAll('#appNav [data-go]').length,
      quickActions: document.querySelectorAll('.dash-quick button').length,
    }));
    assert.equal(home.context, '今日工作台');
    assert.ok(home.navItems >= 18, home);
    assert.ok(home.quickActions >= 5, home);
    report.checks.push({ label: 'desktop-home-contract', passed: true, metrics: home });
    await assertNoOverflow(page, 'desktop-home');
    await shot(page, 'home-desktop-1440x900');

    await go(page, 'functionTree', 'functionTree', '.ft-domain');
    const tree = await page.evaluate(() => ({
      domains: document.querySelectorAll('.ft-domain').length,
      modules: document.querySelectorAll('.ft-node').length,
    }));
    assert.ok(tree.domains >= 8, tree);
    assert.ok(tree.modules >= 19, tree);
    report.checks.push({ label: 'desktop-function-tree-contract', passed: true, metrics: tree });
    await assertNoOverflow(page, 'desktop-function-tree');
    await shot(page, 'function-tree-desktop-1440x900');

    await go(page, 'pool', 'pool', '#poolGrid .card');
    const poolCards = await page.$$eval('#poolGrid .card', nodes => nodes.length);
    assert.ok(poolCards > 0, 'mock pool must render at least one card');
    report.checks.push({ label: 'desktop-pool-cards', passed: true, metrics: { poolCards } });
    await assertNoOverflow(page, 'desktop-pool');

    await page.click('#btnNew');
    await page.waitForSelector('#modal.on');
    const modal = await page.$eval('#modal', node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    });
    assert.ok(modal.left >= -1 && modal.right <= 1441 && modal.top >= -1 && modal.bottom <= 901, modal);
    report.checks.push({ label: 'desktop-create-modal-in-viewport', passed: true, metrics: modal });
    await shot(page, 'idea-modal-desktop-1440x900');
    await page.click('#modal [data-close]');
    await page.waitForSelector('#modal:not(.on)');

    await go(page, 'formal', 'formal', '#formalBody tr');
    await assertNoOverflow(page, 'desktop-formal');
    await go(page, 'stats', 'stats', '.stat-key-card');
    const statCards = await page.$$eval('.stat-key-card', nodes => nodes.length);
    assert.ok(statCards >= 5, { statCards });
    report.checks.push({ label: 'desktop-stats-contract', passed: true, metrics: { statCards } });
    await assertNoOverflow(page, 'desktop-stats');

    await go(page, 'samples', 'samples', '#v-samples .sample-card');
    await assertNoOverflow(page, 'desktop-samples');
    await shot(page, 'samples-desktop-1440x900');

    await go(page, 'home', 'home', '.dash-hero');
    await page.click('[data-dash-learning="framework"]');
    await page.waitForSelector('#v-learning.on .learning-item');
    await assertNoOverflow(page, 'desktop-learning');

    await go(page, 'collector', 'collector', '#collectorForm');
    await assertNoOverflow(page, 'desktop-collector');
  } finally {
    await page.close();
  }
}

async function runMobile(browserInstance) {
  const page = await newPage(browserInstance, 'mobile', { width: 390, height: 844 });
  try {
    await assertNoOverflow(page, 'mobile-home');
    const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    assert.equal(reduced, true);
    report.checks.push({ label: 'mobile-reduced-motion', passed: true });
    await shot(page, 'home-mobile-390x844');

    await page.click('#navToggle');
    await page.waitForSelector('#appNav.mobile-open');
    assert.equal(await page.$eval('#navToggle', node => node.getAttribute('aria-expanded')), 'true');
    await page.click('#tab-functionTree');
    await page.waitForSelector('#v-functionTree.on .ft-domain');
    assert.equal(await page.$eval('#appNav', node => node.classList.contains('mobile-open')), false);
    await assertNoOverflow(page, 'mobile-function-tree');
    await shot(page, 'function-tree-mobile-390x844');

    await go(page, 'pool', 'pool', '#poolGrid .card');
    await assertNoOverflow(page, 'mobile-pool');
    await page.click('#btnNew');
    await page.waitForSelector('#modal.on');
    const modal = await page.$eval('#modal', node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    });
    assert.ok(modal.left >= -1 && modal.right <= 391 && modal.top >= -1 && modal.bottom <= 845, modal);
    report.checks.push({ label: 'mobile-create-modal-in-viewport', passed: true, metrics: modal });
    await shot(page, 'idea-modal-mobile-390x844');
    await page.click('#modal [data-close]');
    await page.waitForSelector('#modal:not(.on)');

    await go(page, 'samples', 'samples', '#v-samples .sample-card');
    await assertNoOverflow(page, 'mobile-samples');
    await shot(page, 'samples-mobile-390x844');
  } finally {
    await page.close();
  }
}
