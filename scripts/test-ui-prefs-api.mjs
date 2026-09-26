/**
 * 界面偏好 / 浏览器报错上报 / 安全响应头 的接口自测（2026-09-26）：npm run test:api:prefs
 *
 * 和 test-api.mjs 一样需要后端已在 PORT 上跑起来（带 ALLOW_HEADER_AUTH=1），数据库已 seed，
 * 并且已经执行过 scripts/migrations/20260926-user-ui-prefs.sql。
 * 单独成一个文件：test-api.mjs 目前在「搜索高亮」那一段就会中断（旧问题，和这次改动无关），
 * 放在它后面的用例根本跑不到。只写测试账号自己的偏好，跑完删掉。
 */
import '../server/src/lib/env.mjs';

const BASE = process.env.TEST_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
let pass = 0, fail = 0;
const { query: dbq, close } = await import('../server/src/db/index.mjs');
const seedId = {};
{
  const { rows } = await dbq(
    `SELECT id, name FROM users WHERE name = ANY($1) AND password_hash IS NULL`, [['林知远', '周未']]);
  for (const r of rows) seedId[r.name] = Number(r.id);
}
const REVIEWER = seedId['林知远'];
const MEMBER = seedId['周未'];
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + JSON.stringify(extra) : ''}`); }
};
async function call(method, path, body, userId) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': String(userId) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, data };
}
if (!MEMBER || !REVIEWER) { console.log('找不到种子用户（周未 / 林知远），先 npm run db:seed'); process.exit(1); }

/* ---------- 界面偏好跟着账号走（09-26） ---------- */
console.log('\n界面偏好（配色与外观跟着账号走）');
{
  await dbq('DELETE FROM user_ui_prefs WHERE user_id = ANY($1)', [[MEMBER, REVIEWER]]);
  const empty = await call('GET', '/api/auth/me/ui-prefs', undefined, MEMBER);
  ok(empty.status === 200 && JSON.stringify(empty.data.prefs) === '{}' && empty.data.updatedAt === null, '没存过时返回空偏好', empty.data);

  const prefs = { look: { family: 'forest', radius: 1.2 }, mine: [{ id: 'm1', name: '我的森屿', A: 162, B: 160 }], theme: 'light', junk: 'x' };
  const put = await call('PATCH', '/api/auth/me/ui-prefs', { prefs }, MEMBER);
  ok(put.status === 200 && put.data.prefs.look?.family === 'forest' && put.data.prefs.theme === 'light'
     && !('junk' in put.data.prefs) && typeof put.data.updatedAt === 'string', '保存偏好，未知字段被过滤', put.data);
  const back = await call('GET', '/api/auth/me/ui-prefs', undefined, MEMBER);
  ok(back.data.prefs.mine?.[0]?.name === '我的森屿' && back.data.updatedAt === put.data.updatedAt, '再读回来和存的一致', back.data);
  const again = await call('PATCH', '/api/auth/me/ui-prefs', { prefs: { theme: 'dark' } }, MEMBER);
  ok(again.status === 200 && again.data.prefs.theme === 'dark' && !again.data.prefs.look && again.data.updatedAt >= put.data.updatedAt, '再存一次是整份覆盖', again.data);
  const other = await call('GET', '/api/auth/me/ui-prefs', undefined, REVIEWER);
  ok(other.status === 200 && JSON.stringify(other.data.prefs) === '{}', '别人读不到我的偏好', other.data);
  const bad = await call('PATCH', '/api/auth/me/ui-prefs', { prefs: [1, 2] }, MEMBER);
  ok(bad.status === 400, `格式不对返回 400（实际 ${bad.status}）`);
  const huge = await call('PATCH', '/api/auth/me/ui-prefs', { prefs: { mine: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: 'x'.repeat(3000) })) } }, MEMBER);
  ok(huge.status === 400, `太大返回 400（实际 ${huge.status}）`);
  const anon = await call('GET', '/api/auth/me/ui-prefs', undefined, null);
  ok(anon.status === 401, `未登录读偏好返回 401（实际 ${anon.status}）`);
  await dbq('DELETE FROM user_ui_prefs WHERE user_id = ANY($1)', [[MEMBER, REVIEWER]]);
}

/* ---------- 浏览器报错上报（09-26） ---------- */
console.log('\n浏览器报错上报');
{
  const one = await call('POST', '/api/client-errors', { items: [{ kind: 'error', message: '自测报错：这不是真的错误', source: '/dist/app.js?v=x#y', line: 1, col: 2, view: 'home' }] }, MEMBER);
  ok(one.status === 202 && one.data.accepted === 1, '收下一条报错', one.data);
  const junk = await call('POST', '/api/client-errors', { items: [{ kind: 'error' }, 'x', null] }, MEMBER);
  ok(junk.status === 202 && junk.data.accepted === 0, '没有消息的条目直接忽略', junk.data);
  const anon = await call('POST', '/api/client-errors', { items: [{ message: 'x' }] }, null);
  ok(anon.status === 401, `未登录上报返回 401（实际 ${anon.status}）`);
  let limited = null;
  for (let i = 0; i < 5 && !limited; i++) {
    const r = await call('POST', '/api/client-errors', { items: Array.from({ length: 10 }, (_, j) => ({ message: `自测刷屏 ${i}-${j}` })) }, REVIEWER);
    if (r.status === 429) limited = r;
  }
  ok(limited?.status === 429, '同一个人 10 分钟内报太多会被限流（429）', limited?.data);
}

/* ---------- 安全响应头（09-26） ---------- */
console.log('\n安全响应头');
{
  for (const path of ['/api/health', '/']) {
    const r = await fetch(BASE + path);
    const h = name => r.headers.get(name) || '';
    ok(h('x-frame-options') === 'SAMEORIGIN' && h('x-content-type-options') === 'nosniff'
       && h('content-security-policy').includes("frame-ancestors 'self'")
       && h('referrer-policy') === 'strict-origin-when-cross-origin'
       && h('permissions-policy').includes('camera=()'),
    `${path} 带上防点击劫持、nosniff 等安全头`, Object.fromEntries(r.headers));
    ok(!h('strict-transport-security'), `${path} 不发 HSTS（80 端口和 IP 直连还要用）`);
  }
}

await close();
console.log(`
${'─'.repeat(46)}`);
console.log(`  通过 ${pass}   失败 ${fail}`);
console.log(`${'─'.repeat(46)}
`);
process.exit(fail ? 1 : 0);
