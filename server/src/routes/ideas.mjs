/** 灵感的读写：列表、详情、提交、编辑、查重 */
import { query } from '../db/index.mjs';
import { ideaRow, commentRow, activityRow, ideaSelect, IDEA_SELECT, POOL_STATUS } from '../lib/dto.mjs';
import { readJson, sendJson, q, qInt, need, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { sourceOf } from '../lib/entity.mjs';
import { setTags, clearTags, tagWhere, loadTags } from '../lib/tags.mjs';
import { purgeRecord } from '../lib/purge.mjs';

const CATEGORIES = ['产品', '技术', '运营', '流程', '其他'];

export function mount(router) {

  /* ---------- 列表 ----------
     status: pool（默认，= pending + reviewing）| pending | reviewing | adopted | rejected | all
     sort:   hot（默认）| new | votes
     另有 category / mine / q / page / pageSize */
  router.get('/api/ideas', async (req, res, _p, url) => {
    const me = await currentUser(req);

    // whereArgs 只装 WHERE 用到的参数。分页和「当前用户」另外追加 ——
    // count 查询不含它们，多传会被 pg 拒掉。
    // 软删的记录一律不出现在任何列表里（任务 14）
    const where = ['i.deleted_at IS NULL'];
    const whereArgs = [];
    const arg = v => { whereArgs.push(v); return '$' + whereArgs.length; };

    const status = q(url, 'status', 'pool');
    if (status === 'pool') where.push(`i.status = ANY(${arg(POOL_STATUS)}::idea_status[])`);
    // 「已转正式」是灵感池的一个视角，不是一个新状态：同一行 status 已经是 adopted，
    // promoted_at 记着它是从灵感转过去的。有这个筛选，业务人员在灵感池里
    // 仍然找得到自己提的那条，而不是「转完就消失了」（任务 7）
    else if (status === 'promoted') where.push(`i.status = 'adopted' AND i.promoted_at IS NOT NULL`);
    else if (status !== 'all') where.push(`i.status = ${arg(status)}::idea_status`);

    const category = q(url, 'category');
    if (category) where.push(`i.category = ${arg(category)}`);

    if (q(url, 'mine') === '1') where.push(`i.author_id = ${arg(me.id)}`);

    const kw = q(url, 'q');
    if (kw) where.push(`(i.title ILIKE ${arg('%' + kw + '%')} OR i.content ILIKE $${whereArgs.length})`);

    const tag = q(url, 'tag');
    if (tag) where.push(`${arg(tag)} = ANY(i.tags)`);

    // 统一标签（任务 3 / 6）：走 entity_tags，和其他模块用的是同一套字典
    const tagClause = tagWhere('idea', (q(url, 'tagIds') || '').split(',').filter(Boolean),
                               whereArgs, 'i.id');
    if (tagClause) where.push(tagClause);

    const sourceType = q(url, 'sourceType');
    if (sourceType) where.push(`i.source_type = ${arg(sourceType)}`);

    const sort = { hot: 'i.hot_score DESC, i.created_at DESC',
                   new: 'i.created_at DESC',
                   votes: 'i.vote_count DESC, i.created_at DESC',
                   adopted: 'i.adopted_at DESC NULLS LAST' }[q(url, 'sort', 'hot')]
              || 'i.hot_score DESC';

    const pageSize = Math.min(Math.max(qInt(url, 'pageSize', 30), 1), 100);
    const page = Math.max(qInt(url, 'page', 1), 1);

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // 先数总数，只用 WHERE 的参数
    const { rows: cnt } = await query(
      `SELECT count(*)::int AS n FROM ideas i ${clause}`, whereArgs);

    // 再取当页数据，在 WHERE 参数之后追加 用户 id / limit / offset
    const listArgs = [...whereArgs, me.id, pageSize, (page - 1) * pageSize];
    const pUser = whereArgs.length + 1;
    const { rows } = await query(
      `${ideaSelect(pUser)} ${clause} ORDER BY ${sort} LIMIT $${pUser + 1} OFFSET $${pUser + 2}`,
      listArgs);

    const tagMap = await loadTags('idea', rows.map(r => r.id));
    sendJson(res, 200, {
      items: rows.map(r => ({ ...ideaRow(r), tagList: tagMap.get(Number(r.id)) || [] })),
      total: cnt[0]?.n ?? rows.length,
      page, pageSize,
    });
  });

  /* ---------- 查重 ----------
     标题打字时实时调用。提示但不阻断 —— 阻断会直接劝退提交欲望。 */
  router.get('/api/ideas/similar', async (req, res, _p, url) => {
    const kw = q(url, 'q', '').trim();
    if (kw.length < 4) return sendJson(res, 200, { items: [] });
    const { rows } = await query(`
      SELECT id, title, status::text AS status, title_similarity(title, $1) AS score
      FROM ideas
      WHERE status <> 'draft' AND deleted_at IS NULL AND title_similarity(title, $1) > 0.2
      ORDER BY score DESC LIMIT 3`, [kw]);
    sendJson(res, 200, {
      items: rows.map(r => ({
        id: Number(r.id), title: r.title, status: r.status,
        score: Math.round(Number(r.score) * 100),
      })),
    });
  });

  /* ---------- 详情 ---------- */
  router.get('/api/ideas/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest('灵感 id 不合法');

    const { rows } = await query(
      `${IDEA_SELECT} WHERE i.id = $2 AND i.deleted_at IS NULL`, [me.id, id]);
    if (!rows[0]) throw notFound('这条灵感不存在，可能已被删除');
    if (rows[0].status === 'draft' && Number(rows[0].author_id) !== me.id) {
      throw forbidden('草稿只有作者本人能看');
    }

    // 浏览数是弱一致的，不必进事务
    query('UPDATE ideas SET view_count = view_count + 1 WHERE id = $1', [id]).catch(() => {});

    const { rows: cs } = await query(`
      SELECT c.*, u.name AS user_name FROM idea_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.idea_id = $1 ORDER BY c.created_at`, [id]);

    const { rows: as } = await query(`
      SELECT a.*, coalesce(u.name,'系统') AS actor_name FROM idea_activities a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.idea_id = $1 ORDER BY a.created_at`, [id]);

    // 匿名灵感：作者本人在流转记录里的所有动作都要遮成「匿名」
    const anonymousActorId = rows[0].is_anonymous ? rows[0].author_id : null;

    sendJson(res, 200, {
      ...ideaRow(rows[0]),
      tagList: (await loadTags('idea', [id])).get(id) || [],
      comments: cs.map(commentRow),
      activities: as.map(a => activityRow(a, { anonymousActorId })),
    });
  });

  /* ---------- 提交 ---------- */
  router.post('/api/ideas', async (req, res) => {
    const me = await currentUser(req);
    const body = await readJson(req);

    const title = need(body, 'title', { min: 1, max: 80, label: '标题' });
    const content = need(body, 'content', { min: 1, max: 5000, label: '详细说明' });
    const category = body.category || '其他';
    if (!CATEGORIES.includes(category)) throw badRequest('分类必须是：' + CATEGORIES.join(' / '));

    const tags = Array.isArray(body.tags)
      ? body.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6)
      : [];

    const src = sourceOf(body);
    const { rows } = await query(`
      INSERT INTO ideas(title, content, category, tags, author_id, is_anonymous, status,
                        source_type, source_url, source_ref)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9) RETURNING id`,
      [title, content, category, tags, me.id, !!body.isAnonymous,
       src.source_type, src.source_url, src.source_ref]);
    const id = Number(rows[0].id);

    // 统一标签写进 entity_tags，再把标签名镜像回 ideas.tags —— 
    // 后者是灵感卡片和 GIN 索引一直在用的列，两边同步才不会出现
    // 「详情里有标签、卡片上没有」。entity_tags 是唯一的事实来源。
    await setTags('idea', id, body.tagIds);
    await syncTagNames(id);

    await query(`INSERT INTO idea_activities(idea_id, actor_id, action, to_status)
                 VALUES($1,$2,'created','pending')`, [id, me.id]);

    // 通知是尽力而为的，不该让它拖慢提交
    notify(`${body.isAnonymous ? '有人' : me.name} 提了个新灵感：${title}`).catch(() => {});

    const { rows: full } = await query(`${IDEA_SELECT} WHERE i.id = $2`, [me.id, id]);
    // tagList 是对象数组（带 id 和 kind），ideaRow 里的 tags 只是标签名的字符串数组。
    // 列表、详情、修改都返回 tagList，新建这里以前漏了 —— 少一处就够让对接方困惑半天
    sendJson(res, 201, { ...ideaRow(full[0]), tagList: (await loadTags('idea', [id])).get(id) || [] });

    // 事件里不带标题和作者：有匿名灵感，脱敏只在 dto.mjs 里做一遍。
    // 订阅方拿到 id 后走 /api/ideas 重新拉，看到的自然是脱敏后的版本。
    publish('idea:created', { id, status: 'pending' });
  });

  /* ---------- 编辑 ----------
     两类字段、两套规则，别混在一起判断：

     · 内容（标题/正文/分类/标签）：作者本人，且只能在进入评审之前改。
     · 立项（进度/方案文档）：负责人本人。谁负责谁更新 ——
       原来这里压根没检查 owner_id，结果实际推进项目的人是唯一改不了
       自己项目进度的人，而界面上又没有任何入口，进度就永远停在采纳那天的值。

     管理员两类都能改。 */
  router.patch('/api/ideas/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const body = await readJson(req);

    const { rows: cur } = await query(
      'SELECT author_id, owner_id, status FROM ideas WHERE id = $1', [id]);
    if (!cur[0]) throw notFound();

    const isAdmin  = me.role === 'admin';
    const isAuthor = Number(cur[0].author_id) === me.id;
    const isOwner  = cur[0].owner_id != null && Number(cur[0].owner_id) === me.id;

    // 负责人也算立项字段：谁负责这件事，和进度、方案文档是同一类信息
    const touchesProject = body.progress !== undefined || body.docUrl !== undefined
                        || body.ownerId !== undefined;
    const touchesContent = body.title !== undefined || body.content !== undefined
                        || body.category !== undefined || body.tags !== undefined
                        || body.tagIds !== undefined || body.sourceType !== undefined
                        || body.sourceUrl !== undefined;

    // 作者也算：这条灵感是他提的，管自己灵感的立项信息天经地义。
    // 更实际的原因是不加会死锁 —— 负责人一旦被指派错（比如采纳时下拉框默认停在
    // 名单第一个人身上），真正该管这件事的人既改不了进度、也改不了负责人，
    // 只能去找管理员。需要修的人正好被锁在外面。
    if (touchesProject && !isOwner && !isAuthor && !isAdmin) {
      throw forbidden('只有作者、负责人和管理员能更新立项信息');
    }
    if (touchesContent) {
      if (!isAuthor && !isAdmin) throw forbidden('只有作者本人能编辑');
      if (!['draft', 'pending'].includes(cur[0].status) && !isAdmin) {
        throw forbidden('已进入评审的灵感不能再改，可以在讨论区补充说明');
      }
    }

    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    for (const [col, val] of Object.entries(sourceOf(body, { partial: true }))) set(col, val);
    if (body.title !== undefined) set('title', need(body, 'title', { min: 1, max: 80, label: '标题' }));
    if (body.content !== undefined) set('content', need(body, 'content', { min: 1, max: 5000, label: '详细说明' }));
    if (body.category !== undefined) {
      if (!CATEGORIES.includes(body.category)) throw badRequest('分类不合法');
      set('category', body.category);
    }
    if (Array.isArray(body.tags)) set('tags', body.tags.map(String).slice(0, 6));
    if (body.progress !== undefined) set('progress', Math.max(0, Math.min(100, Number(body.progress) | 0)));
    if (body.docUrl !== undefined) set('doc_url', body.docUrl || null);
    if (body.ownerId !== undefined) set('owner_id', body.ownerId ? Number(body.ownerId) : null);
    if (!sets.length && body.tagIds === undefined) throw badRequest('没有要修改的字段');

    if (sets.length) {
      args.push(id);
      await query(`UPDATE ideas SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
    }
    if (body.tagIds !== undefined) {
      await setTags('idea', id, body.tagIds);
      await syncTagNames(id);
    }

    // 进度是对外的事实声明，得记下是谁在什么时候改的，否则半年后没人说得清。
    // 借用 reason 这一列存百分比 —— activityRow 会把它拼成文案而不是当「理由」显示。
    if (body.progress !== undefined) {
      await query(`INSERT INTO idea_activities(idea_id, actor_id, action, reason)
                   VALUES($1,$2,'progress_changed',$3)`,
        [id, me.id, `${Math.max(0, Math.min(100, Number(body.progress) | 0))}%`]);
    }

    // 换负责人同理，而且比改进度更该留痕 —— 这是「这件事归谁」的变更
    if (body.ownerId !== undefined) {
      let ownerName = '未指派';
      if (body.ownerId) {
        const { rows: who } = await query('SELECT name FROM users WHERE id = $1', [Number(body.ownerId)]);
        ownerName = who[0]?.name || '未指派';
      }
      await query(`INSERT INTO idea_activities(idea_id, actor_id, action, reason)
                   VALUES($1,$2,'owner_changed',$3)`, [id, me.id, ownerName]);
    }

    const { rows: full } = await query(`${IDEA_SELECT} WHERE i.id = $2`, [me.id, id]);
    sendJson(res, 200, { ...ideaRow(full[0]), tagList: (await loadTags('idea', [id])).get(id) || [] });

    // project 这个标记是给前端用的：只有立项字段变了才值得刷新正式库表格，
    // 否则每投一票都去重拉一遍那张表纯属浪费
    publish('idea:updated', { id, project: touchesProject });
  });

  /* ---------- 删除（任务 14） ----------
     软删：业务人员自己就能删错填的记录，不用找技术改数据库；
     但记录留在库里，误删能捞回来，指向它的评论和关联也不会变成断头指针。
     作者本人和管理员可删 —— 别人提的灵感不该被随手删掉。 */
  router.del('/api/ideas/:id', async (req, res, params, url) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const { rows: cur } = await query(
      'SELECT author_id, status::text AS status FROM ideas WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!cur[0]) throw notFound('这条灵感不存在或已被删除');
    if (Number(cur[0].author_id) !== me.id && me.role !== 'admin') {
      throw forbidden('只有作者本人和管理员能删除');
    }

    // ?purge=1 —— 管理员永久删除。软删捞得回来，这个捞不回来，所以只开给管理员。
    if (q(url, 'purge')) {
      assertAdmin(me);
      const stat = await purgeRecord({ entity: 'idea', table: 'ideas', id: id, scope: null });
      if (!stat.ok) throw notFound('这条灵感不存在');
      sendJson(res, 200, { ok: true, purged: true, ...stat });
      publish('idea:bulk', {});
      return;
    }
    await query('UPDATE ideas SET deleted_at = now() WHERE id = $1', [id]);
    await clearTags('idea', id);
    await query(`DELETE FROM links WHERE (from_entity='idea' AND from_id=$1)
                                      OR (to_entity='idea' AND to_id=$1)`, [id]);
    sendJson(res, 200, { ok: true });
    publish('idea:bulk', {});
  });
}

/** 群机器人通知。还没配 webhook 时就只打日志，不报错。 */
export async function notify(text) {
  const url = process.env.BOT_WEBHOOK;
  if (!url) { console.log('[notify]', text); return; }
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  });
}

/**
 * 把 entity_tags 里的标签名同步回 ideas.tags。
 *
 * 两份数据听起来危险，但这里是有意的：entity_tags 是事实来源，
 * ideas.tags 是给卡片显示和 GIN 索引用的物化副本 —— 灵感卡片本来就在读它，
 * 全站几十处引用改成 JOIN 的代价远大于这一行同步。
 */
async function syncTagNames(id) {
  await query(`
    UPDATE ideas SET tags = coalesce(
      (SELECT array_agg(t.name ORDER BY t.kind, t.sort)
         FROM entity_tags et JOIN tags t ON t.id = et.tag_id
        WHERE et.entity = 'idea' AND et.entity_id = $1), '{}')
    WHERE id = $1`, [id]);
}
