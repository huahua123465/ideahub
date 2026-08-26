/**
 * 客户档案的附件：聊天记录分析报告等。
 *
 * 上传走「原始字节 + 查询参数」而不是 multipart/form-data ——
 * 这个项目用的是 Node 原生 http，没有框架也没有 multipart 解析器，
 * 自己手写一个边界解析器是笔不划算的账（还容易出安全洞）。
 * 前端直接 `fetch(url, { method:'POST', body: file })` 把文件当请求体发，
 * 文件名和类型放在查询参数里，服务端读一次流就完事。
 *
 * 安全上有三处是刻意为之的，改的时候别顺手拆掉：
 *  1. 磁盘上的文件名是系统随机生成的，用户给的原始名只存在数据库里。
 *     直接拿用户文件名当路径，一个 ../../ 就能写到别处去。
 *  2. HTML 报告用 CSP sandbox 隔离。不隔离的话，上传一个带 <script> 的 HTML
 *     就是一次存储型 XSS —— 它跑在本站域名下，能直接读走同事的登录 cookie。
 *     sandbox（不带 allow-same-origin）让它拿到一个独立的空源：报告照样渲染、
 *     图表照样跑，但读不到 cookie，也调不了本站接口。
 *  3. Office 文档一律当附件下载，不在浏览器里内联打开。
 */
