/**
 * 后端接口自测：npm run test:api
 * 需要后端已在 PORT 上跑起来，且数据库已 seed。
 * 会写入测试数据，跑完自己清理。
 *
 * 关于认证：绝大多数用例走 ALLOW_HEADER_AUTH 这个开发后门（X-User-Id 头），
 * 因为要模拟 90 个人投票、5 个评审并发采纳，逐个真登录一遍纯属浪费时间。
 * 但登录注册本身的用例是走真实 cookie 的 —— 认证这块要是也用后门测，
 * 就等于没测。所以后端必须带 ALLOW_HEADER_AUTH=1 启动（.env 里已经配好）。
 */
import '../server/src/lib/env.mjs';

const BASE = process.env.TEST_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
let pass = 0, fail = 0;
const created = [];

/**
 * 种子用户的 id 按姓名查出来，不写死数字。
 * 以前写死 1/2/3/4 是能跑的，因为 seed 每次都 RESTART IDENTITY 从 1 开始重编号。
 * 加了登录之后 seed 不能再重置序列了（会和真实注册账号的 id 撞车），
 * 于是「1 号一定是陈屿」这个前提就不成立了。
 */
const { query: dbq } = await import('../server/src/db/index.mjs');
const seedId = {};
{
  const { rows } = await dbq(
    `SELECT id, name, role::text AS role FROM users
      WHERE name = ANY($1) AND password_hash IS NULL`,
    [['陈屿', '林知远', '苏禾', '周未']]);
  for (const r of rows) seedId[r.name] = Number(r.id);
}
const ADMIN    = seedId['陈屿'];      // admin
const REVIEWER = seedId['林知远'];    // reviewer
const REVIEWER2= seedId['苏禾'];      // reviewer
const MEMBER   = seedId['周未'];      // member

