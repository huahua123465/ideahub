/** 讨论 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, need, notFound, badRequest } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { commentRow } from '../lib/dto.mjs';
import { publish } from '../lib/bus.mjs';

export function mount(router) {
  router.post('/api/ideas/:id/comments', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const body = await readJson(req);
    const text = need(body, 'body', { min: 1, max: 2000, label: '评论内容' });

    const { rows: exists } = await query('SELECT 1 AS ok FROM ideas WHERE id = $1', [id]);
    if (!exists[0]) throw notFound();

    let parentId = null;
    if (body.parentId) {
      const { rows: p } = await query(
        'SELECT id FROM idea_comments WHERE id = $1 AND idea_id = $2', [Number(body.parentId), id]);
      if (!p[0]) throw badRequest('要回复的评论不存在');
      parentId = Number(p[0].id);
    }

    // 匿名与否是每条评论各自的选择，和灵感本身匿不匿名无关 ——
    // 匿名提了灵感的人，回自己帖子下讨论时往往是愿意署名的。
    const { rows } = await query(`
      INSERT INTO idea_comments(idea_id, user_id, parent_id, body, is_anonymous)
      VALUES($1,$2,$3,$4,$5) RETURNING id, user_id, body, is_anonymous, created_at`,
      [id, me.id, parentId, text, !!body.isAnonymous]);

    const { rows: cnt } = await query('SELECT comment_count FROM ideas WHERE id = $1', [id]);
    const commentCount = Number(cnt[0].comment_count);
    sendJson(res, 201, {
      ...commentRow({ ...rows[0], user_name: me.name }),
      commentCount,
    });

    // 只发信号，评论正文由订阅方自己去 GET /api/ideas/:id/comments 拉
    publish('comment:created', { ideaId: id, commentCount });
  });

  router.get('/api/ideas/:id/comments', async (req, res, params) => {
    const { rows } = await query(`
      SELECT c.*, u.name AS user_name FROM idea_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.idea_id = $1 ORDER BY c.created_at`, [Number(params.id)]);
    sendJson(res, 200, { items: rows.map(commentRow) });
  });
}
