/**
 * 五个业务板块的台账接口：真人作品 / 矩阵作品 / 真人直播 / 销售转化 / 后端交付。
 * 业务依据见 docs/新增板块-实现任务.md。
 *
 * 三张表、一套增删改查。前端三个板块（真人/矩阵/直播）共用 works + channel_accounts，
 * 靠 channel 和 side 区分；销售转化和后端交付共用 playbook_items，靠 board 和 section 区分。
 *
 * 权限跟「人人可评审」保持一致：登录即可读写，删除限管理员。
 * 这几张是团队共同维护的台账，卡权限只会让人懒得录 —— 而没人录的台账等于不存在。
 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, q, need, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { sourceOf, sourceRow } from '../lib/entity.mjs';
import { loadTags, setTags, clearTags, tagWhere } from '../lib/tags.mjs';
import { analysisView } from '../lib/t1-analysis.mjs';
import { COVER_DIR, dropCover } from '../lib/cover.mjs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const CHANNELS = ['persona', 'matrix', 'live'];
const SIDES = ['own', 'benchmark'];
const BOARDS = ['sales', 'delivery'];

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt);
const str = (v) => (v == null || v === '' ? null : String(v).trim());

/** 只把日期部分吐出去。前端 <input type="date"> 认的是 YYYY-MM-DD，
    直接给它一个完整 ISO 时间戳会显示成空的。 */
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function accountRow(r) {
  return {
    id: Number(r.id), channel: r.channel, side: r.side,
    platform: r.platform, handle: r.handle, url: r.url,
    followers: Number(r.followers) || 0,
    positioning: r.positioning, note: r.note,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function workRow(r, tags = []) {
  return {
    id: Number(r.id), channel: r.channel, side: r.side,
    ...sourceRow(r),
    tags, tagIds: tags.map(t => t.id),
    accountId: r.account_id ? Number(r.account_id) : null,
    accountName: r.account_name || null,
    title: r.title, url: r.url, pillar: r.pillar,
    publishedAt: ymd(r.published_at),
    metrics: r.metrics || {},
    note: r.note,
    // 技术1 推过来的完整分析（work_analyses）。
    // 列表只带那一小块摘要，整份 JSON（逐字稿 + 评论原文 + AI 拆解，约 30KB 一条）
    // 要点开才拉 —— 见 GET /api/works/:id/analysis。
    analysis: r.analysis_digest || null,
    analysisAt: r.analysis_at || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function playbookRow(r) {
  return {
    id: Number(r.id), board: r.board, section: r.section,
    label: r.label, title: r.title, body: r.body,
    meta: r.meta || {}, sort: Number(r.sort) || 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * 谁能删：所有登录用户。
 * 和 clients.mjs 一样，权限放开的同时改成了软删 —— 删掉的记录不再出现在
 * 列表、搜索、漏斗和统计里，但仍留在库里，误删可以恢复。
 */
async function assertCanDelete(req) {
  return currentUser(req);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw badRequest(`${label} 只能是：${allowed.join(' / ')}`);
  return value;
}

/**
 * 发一张落在本地的对标图（封面或图文笔记里的某一张）。
 *
 * 封面和图文的图存在同一个目录、判定完全一样，抽出来免得两处各写一遍
 * 然后慢慢长歪（比如哪天加了 .avif 只补了一边）。
 */
async function sendLocalImage(res, name) {
  // basename：文件名是我们自己算的 sha1，但路径拼接前还是过一道 ——
  // 「库里的值一定是干净的」这个假设，只要有一处写入没走那条路就不成立了
  const path = join(COVER_DIR, basename(String(name)));
  let size;
  try { size = (await stat(path)).size; } catch { throw notFound('图片文件不在了'); }
  const ext = String(name).slice(String(name).lastIndexOf('.')).toLowerCase();
  const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
                 '.gif': 'image/gif', '.avif': 'image/avif' }[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    // 文件名是内容指纹（sha1(sourceRef)），同一个地址的内容只会在重推时变 ——
    // 缓存一天足够，省掉翻列表时几十张图的重复请求。
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(path).pipe(res);
}

/**
 * 把「这张图有没有本地镜像」并进 analysisView 的结果。
 *
 * 前端拿到 local=true 就走 /api/works/:id/image/:i，否则只能试平台原地址 ——
 * 而那个地址路径里的 `202608241623` 是失效时间，过期后一律 403。
 * 明确告诉前端哪些图还在，它才能对失效的那些给一句人话，
 * 而不是在页面上摆一排碎图标让人以为系统坏了。
 */
function withLocalImages(view, digest) {
  const files = Array.isArray(digest?.imageFiles) ? digest.imageFiles : [];
  const has = new Set(files.map(f => Number(f?.i)));
  return {
    ...view,
    images: (view.images || []).map((im, i) => ({ ...im, i, local: has.has(i) })),
    imagesLocal: has.size,
  };
}

export function mount(router) {

  /* ==================== 账号台账 ==================== */

  router.get('/api/accounts', async (req, res, _p, url) => {
    await currentUser(req);
    const where = ['deleted_at IS NULL'], args = [];
    const channel = q(url, 'channel');
    if (channel) { args.push(oneOf(channel, CHANNELS, 'channel')); where.push(`channel = $${args.length}::work_channel`); }
    const side = q(url, 'side');
    if (side) { args.push(oneOf(side, SIDES, 'side')); where.push(`side = $${args.length}::work_side`); }

    const { rows } = await query(
      `SELECT * FROM channel_accounts
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY side, followers DESC, id`, args);
    sendJson(res, 200, { items: rows.map(accountRow) });
  });

  router.post('/api/accounts', async (req, res) => {
    await currentUser(req);
    const b = await readJson(req);
    const { rows } = await query(
      `INSERT INTO channel_accounts(channel, side, platform, handle, url, followers, positioning, note)
       VALUES($1::work_channel,$2::work_side,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [oneOf(b.channel, CHANNELS, 'channel'), oneOf(b.side, SIDES, 'side'),
       str(b.platform) || '小红书', need(b, 'handle', { max: 60, label: '账号名' }),
       str(b.url), num(b.followers), str(b.positioning), str(b.note)]);
    sendJson(res, 201, accountRow(rows[0]));
    publish('board:updated', { board: b.channel });
  });

  router.patch('/api/accounts/:id', async (req, res, params) => {
    await currentUser(req);
    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (b.platform !== undefined) set('platform', str(b.platform) || '小红书');
    if (b.handle !== undefined) set('handle', need(b, 'handle', { max: 60, label: '账号名' }));
    if (b.url !== undefined) set('url', str(b.url));
    if (b.followers !== undefined) set('followers', num(b.followers));
    if (b.positioning !== undefined) set('positioning', str(b.positioning));
    if (b.note !== undefined) set('note', str(b.note));
    if (!sets.length) throw badRequest('没有要修改的字段');

    args.push(Number(params.id));
    const { rows } = await query(
      `UPDATE channel_accounts SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${args.length} RETURNING *`, args);
    if (!rows[0]) throw notFound('没有这个账号');
    sendJson(res, 200, accountRow(rows[0]));
    publish('board:updated', { board: rows[0].channel });
  });

  router.del('/api/accounts/:id', async (req, res, params) => {
    await assertCanDelete(req);
    const { rows } = await query(
      `UPDATE channel_accounts SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING channel`, [Number(params.id)]);
    if (!rows[0]) throw notFound('没有这个账号');
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: rows[0].channel });
  });

  /* ==================== 作品与直播 ==================== */

  router.get('/api/works', async (req, res, _p, url) => {
    await currentUser(req);
    const where = ['w.deleted_at IS NULL'], args = [];
    const channel = q(url, 'channel');
    if (channel) { args.push(oneOf(channel, CHANNELS, 'channel')); where.push(`w.channel = $${args.length}::work_channel`); }
    const side = q(url, 'side');
    if (side) { args.push(oneOf(side, SIDES, 'side')); where.push(`w.side = $${args.length}::work_side`); }

    // 按内容类型等统一标签筛作品（任务 6）
    const tagClause = tagWhere('work', (q(url, 'tagIds') || '').split(',').filter(Boolean), args, 'w.id');
    if (tagClause) where.push(tagClause);
    const sourceType = q(url, 'sourceType');
    if (sourceType) { args.push(sourceType); where.push(`w.source_type = $${args.length}`); }

    const { rows } = await query(
      `SELECT w.*, a.handle AS account_name,
              -- 摘掉 imageFiles：图文笔记一条能有十几张，卡片上一个都用不到，
              -- 带着走等于让每次翻列表多下发几 KB 纯文件名。详情接口里才需要。
              (wa.digest - 'imageFiles') AS analysis_digest, wa.received_at AS analysis_at
         FROM works w
         LEFT JOIN channel_accounts a ON a.id = w.account_id
         -- 只取 digest 那一列。整份 payload 一条就有 30KB，
         -- 跟着列表一起下发的话翻一页对标要传几百 KB 的逐字稿。
         LEFT JOIN work_analyses wa ON wa.work_id = w.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       -- 技术1 推过来的对标作品没有发布日期（平台页面上抓不到），
       -- 只按 published_at 排的话它们全被挤到有日期的记录后面 ——
       -- 而对标列表以后基本都是推进来的，那等于最新采集的永远在最下面。
       -- 退一步用「收到的时间」，这对「最近在研究哪些对标」正好是对的顺序。
       ORDER BY coalesce(w.published_at, wa.received_at::date) DESC NULLS LAST, w.id DESC`, args);
    const tagMap = await loadTags('work', rows.map(r => r.id));
    sendJson(res, 200, { items: rows.map(r => workRow(r, tagMap.get(Number(r.id)) || [])) });
  });

  /**
   * GET /api/works/:id/analysis —— 技术1 推过来的那份完整分析。
   *
   * 单独一个接口而不是塞进列表：一条 30KB，对标列表随便就是几十条。
   * 点开某一条才拉，是这份数据唯一说得通的取法。
   *
   * 返回的是「读过一遍」的结构（analysisView），不是原始 JSON ——
   * 原始 JSON 里标题有四个候选字段、互动数是「4万」这种字符串，
   * 让前端每处都判一遍的话，同一份数据会在界面上出现四种读法。
   * 原文仍然一个字不差地留在库里，raw=1 能取到。
   */
  router.get('/api/works/:id/analysis', async (req, res, params, url) => {
    await currentUser(req);
    const { rows } = await query(
      `SELECT wa.*, w.title, w.channel, w.side
         FROM work_analyses wa JOIN works w ON w.id = wa.work_id
        WHERE wa.work_id = $1 AND w.deleted_at IS NULL`, [Number(params.id)]);
    if (!rows[0]) throw notFound('这条作品还没有技术1 的分析结果');
    const r = rows[0];
    if (q(url, 'raw')) return sendJson(res, 200, r.payload);
    sendJson(res, 200, {
      workId: Number(r.work_id), workTitle: r.title,
      channel: r.channel, side: r.side,
      taskId: r.task_id, schemaVer: r.schema_ver,
      receivedAt: r.received_at,
      // 封面走本地那张（平台地址带时间签名，几天后就 404）
      coverLocal: !!r.cover_file,
      ...withLocalImages(analysisView(r.payload), r.digest),
    });
  });

  /**
   * GET /api/works/:id/image/:i —— 图文笔记里的第 i 张图（本地镜像）。
   *
   * 和封面同一个目录、同一套判定，单独开一个路由只是因为要按序号取。
   * 序号从 digest.imageFiles 里查，而不是拿 :i 去拼文件名 ——
   * 路径参数直接参与拼文件名的话，就得自己防目录穿越，没必要冒那个险。
   */
  router.get('/api/works/:id/image/:i', async (req, res, params) => {
    await currentUser(req);
    const { rows } = await query(
      `SELECT wa.digest FROM work_analyses wa JOIN works w ON w.id = wa.work_id
        WHERE wa.work_id = $1 AND w.deleted_at IS NULL`, [Number(params.id)]);
    const files = rows[0]?.digest?.imageFiles;
    if (!Array.isArray(files)) throw notFound('这条作品没有本地图片');
    const hit = files.find(f => Number(f?.i) === Number(params.i));
    if (!hit?.file) throw notFound('这张图没有本地镜像');
    return sendLocalImage(res, hit.file);
  });

  /**
   * GET /api/works/:id/cover —— 对标作品的封面图（收到推送时下到本地的那张）。
   *
   * 不直接用平台给的地址：那个 URL 带时间签名，几天后就 404，
   * 而且页面走 HTTPS、它是 http:// 的，浏览器还会当混合内容拦掉。
   */
  router.get('/api/works/:id/cover', async (req, res, params) => {
    await currentUser(req);
    const { rows } = await query(
      `SELECT wa.cover_file FROM work_analyses wa JOIN works w ON w.id = wa.work_id
        WHERE wa.work_id = $1 AND w.deleted_at IS NULL`, [Number(params.id)]);
    const name = rows[0]?.cover_file;
    if (!name) throw notFound('这条对标作品没有本地封面');
    return sendLocalImage(res, name);
  });

  router.post('/api/works', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const sc = sourceOf(b);
    const { rows } = await query(
      `INSERT INTO works(channel, side, account_id, title, url, pillar, published_at, metrics, note, created_by,
                         source_type, source_url, source_ref)
       VALUES($1::work_channel,$2::work_side,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) RETURNING *`,
      [oneOf(b.channel, CHANNELS, 'channel'), oneOf(b.side, SIDES, 'side'),
       b.accountId ? Number(b.accountId) : null,
       need(b, 'title', { max: 120, label: '标题' }), str(b.url), str(b.pillar),
       str(b.publishedAt), JSON.stringify(b.metrics || {}), str(b.note), me.id,
       sc.source_type, sc.source_url, sc.source_ref]);
    await setTags('work', Number(rows[0].id), b.tagIds);
    sendJson(res, 201, workRow(rows[0], (await loadTags('work', [rows[0].id])).get(Number(rows[0].id)) || []));
    publish('board:updated', { board: b.channel });
  });

  router.patch('/api/works/:id', async (req, res, params) => {
    await currentUser(req);
    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (b.accountId !== undefined) set('account_id', b.accountId ? Number(b.accountId) : null);
    if (b.title !== undefined) set('title', need(b, 'title', { max: 120, label: '标题' }));
    if (b.url !== undefined) set('url', str(b.url));
    if (b.pillar !== undefined) set('pillar', str(b.pillar));
    if (b.publishedAt !== undefined) set('published_at', str(b.publishedAt));
    if (b.note !== undefined) set('note', str(b.note));
    if (b.metrics !== undefined) { args.push(JSON.stringify(b.metrics || {})); sets.push(`metrics = $${args.length}::jsonb`); }
    for (const [col, val] of Object.entries(sourceOf(b, { partial: true }))) set(col, val);

    const wid = Number(params.id);
    if (!sets.length && b.tagIds === undefined) throw badRequest('没有要修改的字段');

    let row;
    if (sets.length) {
      args.push(wid);
      const { rows } = await query(
        `UPDATE works SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${args.length} AND deleted_at IS NULL RETURNING *`, args);
      if (!rows[0]) throw notFound('没有这条记录');
      row = rows[0];
    } else {
      const { rows } = await query(
        'SELECT * FROM works WHERE id = $1 AND deleted_at IS NULL', [wid]);
      if (!rows[0]) throw notFound('没有这条记录');
      row = rows[0];
    }
    await setTags('work', wid, b.tagIds);
    sendJson(res, 200, workRow(row, (await loadTags('work', [wid])).get(wid) || []));
    publish('board:updated', { board: row.channel });
  });

  router.del('/api/works/:id', async (req, res, params) => {
    await assertCanDelete(req);
    const wid = Number(params.id);
    const { rows } = await query(
      `UPDATE works SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING channel`, [wid]);
    if (!rows[0]) throw notFound('没有这条记录');
    await clearTags('work', wid);
    // 分析结果本身留着（软删，误删要能捞回来），但本地封面图删掉 ——
    // 那是几十 KB 的二进制副本，恢复一条记录时重推一次就有了。
    const { rows: cov } = await query(
      'SELECT cover_file FROM work_analyses WHERE work_id = $1', [wid]);
    if (cov[0]?.cover_file) {
      await dropCover(cov[0].cover_file);
      await query('UPDATE work_analyses SET cover_file = NULL WHERE work_id = $1', [wid]);
    }
    await query(`DELETE FROM links WHERE (from_entity='work' AND from_id=$1)
                                      OR (to_entity='work' AND to_id=$1)`, [wid]);
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: rows[0].channel });
  });

  /* ==================== 销售转化 / 后端交付 ==================== */

  router.get('/api/playbook', async (req, res, _p, url) => {
    await currentUser(req);
    const where = ['deleted_at IS NULL'], args = [];
    const board = q(url, 'board');
    if (board) { args.push(oneOf(board, BOARDS, 'board')); where.push(`board = $${args.length}`); }
    const section = q(url, 'section');
    if (section) { args.push(section); where.push(`section = $${args.length}`); }

    const { rows } = await query(
      `SELECT * FROM playbook_items
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY sort, id`, args);
    sendJson(res, 200, { items: rows.map(playbookRow) });
  });

  router.post('/api/playbook', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const { rows } = await query(
      `INSERT INTO playbook_items(board, section, label, title, body, meta, sort, created_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [oneOf(b.board, BOARDS, 'board'), String(b.section || '').trim() || 'script',
       str(b.label), need(b, 'title', { max: 120, label: '标题' }), str(b.body),
       JSON.stringify(b.meta || {}), num(b.sort), me.id]);
    sendJson(res, 201, playbookRow(rows[0]));
    publish('board:updated', { board: b.board });
  });

  router.patch('/api/playbook/:id', async (req, res, params) => {
    await currentUser(req);
    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (b.label !== undefined) set('label', str(b.label));
    if (b.title !== undefined) set('title', need(b, 'title', { max: 120, label: '标题' }));
    if (b.body !== undefined) set('body', str(b.body));
    if (b.sort !== undefined) set('sort', num(b.sort));
    if (b.meta !== undefined) { args.push(JSON.stringify(b.meta || {})); sets.push(`meta = $${args.length}::jsonb`); }
    if (!sets.length) throw badRequest('没有要修改的字段');

    args.push(Number(params.id));
    const { rows } = await query(
      `UPDATE playbook_items SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${args.length} AND deleted_at IS NULL RETURNING *`, args);
    if (!rows[0]) throw notFound('没有这条记录');
    sendJson(res, 200, playbookRow(rows[0]));
    publish('board:updated', { board: rows[0].board });
  });

  router.del('/api/playbook/:id', async (req, res, params) => {
    await assertCanDelete(req);
    const { rows } = await query(
      `UPDATE playbook_items SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING board`, [Number(params.id)]);
    if (!rows[0]) throw notFound('没有这条记录');
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: rows[0].board });
  });
}