const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + JSON.stringify(extra) : ''}`); }
};

/**
 * userId 默认是种子里的管理员陈屿。
 * 传 null 表示「完全不带身份」，用来测未登录会不会被拦。
 */
async function call(method, path, body, userId = ADMIN) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': String(userId) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, data };
}

/** 对接接口走 Bearer API Key；raw=true 时 body 是文件字节，不做 JSON 序列化。 */
async function keyCall(method, path, body, key, raw = false) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(raw ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, data };
}

/** 走真实 cookie 的请求，用于测登录本身。cookie 自己收自己带。 */
function makeClient() {
  let cookie = '';
  return async function req(method, path, body) {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of (r.headers.getSetCookie?.() || [])) {
      const [kv] = c.split(';');
      if (kv.startsWith('ideahub_sid=')) cookie = kv;
    }
    let data = null;
    try { data = await r.json(); } catch { /* 空响应 */ }
    return { status: r.status, data, cookie };
  };
}

console.log(`\n对 ${BASE} 跑接口自测`);
console.log(`\x1b[90m（断言基于种子数据的初始状态。数据被改过的话先跑 npm run db:seed）\x1b[0m\n`);

/* ---------- 健康检查 ---------- */
console.log('健康检查');
{
  ok(!!ADMIN && !!MEMBER && !!REVIEWER, '种子用户 id 解析成功', seedId);
  const r = await call('GET', '/api/health');
  ok(r.status === 200 && r.data.ok, '/api/health 返回 200 且数据库连通', r.data);
  const me = await call('GET', '/api/me');
  ok(me.data.name === '陈屿' && me.data.role === 'admin', '/api/me 是管理员陈屿', me.data);
}

/* ---------- 列表 ---------- */
console.log('\n列表与筛选');
let poolFirst;
{
  const r = await call('GET', '/api/ideas');
  ok(r.data.items.length === 9, `灵感池 9 条（实际 ${r.data.items.length}）`);
  ok(r.data.items.every(i => ['pending', 'reviewing'].includes(i.status)), '灵感池只含 pending / reviewing');

  const hot = r.data.items.map(i => i.voteCount);
  ok(hot[0] >= hot[hot.length - 1], '默认按热度排，首条不低于末条');
  poolFirst = r.data.items[0];

  const adopted = await call('GET', '/api/ideas?status=adopted&sort=adopted');
  ok(adopted.data.items.length === 6, `正式库 6 条（实际 ${adopted.data.items.length}）`);
  ok(adopted.data.items.every(i => i.code && /^IDEA-\d{4}-\d{4}$/.test(i.code)), '正式库每条都有规范编号');

  const tech = await call('GET', '/api/ideas?category=技术');
  ok(tech.data.items.every(i => i.category === '技术'), '按分类筛选生效');

  const kw = await call('GET', '/api/ideas?q=周会');
  ok(kw.data.items.length >= 1, '关键词搜索能搜到「周会」那条');

  const anon = r.data.items.find(i => i.isAnonymous);
  ok(anon && anon.author.name === '匿名' && anon.author.id === null, '匿名灵感不暴露作者');
}

/* ---------- 详情 ---------- */
console.log('\n详情');
{
  const list = await call('GET', '/api/ideas?q=工单');
  const id = list.data.items[0].id;
  const r = await call('GET', `/api/ideas/${id}`);
  ok(r.status === 200, '详情返回 200');
  ok(r.data.comments.length === 12, `讨论 12 条（实际 ${r.data.comments.length}）`);
  ok(r.data.comments[0].body.includes('60%'), '讨论按时间正序，最早那条排第一');
  ok(r.data.commentCount === r.data.comments.length, '物化的评论数与实际条数一致');
  ok(r.data.activities.length >= 2, '流转记录至少 2 条（提交 + 认领评审）');
  ok(r.data.activities[0].text.includes('提交了这条灵感'), '第一条流转记录是提交');

  const missing = await call('GET', '/api/ideas/999999');
  ok(missing.status === 404, '不存在的灵感返回 404');
}

/* ---------- 提交 ---------- */
console.log('\n提交灵感');
let newId;
{
  const r = await call('POST', '/api/ideas', {
    title: '自测用灵感：把打印机挪到二楼',
    content: '一楼打印机排队严重，二楼那台几乎没人用，挪一下就能均衡。',
    category: '流程',
    tags: ['自测', '后勤'],
  });
  ok(r.status === 201, '提交返回 201', r.data);
  ok(r.data.status === 'pending', '新灵感状态是 pending');
  ok(r.data.voteCount === 0 && r.data.commentCount === 0, '新灵感计数从 0 开始');
  ok(r.data.tags.length === 2, '标签保存成功');
  newId = r.data.id; created.push(newId);

  const short = await call('POST', '/api/ideas', { title: '短', content: '也很短' });
  ok(short.status === 400, '标题太短被拒（400）');
  ok(/标题/.test(short.data.error), '错误信息点名是标题的问题', short.data);

  const badCat = await call('POST', '/api/ideas', {
    title: '分类不合法的测试灵感', content: '内容够长够长够长够长', category: '外星人',
  });
  ok(badCat.status === 400, '非法分类被拒');

  const anon = await call('POST', '/api/ideas', {
    title: '自测用匿名灵感：食堂加个素食窗口', content: '茹素的同事现在只能自己带饭，加个窗口就行。',
    category: '流程', isAnonymous: true,
  });
  ok(anon.data.author.name === '匿名', '匿名提交作者显示为匿名');
  created.push(anon.data.id);
}

/* ---------- 投票 ---------- */
console.log('\n投票');
{
  const before = (await call('GET', `/api/ideas/${newId}`)).data.voteCount;

  const v1 = await call('POST', `/api/ideas/${newId}/vote`);
  ok(v1.data.voted === true && v1.data.voteCount === before + 1, '第一次投票 +1');

  const v2 = await call('POST', `/api/ideas/${newId}/vote`);
  ok(v2.data.voted === false && v2.data.voteCount === before, '再点一次是撤票，回到原值');

  // 并发：同一个用户同时发 8 次
  await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/ideas/${newId}/vote`)));
  const after = (await call('GET', `/api/ideas/${newId}`)).data.voteCount;
  ok(after === before || after === before + 1, `并发 8 次投票后票数仍在 0/1 之间（实际 ${after - before}）`);

  // 不同用户各投一票
  await call('POST', `/api/ideas/${newId}/vote`, undefined, REVIEWER);
  await call('POST', `/api/ideas/${newId}/vote`, undefined, REVIEWER2);
  const multi = (await call('GET', `/api/ideas/${newId}`)).data.voteCount;
  ok(multi >= 2, `不同用户的票会累加（实际 ${multi}）`);

  const ghost = await call('POST', '/api/ideas/999999/vote');
  ok(ghost.status === 404, '给不存在的灵感投票返回 404');
}

