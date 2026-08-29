/**
 * 入口：Node 内置 http，没有 Web 框架。
 * 同时负责托管 web/ 目录的静态文件，这样生产环境一个进程就够了。
 */
import '../src/lib/env.mjs';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

import { createRouter } from './router.mjs';
import { sendJson, sendError, HttpError } from './lib/http.mjs';
import { currentUser, currentUserOrNull, headerAuthEnabled } from './lib/auth.mjs';
import { query, close, driverName } from './db/index.mjs';

import * as ideas from './routes/ideas.mjs';
import * as votes from './routes/votes.mjs';
import * as comments from './routes/comments.mjs';
import * as status from './routes/status.mjs';
import * as stats from './routes/stats.mjs';
import * as auth from './routes/auth.mjs';
import * as events from './routes/events.mjs';
import * as boards from './routes/boards.mjs';
import * as clients from './routes/clients.mjs';
import * as files from './routes/files.mjs';
import * as work from './routes/work.mjs';
import * as notifications from './routes/notifications.mjs';
import * as chat from './routes/chat.mjs';
import * as demands from './routes/demands.mjs';
import * as tags from './routes/tags.mjs';
import * as links from './routes/links.mjs';
import * as search from './routes/search.mjs';
import * as ingest from './routes/ingest.mjs';
import * as smartImport from './routes/smart-import.mjs';
import * as learning from './routes/learning.mjs';
import * as collector from './routes/collector.mjs';
import * as samples from './routes/samples.mjs';
import { archiveStaleIdeas } from './routes/status.mjs';
import { publish, closeAll, clientCount } from './lib/bus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, '..', '..', 'web');
const PORT = Number(process.env.PORT || 3000);

const router = createRouter();

router.get('/api/health', async (req, res) => {
  let db = 'down', dbError = null;
  try {
    await query('SELECT 1');
    db = 'up';
  } catch (e) { dbError = e.message; }
  sendJson(res, db === 'up' ? 200 : 503, {
    ok: db === 'up', db, driver: driverName, dbError,
    version: '0.1.0', at: new Date().toISOString(),
  });
});

router.get('/api/me', async (req, res) => {
  sendJson(res, 200, await currentUser(req));
});

/**
 * 可以被指派为负责人的人 = 所有有账号的真人。
 *
 * 原来的条件是 `role <> 'member' OR id <= 6`，两截都是历史包袱：
 *   · id <= 6 是当年种子数据里 90 个虚拟同事留下的，现在库里全是真人账号，只剩副作用；
 *   · 按角色过滤更是错的 —— 负责人是「谁去干这件事」，评审权限是「谁能拍板」，
 *     两回事。一个普通成员完全可以负责某个项目，把他挡在下拉框外面没有道理。
 * 结果就是新注册的同事永远选不到自己。
 *
 * password_hash IS NOT NULL 才是真正该有的判据：能登录的人才谈得上被指派工作。
 */
router.get('/api/users', async (req, res) => {
  await currentUser(req);
  const { rows } = await query(
    `SELECT id, name, dept, role::text AS role FROM users
      WHERE password_hash IS NOT NULL ORDER BY id`);
  sendJson(res, 200, { items: rows.map(r => ({ ...r, id: Number(r.id) })) });
});

auth.mount(router);
ideas.mount(router);
votes.mount(router);
comments.mount(router);
status.mount(router);
stats.mount(router);
events.mount(router);
boards.mount(router);
clients.mount(router);
files.mount(router);
work.mount(router);
notifications.mount(router);
chat.mount(router);
demands.mount(router);
tags.mount(router);
links.mount(router);
search.mount(router);
ingest.mount(router);
smartImport.mount(router);
learning.mount(router);
collector.mount(router);
samples.mount(router);


/* ---------- 登录闸门 ---------- */
/**
 * 除了下面这几个，所有 /api/ 接口都必须先登录。
 *
 * 每个路由里其实也各自调了 currentUser()，这里再拦一道是故意的：
 * 以后谁新加一个接口忘了写权限判断，默认是「进不来」而不是「谁都能进」。
 * 安全上的默认值应该往严的方向倒。
 */
const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/config',
  // 技术1 / 技术2 的接入口走 API key（Authorization: Bearer），不走登录 cookie。
  // 放行的只是这道登录闸门 —— 每个 ingest 路由里第一行都是 requireKey()，
  // 没有钥匙照样进不来。
  '/api/ingest/ping',
  '/api/ingest/save',
  '/api/ingest/analysis',
  '/api/ingest/sample',
  '/api/ingest/client',
  '/api/ingest/client/delivery',
  '/api/ingest/client/file',
]);

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  // 登录页那张插图就是 webp。不在这张表里的话会以
  // application/octet-stream 发出去 —— 浏览器多半会嗅探后照样显示，
  // 但那是碰巧能用：一旦哪天前面加了 nosniff，图就整个不出来了。
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif':  'image/gif',
  '.pdf':  'application/pdf',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

