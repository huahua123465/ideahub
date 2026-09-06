import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer';
import {
  PROJECT_ROOT,
  WEB_HTML,
  WEB_ROOT,
  buildWebBundle,
  makeQaHtml,
  readBundleOutput,
  validateWebBuildInputs,
} from './web-build.mjs';

const LEARNING_ROOT = join(PROJECT_ROOT, 'server', 'content', 'learning');
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

export const DEFAULT_UI_OUTPUT = join(PROJECT_ROOT, 'scripts', '.uidiff');

export async function createUiHarness({
  outputDir = DEFAULT_UI_OUTPUT,
  query = 'mock=1&uiqa=1',
} = {}) {
  outputDir = ownedOutputDirectory(outputDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await validateWebBuildInputs();
  const buildResult = await buildWebBundle({ write: false, sourcemap: false });
  const bundle = readBundleOutput(buildResult);
  const sourceHtml = await readFile(WEB_HTML, 'utf8');
  const qaHtml = makeQaHtml(sourceHtml);

  const marker = randomUUID();
  const server = createQaServer({ bundle, marker, qaHtml });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(`${origin}/__qa/health`, { cache: 'no-store' });
  if (!health.ok || await health.text() !== marker) {
    await closeServer(server);
    throw new Error('UI QA server identity check failed');
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    bundleBytes: bundle.length,
    checks: [],
    screenshots: [],
    capabilities: {},
    browserErrors: [],
    networkErrors: [],
    network: { requests: 0, responses: 0 },
  };
  const pages = new Set();

  async function newPage(scene, viewport) {
    const page = await browser.newPage();
    pages.add(page);
    page.once('close', () => pages.delete(page));
    await page.setViewport({ deviceScaleFactor: 1, ...viewport });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await attachRuntimeGates(page, { origin, report, scene });

    await page.goto(`${origin}/?${query}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForFunction(() => {
      const home = document.querySelector('#v-home.on');
      const avatar = document.querySelector('#meAvatar');
      return home?.childElementCount > 0 && avatar?.textContent.trim() &&
        document.title.endsWith('· IdeaHub');
    }, { timeout: 15_000 });
    await settleDom(page);
    await page.addStyleTag({
      content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}',
    });
    return page;
  }

  function recordCheck(label, kind, metrics = {}) {
    report.checks.push({ label, kind, passed: true, metrics });
  }

  async function screenshot(page, name, options = {}) {
    const path = join(outputDir, `${name}.png`);
    await page.screenshot({ path, fullPage: false, ...options });
    report.screenshots.push(name);
    return path;
  }

  async function writeReport(error) {
    if (error) report.failure = error?.stack || String(error);
    await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  }

  async function close() {
    await Promise.allSettled([...pages].map(page => page.close()));
    await browser.close();
    await closeServer(server);
  }

  return {
    browser,
    origin,
    outputDir,
    report,
    newPage,
    recordCheck,
    screenshot,
    writeReport,
    close,
  };
}

function ownedOutputDirectory(path) {
  const root = resolve(DEFAULT_UI_OUTPUT);
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return target;
  throw new Error(`UI QA output must stay inside ${root}: ${target}`);
}

export async function settleDom(page, { quietMs = 100, timeoutMs = 2_500 } = {}) {
  await page.evaluate(async ({ quietMs: quiet, timeoutMs: timeout }) => {
    await document.fonts?.ready;
    await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    await new Promise(resolveIdle => {
      let idleTimer;
      let timeoutTimer;
      const observer = new MutationObserver(() => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, quiet);
      });
      const finish = () => {
        clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        observer.disconnect();
        resolveIdle();
      };
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      idleTimer = setTimeout(finish, quiet);
      timeoutTimer = setTimeout(finish, timeout);
    });
  }, { quietMs, timeoutMs });
}

async function attachRuntimeGates(page, { origin, report, scene }) {
  await page.setRequestInterception(true);
  page.on('pageerror', error => {
    report.browserErrors.push({ scene, type: 'pageerror', message: error.message });
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      report.browserErrors.push({ scene, type: 'console', message: message.text() });
    }
  });
  page.on('request', request => {
    report.network.requests += 1;
    const url = request.url();
    if (!isAllowedRequest(url, origin)) {
      report.networkErrors.push({ scene, type: 'external-request', method: request.method(), url });
      request.abort('blockedbyclient').catch(() => {});
      return;
    }
    request.continue().catch(() => {});
  });
  page.on('requestfailed', request => {
    report.networkErrors.push({
      scene,
      type: 'request-failed',
      method: request.method(),
      url: request.url(),
      message: request.failure()?.errorText || 'request failed',
    });
  });
  page.on('response', response => {
    report.network.responses += 1;
    if (response.status() >= 400) {
      report.networkErrors.push({
        scene,
        type: 'http-error',
        status: response.status(),
        url: response.url(),
      });
    }
  });
}

function isAllowedRequest(url, origin) {
  if (/^(?:data|blob|about):/.test(url)) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function createQaServer({ bundle, marker, qaHtml }) {
  return createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);

      if (pathname === '/__qa/health') {
        respond(res, 200, Buffer.from(marker), 'text/plain; charset=utf-8');
        return;
      }
      if (pathname === '/__qa/app.js') {
        respond(res, 200, bundle, 'text/javascript; charset=utf-8');
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' }).end();
        return;
      }

      const learning = /^\/api\/learning\/(framework|detail)\/([^/]+\.pdf)$/.exec(pathname);
      if (learning) {
        const file = join(LEARNING_ROOT, learning[1], learning[2]);
        respond(res, 200, await readFile(file), 'application/pdf');
        return;
      }

      if (pathname.startsWith('/api/')) {
        respond(
          res,
          404,
          Buffer.from(JSON.stringify({ error: 'UI QA runs with local mock data' })),
          'application/json; charset=utf-8',
        );
        return;
      }

      let rel = normalize(pathname).replace(/^([/\\])+/, '');
      if (!rel || rel.endsWith('/') || rel === 'index.html') {
        respond(res, 200, Buffer.from(qaHtml), 'text/html; charset=utf-8');
        return;
      }

      const webRoot = resolve(WEB_ROOT) + sep;
      const file = resolve(WEB_ROOT, rel);
      if (!file.startsWith(webRoot)) {
        respond(res, 403, Buffer.from('Forbidden'), 'text/plain; charset=utf-8');
        return;
      }
      if ((await stat(file)).isDirectory()) throw new Error('directory');
      respond(
        res,
        200,
        await readFile(file),
        MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      );
    } catch {
      respond(res, 404, Buffer.from('Not Found'), 'text/plain; charset=utf-8');
    }
  });
}

function respond(res, status, body, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  }).end(body);
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
}
