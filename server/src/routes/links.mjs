/**
 * 资料关联（任务 8）。
 *
 * 第一版不做关系图，就是「这条资料和那条资料有关」。
 * 一条关联只存一行，查的时候两头都查 —— 存两行的话删除时要记得删两条，
 * 早晚漏一条，变成 A 能看到 B、B 看不到 A 的幽灵关联。
 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, q, badRequest, notFound } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { ENTITIES, assertEntity, str } from '../lib/entity.mjs';
import { publish } from '../lib/bus.mjs';

/**
 * 批量取一组 (entity, id) 的标题。
 * 按实体分组后每类查一次，而不是每条查一次 —— 一条需求挂 8 条关联时
 * 前者是 3 次查询，后者是 8 次。
 */
async function titlesOf(pairs) {
  const byEntity = new Map();
  for (const [e, id] of pairs) {
    if (!ENTITIES[e]) continue;
    if (!byEntity.has(e)) byEntity.set(e, []);
    byEntity.get(e).push(Number(id));
  }
  const out = new Map();
  for (const [e, ids] of byEntity) {
    const def = ENTITIES[e];
    const board = def.boardCol || `'${def.board}'`;
    const { rows } = await query(
      `SELECT id, ${def.title} AS title, ${board} AS board
         FROM ${def.table} WHERE id = ANY($1::bigint[])
         ${def.alive ? 'AND ' + def.alive : ''}`, [ids]);
    for (const r of rows) {
      out.set(`${e}:${r.id}`, { title: r.title, board: r.board });
    }
  }
  return out;
}

export function mount(router) {

  /** 某条资料的全部关联。entity + id 两个参数，两个方向一起返回 */
  router.get('/api/links', async (req, res, _p, url) => {
    await currentUser(req);
    const entity = q(url, 'entity');
    assertEntity(entity);
    const id = Number(q(url, 'id'));
    if (!Number.isFinite(id)) throw badRequest('id 不合法');

    const { rows } = await query(
      `SELECT l.*, u.name AS created_by_name FROM links l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE (l.from_entity = $1 AND l.from_id = $2)
          OR (l.to_entity   = $1 AND l.to_id   = $2)
       ORDER BY l.created_at DESC`, [entity, id]);

    // 统一成「对面那一条是谁」的视角 —— 前端不关心这条关联当初是从哪头建的
    const others = rows.map(r => (r.from_entity === entity && Number(r.from_id) === id)
      ? [r.to_entity, Number(r.to_id)] : [r.from_entity, Number(r.from_id)]);
    const titles = await titlesOf(others);

    const items = rows.map((r, i) => {
      const [e, oid] = others[i];
      const hit = titles.get(`${e}:${oid}`);
      return {
        id: Number(r.id), entity: e, entityLabel: ENTITIES[e]?.label || e,
        refId: oid, title: hit?.title || '(已删除)', board: hit?.board || ENTITIES[e]?.board,
        missing: !hit, note: r.note,
        createdByName: r.created_by_name, createdAt: r.created_at,
      };
    });
    sendJson(res, 200, { items });
  });

  router.post('/api/links', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    assertEntity(b.fromEntity, '来源资料类型');
    assertEntity(b.toEntity, '目标资料类型');
    const fromId = Number(b.fromId), toId = Number(b.toId);
    if (!Number.isFinite(fromId) || !Number.isFinite(toId)) throw badRequest('id 不合法');
    if (b.fromEntity === b.toEntity && fromId === toId) throw badRequest('不能关联到自己');

    // 反向已经存在时不再插一条：对用户来说「这两条有关」已经成立了
    const { rows: dup } = await query(
      `SELECT id FROM links WHERE (from_entity=$1 AND from_id=$2 AND to_entity=$3 AND to_id=$4)
                               OR (from_entity=$3 AND from_id=$4 AND to_entity=$1 AND to_id=$2)`,
      [b.fromEntity, fromId, b.toEntity, toId]);
    if (dup[0]) return sendJson(res, 200, { id: Number(dup[0].id), existed: true });

    const { rows } = await query(
      `INSERT INTO links(from_entity, from_id, to_entity, to_id, note, created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.fromEntity, fromId, b.toEntity, toId, str(b.note), me.id]);
    sendJson(res, 201, { id: Number(rows[0].id) });
    publish('links:updated', { entity: b.fromEntity, id: fromId });
  });

  router.del('/api/links/:id', async (req, res, params) => {
    await currentUser(req);
    const { rows } = await query('DELETE FROM links WHERE id = $1 RETURNING id', [Number(params.id)]);
    if (!rows[0]) throw notFound('这条关联已经不在了');
    sendJson(res, 200, { ok: true });
    publish('links:updated', {});
  });
}
