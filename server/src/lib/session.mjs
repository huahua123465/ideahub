/**
 * 会话：随机 id 存数据库，浏览器只拿一个 HttpOnly cookie。
 *
 * 为什么 cookie 里只放 id、真东西存库：
 * 这样「退出登录」和「把某个人踢下线」是同一件事 —— 删一行。
 * 如果把用户信息签进 cookie 里，签发出去就收不回来了，只能等它自己过期。
 */
import { randomBytes } from 'node:crypto';
import { query } from '../db/index.mjs';

export const COOKIE = 'ideahub_sid';
const DAYS = Number(process.env.SESSION_DAYS || 30);

/** 解析 Cookie 头 */
export function readCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

/**
 * Secure 标志不能写死。
 * 本地开发是 http://localhost，带上 Secure 浏览器会直接丢掉 cookie，登录就永远不成功；
 * 线上是 https，不带 Secure 又等于允许它在明文里跑一趟。
 * 所以看 Caddy 转发过来的 X-Forwarded-Proto，也允许用 COOKIE_SECURE 环境变量强制。
 */
function isSecure(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

export function setSessionCookie(req, res, sid) {
  const bits = [
    `${COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',                              // JS 读不到，XSS 也偷不走
    'SameSite=Lax',                          // 挡掉大部分 CSRF，又不影响正常点链接进来
    `Max-Age=${DAYS * 24 * 3600}`,
  ];
  if (isSecure(req)) bits.push('Secure');
  append(res, 'set-cookie', bits.join('; '));
}

export function clearSessionCookie(req, res) {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) bits.push('Secure');
  append(res, 'set-cookie', bits.join('; '));
}

function append(res, name, value) {
  const prev = res.getHeader(name);
  res.setHeader(name, prev ? [].concat(prev, value) : [value]);
}

/** 建会话，返回 sid */
export async function createSession(userId, userAgent) {
  const sid = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [sid, userId, String(DAYS), (userAgent || '').slice(0, 300)]);
  return sid;
}

/** 按 sid 查人。过期的当作不存在。 */
export async function userBySession(sid) {
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const { rows } = await query(
    `SELECT u.id, u.name, u.dept, u.role::text AS role, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`, [sid]);
  if (!rows[0]) return null;
  return { ...rows[0], id: Number(rows[0].id) };
}

export async function destroySession(sid) {
  if (!sid) return;
  await query('DELETE FROM sessions WHERE id = $1', [sid]);
}

/** 某个人的所有会话都作废（改密码、踢下线时用） */
export async function destroyUserSessions(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** 清理过期会话。cron 里顺手调一下就行，不必单独起定时器。 */
export async function purgeExpiredSessions() {
  const { rows } = await query('DELETE FROM sessions WHERE expires_at <= now() RETURNING id');
  return rows.length;
}