import { createWriteStream } from 'node:fs';
import { unlink, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { query } from '../db/index.mjs';
import { sendJson, q, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { requireKey } from '../lib/apikey.mjs';
import { publish } from '../lib/bus.mjs';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const MAX_SIZE = 20 * 1024 * 1024;   // 20MB

/** 允许的类型。键是扩展名，值是回给浏览器的 Content-Type 和打开方式 */
const KINDS = {
  '.html': { mime: 'text/html; charset=utf-8', inline: true,  sandbox: true },
  '.htm':  { mime: 'text/html; charset=utf-8', inline: true,  sandbox: true },
  '.pdf':  { mime: 'application/pdf',          inline: true },
  '.doc':  { mime: 'application/msword' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xls':  { mime: 'application/vnd.ms-excel' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.csv':  { mime: 'text/csv; charset=utf-8' },
  '.txt':  { mime: 'text/plain; charset=utf-8', inline: true },
  '.md':   { mime: 'text/plain; charset=utf-8', inline: true },
  // ——— 图片 ———
  // image: true 是给前端看的标记：附件区据此把它画成缩略图而不是一行链接。
  // 审核人要看的是「图里写了什么」，不是「有个附件叫 IMG_2381」。
  '.png':  { mime: 'image/png',  inline: true, image: true },
  '.jpg':  { mime: 'image/jpeg', inline: true, image: true },
  '.jpeg': { mime: 'image/jpeg', inline: true, image: true },
  '.gif':  { mime: 'image/gif',  inline: true, image: true },
  '.webp': { mime: 'image/webp', inline: true, image: true },
  '.bmp':  { mime: 'image/bmp',  inline: true, image: true },
  '.avif': { mime: 'image/avif', inline: true, image: true },
  // iPhone 默认就是 HEIC，直接拒收等于让同事「拍完还得先转格式」——
  // 那一步没人会做，结果就是干脆不传图了。所以收下。
  // 但除了 Safari 之外浏览器显示不了它，所以不标 image：
  // 界面上退化成一行文件（可下载），并且会提示一句「换成 JPG 才能直接看」。
  '.heic': { mime: 'image/heic' },
  '.heif': { mime: 'image/heif' },
};

/** 这些扩展名在界面上按图片处理（能直接看缩略图） */
export const IMAGE_EXT = Object.entries(KINDS)
  .filter(([, v]) => v.image).map(([k]) => k);
export const ALLOWED_EXT = Object.keys(KINDS);

function fileRow(r) {
  return {
    id: Number(r.id),
    scope: r.scope, refId: Number(r.ref_id), side: r.side,
    name: r.orig_name, mime: r.mime, size: Number(r.size),
    note: r.note, sourceUrl: r.source_url || null,
    uploaderName: r.uploader_name || null,
    createdAt: r.created_at,
    url: `/api/files/${r.id}`,
  };
}

/** 只取扩展名，且是从 basename 里取 —— 防住 "a/../../b.html" 这种 */
function kindOf(name) {
  const ext = extname(basename(String(name || ''))).toLowerCase();
  const k = KINDS[ext];
  if (!k) {
    throw badRequest(`不支持这个格式（${ext || '无扩展名'}）。支持：${ALLOWED_EXT.join(' ')}`);
  }
  return { ext, ...k };
}

/** 把请求体流式写到磁盘，超限就中断并删掉半截文件 */
async function saveBody(req, dest) {
  await mkdir(UPLOAD_DIR, { recursive: true });
  let size = 0;
  let tooBig = false;
  const out = createWriteStream(dest);
  req.on('data', c => {
    size += c.length;
    if (size > MAX_SIZE && !tooBig) { tooBig = true; req.destroy(); }
  });
  try {
    await pipeline(req, out);
  } catch (e) {
    await unlink(dest).catch(() => {});
    if (tooBig) throw badRequest(`文件太大了，单个最多 ${MAX_SIZE / 1024 / 1024}MB`);
    throw e;
  }
  if (tooBig) {
    await unlink(dest).catch(() => {});
    throw badRequest(`文件太大了，单个最多 ${MAX_SIZE / 1024 / 1024}MB`);
  }
  if (size === 0) {
    await unlink(dest).catch(() => {});
    throw badRequest('文件是空的');
  }
  return size;
}

/** 上传/下载/删除这三件事，客户档案和工作提交是一模一样的，
    所以把它们导出去给 routes/work.mjs 复用，而不是复制一份。 */
export { kindOf, saveBody, fileRow, UPLOAD_DIR, MAX_SIZE, KINDS };

function uploadParams(url) {
  const origName = String(q(url, 'name', '') || '').trim();
  if (!origName) throw badRequest('缺少文件名 name');
  if (origName.length > 200) throw badRequest('文件名太长了');

  const note = String(q(url, 'note', '') || '').trim();
  if (note.length > 2000) throw badRequest('附件备注太长了');

  const sourceUrl = String(q(url, 'sourceUrl', '') || '').trim();
  if (sourceUrl.length > 2000) throw badRequest('sourceUrl 太长了');
  if (sourceUrl) {
    let parsed;
    try { parsed = new URL(sourceUrl); }
    catch { throw badRequest('sourceUrl 不是合法网址'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw badRequest('sourceUrl 只支持 http 或 https 地址');
    }
  }

  return { origName, note: note || null, sourceUrl: sourceUrl || null, kind: kindOf(origName) };
}

async function storeClientFile(req, clientId, params, uploadedBy = null) {
  const storedName = randomBytes(16).toString('hex') + params.kind.ext;
  const diskPath = join(UPLOAD_DIR, storedName);
  const size = await saveBody(req, diskPath);

  try {
    const { rows } = await query(
      `INSERT INTO attachments(scope, ref_id, side, orig_name, stored_name, mime, size,
                               note, source_url, uploaded_by)
       VALUES('client',$1,'submit',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [clientId, basename(params.origName), storedName, params.kind.mime, size,
       params.note, params.sourceUrl, uploadedBy]);
    return rows[0];
  } catch (e) {
    // 数据库写入失败时同步清理文件，避免磁盘留下永远查不到的孤儿附件。
    await unlink(diskPath).catch(() => {});
    throw e;
  }
}

export function mount(router) {

  /* ---------- 列出某个客户的附件 ---------- */
  router.get('/api/clients/:id/files', async (req, res, params) => {
    await currentUser(req);
    const { rows } = await query(
      `SELECT f.*, u.name AS uploader_name
         FROM attachments f LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE f.scope = 'client' AND f.ref_id = $1 ORDER BY f.created_at DESC`, [Number(params.id)]);
    sendJson(res, 200, { items: rows.map(fileRow) });
  });

  /* ---------- 上传 ----------
     POST /api/clients/:id/files?name=分析报告.html
     请求体就是文件本身的原始字节。 */
  router.post('/api/clients/:id/files', async (req, res, params, url) => {
    const me = await currentUser(req);
    const clientId = Number(params.id);

    const { rows: c } = await query(
      'SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL', [clientId]);
    if (!c[0]) throw notFound('没有这个客户');

    const row = await storeClientFile(req, clientId, uploadParams(url), me.id);

    sendJson(res, 201, fileRow({ ...row, uploader_name: me.name }));
    publish('board:updated', { board: 'clients' });
  });

  /* ---------- 技术2：按 externalId 上传客户附件 ----------
     POST /api/ingest/client/file?externalId=t2-8891&name=分析报告.pdf&sourceUrl=https%3A%2F%2F...
     Authorization: Bearer ih_tech2_...
     请求体是一个文件的原始字节；多文件逐文件调用，可并发。 */
  router.post('/api/ingest/client/file', async (req, res, _params, url) => {
    const key = await requireKey(req, 'tech2');
    const externalId = String(q(url, 'externalId', '') || '').trim();
    if (!externalId) throw badRequest('externalId 必填');
    if (externalId.length > 300) throw badRequest('externalId 太长了');

    const { rows: clients } = await query(
      'SELECT id FROM clients WHERE external_id = $1 AND deleted_at IS NULL', [externalId]);
    if (!clients[0]) throw notFound('这个客户还没建档，先调 /api/ingest/client');

    const row = await storeClientFile(req, Number(clients[0].id), uploadParams(url), null);
    sendJson(res, 201, {
      ok: true,
      externalId,
      ...fileRow({ ...row, uploader_name: key.name }),
      by: key.name,
    });
    publish('board:updated', { board: 'clients' });
  });

  /* ---------- 打开 / 下载 ---------- */
  router.get('/api/files/:id', async (req, res, params, url) => {
    const me = await currentUser(req);
    const { rows } = await query('SELECT * FROM attachments WHERE id = $1', [Number(params.id)]);
    const f = rows[0];
    if (!f) throw notFound('没有这个文件');

    // 客户档案的附件是团队共同维护的台账，登录就能看；
    // 工作提交的附件只有提交人、审核人和管理员能看 —— 这条不能漏，
    // 漏了的话任何人拿着一个连续的 id 就能把别人交的东西翻个遍。
    // 私聊附件只有对话双方能取，管理员也不行 —— 私聊不是台账。
    // 少了这一段，拿着连续的文件 id 就能把别人的私聊文件翻个遍。
    if (f.scope === 'chat') {
      const { rows: m } = await query(
        'SELECT from_id, to_id FROM chat_messages WHERE id = $1', [f.ref_id]);
      const ok = m[0] && (Number(m[0].from_id) === me.id || Number(m[0].to_id) === me.id);
      if (!ok) throw forbidden('这是别人的私聊文件');
    }
    if (f.scope === 'report' && me.role !== 'admin') {
      const { rows: r } = await query(
        'SELECT author_id, reviewer_id FROM work_reports WHERE id = $1', [f.ref_id]);
      const ok = r[0] && (Number(r[0].author_id) === me.id || Number(r[0].reviewer_id) === me.id);
      if (!ok) throw forbidden('这是别人的工作提交，你看不到');
    }

    const path = join(UPLOAD_DIR, basename(f.stored_name));
    let st;
    try { st = await stat(path); }
    catch { throw notFound('文件已经不在磁盘上了'); }

    const kind = KINDS[extname(f.stored_name).toLowerCase()] || {};
    // ?download=1 可以强制下载，哪怕这个类型默认是内联打开的
    const inline = kind.inline && q(url, 'download') !== '1';

    const headers = {
      'content-type': f.mime,
      'content-length': st.size,
      'cache-control': 'private, no-store',
      // 上传的内容一律不许浏览器猜类型，猜错就可能当成脚本执行
      'x-content-type-options': 'nosniff',
      'content-disposition':
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.orig_name)}`,
    };
    if (kind.sandbox) {
      // allow-scripts 但不给 allow-same-origin：报告里的图表脚本照跑，
      // 但它拿到的是一个独立的空源，读不到本站 cookie，也调不了本站接口。
      headers['content-security-policy'] = "sandbox allow-scripts allow-popups";
    }

    res.writeHead(200, headers);
    await pipeline(createReadStream(path), res).catch(() => {});
  });

  /* ---------- 删除 ---------- */
  router.del('/api/files/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const { rows } = await query('SELECT * FROM attachments WHERE id = $1', [Number(params.id)]);
    const f = rows[0];
    if (!f) throw notFound('没有这个文件');
    // 传的人自己能删，管理员也能删
    if (me.role !== 'admin' && Number(f.uploaded_by) !== me.id) {
      throw forbidden('只有上传者本人和管理员能删除');
    }
    await query('DELETE FROM attachments WHERE id = $1', [f.id]);
    await unlink(join(UPLOAD_DIR, basename(f.stored_name))).catch(() => {});
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: 'clients' });
  });
}