/* ---------- 评论 ---------- */
console.log('\n讨论');
{
  const c = await call('POST', `/api/ideas/${newId}/comments`, { body: '同意，我这周就能搬。' });
  ok(c.status === 201 && c.data.commentCount === 1, '发表评论后计数变成 1', c.data);
  ok(c.data.author.name === '陈屿', '评论带上了作者名');

  const empty = await call('POST', `/api/ideas/${newId}/comments`, { body: '   ' });
  ok(empty.status === 400, '空评论被拒');

  const reply = await call('POST', `/api/ideas/${newId}/comments`, { body: '我也来搬。', parentId: c.data.id });
  ok(reply.status === 201, '回复评论成功');

  const detail = await call('GET', `/api/ideas/${newId}`);
  ok(detail.data.commentCount === 2 && detail.data.comments.length === 2, '详情里评论数与列表一致');
}

/* ---------- 状态流转 ---------- */
console.log('\n状态流转');
{
  const bad = await call('PATCH', `/api/ideas/${newId}/status`, { status: 'archived' }, MEMBER);
  ok(bad.status === 403, '普通成员不能流转状态（403）', bad.data);

  const skip = await call('PATCH', `/api/ideas/${newId}/status`, { status: 'draft' });
  ok(skip.status === 400, 'pending → draft 这种非法流转被拒');

  const r1 = await call('PATCH', `/api/ideas/${newId}/status`, { status: 'reviewing' });
  ok(r1.status === 200 && r1.data.status === 'reviewing', '认领评审成功');

  const noReason = await call('PATCH', `/api/ideas/${newId}/status`, { status: 'rejected' });
  ok(noReason.status === 400 && /理由/.test(noReason.data.error), '否决不填理由被拒');

  const r2 = await call('PATCH', `/api/ideas/${newId}/status`, { status: 'adopted', ownerId: REVIEWER });
  ok(r2.status === 200, '采纳成功');
  ok(/^IDEA-\d{4}-\d{4}$/.test(r2.data.code), `生成了正式编号 ${r2.data.code}`);
  ok(r2.data.owner && r2.data.owner.id === REVIEWER, '负责人指派成功');
  ok(!!r2.data.adoptedAt, '记录了采纳时间');

  const again = await call('PATCH', `/api/ideas/${newId}/status`, { status: 'adopted' });
  ok(again.status === 409, '重复采纳返回 409');

  const detail = await call('GET', `/api/ideas/${newId}`);
  const adoptAct = detail.data.activities.find(a => a.toStatus === 'adopted');
  ok(!!adoptAct, '采纳这件事写进了流转记录');
  ok(adoptAct.highlight === true, '采纳记录带高亮标记');
}

/* ---------- 并发采纳 ---------- */
console.log('\n并发采纳（行级锁）');
{
  const t = await call('POST', '/api/ideas', {
    title: '自测用灵感：并发采纳压力测试', content: '这条灵感专门用来验证两个评审同时点采纳时会发生什么。',
    category: '技术',
  });
  created.push(t.data.id);
  await call('PATCH', `/api/ideas/${t.data.id}/status`, { status: 'reviewing' });

  const results = await Promise.all([REVIEWER, REVIEWER2, ADMIN, REVIEWER, REVIEWER2].map(u =>
    call('PATCH', `/api/ideas/${t.data.id}/status`, { status: 'adopted' }, u)));
  const won = results.filter(r => r.status === 200);
  ok(won.length === 1, `5 个并发采纳只有 1 个成功（实际 ${won.length}）`,
     results.map(r => r.status));

  const codes = new Set(won.map(r => r.data.code));
  ok(codes.size === 1, '只生成了一个编号，没有撞号');
}

