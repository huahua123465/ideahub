/**
 * 状态流转 —— 整个系统里唯一需要小心处理并发的地方。
 *
 * 流转图：
 *   draft ──提交──> pending ──认领──> reviewing ──采纳──> adopted
 *                     │                   │
 *                     └───否决(必填理由)──┴──> rejected ──重新提出──> pending
 *   pending/reviewing ──90天无人处理──> archived ──重新提出──> pending
 */
import { tx, query } from '../db/index.mjs';
import { readJson, sendJson, badRequest, notFound, conflict } from '../lib/http.mjs';
import { currentUser, assertReviewer } from '../lib/auth.mjs';
import { ideaRow, IDEA_SELECT } from '../lib/dto.mjs';
import { notify } from './ideas.mjs';
import { publish } from '../lib/bus.mjs';

/** 允许的流转。键是「从 → 到」
 *
 *  2026-08-20：按需求改成「人人可评审」—— 这是公司内部的自由发言渠道，
 *  提灵感、投票、评论、采纳、否决、归档，所有登录用户一视同仁。
 *  'reviewer' 这条门禁的机制保留着（下面 assertReviewer 那行没删），
 *  以后想收回权限，把对应几条改回 who: 'reviewer' 就行。
 *  仍然只有管理员能做的：撤销采纳、用户管理。
 */
const ALLOWED = {
  'draft→pending':      { who: 'author'   },
  'pending→reviewing':  { who: 'anyone'   },
  'pending→adopted':    { who: 'anyone'   },
  'reviewing→adopted':  { who: 'anyone'   },
  'pending→rejected':   { who: 'anyone',   needReason: true },
  'reviewing→rejected': { who: 'anyone',   needReason: true },
  'pending→archived':   { who: 'anyone'   },
  'reviewing→archived': { who: 'anyone'   },
  'reviewing→pending':  { who: 'anyone'   },   // 撤回认领
  'rejected→pending':   { who: 'anyone'   },   // 任何人都能重新提出
  'archived→pending':   { who: 'anyone'   },
  'adopted→reviewing':  { who: 'admin'    },   // 撤销采纳，编号保留
};

