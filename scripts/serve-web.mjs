/**
 * 只跑前端的静态服务器（零依赖）。
 * 后端没起时前端会自动用内置演示数据，所以这个命令足够「只看界面」。
 */
import '../server/src/lib/env.mjs';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const LEARNING = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'content', 'learning');
const PORT = Number(process.env.WEB_PORT || 5173);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.pdf':'application/pdf', '.ico':'image/x-icon' };

http.createServer(async (req, res) => {
  let rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
  // 本地只看界面时没有后端；为学习中心模拟同一路径。只允许两个目录和纯文件名，
  // 生产环境由需登录的 /api/learning 路由负责。
  const learn = /^api[\\/]learning[\\/](framework|detail)[\\/]([^\\/]+\.pdf)$/.exec(rel);
  if (learn) {
    const file = join(LEARNING, learn[1], learn[2]);
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline',
        'content-length': buf.length, 'cache-control': 'no-cache' });
      res.end(buf);
    } catch { res.writeHead(404).end('Not Found'); }
    return;
  }
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    if ((await stat(file)).isDirectory()) throw new Error('dir');
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
                         'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    const buf = await readFile(join(WEB, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(buf);
  }
}).listen(PORT, () => {
  console.log(`\n  前端已启动：http://localhost:${PORT}`);
  console.log(`  后端没起也没关系，会自动用内置演示数据。\n`);
});
