/**
 * 机器身份（任务 10 / 11）。
 *
 * 技术1 和技术2 是两个独立系统，不能让它们拿某个同事的登录 cookie 来写数据：
 * 那个人一改密码对接就断，而且日志里查不出到底是谁写进来的。
 *
 * 只存 sha256(key)，明文只在创建那一刻返回一次 —— 库被看到也不能拿来冒充。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db/index.mjs';
import { HttpError } from './http.mjs';

const hash = (k) => createHash('sha256').update(String(k)).digest('hex');

/** 生成一把新钥匙。前缀让人一眼看出这是 IdeaHub 的 key，不至于和别的密钥混在一起 */
export function newKey(scope) {
  return `ih_${scope}_${randomBytes(24).toString('hex')}`;
}

export function keyHash(k) { return hash(k); }

/** 从请求头里取 Bearer token */
function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * 校验并返回这把钥匙。scope 不匹配直接 403 ——
 * 技术1 的钥匙不该能往客户档案里写东西，反之亦然。
 */
export async function requireKey(req, scope) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, '缺少 Authorization: Bearer <api key>');

  const { rows } = await query(
    'SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [hash(token)]);
  const row = rows[0];
  // 查不到时也走一次等长比较，避免用响应时间区分「key 不存在」和「key 存在但被停用」
  if (!row) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    throw new HttpError(401, 'API key 无效或已停用');
  }
  if (scope && !(row.scopes || []).includes(scope)) {
    throw new HttpError(403, `这把 key 没有 ${scope} 权限`);
  }

  // 最后使用时间：对接出问题时第一个要看的就是「它到底有没有调进来过」。
  // 不 await —— 记一笔审计信息不该拖慢每一次写入。
  query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});

  return { id: Number(row.id), name: row.name, scopes: row.scopes || [] };
}
