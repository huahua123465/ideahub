/**
 * 聊天：一对一 + 群聊。
 *
 * 私聊只有双方能读，群聊只有群成员能读，管理员一律不例外 —— 聊天不是台账。
 * 附件那条路径上的检查同样重要（见 routes/files.mjs），
 * 少了它，拿着连续的文件 id 就能把别人的聊天文件翻个遍。
 *
 * 「撤回」和「删除」是两件不同的事，别合并：
 *   撤回 = 双方都看不到了，留一行「XX 撤回了一条消息」；
 *   删除 = 只有我自己不看了，对方那边一切照旧（记在 chat_deletes 里）。
 * 把删除做成硬删是常见的想当然 —— 那样一个人就能替所有人抹掉对话，
 * 而用户点「删除」时想的只是「从我这儿清掉」。
 * 编辑会留「已编辑」标记：改过的地方看不出来，聊天记录就没有可信度了。
 */
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { unlink } from 'node:fs/promises';

import { query } from '../db/index.mjs';
import { readJson, sendJson, q, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';
import { publish } from '../lib/bus.mjs';
import { kindOf, saveBody, UPLOAD_DIR } from './files.mjs';

const num = v => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const MAX_BODY = 4000;

/* ---------------- 共用 ---------------- */

/**
 * 「这条被我自己删掉了」的判断。
 * 当前用户 id 在各个查询里的占位符位置不一样，所以做成函数传进去 ——
 * 之前是写死 $2 再用字符串替换改成 $1，改错一个位置就是查错人的删除记录。
 */
const hidden = (p) => `EXISTS(SELECT 1 FROM chat_deletes d WHERE d.message_id = m.id AND d.user_id = ${p})`;

const MSG_SELECT = `
  SELECT m.*, u.name AS from_name,
         a.id AS file_id, a.orig_name AS file_name, a.size AS file_size, a.mime AS file_mime
    FROM chat_messages m
    JOIN users u ON u.id = m.from_id
    LEFT JOIN attachments a ON a.scope = 'chat' AND a.ref_id = m.id`;

function msgRow(r, extra = {}) {
  const recalled = !!r.recalled_at;
  return {
    id: Number(r.id),
    fromId: Number(r.from_id), fromName: r.from_name,
    toId: r.to_id ? Number(r.to_id) : null,
    groupId: r.group_id ? Number(r.group_id) : null,
    // 撤回后不再把原文发出去 —— 只在界面上藏起来等于没撤回
    body: recalled ? null : r.body,
    file: (!recalled && r.file_id) ? {
      id: Number(r.file_id), name: r.file_name,
      size: Number(r.file_size), mime: r.file_mime,
      url: `/api/files/${r.file_id}`,
    } : null,
    mentions: (r.mentions || []).map(Number),
    recalled,
    edited: !!r.edited_at,
    read: !!r.read_at,
    readBy: extra.readBy ?? null,     // 群里：有几个人看过
    createdAt: r.created_at,
  };
}

/** 我是不是这个群的成员 */
async function assertMember(groupId, me) {
  const { rows } = await query(
    'SELECT 1 FROM chat_group_members WHERE group_id = $1 AND user_id = $2', [groupId, me.id]);
  if (!rows[0]) throw forbidden('你不在这个群里');
}

/** 从正文里把 @某人 解析成用户 id。只认候选名单里的人，避免 @ 一个不相干的名字 */
function parseMentions(body, candidates) {
  if (!body) return [];
  const hit = new Set();
  for (const u of candidates) {
    // 名字可能含正则元字符，转义后再匹配
    const esc = String(u.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('@' + esc + '(?![\\w\\u4e00-\\u9fa5])').test(body)) hit.add(Number(u.id));
  }
  return [...hit];
}

export function mount(router) {

  /* ==================== 会话列表（人 + 群） ==================== */
  router.get('/api/chat/peers', async (req, res) => {
    const me = await currentUser(req);

    const { rows: people } = await query(`
      SELECT u.id, u.name, u.dept,
             (SELECT count(*) FROM chat_messages m
               WHERE m.from_id = u.id AND m.to_id = $1 AND m.read_at IS NULL)::int AS unread,
             last.body, last.created_at AS last_at, last.from_id AS last_from,
             last.recalled_at, lastf.orig_name AS last_file
        FROM users u
        LEFT JOIN LATERAL (
          SELECT m.* FROM chat_messages m
           WHERE ((m.from_id = u.id AND m.to_id = $1) OR (m.from_id = $1 AND m.to_id = u.id))
             AND NOT ${hidden('$1')}
           ORDER BY m.id DESC LIMIT 1) last ON TRUE
        LEFT JOIN attachments lastf ON lastf.scope = 'chat' AND lastf.ref_id = last.id
       WHERE u.password_hash IS NOT NULL AND u.id <> $1
       ORDER BY last.created_at DESC NULLS LAST, u.id`, [me.id]);

    const { rows: groups } = await query(`
      SELECT g.id, g.name, g.created_by,
             (SELECT count(*) FROM chat_group_members mm WHERE mm.group_id = g.id)::int AS members,
             (SELECT count(*) FROM chat_messages m
               WHERE m.group_id = g.id AND m.from_id <> $1
                 AND m.id > coalesce((SELECT last_read_id FROM chat_group_reads r
                                       WHERE r.group_id = g.id AND r.user_id = $1), 0))::int AS unread,
             last.body, last.created_at AS last_at, last.recalled_at,
             lu.name AS last_from_name, last.from_id AS last_from,
             lastf.orig_name AS last_file
        FROM chat_groups g
        JOIN chat_group_members me_m ON me_m.group_id = g.id AND me_m.user_id = $1
        LEFT JOIN LATERAL (
          SELECT m.* FROM chat_messages m
           WHERE m.group_id = g.id AND NOT ${hidden('$1')}
           ORDER BY m.id DESC LIMIT 1) last ON TRUE
        LEFT JOIN users lu ON lu.id = last.from_id
        LEFT JOIN attachments lastf ON lastf.scope = 'chat' AND lastf.ref_id = last.id
       ORDER BY last.created_at DESC NULLS LAST, g.id`, [me.id]);

    const preview = r => r.recalled_at ? '[已撤回]'
      : (r.body || (r.last_file ? '[文件] ' + r.last_file : null));

    sendJson(res, 200, {
      items: people.map(r => ({
        kind: 'user', id: Number(r.id), name: r.name, dept: r.dept,
        unread: r.unread, lastText: preview(r), lastAt: r.last_at,
        lastMine: r.last_from ? Number(r.last_from) === me.id : null,
      })),
      groups: groups.map(r => ({
        kind: 'group', id: Number(r.id), name: r.name, members: r.members,
        createdBy: r.created_by ? Number(r.created_by) : null,
        unread: r.unread, lastText: preview(r), lastAt: r.last_at,
        lastFrom: r.last_from_name,
        lastMine: r.last_from ? Number(r.last_from) === me.id : null,
      })),
      unreadTotal: people.reduce((a, r) => a + r.unread, 0)
                 + groups.reduce((a, r) => a + r.unread, 0),
    });
  });

  /* ==================== 群管理 ==================== */

  router.post('/api/chat/groups', async (req, res) => {
    const me = await currentUser(req);
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) throw badRequest('给群起个名字');
    const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(Number).filter(Boolean))];
    if (!ids.length) throw badRequest('至少拉一个人进来');

    const { rows } = await query(
      'INSERT INTO chat_groups(name, created_by) VALUES($1,$2) RETURNING id', [name, me.id]);
    const gid = Number(rows[0].id);
    // 建群的人自己当然在群里
    for (const uid of new Set([me.id, ...ids])) {
      await query(`INSERT INTO chat_group_members(group_id, user_id) VALUES($1,$2)
                   ON CONFLICT DO NOTHING`, [gid, uid]);
    }
    sendJson(res, 201, { id: gid, name });
    publish('chat:ping', {});
  });

  router.get('/api/chat/groups/:id/members', async (req, res, params) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    await assertMember(gid, me);
    const { rows } = await query(`
      SELECT u.id, u.name, u.dept FROM chat_group_members m
        JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 ORDER BY u.id`, [gid]);
    sendJson(res, 200, { items: rows.map(r => ({ id: Number(r.id), name: r.name, dept: r.dept })) });
  });

  router.post('/api/chat/groups/:id/members', async (req, res, params) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    await assertMember(gid, me);
    const b = await readJson(req);
    const ids = (Array.isArray(b.memberIds) ? b.memberIds : []).map(Number).filter(Boolean);
    for (const uid of ids) {
      await query(`INSERT INTO chat_group_members(group_id, user_id) VALUES($1,$2)
                   ON CONFLICT DO NOTHING`, [gid, uid]);
    }
    sendJson(res, 200, { ok: true });
    publish('chat:ping', {});
  });

  /* ==================== 读消息 ==================== */

  /** 群：GET /api/chat/group/:id */
  router.get('/api/chat/group/:id', async (req, res, params, url) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    await assertMember(gid, me);

    const before = num(q(url, 'before'));
    const args = [gid, me.id];
    let cond = '';
    if (before) { args.push(before); cond = ` AND m.id < $${args.length}`; }

    const { rows } = await query(
      `${MSG_SELECT} WHERE m.group_id = $1 AND NOT ${hidden('$2')}${cond}
        ORDER BY m.id DESC LIMIT 50`, args);

    // 「N 人已读」：读游标走过这条的人数（不算发消息的自己）
    const { rows: reads } = await query(
      `SELECT last_read_id, user_id FROM chat_group_reads WHERE group_id = $1`, [gid]);
    const readBy = m => reads.filter(r =>
      Number(r.last_read_id) >= Number(m.id) && Number(r.user_id) !== Number(m.from_id)).length;

    sendJson(res, 200, { items: rows.reverse().map(r => msgRow(r, { readBy: readBy(r) })) });
  });

  /** 一对一：GET /api/chat/:userId */
  router.get('/api/chat/:userId', async (req, res, params, url) => {
    const me = await currentUser(req);
    const peer = num(params.userId);
    if (!peer) throw badRequest('用户 id 不合法');

    const before = num(q(url, 'before'));
    const args = [me.id, peer];
    let cond = '';
    if (before) { args.push(before); cond = ` AND m.id < $${args.length}`; }

    const { rows } = await query(`
      ${MSG_SELECT}
       WHERE m.group_id IS NULL
         AND ((m.from_id = $1 AND m.to_id = $2) OR (m.from_id = $2 AND m.to_id = $1))
         AND NOT ${hidden('$1')}${cond}
       ORDER BY m.id DESC LIMIT 50`, args);
    sendJson(res, 200, { items: rows.reverse().map(r => msgRow(r)) });
  });

  /* ==================== 发消息 ==================== */

  async function sendText(me, { toId, groupId }, body) {
    const text = String(body || '').trim();
    if (!text) throw badRequest('说点什么再发');
    if (text.length > MAX_BODY) throw badRequest(`一条消息最多 ${MAX_BODY} 字`);

    let mentions = [];
    if (groupId) {
      const { rows: mem } = await query(`
        SELECT u.id, u.name FROM chat_group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = $1`, [groupId]);
      mentions = parseMentions(text, mem).filter(id => id !== me.id);
    }

    const { rows } = await query(
      `INSERT INTO chat_messages(from_id, to_id, group_id, body, mentions)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [me.id, toId || null, groupId || null, text, mentions.length ? mentions : null]);
    return Number(rows[0].id);
  }

  router.post('/api/chat/group/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    await assertMember(gid, me);
    const b = await readJson(req);
    const id = await sendText(me, { groupId: gid }, b.body);
    const { rows } = await query(`${MSG_SELECT} WHERE m.id = $1`, [id]);
    sendJson(res, 201, msgRow(rows[0]));
    publish('chat:ping', {});
  });

  router.post('/api/chat/:userId', async (req, res, params) => {
    const me = await currentUser(req);
    const peer = num(params.userId);
    const { rows: p } = await query(
      'SELECT id FROM users WHERE id = $1 AND password_hash IS NOT NULL', [peer]);
    if (!p[0]) throw notFound('没有这个人');
    const b = await readJson(req);
    const id = await sendText(me, { toId: peer }, b.body);
    const { rows } = await query(`${MSG_SELECT} WHERE m.id = $1`, [id]);
    sendJson(res, 201, msgRow(rows[0]));
    publish('chat:ping', {});
  });

  /* ---------- 发文件 ---------- */
  async function sendFile(req, res, me, { toId, groupId }, url) {
    const origName = String(q(url, 'name', '') || '').trim();
    if (!origName) throw badRequest('缺少文件名');
    const kind = kindOf(origName);

    // 先建消息再存文件：文件写一半失败的话，留一条空消息比留一个没人认领的文件好清理
    const { rows: m } = await query(
      'INSERT INTO chat_messages(from_id, to_id, group_id) VALUES($1,$2,$3) RETURNING id',
      [me.id, toId || null, groupId || null]);
    const mid = Number(m[0].id);

    const storedName = randomBytes(16).toString('hex') + kind.ext;
    let size;
    try { size = await saveBody(req, join(UPLOAD_DIR, storedName)); }
    catch (e) { await query('DELETE FROM chat_messages WHERE id = $1', [mid]); throw e; }

    await query(
      `INSERT INTO attachments(scope, ref_id, side, orig_name, stored_name, mime, size, uploaded_by)
       VALUES('chat',$1,'submit',$2,$3,$4,$5,$6)`,
      [mid, basename(origName), storedName, kind.mime, size, me.id]);

    const { rows } = await query(`${MSG_SELECT} WHERE m.id = $1`, [mid]);
    sendJson(res, 201, msgRow(rows[0]));
    publish('chat:ping', {});
  }

  router.post('/api/chat/group/:id/files', async (req, res, params, url) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    await assertMember(gid, me);
    await sendFile(req, res, me, { groupId: gid }, url);
  });

  router.post('/api/chat/:userId/files', async (req, res, params, url) => {
    const me = await currentUser(req);
    const peer = num(params.userId);
    const { rows: p } = await query(
      'SELECT id FROM users WHERE id = $1 AND password_hash IS NOT NULL', [peer]);
    if (!p[0]) throw notFound('没有这个人');
    await sendFile(req, res, me, { toId: peer }, url);
  });

  /* ==================== 撤回 / 编辑 / 删除 ==================== */

  async function loadMsg(id, me) {
    const { rows } = await query('SELECT * FROM chat_messages WHERE id = $1', [id]);
    const m = rows[0];
    if (!m) throw notFound('没有这条消息');
    // 能不能看到这条：私聊看双方，群聊看成员
    if (m.group_id) await assertMember(Number(m.group_id), me);
    else if (Number(m.from_id) !== me.id && Number(m.to_id) !== me.id) {
      throw forbidden('这不是你的对话');
    }
    return m;
  }

  /** 撤回：内容清空，保留一行痕迹 */
  router.post('/api/chat/messages/:id/recall', async (req, res, params) => {
    const me = await currentUser(req);
    const m = await loadMsg(num(params.id), me);
    if (Number(m.from_id) !== me.id) throw forbidden('只能撤回自己发的消息');
    await query('UPDATE chat_messages SET recalled_at = now(), body = NULL WHERE id = $1', [m.id]);
    // 附件一并清掉，否则文件还躺在磁盘上、链接也还能打开，撤回等于没撤
    const { rows: fs } = await query(
      `DELETE FROM attachments WHERE scope='chat' AND ref_id=$1 RETURNING stored_name`, [m.id]);
    for (const f of fs) await unlink(join(UPLOAD_DIR, basename(f.stored_name))).catch(() => {});
    sendJson(res, 200, { ok: true });
    publish('chat:ping', {});
  });

  /** 编辑：保留「已编辑」标记 —— 改过的地方看不出来，聊天记录就没有可信度了 */
  router.patch('/api/chat/messages/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const m = await loadMsg(num(params.id), me);
    if (Number(m.from_id) !== me.id) throw forbidden('只能编辑自己发的消息');
    if (m.recalled_at) throw badRequest('已撤回的消息不能再编辑');
    const b = await readJson(req);
    const text = String(b.body || '').trim();
    if (!text) throw badRequest('内容不能为空');
    if (text.length > MAX_BODY) throw badRequest(`一条消息最多 ${MAX_BODY} 字`);
    await query('UPDATE chat_messages SET body = $2, edited_at = now() WHERE id = $1', [m.id, text]);
    const { rows } = await query(`${MSG_SELECT} WHERE m.id = $1`, [m.id]);
    sendJson(res, 200, msgRow(rows[0]));
    publish('chat:ping', {});
  });

  /**
   * 删除：只从我自己的视野里去掉，对方那边一切照旧。
   * 所以别人发的消息我也能删（删的是我这份显示），这和撤回是两回事。
   */
  router.del('/api/chat/messages/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const m = await loadMsg(num(params.id), me);
    await query(`INSERT INTO chat_deletes(message_id, user_id) VALUES($1,$2)
                 ON CONFLICT DO NOTHING`, [m.id, me.id]);
    sendJson(res, 200, { ok: true });
    // 不 publish：这只影响我自己看到的内容，没必要惊动别人
  });

  /* ---------- 解散群聊 ---------- */
  router.del('/api/chat/groups/:id', async (req, res, params) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    const { rows } = await query('SELECT * FROM chat_groups WHERE id = $1', [gid]);
    const g = rows[0];
    if (!g) throw notFound('没有这个群');
    if (Number(g.created_by) !== me.id && me.role !== 'admin') {
      throw forbidden('只有建群的人和管理员能解散');
    }
    // 磁盘上的文件不会跟着外键级联，得自己清，否则攒出一堆没人认领的文件
    const { rows: fs } = await query(`
      DELETE FROM attachments a
       USING chat_messages m
       WHERE a.scope='chat' AND a.ref_id = m.id AND m.group_id = $1
       RETURNING a.stored_name`, [gid]);
    for (const f of fs) await unlink(join(UPLOAD_DIR, basename(f.stored_name))).catch(() => {});
    // 群一删，成员、已读游标、群消息都跟着级联删掉
    await query('DELETE FROM chat_groups WHERE id = $1', [gid]);
    sendJson(res, 200, { ok: true, files: fs.length });
    publish('chat:ping', {});
  });

  /* ==================== 标已读 ==================== */

  router.post('/api/chat/group/:id/read', async (req, res, params) => {
    const me = await currentUser(req);
    const gid = num(params.id);
    await assertMember(gid, me);
    const { rows: last } = await query(
      'SELECT coalesce(max(id),0) AS id FROM chat_messages WHERE group_id = $1', [gid]);
    // 「游标真的往前挪了」才返回行：DO UPDATE 带 WHERE，没前进就整句不更新、
    // RETURNING 也拿不到行。GREATEST 因此不再需要 —— WHERE 已经保证只增不减。
    //
    // 和单聊那边同一个理由：游标没动就不该广播。以前无条件 publish，
    // 转成了一个死循环（推送 → refresh → loadMsgs → 无条件标已读 → 又 publish），
    // 而且一个人开着聊天窗口，所有在线的人都跟着每秒刷两三次。
    const { rows: r } = await query(`
      INSERT INTO chat_group_reads(group_id, user_id, last_read_id) VALUES($1,$2,$3)
      ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id
        WHERE chat_group_reads.last_read_id < EXCLUDED.last_read_id
      RETURNING last_read_id`,
      [gid, me.id, Number(last[0].id)]);
    sendJson(res, 200, { ok: true });
    if (r.length) publish('chat:ping', {});
  });

  router.post('/api/chat/:userId/read', async (req, res, params) => {
    const me = await currentUser(req);
    const peer = num(params.userId);
    const upd = await query(
      `UPDATE chat_messages SET read_at = now()
        WHERE from_id = $1 AND to_id = $2 AND read_at IS NULL`, [peer, me.id]);
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM chat_messages WHERE to_id = $1 AND read_at IS NULL', [me.id]);
    sendJson(res, 200, { unreadTotal: rows[0].n });
    // 只有**真的**标掉了未读才广播。以前是无条件发，结果转成一个死循环：
    // 推送 → 前端 refresh → 面板开着就 loadMsgs → 无条件 POST /read →
    // 又 publish → 广播给所有人（含自己）→ 再 refresh …… 被 120ms 防抖卡成
    // 每秒 2.5 次请求，而且**一个人开着聊天窗口，所有在线的人都跟着刷**。
    // 判据用 rowCount：没有未读可标 = 对方那边的「已读」状态也没变，没什么可通知的。
    if (upd.rowCount > 0) publish('chat:ping', {});     // 对方要能看到「已读」
  });
}