/* ---------- 查重 ---------- */
console.log('\n提交查重');
{
  const r = await call('GET', '/api/ideas/similar?q=' + encodeURIComponent('用大模型给工单打标签'));
  ok(r.status === 200, '查重接口返回 200');
  ok(r.data.items.length >= 1, `找到了相似灵感（${r.data.items.length} 条）`);
  ok(r.data.items.every(i => typeof i.score === 'number'), '每条都带相似度百分比');

  const shortQ = await call('GET', '/api/ideas/similar?q=好');
  ok(shortQ.data.items.length === 0, '关键词太短时不做查重（省一次全表扫）');
}

/* ---------- 统计 ---------- */
console.log('\n统计看板');
{
  const r = await call('GET', '/api/stats/overview');
  const all = await call('GET', '/api/ideas?status=all&pageSize=100');
  ok(r.data.tiles.total === all.data.total, `累计数与实际条数一致（${r.data.tiles.total}）`);

  const adopted = await call('GET', '/api/ideas?status=adopted&pageSize=100');
  ok(r.data.tiles.adopted === adopted.data.total, '已采纳数与正式库条数一致');

  const catSum = r.data.byCategory.reduce((s, c) => s + c.value, 0);
  ok(catSum === r.data.tiles.total, '分类分布加起来等于总数');

  const f = r.data.funnel.map(x => x.value);
  ok(f[0] >= f[1] && f[1] >= f[2] && f[2] >= f[3], `漏斗逐级递减 [${f.join(' → ')}]`);
  ok(r.data.tiles.adoptRate >= 0 && r.data.tiles.adoptRate <= 100, '采纳率在 0-100 之间');
}


/* ---------- 登录注册（走真实 cookie，不用后门） ---------- */
console.log('\n登录与注册');
const stamp = Date.now().toString(36).slice(-6);
const U1 = `zt${stamp}a`, U2 = `zt${stamp}b`;
const PW = 'ideahub-test-8899';
{
  // 未登录时业务接口必须被拦下
  const anon = await call('GET', '/api/ideas', undefined, null);
  ok(anon.status === 401, `未登录访问灵感列表返回 401（实际 ${anon.status}）`);
  const anonHealth = await call('GET', '/api/health', undefined, null);
  ok(anonHealth.status === 200, '健康检查不需要登录');

  const cfg = await call('GET', '/api/auth/config', undefined, null);
  ok(cfg.status === 200 && typeof cfg.data.isEmpty === 'boolean', '/api/auth/config 不需要登录就能读');
  const wasEmpty = cfg.data.isEmpty;

  // 注册
  const c1 = makeClient();
  const reg = await c1('POST', '/api/auth/register',
    { username: U1, password: PW, name: '自测账号甲', dept: '测试' });
  ok(reg.status === 201, `注册返回 201（实际 ${reg.status}）`, reg.data);
  ok(!!reg.cookie, '注册后直接下发了会话 cookie，不用再登录一次');
  ok(reg.data.role === (wasEmpty ? 'admin' : 'member'),
     `首个账号自动成为管理员${wasEmpty ? '' : '（本次库里已有账号，应为 member）'}`, reg.data);

  // 带着 cookie 就能访问业务接口了
  const mine = await c1('GET', '/api/me');
  ok(mine.status === 200 && mine.data.username === U1, 'cookie 能换到当前登录人', mine.data);

  // 用户名唯一，且大小写不敏感
  const dup = await makeClient()('POST', '/api/auth/register',
    { username: U1.toUpperCase(), password: PW, name: '重名的人' });
  ok(dup.status === 409, `用户名大小写不同也算重复，返回 409（实际 ${dup.status}）`);

  // 弱密码挡掉
  const weak = await makeClient()('POST', '/api/auth/register',
    { username: U2, password: '123', name: '弱密码' });
  ok(weak.status === 400, '密码太短被拒');
  const digits = await makeClient()('POST', '/api/auth/register',
    { username: U2, password: '12345678901', name: '纯数字' });
  ok(digits.status === 400, '纯数字密码被拒');

  // 用户名格式
  const badName = await makeClient()('POST', '/api/auth/register',
    { username: '中文名', password: PW, name: '格式不对' });
  ok(badName.status === 400, '中文用户名被拒');

  // 再注册一个。库里已经有账号了，这个必须是普通成员 ——
  // 「第一个是管理员」如果写错成「每个都是管理员」，就是在这里露馅。
  const reg2 = await makeClient()('POST', '/api/auth/register',
    { username: U2, password: PW, name: '自测账号乙', dept: '测试' });
  ok(reg2.status === 201 && reg2.data.role === 'member',
     '第二个注册的人是普通成员，不是管理员', reg2.data);

  // 登录
  const c2 = makeClient();
  const bad = await c2('POST', '/api/auth/login', { username: U1, password: PW + 'x' });
  ok(bad.status === 401, `密码错了返回 401（实际 ${bad.status}）`);

  const nobody = await makeClient()('POST', '/api/auth/login',
    { username: 'nosuchuser' + stamp, password: PW });
  ok(nobody.status === 401 && nobody.data.error === bad.data.error,
     '用户不存在和密码错误返回同一句提示，不泄露用户名是否存在');

  const good = await c2('POST', '/api/auth/login', { username: U1, password: PW });
  ok(good.status === 200, '正确密码能登录');
  ok(!!good.cookie, '登录下发了会话 cookie');

  // 退出后 cookie 立刻失效
  await c2('POST', '/api/auth/logout');
  const after = await c2('GET', '/api/me');
  ok(after.status === 401, `退出后会话立刻失效（实际 ${after.status}）`);
}

