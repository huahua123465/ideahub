/**
 * 用户需求（任务 2）—— 第一版最需要补的一块。
 *
 * 字段严格照任务表原文，一个不多：
 *   需求名称、用户原话/证据、发生场景、用户真正想解决什么、来源、相关标签、备注
 * 标签走统一的 entity_tags，来源走统一的三件套 —— 这两样都不在这张表里自己造。
 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, q, need, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { sourceOf, sourceRow, str } from '../lib/entity.mjs';
import { loadTags, setTags, clearTags, tagWhere } from '../lib/tags.mjs';

function demandRow(r, tags = []) {
  return {
    id: Number(r.id),
    title: r.title, quote: r.quote, scene: r.scene, realGoal: r.real_goal, note: r.note,
    ...sourceRow(r),
    tags,
    tagIds: tags.map(t => t.id),
    createdBy: r.created_by ? Number(r.created_by) : null,
    createdByName: r.created_by_name || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 一条需求的完整读取（带标签），新增和修改后都要用它回传 */
async function fullRow(id) {
  const { rows } = await query(
    `SELECT d.*, u.name AS created_by_name FROM demands d
     LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [id]);
  if (!rows[0]) throw notFound('没有这条需求');
  const tags = (await loadTags('demand', [id])).get(Number(id)) || [];
  return demandRow(rows[0], tags);
}

export function mount(router) {

  /* ---------- 列表 ----------
     支持 q 关键词、tagIds 标签筛选、sourceType 来源筛选（任务 5 / 6 的需求侧） */
  router.get('/api/demands', async (req, res, _p, url) => {
    await currentUser(req);
    const where = ['d.deleted_at IS NULL'], args = [];

    const kw = q(url, 'q');
    if (kw) {
      args.push('%' + kw + '%');
      const p = '$' + args.length;
      where.push(`(d.title ILIKE ${p} OR d.quote ILIKE ${p} OR d.scene ILIKE ${p}
                   OR d.real_goal ILIKE ${p} OR d.note ILIKE ${p})`);
    }

    const sourceType = q(url, 'sourceType');
    if (sourceType) { args.push(sourceType); where.push(`d.source_type = $${args.length}`); }

    const tagIds = (q(url, 'tagIds') || '').split(',').filter(Boolean);
    const tagClause = tagWhere('demand', tagIds, args, 'd.id');
    if (tagClause) where.push(tagClause);

    const { rows } = await query(
      `SELECT d.*, u.name AS created_by_name
         FROM demands d LEFT JOIN users u ON u.id = d.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.updated_at DESC`, args);

    const tagMap = await loadTags('demand', rows.map(r => r.id));
    sendJson(res, 200, { items: rows.map(r => demandRow(r, tagMap.get(Number(r.id)) || [])) });
  });

  router.get('/api/demands/:id', async (req, res, params) => {
    await currentUser(req);
    sendJson(res, 200, await fullRow(Number(params.id)));
  });

  router.post('/api/demands', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const src = sourceOf(b);

    const { rows } = await query(
      `INSERT INTO demands(title, quote, scene, real_goal, note,
                           source_type, source_url, source_ref, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [need(b, 'title', { max: 80, label: '需求名称' }),
       str(b.quote), str(b.scene), str(b.realGoal), str(b.note),
       src.source_type, src.source_url, src.source_ref, me.id]);

    const id = Number(rows[0].id);
    await setTags('demand', id, b.tagIds);
    sendJson(res, 201, await fullRow(id));
    publish('board:updated', { board: 'demands' });
  });

  router.patch('/api/demands/:id', async (req, res, params) => {
    await currentUser(req);
    const id = Number(params.id);
    const b = await readJson(req);
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };

    if (b.title !== undefined) set('title', need(b, 'title', { max: 80, label: '需求名称' }));
    for (const [k, col] of [['quote', 'quote'], ['scene', 'scene'],
                            ['realGoal', 'real_goal'], ['note', 'note']]) {
      if (b[k] !== undefined) set(col, str(b[k]));
    }
    for (const [col, val] of Object.entries(sourceOf(b, { partial: true }))) set(col, val);

    // 只改标签、正文一个字没动，也是合法的一次保存
    if (sets.length) {
      args.push(id);
      const { rows } = await query(
        `UPDATE demands SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${args.length} AND deleted_at IS NULL RETURNING id`, args);
      if (!rows[0]) throw notFound('没有这条需求');
    } else if (b.tagIds === undefined) {
      throw badRequest('没有要修改的字段');
    }

    await setTags('demand', id, b.tagIds);
    sendJson(res, 200, await fullRow(id));
    publish('board:updated', { board: 'demands' });
  });

  /** 软删。业务人员自己就能删（任务 14 要求「不需要找技术改数据库」），
      但记录留在库里，误删能捞回来。 */
  router.del('/api/demands/:id', async (req, res, params) => {
    await currentUser(req);
    const id = Number(params.id);
    const { rows } = await query(
      'UPDATE demands SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
    if (!rows[0]) throw notFound('没有这条需求');
    await clearTags('demand', id);
    await query(`DELETE FROM links WHERE (from_entity='demand' AND from_id=$1)
                                      OR (to_entity='demand' AND to_id=$1)`, [id]);
    sendJson(res, 200, { ok: true });
    publish('board:updated', { board: 'demands' });
  });
}
