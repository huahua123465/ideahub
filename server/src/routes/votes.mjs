/** 投票：点一次投，再点一次撤 */
import { query } from '../db/index.mjs';
import { sendJson, notFound } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';

export function mount(router) {
  router.post('/api/ideas/:id/vote', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);

    const { rows: exists } = await query('SELECT 1 AS ok FROM ideas WHERE id = $1', [id]);
    if (!exists[0]) throw notFound();

    // ON CONFLICT DO NOTHING + RETURNING：真的插进去了才有返回行。
    // 用数据库的唯一约束判重，而不是先查后写 —— 并发双击时后者必漏。
    const { rows: ins } = await query(`
      INSERT INTO idea_votes(idea_id, user_id) VALUES($1,$2)
      ON CONFLICT DO NOTHING RETURNING idea_id`, [id, me.id]);

    let voted;
    if (ins.length) {
      voted = true;                       // 本次是新投的一票
    } else {
      await query('DELETE FROM idea_votes WHERE idea_id = $1 AND user_id = $2', [id, me.id]);
      voted = false;                      // 已投过 → 视为撤票
    }

    // 热度一并取回来。它由 trg_hot_score 触发器在票数变化时同步算好，
    // 是权威值 —— 前端要拿它去动热度条，不能自己在客户端复刻一遍公式，
    // 那等于把「热度怎么算」变成两份会各自漂移的真相。
    const { rows } = await query('SELECT vote_count, hot_score FROM ideas WHERE id = $1', [id]);
    const voteCount = Number(rows[0].vote_count);
    const hotScore = Number(rows[0].hot_score) || 0;
    sendJson(res, 200, { voted, voteCount, hotScore });

    // 广播的是公共票数和热度，不含 voted —— 那是「我投没投」，每个人各不相同
    publish('idea:updated', { id, voteCount, hotScore });
  });
}
