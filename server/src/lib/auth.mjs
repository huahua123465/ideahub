/**
 * 当前登录人 + 权限断言。
 *
 * 这里原本是开发期的临时方案（从 X-User-Id 头取人），现在换成了真正的
 * 用户名密码登录 —— 当初把认人这件事收在这一个文件里，就是为了今天这一刻：
 * 13 个接口和所有业务代码一行都没动。
 */
import { query } from '../db/index.mjs';
import { forbidden, HttpError } from './http.mjs';
import { COOKIE, readCookies, userBySession } from './session.mjs';

export const unauthorized = (m) => new HttpError(401, m || '请先登录');

/**
 * 开发/自测用的头认证后门。
 *
 * 接口自测要模拟 90 个人投票、5 个评审并发采纳，逐个真登录一遍纯属浪费。
 * 但这个后门等于「谁都能当管理员」，所以卡了两道：
 *   1. 必须显式设 ALLOW_HEADER_AUTH=1
 *   2. NODE_ENV=production 时无条件失效，设了也没用
 * 启动时还会在控制台喊一嗓子，避免它被忘在生产配置里。
 */
export const headerAuthEnabled =
  process.env.ALLOW_HEADER_AUTH === '1' && process.env.NODE_ENV !== 'production';

/**
 * 取当前登录人，没登录返回 null。
 * 不抛异常 —— /api/health 这类接口不需要人也能跑。
 */
export async function currentUserOrNull(req) {
  if (headerAuthEnabled && req.headers['x-user-id']) {
    const id = Number(req.headers['x-user-id']);
    if (Number.isFinite(id)) {
      const { rows } = await query(
        'SELECT id, name, dept, role::text AS role, username FROM users WHERE id = $1', [id]);
      if (rows[0]) return { ...rows[0], id: Number(rows[0].id) };
    }
    return null;
  }

  const sid = readCookies(req)[COOKIE];
  return await userBySession(sid);
}

/** 取当前登录人，没登录直接 401。业务接口都用这个。 */
export async function currentUser(req) {
  const u = await currentUserOrNull(req);
  if (!u) throw unauthorized();
  return u;
}

/** 评审委员及以上才能做状态流转 */
export function assertReviewer(user) {
  if (user.role !== 'reviewer' && user.role !== 'admin') {
    throw forbidden('只有评审委员可以流转灵感状态');
  }
}

/** 管理员专用操作 */
export function assertAdmin(user) {
  if (user.role !== 'admin') throw forbidden('只有管理员可以做这个操作');
}