/* ---------- 角色与权限 ---------- */
console.log('\n角色与权限');
{
  const meMember = await call('GET', '/api/me', undefined, MEMBER);
  ok(meMember.data.role === 'member', '种子里的周未是普通成员', meMember.data);

  const poolId = (await call('GET', '/api/ideas')).data.items
    .find(i => i.status === 'pending').id;

  const denied = await call('PATCH', `/api/ideas/${poolId}/status`, { status: 'adopted' }, MEMBER);
  ok(denied.status === 403, `普通成员采纳灵感被拒 403（实际 ${denied.status}）`, denied.data);

  const adminOnly = await call('GET', '/api/admin/users', undefined, MEMBER);
  ok(adminOnly.status === 403, `普通成员访问用户管理被拒 403（实际 ${adminOnly.status}）`);

  const asAdmin = await call('GET', '/api/admin/users', undefined, ADMIN);
  ok(asAdmin.status === 200 && Array.isArray(asAdmin.data.items),
     '管理员能列出用户', asAdmin.data);
  ok(asAdmin.data.items.every(u => u.username),
     '用户管理只列有账号的人，不列种子里的虚拟同事');

  ok(asAdmin.data.items.some(u => u.username === U1), '刚注册的自测账号出现在用户列表里');
  // 拿普通成员那个账号做提权测试。U1 是库里第一个账号，必然是唯一的管理员，
  // 降级它会被「最后一个管理员」的保护挡下来 —— 那是对的，但测不了提权。
  const target = asAdmin.data.items.find(u => u.username === U2);
  if (target) {
    const up = await call('PATCH', `/api/admin/users/${target.id}/role`, { role: 'reviewer' }, ADMIN);
    ok(up.status === 200 && up.data.role === 'reviewer', '管理员能把人升为评审委员', up.data);

    const nowCanReview = await call('PATCH', `/api/ideas/${poolId}/status`,
      { status: 'reviewing' }, target.id);
    ok(nowCanReview.status === 200, '升级后立刻就能流转灵感状态', nowCanReview.data);
    await call('PATCH', `/api/ideas/${poolId}/status`, { status: 'pending' }, target.id);

    const bogus = await call('PATCH', `/api/admin/users/${target.id}/role`, { role: '超级管理员' }, ADMIN);
    ok(bogus.status === 400, '不存在的角色被拒');

    // 降回普通成员，确认权限能收回去
    const down = await call('PATCH', `/api/admin/users/${target.id}/role`, { role: 'member' }, ADMIN);
    ok(down.status === 200 && down.data.role === 'member', '评审权限能收回去', down.data);
    const revoked = await call('PATCH', `/api/ideas/${poolId}/status`,
      { status: 'reviewing' }, target.id);
    ok(revoked.status === 403, `降级后立刻失去流转权限（实际 ${revoked.status}）`);

    const admins = (await call('GET', '/api/admin/users', undefined, ADMIN))
      .data.items.filter(u => u.role === 'admin');
    if (admins.length === 1) {
      const self = await call('PATCH', `/api/admin/users/${admins[0].id}/role`, { role: 'member' }, ADMIN);
      ok(self.status === 400, '最后一个管理员不能降级，否则系统会锁死', self.data);
    } else {
      ok(true, `管理员有 ${admins.length} 个，跳过「最后一个管理员」用例`);
    }
  }
}

