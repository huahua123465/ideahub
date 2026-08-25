/**
 * 账号：注册 / 登录 / 退出 / 改密码，以及管理员的用户管理。
 */
import { query, tx } from '../db/index.mjs';
import { readJson, sendJson, badRequest, conflict, notFound } from '../lib/http.mjs';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../lib/password.mjs';
import {
  COOKIE, readCookies, createSession, destroySession,
  destroyUserSessions, setSessionCookie, clearSessionCookie,
} from '../lib/session.mjs';
import { currentUser, currentUserOrNull, assertAdmin, unauthorized } from '../lib/auth.mjs';

/** 邀请码。留空 = 开放注册（当前配置）。哪天公网上来了陌生人，填上它即可关门。 */
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();

const ROLES = ['member', 'reviewer', 'admin'];

/**
 * 用户名规则：字母开头，字母数字下划线点，3-24 位。
 * 不允许中文和空格 —— 用户名是要手敲进登录框的，
 * 中文用户名在输入法上会踩到全角半角、简繁转换一堆坑。
 * 真实姓名另有 name 字段，界面上显示的是那个。
 */
/**
 * 姓名即登录名。
 *
 * 原来注册要单独填一个「字母开头、3-24 位」的用户名，现在去掉了 ——
 * 那条正则连中文姓名都过不了，同事还得额外记一串跟自己没关系的字符。
 *
 * 姓名直接写进 username 列，唯一索引 users_username_uniq 建在 lower(username) 上，
 * 所以「姓名必须唯一」这件事由数据库来保证，不用应用层再造一套。
 */
function loginNameOf(name) {
  const n = String(name || '').trim();
  if (!n) throw badRequest('请填写你的姓名');
  if (n.length > 30) throw badRequest('姓名太长了');
  return n;
}

function publicUser(r) {
  return {
    id: Number(r.id), username: r.username, name: r.name,
    dept: r.dept, role: r.role,
    createdAt: r.created_at, lastLoginAt: r.last_login_at,
  };
}