export function mount(router) {
  router.patch('/api/ideas/:id/status', async (req, res, params) => {
    const me = await currentUser(req);
    const id = Number(params.id);
    const body = await readJson(req);
    const to = String(body.status || '');
    const reason = (body.reason || '').trim();

    const result = await tx(async c => {
      // 行级锁：两个评审同时点「采纳」时，后到的那个会在这里等，
      // 拿到锁后看到的已经是 adopted，走下面的状态机校验被挡掉。
      const { rows: cur } = await c.query(
        'SELECT id, status::text AS status, title, code, author_id, is_anonymous FROM ideas WHERE id = $1 FOR UPDATE', [id]);
      if (!cur[0]) throw notFound();

      const from = cur[0].status;
      if (from === to) throw conflict(`这条灵感已经是「${to}」了`, { status: from });

      const rule = ALLOWED[`${from}→${to}`];
      if (!rule) throw badRequest(`不允许从「${from}」直接改成「${to}」`, { from, to });

      if (rule.who === 'reviewer') assertReviewer(me);
      if (rule.who === 'admin' && me.role !== 'admin') throw badRequest('只有管理员能撤销采纳');
      if (rule.who === 'author' && Number(cur[0].author_id) !== me.id) throw badRequest('只有作者能提交自己的草稿');

      // 否决必须给理由。石沉大海比被否决更伤人，理由是这条规则存在的全部意义。
      if (rule.needReason && reason.length < 2) throw badRequest('否决必须填写理由');

      const sets = ['status = $2::idea_status', 'updated_at = now()'];
      const args = [id, to];
      let newCode = cur[0].code;

      if (to === 'adopted') {
        if (!newCode) {
          const { rows: seq } = await c.query(
            `SELECT 'IDEA-' || to_char(now(),'YYYY') || '-' ||
                    lpad(nextval('idea_code_seq')::text, 4, '0') AS code`);
          newCode = seq[0].code;
          args.push(newCode); sets.push(`code = $${args.length}`);
        }
        sets.push('adopted_at = now()');
        // 转正式的时刻。灵感池那边靠它把这条卡片标成「已转正式」并留一个
        // 回正式库的入口（任务 7：不要转完就找不到来源）
        sets.push('promoted_at = coalesce(promoted_at, now())');
        args.push(me.id); sets.push(`adopted_by = $${args.length}`);
        // 负责人：没指定就先挂在作者名下，后面可以改。
        // 但匿名灵感不能这么挂 —— 负责人会显示在正式库表格里，
        // 等于把匿名作者的真名直接贴出去，卡片上遮了名字也白遮。
        // 留空显示「未指派」，等人认领。
        const fallbackOwner = cur[0].is_anonymous ? null : Number(cur[0].author_id);
        args.push(body.ownerId ? Number(body.ownerId) : fallbackOwner);
        sets.push(`owner_id = $${args.length}`);
      }

      await c.query(`UPDATE ideas SET ${sets.join(', ')} WHERE id = $1`, args);

      await c.query(`
        INSERT INTO idea_activities(idea_id, actor_id, action, from_status, to_status, reason)
        VALUES($1,$2,'status_changed',$3::idea_status,$4::idea_status,$5)`,
        [id, me.id, from, to, reason || null]);

      return { from, to, code: newCode, title: cur[0].title };
    });

    // 通知放在事务外：通知失败不该让状态流转回滚
    if (result.to === 'adopted') {
      notify(`「${result.title}」已被采纳，编号 ${result.code}`).catch(() => {});
    } else if (result.to === 'rejected') {
      notify(`「${result.title}」未被采纳，理由：${reason}`).catch(() => {});
    }

    const { rows } = await query(`${IDEA_SELECT} WHERE i.id = $2`, [me.id, id]);
    sendJson(res, 200, { ...ideaRow(rows[0]), transition: result });

    publish('idea:status', { id, from: result.from, to: result.to, code: result.code });
  });

  /** 手动触发一次归档（内置定时任务也会调同一个函数） */
  router.post('/api/maintenance/archive-stale', async (req, res) => {
    const r = await archiveStaleIdeas();
    sendJson(res, 200, r);
  });
}

/**
 * 把超期没人处理的灵感归档，给每条灵感一个明确的结局。
 *
 * 「提了没人理」比「被否决」更伤积极性，所以宁可给一个自动的结局，
 * 也不要让它无限期地躺在池子里。归档不是删除，任何人都能重新提出。
 */
export async function archiveStaleIdeas() {
  const days = Number(process.env.STALE_DAYS || 90);
  const { rows } = await query(`
    UPDATE ideas SET status='archived', updated_at=now()
    WHERE status='pending' AND created_at < now() - ($1 || ' days')::interval
    RETURNING id, title`, [days]);

  for (const r of rows) {
    await query(`INSERT INTO idea_activities(idea_id, action, from_status, to_status, reason)
                 VALUES($1,'status_changed','pending','archived',$2)`,
      [r.id, `超过 ${days} 天无人处理，自动归档`]);
  }
  if (rows.length) {
    // 之前这里是静默归档的 —— 悄悄把人的灵感收走，比不收更伤人
    notify(`有 ${rows.length} 条灵感超过 ${days} 天无人处理，已自动归档：` +
           rows.map(r => `「${r.title}」`).join('、')).catch(() => {});
    // 归档是定时任务干的，页面上没人操作过。不推的话挂着的页面会一直显示已经归档的卡片。
    publish('idea:bulk', { n: rows.length, reason: 'archived' });
  }
  return { archived: rows.length, items: rows.map(r => r.title), staleDays: days };
}
