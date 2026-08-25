/**
 * 标签字典的维护（任务 3）。
 *
 * 读：所有人。写：管理员。
 * 任务表原文是「管理员可以新增标签；不要每个页面自己写一套」——
 * 前半句是这个文件，后半句是各模块统一从 /api/tags 拉下拉选项。
 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, q, need, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { TAG_KINDS, isTagKind, tagRow } from '../lib/tags.mjs';
import { publish } from '../lib/bus.mjs';

async function assertAdmin(req) {
  const me = await currentUser(req);
  if (me.role !== 'admin') throw forbidden('只有管理员能维护标签');
  return me;
}

export function mount(router) {

  /** 全部标签，按类分组返回 —— 前端一次拉完，各个下拉直接取，不用每个页面各请求一次 */
  router.get('/api/tags', async (req, res, _p, url) => {
    await currentUser(req);
    const kind = q(url, 'kind');
    if (kind && !isTagKind(kind)) throw badRequest('标签类型不合法');
    const withInactive = q(url, 'all') === '1';

    const where = [], args = [];
    if (kind) { args.push(kind); where.push(`kind = $${args.length}`); }
    if (!withInactive) where.push('active');

    const { rows } = await query(
      `SELECT * FROM tags ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY kind, sort, id`, args);

    const items = rows.map(tagRow);
    const byKind = {};
    for (const k of Object.keys(TAG_KINDS)) byKind[k] = [];
    for (const t of items) (byKind[t.kind] ||= []).push(t);

    // 每类下面挂了多少条资料，管理员删标签前能看到影响面
    const { rows: used } = await query(
      `SELECT tag_id, count(*)::int AS n FROM entity_tags GROUP BY tag_id`);
    const usage = Object.fromEntries(used.map(r => [Number(r.tag_id), r.n]));
    for (const t of items) t.usedBy = usage[t.id] || 0;

    sendJson(res, 200, { items, byKind, kinds: TAG_KINDS });
  });

  router.post('/api/tags', async (req, res) => {
    await assertAdmin(req);
    const b = await readJson(req);
    if (!isTagKind(b.kind)) throw badRequest('标签类型只能是：' + Object.keys(TAG_KINDS).join(' / '));
    const name = need(b, 'name', { max: 20, label: '标签名' });

    // 同类下重名直接把老的那条返回回去，不报错 ——
    // 管理员看到的结果（这个标签存在）和他想要的一致，弹个「已存在」的红框没有意义
    const { rows } = await query(
      `INSERT INTO tags(kind, name, sort) VALUES($1,$2,$3)
       ON CONFLICT (kind, name) DO UPDATE SET active = true
       RETURNING *`, [b.kind, name, Number(b.sort) || 0]);
    sendJson(res, 201, tagRow(rows[0]));
    publish('tags:updated', {});
  });

  router.patch('/api/tags/:id', async (req, res, params) => {
    await assertAdmin(req);
    const b = await readJson(req);
    const sets = [], args = [];
    if (b.name !== undefined) { args.push(need(b, 'name', { max: 20, label: '标签名' })); sets.push(`name = $${args.length}`); }
    if (b.sort !== undefined) { args.push(Number(b.sort) || 0); sets.push(`sort = $${args.length}`); }
    if (b.active !== undefined) { args.push(!!b.active); sets.push(`active = $${args.length}`); }
    if (!sets.length) throw badRequest('没有要修改的字段');

    args.push(Number(params.id));
    const { rows } = await query(
      `UPDATE tags SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
    if (!rows[0]) throw notFound('没有这个标签');
    sendJson(res, 200, tagRow(rows[0]));
    publish('tags:updated', {});
  });

  /**
   * 删除。已经被用过的标签不真删，只停用 ——
   * 真删会把已有资料上的标签一起 CASCADE 掉，
   * 那些资料的「关系阶段」会凭空消失，而且没人知道消失了什么。
   */
  router.del('/api/tags/:id', async (req, res, params) => {
    await assertAdmin(req);
    const id = Number(params.id);
    const { rows: used } = await query(
      'SELECT count(*)::int AS n FROM entity_tags WHERE tag_id = $1', [id]);
    if (used[0].n > 0) {
      const { rows } = await query(
        'UPDATE tags SET active = false WHERE id = $1 RETURNING *', [id]);
      if (!rows[0]) throw notFound('没有这个标签');
      sendJson(res, 200, { ok: true, disabled: true, usedBy: used[0].n,
        message: `这个标签已经用在 ${used[0].n} 条资料上，已停用（不再出现在下拉里），历史资料保持不变` });
    } else {
      const { rows } = await query('DELETE FROM tags WHERE id = $1 RETURNING id', [id]);
      if (!rows[0]) throw notFound('没有这个标签');
      sendJson(res, 200, { ok: true, disabled: false });
    }
    publish('tags:updated', {});
  });
}
