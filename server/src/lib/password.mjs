/**
 * 密码哈希。用 Node 内置的 scrypt，不引第三方包。
 *
 * 为什么是 scrypt 而不是 SHA-256 加盐：
 * scrypt 是「慢哈希」，故意吃内存吃 CPU。真有人拖走了数据库，
 * 拿一张显卡爆破 SHA-256 是每秒几十亿次，爆破 scrypt 是每秒几千次。
 * 差了六个数量级，这就是同事那些「公司缩写 + 123」的弱密码还能撑一阵的原因。
 *
 * 存储格式：scrypt$N$r$p$盐的十六进制$哈希的十六进制
 * 把参数一起存进去，是为了以后调高强度时，老密码仍然能用它自己的参数验证，
 * 不会因为改了个常量就让所有人登不进来。
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// N=16384 在普通 VPS 上单次约 50-100ms。这个量级用户无感，爆破的人很痛苦。
const N = 16384, R = 8, P = 1, KEYLEN = 32;

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = await scryptAsync(plain.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');

  let actual;
  try {
    actual = await scryptAsync(plain.normalize('NFKC'), salt, expected.length,
      { N: Number(n), r: Number(r), p: Number(p) });
  } catch {
    return false;   // 参数被改坏了，当作验证失败，不要抛出去
  }

  // 定长比较，避免按字节提前返回泄露信息
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 密码强度。只做最低限度的拦截 —— 这是公司内部工具，不是银行。
 * 规则定得太狠，同事只会写在便利贴上贴显示器，反而更不安全。
 */
/**
 * 密码校验。
 *
 * 2026-08-21 按要求去掉了全部强度限制（原来是「至少 8 位、不能全数字、
 * 不能是常见弱密码」）—— 这是内部小范围试用的工具，注册门槛压到最低。
 *
 * 只剩两条硬性规则，都不是「强度」：
 *   · 不能为空 —— 空密码等于谁知道姓名谁就能登进来。
 *   · 不能超长 —— scrypt 对超长输入要算很久，是个廉价的 DoS 入口。
 *
 * 注意这站目前是明文 HTTP + 开放注册，密码本来就在网络上可见；
 * 哪天换成域名 + HTTPS 时，值得把强度检查加回来。
 */
export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return '请填写密码';
  if (pw.length > 200) return '密码太长了';
  return null;
}
