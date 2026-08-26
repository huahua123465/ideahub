/**
 * 登录后站内阅读的学习资料。
 *
 * PDF 不放 web/ 静态目录：静态资源无需登录就能取到，知道地址的人会绕过权限。
 * 这里用明确白名单 + 登录校验提供同源 inline 阅读，并支持 Range，避免翻到后面一页
 * 还要重新下载整份文件。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { currentUser } from '../lib/auth.mjs';
import { notFound } from '../lib/http.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'learning');
const FILES = {
  framework: new Set([
    'security-foundation.pdf', 'relationship-posture.pdf', 'attachment-chain.pdf',
    'control-needs.pdf', 'aggression-chain.pdf', 'coquetry.pdf', 'coquetry-chain.pdf',
  ]),
  detail: new Set([
    'security-foundation-detail.pdf', 'self-worth-detail.pdf', 'relationship-posture-detail.pdf',
    'attachment-detail.pdf', 'control-needs-detail.pdf', 'aggression-detail.pdf', 'coquetry-detail.pdf',
  ]),
};

export function mount(router) {
  router.get('/api/learning/:section/:file', async (req, res, params) => {
    await currentUser(req);
    const section = String(params.section || '');
    const file = String(params.file || '');
    if (!FILES[section]?.has(file)) throw notFound('没有这份学习资料');

    const path = join(ROOT, section, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw notFound('学习资料文件不存在');

    const base = {
      'content-type': 'application/pdf',
      'content-disposition': 'inline',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= info.size) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${info.size}`,
        'content-length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...base, 'content-length': info.size });
    createReadStream(path).pipe(res);
  });
}
