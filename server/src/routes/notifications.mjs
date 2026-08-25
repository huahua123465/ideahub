/**
 * 站内消息。
 *
 * 推送复用已有的 SSE 通道，但**只发一个不带内容的 ping**，
 * 各客户端收到后自己去拉属于自己的那份。
 * 广播里带上收件人 id 也算一种泄露（能看出谁在被通知），而省下的那次请求
 * 在五个人的团队里根本不值一提。
 */
import { query } from '../db/index.mjs';
import { readJson, sendJson, q, notFound } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';

function row(r) {
  return {
    id: Number(r.id), kind: r.kind, title: r.title, body: r.body,
    board: r.board, refId: r.ref_id ? Number(r.ref_id) : null,
    actorName: r.actor_name || null,
    read: !!r.read_at,
    createdAt: r.created_at,
  };
}

/**
 * 给某人发一条消息。给自己发的直接跳过 ——
 * 审核人给自己的提交写反馈时不该收到「你收到了自己的反馈」。
 */
export async function notifyUser(userId, { actorId, kind, title, body, board, refId }) {
  if (!userId || Number(userId) === Number(actorId)) return;
  await query(
    `INSERT INTO notifications(user_id, actor_id, kind, title, body, board, ref_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [Number(userId), actorId || null, kind, title, body || null, board || null, refId || null]);
  publish('notify:ping', {});
}

export function mount(router) {

  router.get('/api/notifications', async (req, res, _p, url) => {
    const me = await currentUser(req);
    const limit = Math.min(Math.max(Number(q(url, 'limit', 30)) || 30, 1), 100);
    const { rows } = await query(`
      SELECT n.*, u.name AS actor_name
        FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT $2`, [me.id, limit]);
    const { rows: c } = await query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [me.id]);
    sendJson(res, 200, { items: rows.map(row), unread: c[0].n });
  });

  /** 标记已读。带 id 就标一条，不带就全标。 */
  router.post('/api/notifications/read', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    if (b.id) {
      const { rows } = await query(
        `UPDATE notifications SET read_at = now()
          WHERE id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id`, [Number(b.id), me.id]);
      // 没更新到不算错：可能本来就是已读，也可能是别人的消息 —— 两种都不该报错给对方看
      if (!rows[0]) {
        const { rows: exists } = await query(
          'SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2', [Number(b.id), me.id]);
        if (!exists[0]) throw notFound('没有这条消息');
      }
    } else {
      await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [me.id]);
    }
    const { rows: c } = await query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [me.id]);
    sendJson(res, 200, { unread: c[0].n });
  });
}