async function serveStatic(req, pathname, res) {
  // normalize + 前缀检查，挡住 ../../etc/passwd 这类路径穿越
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end('Forbidden'); return true; }

  try {
    const s = await stat(file);
    if (s.isDirectory()) return serveStatic(req, pathname.replace(/\/?$/, '/'), res);

    // 用「修改时间 + 大小」当 ETag。
    // 原来只发 cache-control: no-cache 又没有任何校验字段 ——
    // no-cache 的意思是「每次都回来问」，可是没有 ETag 就无从判断有没有变，
    // 结果每次打开页面都要把全部 280KB 重新下一遍，哪怕一个字都没改。
    // 加上之后日常访问基本都是 304，几乎不传数据。
    // 不用内容哈希是因为那要把文件读一遍再算，收益不值这个开销。
    const etag = `W/"${s.mtimeMs.toString(36)}-${s.size.toString(36)}"`;
    const lastMod = new Date(s.mtimeMs).toUTCString();

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      res.end();
      return true;
    }

    const buf = await readFile(file);
    const headers = {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
      etag,
      'last-modified': lastMod,
    };
    // 学习中心需要在 iframe 内直接阅读，不能让浏览器把 PDF 当附件下载。
    if (extname(file).toLowerCase() === '.pdf') headers['content-disposition'] = 'inline';
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/** 允许跨域带 cookie 的来源：本机开发端口，外加 CORS_ORIGIN 里显式配的 */
function isAllowedOrigin(origin) {
  const extra = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch { return false; }
}

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS。
  // 生产环境前后端同源（后端自己托管 web/），根本用不到这几个头。
  // 只有开发时前端在 5173、后端在 3000 才需要，所以白名单只放本机，
  // 不再无脑回显 Origin —— 带 cookie 的接口回显任意 Origin，
  // 等于允许任何网站拿着同事的登录态调我们的接口。
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-credentials', 'true');   // 不加这个，跨域时 cookie 不会带
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-user-id, last-event-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const t0 = Date.now();
  try {
    if (url.pathname.startsWith('/api/') && !PUBLIC_API.has(url.pathname)) {
      if (!await currentUserOrNull(req)) throw new HttpError(401, '请先登录');
    }

    const hit = router.match(req.method, url.pathname);
    if (hit && hit.handler) {
      await hit.handler(req, res, hit.params, url);
      log(req, res, t0);
      return;
    }
    if (hit && hit.methodNotAllowed) throw new HttpError(405, `${url.pathname} 不支持 ${req.method}`);

    if (url.pathname.startsWith('/api/')) throw new HttpError(404, `没有这个接口：${url.pathname}`);

    if (await serveStatic(req, url.pathname, res)) return;
    // 前端是单页应用，其余路径回落到 index.html
    if (await serveStatic(req, '/index.html', res)) return;
    throw new HttpError(404, '页面不存在');
  } catch (e) {
    sendError(res, e);
    log(req, res, t0);
  }
});

function log(req, res, t0) {
  if (!req.url.startsWith('/api/')) return;
  const ms = Date.now() - t0;
  // 查询串可能带平台分享 token、搜索词或其它内部参数；访问日志只需要路由路径。
  const pathname = new URL(req.url, 'http://local').pathname;
  console.log(`${String(req.method).padEnd(5)} ${res.statusCode} ${String(ms + 'ms').padStart(6)}  ${pathname}`);
}

/* ---------- 内置定时任务 ----------
   之前只提供了 /api/maintenance/* 两个接口，靠使用者自己去配 crontab。
   问题是 docker-compose 里并没有任何东西去调它们 —— 也就是说默认部署下
   「热度会衰减」「90 天自动归档」这两件事根本不会发生，而界面上却在暗示它们会。
   与其指望别人记得配，不如直接跑在进程里。不需要它的话设 ENABLE_SCHEDULER=false。*/
function startScheduler() {
  if (process.env.ENABLE_SCHEDULER === 'false') {
    console.log('  定时任务   已按 ENABLE_SCHEDULER=false 关闭');
    return;
  }
  const HOT_EVERY = 15 * 60 * 1000;
  const STALE_EVERY = 24 * 60 * 60 * 1000;

  const tick = async (name, fn) => {
    try { await fn(); }
    catch (e) { console.error(`[定时任务] ${name} 失败:`, e.message); }
  };

  // 热度重算完要推一把：它是进程自己定时跑的，页面上没人操作过，
  // 不推的话挂着的页面上热度条会一直停在打开那一刻的样子。
  const recalcHot = () => tick('热度重算', async () => {
    await query('SELECT recalc_hot_scores()');
    publish('hot:recalced', {});
  });
  const archiveStale = () => tick('超期归档', archiveStaleIdeas);

  setTimeout(recalcHot, 5000).unref?.();
  setInterval(recalcHot, HOT_EVERY).unref?.();
  setTimeout(archiveStale, 30_000).unref?.();
  setInterval(archiveStale, STALE_EVERY).unref?.();

  console.log(`  定时任务   热度每 15 分钟重算，超期归档每天一次`);
}

server.listen(PORT, () => {
  console.log(`\n  IdeaHub 后端已启动`);
  console.log(`  接口   http://localhost:${PORT}/api/health`);
  console.log(`  前端   http://localhost:${PORT}/`);
  console.log(`  驱动   ${driverName}`);
  startScheduler();
  if (headerAuthEnabled) {
    console.log('\n  \x1b[43m\x1b[30m 警告 \x1b[0m ALLOW_HEADER_AUTH=1 已打开：任何人发一个 X-User-Id 头就能冒充管理员。');
    console.log('        它是给接口自测用的，上生产前必须从 .env 里删掉。');
    console.log('        （NODE_ENV=production 时会自动失效，但别指望这道保险）');
  }
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n正在关闭…');
    // 必须先主动断开 SSE 长连接。server.close() 只停止接受新连接、不碰已建立的连接，
    // 漏了这步的话只要还有人挂着页面，容器就停不下来，最后被 SIGKILL。
    if (clientCount()) console.log(`  断开 ${clientCount()} 个推送连接`);
    closeAll();
    server.close();
    await close().catch(() => {});
    process.exit(0);
  });
}