/* ---------- 技术2按 externalId 上传客户附件 ---------- */
console.log('\n技术2客户附件接入');
let tech2TestKeyId = null;
let tech2TestClientId = null;
{
  const noKey = await keyCall('POST',
    '/api/ingest/client/file?externalId=missing&name=test.txt',
    new TextEncoder().encode('no key'), '', true);
  ok(noKey.status === 401, `附件接入口没有 API Key 返回 401（实际 ${noKey.status}）`);

  const made = await call('POST', '/api/admin/api-keys',
    { scope: 'tech2', name: '技术2附件接口自测' });
  ok(made.status === 201 && /^ih_tech2_/.test(made.data?.key || ''),
    '管理员能生成技术2附件自测 Key', made.data);
  tech2TestKeyId = made.data?.id || null;

  const externalId = `tech2-file-test-${stamp}`;
  const client = await keyCall('POST', '/api/ingest/client',
    { externalId, alias: '技术2附件接口自测客户' }, made.data.key);
  ok(client.status === 200 && client.data?.id, '技术2先按 externalId 建立客户', client.data);
  tech2TestClientId = client.data?.id || null;

  const sourceUrl = 'https://tech2.example/documents/test-report';
  const path = '/api/ingest/client/file?'
    + new URLSearchParams({ externalId, name: '接口自测报告.txt', sourceUrl, note: '自动化测试' });
  const uploaded = await keyCall('POST', path,
    new TextEncoder().encode('IdeaHub tech2 attachment integration test'), made.data.key, true);
  ok(uploaded.status === 201 && uploaded.data?.id,
    `技术2附件上传返回 201 和附件 ID（实际 ${uploaded.status}）`, uploaded.data);
  ok(uploaded.data?.externalId === externalId && uploaded.data?.sourceUrl === sourceUrl,
    '返回值包含 externalId 和 sourceUrl', uploaded.data);

  if (uploaded.data?.id) {
    const { rows } = await dbq(
      'SELECT scope, ref_id, source_url FROM attachments WHERE id = $1', [uploaded.data.id]);
    ok(rows[0]?.scope === 'client'
       && Number(rows[0]?.ref_id) === Number(tech2TestClientId)
       && rows[0]?.source_url === sourceUrl,
    '附件已关联到 externalId 对应客户并保存 sourceUrl', rows[0]);

    const removed = await call('DELETE', `/api/files/${uploaded.data.id}`);
    ok(removed.status === 200, '自测附件及磁盘文件已清理', removed.data);
  }

  const missingClient = await keyCall('POST',
    '/api/ingest/client/file?externalId=not-created&name=test.txt',
    new TextEncoder().encode('missing client'), made.data.key, true);
  ok(missingClient.status === 404, `未建档 externalId 返回 404（实际 ${missingClient.status}）`);
}

/* ---------- 清理 ---------- */
console.log('\n清理测试数据');
{
  const { close } = await import('../server/src/db/index.mjs');
  const query = dbq;
  for (const id of created) await query('DELETE FROM ideas WHERE id = $1', [id]);
  // 自测注册出来的是真账号，不删掉会一直堆在用户管理列表里
  const { rows: gone } = await query(
    `DELETE FROM users WHERE username LIKE 'zt%' AND name LIKE '自测账号%' RETURNING id`);
  ok(gone.length === 2, `自测账号已删除（${gone.length} 个）`);
  if (tech2TestClientId) {
    await query('DELETE FROM clients WHERE id = $1', [tech2TestClientId]);
  }
  if (tech2TestKeyId) {
    await query('DELETE FROM api_keys WHERE id = $1', [tech2TestKeyId]);
  }
  await query('SELECT recalc_hot_scores()');
  const { rows } = await query(`SELECT count(*)::int AS n FROM ideas WHERE title LIKE '自测用灵感%'`);
  ok(rows[0].n === 0, '测试数据已清理干净');
  await close();
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`  通过 ${pass}   失败 ${fail}`);
console.log(`${'─'.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
