/**
 * 统一标签的读写（任务 3）。
 *
 * 所有模块共用 tags 字典 + entity_tags 关系表，任何模块都不再自己维护一套下拉。
 * 这个文件只负责「怎么读、怎么写、怎么按标签筛」，标签本身的增删改在 routes/tags.mjs。
 */
import { query } from '../db/index.mjs';
import { badRequest } from './http.mjs';

export const TAG_KINDS = {
  relation_stage: '关系阶段',
  problem_type:   '问题类型',
  demand:         '用户需求',
  content_type:   '内容类型',
};

export const isTagKind = (k) => Object.prototype.hasOwnProperty.call(TAG_KINDS, k);

export const tagRow = (r) => ({
  id: Number(r.id), kind: r.kind, kindLabel: TAG_KINDS[r.kind] || r.kind,
  name: r.name, sort: Number(r.sort) || 0, active: r.active !== false,
});

/**
 * 批量取一组记录的标签。
 *
 * 一定要批量：列表页每行单独查一次标签，30 行就是 30 次往返，
 * 这正是「列表加了标签之后变慢」的经典来源。
 * 返回 Map<entityId, tag[]>。
 */
export async function loadTags(entity, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  const map = new Map(list.map(id => [id, []]));
  if (!list.length) return map;
  const { rows } = await query(
    `SELECT et.entity_id, t.id, t.kind, t.name, t.sort, t.active
       FROM entity_tags et JOIN tags t ON t.id = et.tag_id
      WHERE et.entity = $1 AND et.entity_id = ANY($2::bigint[])
      ORDER BY t.kind, t.sort, t.id`, [entity, list]);
  for (const r of rows) map.get(Number(r.entity_id))?.push(tagRow(r));
  return map;
}

/** 单条的标签 */
export async function tagsOf(entity, id) {
  return (await loadTags(entity, [id])).get(Number(id)) || [];
}

/**
 * 覆盖式设置标签。传 null / undefined 表示「这次不动标签」，传 [] 表示「清空」——
 * 两者必须区分开，否则任何一次只改标题的保存都会顺手把标签清光。
 */
export async function setTags(entity, id, tagIds) {
  if (tagIds == null) return;
  if (!Array.isArray(tagIds)) throw badRequest('tagIds 必须是数组');
  const ids = [...new Set(tagIds.map(Number).filter(Number.isFinite))];
  await query('DELETE FROM entity_tags WHERE entity = $1 AND entity_id = $2', [entity, id]);
  if (!ids.length) return;
  // 一次插完。逐条 INSERT 在有 6 个标签时就是 6 次往返
  await query(
    `INSERT INTO entity_tags(entity, entity_id, tag_id)
     SELECT $1, $2, t.id FROM tags t WHERE t.id = ANY($3::bigint[])
     ON CONFLICT DO NOTHING`, [entity, id, ids]);
}

/** 删记录时把它的标签一起清掉（entity_tags 没有外键指向业务表，不会自动级联） */
export async function clearTags(entity, id) {
  await query('DELETE FROM entity_tags WHERE entity = $1 AND entity_id = $2', [entity, id]);
}

/**
 * 生成「带这些标签」的 WHERE 片段。
 *
 * 语义：**同一类之内是「或」，跨类之间是「且」**。
 *
 * 任务表的验收标准写的是「能筛出『分手 + 想判断对方态度』的需求、案例或内容」——
 * 那个加号是「且」。一开始做成了全「或」，结果只打了「分手」的记录也会被筛出来，
 * 筛选等于没筛。
 * 但同一类之内必须是「或」：在「关系阶段」里同时勾上「冷战中」和「已分手」，
 * 想看的是这两种阶段的记录，而不是同时处于两个阶段的记录（那不存在）。
 *
 * 实现方式是「命中的标签覆盖了几类」和「筛选条件涉及几类」相等：
 * 每一类都至少命中一个，就是跨类取且；一类里命中哪一个都算，就是类内取或。
 * 这样不用在应用层先查一次标签的 kind 再拼 SQL。
 */
export function tagWhere(entity, tagIds, args, alias = 'id') {
  const ids = [...new Set((tagIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return null;
  args.push(entity); const pe = '$' + args.length;
  args.push(ids);    const pt = '$' + args.length;
  return `(SELECT count(DISTINCT t.kind) FROM entity_tags et
             JOIN tags t ON t.id = et.tag_id
            WHERE et.entity = ${pe} AND et.entity_id = ${alias}
              AND et.tag_id = ANY(${pt}::bigint[]))
          = (SELECT count(DISTINCT kind) FROM tags WHERE id = ANY(${pt}::bigint[]))`;
}