export function mount(router) {

  /* ---------- 注册 ---------- */
  router.post('/api/auth/register', async (req, res) => {
    const body = await readJson(req);
    const password = String(body.password || '');
    const name = loginNameOf(body.name);
    const username = name;                     // 姓名即登录名
    const dept = String(body.dept || '').trim() || null;

    const weak = checkPasswordStrength(password);
    if (weak) throw badRequest(weak);

    if (INVITE_CODE && String(body.inviteCode || '').trim() !== INVITE_CODE) {
      throw badRequest('邀请码不对，找管理员要一个');
    }

    const hash = await hashPassword(password);

    const user = await tx(async c => {
      // 第一个注册的人自动是管理员 —— 否则系统上线后没有任何人能任命评审委员，
      // 会死锁在「要管理员才能设管理员」上。
      // 计数只算有账号的人：种子数据里那些虚拟同事不算数。
      const { rows: cnt } = await c.query(
        'SELECT count(*)::int AS n FROM users WHERE password_hash IS NOT NULL');
      const role = cnt[0].n === 0 ? 'admin' : 'member';

      // 唯一索引是 lower(username)，这里先查一次只为给出人话错误提示；
      // 真正防重复的是下面 INSERT 撞上索引时的 23505。并发注册同名靠数据库拦。
      const { rows: dup } = await c.query(
        'SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
      if (dup[0]) throw conflict('已经有同事用了这个姓名，加个部门或花名区分一下，比如「张伟·产品」');

      try {
        const { rows } = await c.query(
          `INSERT INTO users (name, dept, role, username, password_hash)
           VALUES ($1, $2, $3::user_role, $4, $5)
           RETURNING id, username, name, dept, role::text AS role, created_at, last_login_at`,
          [name, dept, role, username, hash]);
        return rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('已经有同事用了这个姓名，加个部门或花名区分一下，比如「张伟·产品」');
        throw e;
      }
    });

    const sid = await createSession(user.id, req.headers['user-agent']);
    setSessionCookie(req, res, sid);
    sendJson(res, 201, { ...publicUser(user), isFirstAdmin: user.role === 'admin' });
  });

  /* ---------- 登录 ---------- */
  router.post('/api/auth/login', async (req, res) => {
    const body = await readJson(req);
    const who = String(body.username || body.name || '').trim();
    const password = String(body.password || '');
    if (!who || !password) throw badRequest('请填写姓名和密码');

    // 姓名或用户名都认。
    // 新注册的人 username 就是姓名，两边都能命中；
    // 而改版之前注册的老账号（username 和 name 不一样）照样能用原来的用户名登进来，
    // 不会因为这次改动被锁在外面。用户名精确命中的优先。
    const { rows } = await query(
      `SELECT id, username, name, dept, role::text AS role, password_hash, created_at, last_login_at
         FROM users
        WHERE lower(username) = lower($1) OR lower(name) = lower($1)
        ORDER BY (lower(username) = lower($1)) DESC
        LIMIT 1`, [who]);
    const row = rows[0];

    // 用户名不存在时也照样跑一次哈希验证，让两种失败耗时接近。
    // 否则光看响应快慢就能枚举出哪些用户名是真实存在的。
    const okPw = await verifyPassword(password, row?.password_hash
      || 'scrypt$16384$8$1$00000000000000000000000000000000$' + '0'.repeat(64));

    // 错误提示不区分「没这个人」和「密码错了」，同样是为了不泄露用户名是否存在。
    if (!row || !row.password_hash || !okPw) throw unauthorized('姓名或密码不对');

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);

    const sid = await createSession(row.id, req.headers['user-agent']);
    setSessionCookie(req, res, sid);
    sendJson(res, 200, publicUser(row));
  });

  /* ---------- 退出 ---------- */
  router.post('/api/auth/logout', async (req, res) => {
    await destroySession(readCookies(req)[COOKIE]);
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true });
  });

  /* ---------- 改密码 ---------- */
  router.post('/api/auth/password', async (req, res) => {
    const me = await currentUser(req);
    const body = await readJson(req);
    const oldPw = String(body.oldPassword || '');
    const newPw = String(body.newPassword || '');

    const weak = checkPasswordStrength(newPw);
    if (weak) throw badRequest(weak);

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [me.id]);
    if (!await verifyPassword(oldPw, rows[0]?.password_hash)) throw badRequest('原密码不对');

    await query('UPDATE users SET password_hash = $2 WHERE id = $1',
      [me.id, await hashPassword(newPw)]);

    // 改完密码把所有会话都作废，再给当前这台设备发一个新的。
    // 密码可能就是因为泄露才改的，旧会话必须一起断掉，否则改了等于没改。
    await destroyUserSessions(me.id);
    const sid = await createSession(me.id, req.headers['user-agent']);
    setSessionCookie(req, res, sid);
    sendJson(res, 200, { ok: true });
  });

  /* ---------- 注册是否开放 / 是否首个账号（登录页要用，不需要登录） ---------- */
  router.get('/api/auth/config', async (req, res) => {
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM users WHERE password_hash IS NOT NULL');
    sendJson(res, 200, {
      needInviteCode: !!INVITE_CODE,
      isEmpty: rows[0].n === 0,      // 还没有任何账号 → 提示第一个注册的人会是管理员
      loggedIn: !!(await currentUserOrNull(req)),
    });
  });

  /* ================= 管理员：用户管理 ================= */

  router.get('/api/admin/users', async (req, res) => {
    assertAdmin(await currentUser(req));
    const { rows } = await query(
      `SELECT u.id, u.username, u.name, u.dept, u.role::text AS role,
              u.created_at, u.last_login_at,
              (SELECT count(*)::int FROM ideas i WHERE i.author_id = u.id) AS idea_count
         FROM users u
        WHERE u.password_hash IS NOT NULL
        ORDER BY u.created_at`);
    sendJson(res, 200, { items: rows.map(r => ({ ...publicUser(r), ideaCount: r.idea_count })) });
  });

  /** 改角色。这是管理员把评审权限分给别人的唯一入口。 */
  router.patch('/api/admin/users/:id/role', async (req, res, params) => {
    const me = await currentUser(req);
    assertAdmin(me);
    const id = Number(params.id);
    const role = String((await readJson(req)).role || '');
    if (!ROLES.includes(role)) throw badRequest(`角色只能是 ${ROLES.join(' / ')}`);

    await tx(async c => {
      const { rows } = await c.query(
        'SELECT id, role::text AS role FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw notFound('没有这个用户');

      // 不能把最后一个管理员降级 —— 降完就没人能再任命管理员了，
      // 系统会锁死在没有管理员的状态，只能上服务器改数据库才能救回来。
      if (rows[0].role === 'admin' && role !== 'admin') {
        const { rows: n } = await c.query(
          `SELECT count(*)::int AS n FROM users
            WHERE role = 'admin' AND password_hash IS NOT NULL`);
        if (n[0].n <= 1) throw badRequest('这是最后一个管理员，不能降级。先任命另一个管理员。');
      }

      await c.query('UPDATE users SET role = $2::user_role WHERE id = $1', [id, role]);
    });

    const { rows } = await query(
      `SELECT id, username, name, dept, role::text AS role, created_at, last_login_at
         FROM users WHERE id = $1`, [id]);
    sendJson(res, 200, publicUser(rows[0]));
  });

  /** 重置某人的密码。同事忘了密码时管理员用，没有邮件系统，只能这样。 */
  router.post('/api/admin/users/:id/reset-password', async (req, res, params) => {
    assertAdmin(await currentUser(req));
    const id = Number(params.id);
    const newPw = String((await readJson(req)).password || '');
    const weak = checkPasswordStrength(newPw);
    if (weak) throw badRequest(weak);

    const { rows } = await query('SELECT id FROM users WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('没有这个用户');

    await query('UPDATE users SET password_hash = $2 WHERE id = $1',
      [id, await hashPassword(newPw)]);
    await destroyUserSessions(id);   // 把这个人已有的登录状态全部断掉
    sendJson(res, 200, { ok: true });
  });
}
