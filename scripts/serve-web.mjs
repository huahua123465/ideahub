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
const PORT = Number(process.env.WEB_PORT || 5173);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

http.createServer(async (req, res) => {
  let rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
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
