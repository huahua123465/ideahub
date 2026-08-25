/**
 * 永久删除一条记录（管理员专用）。
 *
 * 平时的删除是**软删**：只打一个 deleted_at，记录从列表和搜索里消失但仍在库里，
 * 误删了能捞回来。这个文件干的是另一件事 —— 真的把它从库里抹掉。
 *
 * 为什么需要单独一套：软删只动一列，而永久删除要负责把这条记录**牵连的东西**
 * 一并收拾干净，否则库里会攒下一堆指向不存在记录的孤儿数据：
 *
 *   - `attachments` / `entity_tags` / `links` 都是**多态关联**（靠 scope+ref_id
 *     这种字段对应，没有外键），数据库不会替我们级联，必须手工删。
 *   - 附件还有**磁盘上的文件本体**。只删库里那行，文件会永远留在 data/uploads
 *     里没人认领 —— 那才是真正会越攒越多的东西。
 *   - 有外键的子表（work_analyses、idea_votes、client_deliveries…）已经写了
 *     ON DELETE CASCADE，交给数据库即可，这里不重复处理。
 *
 * 顺序是有讲究的：**先删文件、再删库里的行**。反过来的话，一旦删行之后进程挂了，
 * 就再也查不到该删哪些文件了。文件删失败不影响继续 —— 多留一个孤儿文件，
 * 比留一条指向空文件的记录要好查得多。
 */
import { join, basename } from 'node:path';
import { unlink } from 'node:fs/promises';
import { query } from '../db/index.mjs';
import { UPLOAD_DIR } from '../routes/files.mjs';

/**
 * @param entity  多态关联里用的实体名：'work' | 'idea' | 'client' | 'case' | 'demand' …
 * @param table   要删的表名（调用方写死，绝不来自请求参数）
 * @param id      记录 id
 * @param scope   attachments.scope 的取值，默认同 entity。没有附件的实体传 null
 * @returns 删掉了什么，给接口返回和日志用
 */
export async function purgeRecord({ entity, table, id, scope = entity }) {
  const stat = { attachments: 0, files: 0, tags: 0, links: 0 };

  if (scope) {
    const { rows: files } = await query(
      'SELECT id, stored_name FROM attachments WHERE scope = $1 AND ref_id = $2', [scope, id]);
    for (const f of files) {
      // 删不掉就算了（可能本来就不在），但库里那行一定要删干净
      await unlink(join(UPLOAD_DIR, basename(String(f.stored_name)))).catch(() => {});
      stat.files++;
    }
    const del = await query(
      'DELETE FROM attachments WHERE scope = $1 AND ref_id = $2', [scope, id]);
    stat.attachments = del.rowCount || 0;
  }

  const t = await query('DELETE FROM entity_tags WHERE entity = $1 AND entity_id = $2', [entity, id]);
  stat.tags = t.rowCount || 0;

  const l = await query(
    `DELETE FROM links
      WHERE (from_entity = $1 AND from_id = $2) OR (to_entity = $1 AND to_id = $2)`, [entity, id]);
  stat.links = l.rowCount || 0;

  // 表名不来自请求，是各路由写死传进来的 —— 这里不做拼接校验是因为
  // 校验一个常量没有意义，真正的约束在"调用方不许把用户输入传进来"这条规矩上。
  const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return { ok: rowCount > 0, ...stat };
}
