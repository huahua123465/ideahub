/**
 * 种子数据：npm run db:seed
 *
 * 灌入的就是演示视频里那批内容，方便一上来就有东西看。
 * 上线前把这些换成真实灵感 —— 空池子没人愿意当第一个提的人，
 * 冷启动阶段先自己灌 20-30 条是必要的。
 */
import { query, tx, close } from './db/index.mjs';

const NAMED = [
  { name: '陈屿',   dept: '产品部', role: 'admin'    },  // id=1，当前登录人
  { name: '林知远', dept: '技术部', role: 'reviewer' },
  { name: '苏禾',   dept: '产品部', role: 'reviewer' },
  { name: '周未',   dept: '人力',   role: 'member'   },
  { name: '叶昭',   dept: '市场部', role: 'member'   },
  { name: '何叙',   dept: '技术部', role: 'member'   },
];

// 再造一批同事，让投票是真实的行而不是硬写的计数
const SURNAME = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜';
const GIVEN = ['嘉一','明轩','思远','雨桐','子涵','浩然','若冰','家豪','梦琪','俊杰',
               '晓峰','紫涵','宇航','欣怡','天佑','沐辰','静姝','煜城','诗涵','博文',
               '安然','langli','雪松','逸尘','清越','沁然','行舟','知微','langyu','秋白',
               '和光','听澜','南乔','景行','时雨','惟允','斯年','长庚','怀瑾','鹤鸣'];

const IDEAS = [
  { t:'用大模型自动给客服工单打标签', c:'技术', tags:['AI','降本'], st:'reviewing', days:3, votes:34, by:'林知远',
    d:'客服每天手动给几百条工单分类，既慢又不一致。可以接一个小模型，工单进来自动打「退款 / 物流 / 功能建议」等标签，人工只需复核。预计能省掉客服团队每天 2 小时。' },
  { t:'新人入职「第一周清单」自动化', c:'流程', tags:['入职','效率'], st:'pending', days:5, votes:28, by:'周未',
    d:'现在新人入职靠 HR 手动拉群、发文档、约人。做一个入职流程引擎：入职当天自动建群、推送必读文档、按角色约好 5 场 1v1。' },
  { t:'把周会改成异步文档 + 15 分钟决策会', c:'流程', tags:['会议','协作'], st:'pending', days:6, votes:41, by:'何叙', anon:true,
    d:'现在的周会 60 分钟里有 45 分钟在同步信息，这部分完全可以写成文档提前读。会上只留需要当场拍板的事。' },
  { t:'官网加一个「三分钟试用」的沙箱环境', c:'产品', tags:['增长','转化'], st:'reviewing', days:7, votes:52, by:'苏禾',
    d:'潜在客户现在必须注册才能看到产品长什么样，流失很大。做一个免注册的只读沙箱，塞进预置数据，让人三分钟内摸清楚。' },
  { t:'内部工具统一登录（SSO）', c:'技术', tags:['基建'], st:'pending', days:7, votes:19, by:'林知远',
    d:'现在内部有 7 个系统 7 套密码，新人入职要开 7 次账号，离职要关 7 次。接一套 SSO，一次登录全部打通。' },
  { t:'客户成功案例做成短视频而不是 PDF', c:'运营', tags:['内容','品牌'], st:'pending', days:7, votes:23, by:'叶昭',
    d:'现在的案例是 8 页 PDF，销售发出去基本没人看完。改成 90 秒竖版短视频，客户自己出镜讲，转发率会高很多。' },
  { t:'给报表系统加一个「订阅推送」', c:'产品', tags:['数据'], st:'pending', days:9, votes:17, by:'苏禾',
    d:'用户每天上来手动看同一张报表。加个订阅：选好报表和频率，到点自动推到企业微信。' },
  { t:'把构建流水线从 12 分钟压到 3 分钟', c:'技术', tags:['CI','效率'], st:'pending', days:11, votes:31, by:'何叙',
    d:'现在每次提交要等 12 分钟才知道有没有挂。用远程缓存 + 只跑受影响的测试，应该能压到 3 分钟以内。' },
  { t:'季度 OKR 复盘改成「灯塔案例」分享', c:'运营', tags:['文化'], st:'pending', days:12, votes:14, by:'叶昭', anon:true,
    d:'OKR 复盘现在是每个组念 PPT。改成每季度选 3 个做得最好的案例深讲，其余书面提交。' },
];

const ADOPTED = [
  { code:'IDEA-2026-0038', t:'搜索结果加入个性化排序',     c:'产品', own:'苏禾',   at:'2026-07-14', p:80,  votes:47,
    d:'所有人搜同一个词看到的结果完全一样。按用户所在团队和历史点击做一层轻量重排。' },
  { code:'IDEA-2026-0037', t:'移动端离线草稿箱',           c:'产品', own:'何叙',   at:'2026-06-30', p:100, votes:39,
    d:'地铁上写到一半网断了内容就没了。本地先存，联网后自动补传。' },
  { code:'IDEA-2026-0036', t:'客户健康分预警看板',         c:'运营', own:'叶昭',   at:'2026-06-11', p:55,  votes:44,
    d:'客户流失前通常有征兆：登录频次下降、工单变多。把这些指标合成一个分数，跌破阈值就提醒客户成功团队。' },
  { code:'IDEA-2026-0035', t:'内部 API 网关限流改造',      c:'技术', own:'林知远', at:'2026-05-22', p:100, votes:26,
    d:'一个下游服务抖动就把整条链路拖垮。网关层加令牌桶和熔断。' },
  { code:'IDEA-2026-0034', t:'新官网信息架构重做',         c:'产品', own:'周未',   at:'2026-04-30', p:35,  votes:33,
    d:'现在官网导航是按内部组织架构分的，客户根本看不懂。改成按「你想解决什么问题」组织。' },
  { code:'IDEA-2026-0033', t:'销售线索自动分配规则引擎',   c:'运营', own:'苏禾',   at:'2026-04-08', p:100, votes:21,
    d:'线索现在靠销售主管手动分，经常压着几十条没人跟。做一套按地区、行业、负载自动分配的规则。' },
];


// 被否决和归档的灵感。没有这些，采纳率会显示成 100% —— 一个一眼假的数字。
// 真实的灵感库里「提了没被采纳」才是多数，这也是采纳率有意义的前提。
const CLOSED = [
  { t:'给每个工位配一台独立打印机',       c:'流程', by:'周未',   st:'rejected', days:34, votes:6,
    r:'算过账，18 台打印机的采购加耗材一年比现在贵 4 倍，而排队问题挪一台机器就能解决。',
    d:'一楼打印机永远在排队，索性每人一台。' },
  { t:'自研一套内部 IM 替代企业微信',     c:'技术', by:'何叙',   st:'rejected', days:41, votes:11,
    r:'自研 IM 的长期维护成本远超收益，且要重做审计合规。已采纳其中「消息可搜索」的诉求，转到 0036。',
    d:'企业微信搜索太难用，历史记录也翻不到。' },
  { t:'把所有文档迁到自建 wiki',          c:'技术', by:'林知远', st:'rejected', days:47, votes:9,
    r:'迁移成本高且容易半途而废。先解决「找不到」而不是「放在哪」，已并入知识库项目。',
    d:'现在文档散在三个平台，谁也说不清哪份是最新的。' },
  { t:'取消所有例会',                     c:'流程', by:'叶昭',   st:'rejected', days:52, votes:22,
    r:'方向认同但一刀切风险太大。已采纳更温和的版本：周会改异步文档（在评审中）。',
    d:'会太多了，一周有九个会。' },
  { t:'官网加一个 AI 客服机器人',         c:'产品', by:'苏禾',   st:'rejected', days:58, votes:14,
    r:'当前工单量还不足以支撑，人工回复的满意度更高。等工单量翻倍再重新评估。',
    d:'半夜来的咨询没人接，第二天客户已经跑了。' },
  { t:'季度改成月度 OKR',                 c:'流程', by:'周未',   st:'rejected', days:63, votes:5,
    r:'月度周期太短，会把 OKR 变成任务清单。维持季度。',
    d:'季度太长了，中间容易跑偏。' },
  { t:'所有服务迁到 Kubernetes',          c:'技术', by:'何叙',   st:'rejected', days:71, votes:16,
    r:'现在一共 6 个服务，K8s 带来的运维复杂度大于收益。等服务数过 20 再说。',
    d:'现在部署还是手动 scp，太原始了。' },
  { t:'内部推出积分商城',                 c:'运营', by:'叶昭',   st:'rejected', days:78, votes:8,
    r:'外部积分体系的经验是三个月后无人问津。同样的预算直接发到团建更实在。',
    d:'用积分激励大家提灵感、写文档。' },
  { t:'把客户反馈同步到飞书多维表格',     c:'运营', by:'苏禾',   st:'archived', days:96, votes:4,
    r:'超过 90 天无人处理，自动归档',
    d:'反馈现在散在邮件里，没人汇总。' },
  { t:'内网加一个「谁在做什么」看板',     c:'流程', by:'林知远', st:'archived', days:104, votes:7,
    r:'超过 90 天无人处理，自动归档',
    d:'经常出现两个组在做同一件事，互相不知道。' },
  { t:'把测试环境的数据每周重置一次',     c:'技术', by:'何叙',   st:'archived', days:118, votes:3,
    r:'超过 90 天无人处理，自动归档',
    d:'测试环境数据脏得没法用了。' },
];

const COMMENTS = {
  '用大模型自动给客服工单打标签': [
    { by:'苏禾', h:50, t:'客服组去年统计过，工单里 60% 是物流和退款两类，这两类特征很明显，模型不用很大就能做到 90% 准确率。' },
    { by:'何叙', h:46, t:'技术上没问题。建议先跑影子模式：模型打标但不生效，跟人工结果比对两周，准确率达标再切。' },
    { by:'周未', h:20, t:'+1。另外希望保留人工修正的入口，修正数据可以回流去做微调。' },
  ],
  '把周会改成异步文档 + 15 分钟决策会': [
    { by:'林知远', h:80, t:'支持。但异步文档要有人真的写，不然就变成会也不开、文档也没有。建议轮值。' },
    { by:'叶昭',   h:30, t:'市场这边周会本来就短，可以先在我们组试两周看看效果。' },
  ],
  '官网加一个「三分钟试用」的沙箱环境': [
    { by:'周未', h:60, t:'销售那边最想要这个。现在演示环境要提前一天申请，客户在电话里等不了。' },
  ],
};

// 每条灵感的目标讨论数，与客户看过的演示效果一致。
// 手写的那几条排在最前，剩下的从下面的短评池里按 id 确定性地取，保证每次 seed 结果一样。
const TARGET_COMMENTS = {
  '用大模型自动给客服工单打标签': 12,
  '新人入职「第一周清单」自动化': 7,
  '把周会改成异步文档 + 15 分钟决策会': 23,
  '官网加一个「三分钟试用」的沙箱环境': 16,
  '内部工具统一登录（SSO）': 5,
  '客户成功案例做成短视频而不是 PDF': 9,
  '给报表系统加一个「订阅推送」': 4,
  '把构建流水线从 12 分钟压到 3 分钟': 11,
  '季度 OKR 复盘改成「灯塔案例」分享': 6,
};

const CHATTER = [
  '这个我早就想提了，支持。',
  '能不能先在一个组试点？全公司铺开风险有点大。',
  '需要多少人力？有粗略估算吗。',
  '和我们在做的那个方向有重叠，可以一起聊聊。',
  '数据能拿到吗？我记得那部分权限卡得比较严。',
  '同意方向，但优先级上我觉得排在 Q4 更合适。',
  '实施之前建议先跟客服组对一次，他们最有发言权。',
  '有没有现成的方案可以直接用，不一定要自己造。',
  '我这边可以出人配合。',
  '关键是谁来长期维护，不然三个月后又荒废了。',
  '成本这块能再细算一下吗，我担心比看上去贵。',
  '这个如果做了，我们组第一个用。',
  '之前有人提过类似的，可以翻一下历史记录。',
  '建议加一个灰度开关，出问题能立刻关掉。',
  '从用户角度看这个体感提升会很明显。',
  '技术上没什么难点，主要是流程要理顺。',
  '能不能量化一下收益？比如省多少时间。',
  '我个人保留意见，但不反对试一试。',
  '这事关键在推动，工具反而是次要的。',
  '如果做，希望文档同步跟上，别又是口口相传。',
  '排期上要注意别和上线周期撞车。',
  '赞成，但希望先把最小可用版本跑起来看看。',
  '我们去年评估过，当时的结论是时机没到，现在可能不一样了。',
  '有没有考虑过对老用户的影响？',
];

const ago = h => new Date(Date.now() - h * 3600_000).toISOString();

try {
  // ---------- 防呆 ----------
  // 这个脚本会 TRUNCATE 整个库。在生产上手滑跑一次，所有真实灵感就没了。
  // 所以：先报清楚要删掉多少东西；生产环境必须显式加 --force 才放行。
  const force = process.argv.includes('--force');
  let existing = 0;
  try {
    const { rows } = await query('SELECT count(*)::int AS n FROM ideas');
    existing = rows[0].n;
  } catch { /* 表还不存在，说明是全新库 */ }

  if (existing > 0) {
    console.log(`[seed] 注意：当前库里有 ${existing} 条灵感，这个脚本会全部清空后重灌。`);
    console.log('       注册的账号会保留，但所有灵感、投票和讨论都会没有。');
  }
  if (process.env.NODE_ENV === 'production' && !force) {
    console.error('[seed] 已中止：NODE_ENV=production。');
    console.error('       生产库不该被种子数据覆盖。真的要这么做就加 --force。');
    process.exit(1);
  }

  console.log('[seed] 开始灌入种子数据…');

  // ---------- 用户 ----------
  // 原来这里是 TRUNCATE ... users CASCADE，会把真实注册的账号一起抹掉 ——
  // 加了登录功能之后，那意味着谁重灌一次演示数据，全公司就都登不进来了，
  // 而且 sessions 也被级联清空，正在用的人当场被踢下线。
  // 现在只删「没有密码」的那些人，也就是种子造出来的虚拟同事。
  await query('DELETE FROM idea_activities');
  await query('DELETE FROM idea_comments');
  await query('DELETE FROM idea_votes');
  await query('DELETE FROM ideas');
  await query('DELETE FROM users WHERE password_hash IS NULL');

  const { rows: kept } = await query(
    'SELECT count(*)::int AS n FROM users WHERE password_hash IS NOT NULL');
  if (kept[0].n > 0) console.log(`[seed] 保留了 ${kept[0].n} 个真实注册的账号（只清演示数据）`);

  const uid = {};
  for (const u of NAMED) {
    const { rows } = await query(
      'INSERT INTO users(name, dept, role) VALUES($1,$2,$3) RETURNING id', [u.name, u.dept, u.role]);
    uid[u.name] = rows[0].id;
  }
  const extras = [];
  for (let i = 0; i < 90; i++) {
    // 交叉取姓和名，保证 90 个人不重名
    const name = SURNAME[(i * 7 + Math.floor(i / GIVEN.length)) % SURNAME.length] + GIVEN[i % GIVEN.length];
    const { rows } = await query(
      'INSERT INTO users(name, dept) VALUES($1,$2) RETURNING id', [name, ['产品部','技术部','运营','市场部','人力'][i % 5]]);
    extras.push(rows[0].id);
  }
  const allUsers = [...Object.values(uid), ...extras];
  globalThis.__users = allUsers;
  console.log(`[seed] 用户 ${allUsers.length} 人`);

  // ---------- 灵感池 ----------
  const idOf = {};
  for (const x of IDEAS) {
    const created = ago(x.days * 24 + 3);
    const { rows } = await query(`
      INSERT INTO ideas(title, content, category, tags, status, author_id, is_anonymous, view_count, created_at, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [x.t, x.d, x.c, x.tags, x.st, uid[x.by], !!x.anon, 40 + x.votes * 3, created]);
    idOf[x.t] = rows[0].id;

    await query(`INSERT INTO idea_activities(idea_id, actor_id, action, to_status, created_at)
                 VALUES($1,$2,'created','pending',$3)`, [rows[0].id, uid[x.by], created]);
    if (x.st === 'reviewing') {
      await query(`INSERT INTO idea_activities(idea_id, actor_id, action, from_status, to_status, created_at)
                   VALUES($1,$2,'status_changed','pending','reviewing',$3)`, [rows[0].id, uid['陈屿'], ago(48)]);
    }
    await castVotes(rows[0].id, x.votes, created);
  }
  console.log(`[seed] 灵感池 ${IDEAS.length} 条`);

  // ---------- 被否决 / 已归档 ----------
  for (const x of CLOSED) {
    const created = ago(x.days * 24 + 5);
    const closed = ago(x.days * 24 - 40);
    const { rows } = await query(`
      INSERT INTO ideas(title, content, category, tags, status, author_id, view_count, created_at, updated_at)
      VALUES($1,$2,$3,'{}',$4,$5,$6,$7,$7) RETURNING id`,
      [x.t, x.d, x.c, x.st, uid[x.by], 30 + x.votes * 4, created]);
    await query(`INSERT INTO idea_activities(idea_id, actor_id, action, to_status, created_at)
                 VALUES($1,$2,'created','pending',$3)`, [rows[0].id, uid[x.by], created]);
    await query(`INSERT INTO idea_activities(idea_id, actor_id, action, from_status, to_status, reason, created_at)
                 VALUES($1,$2,'status_changed','pending',$3::idea_status,$4,$5)`,
      [rows[0].id, x.st === 'archived' ? null : uid['陈屿'], x.st, x.r, closed]);
    await castVotes(rows[0].id, x.votes, created);
  }
  console.log(`[seed] 已否决 / 已归档 ${CLOSED.length} 条`);

  // ---------- 正式库 ----------
  for (const a of ADOPTED) {
    const created = new Date(new Date(a.at).getTime() - 20 * 86400_000).toISOString();
    const { rows } = await query(`
      INSERT INTO ideas(code, title, content, category, tags, status, author_id, owner_id,
                        adopted_at, adopted_by, progress, doc_url, view_count, created_at, updated_at)
      VALUES($1,$2,$3,$4,'{}','adopted',$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [a.code, a.t, a.d, a.c, uid[a.own], uid[a.own], a.at, uid['陈屿'], a.p,
       `https://docs.internal/${a.code.toLowerCase()}`, 200 + a.votes * 4, created]);

    await query(`INSERT INTO idea_activities(idea_id, actor_id, action, to_status, created_at)
                 VALUES($1,$2,'created','pending',$3)`, [rows[0].id, uid[a.own], created]);
    await query(`INSERT INTO idea_activities(idea_id, actor_id, action, from_status, to_status, created_at)
                 VALUES($1,$2,'status_changed','reviewing','adopted',$3)`, [rows[0].id, uid['陈屿'], a.at]);
    await castVotes(rows[0].id, a.votes, created);
  }
  console.log(`[seed] 正式库 ${ADOPTED.length} 条`);

  // 编号序列要跳到已用编号之后，否则下一条采纳会撞号
  await query(`SELECT setval('idea_code_seq', 38, true)`);

  // ---------- 讨论 ----------
  let n = 0;
  for (const [title, list] of Object.entries(COMMENTS)) {
    for (const c of list) {
      await query('INSERT INTO idea_comments(idea_id, user_id, body, created_at) VALUES($1,$2,$3,$4)',
        [idOf[title], uid[c.by], c.t, ago(c.h)]);
      n++;
    }
  }
  // 补齐到目标条数
  for (const [title, target] of Object.entries(TARGET_COMMENTS)) {
    const id = idOf[title];
    if (!id) continue;
    const have = (COMMENTS[title] || []).length;
    let s = id * 7919 + 104729;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    for (let k = have; k < target; k++) {
      const who = allUsers[Math.floor(rnd() * allUsers.length)];
      const text = CHATTER[Math.floor(rnd() * CHATTER.length)];
      await query('INSERT INTO idea_comments(idea_id, user_id, body, created_at) VALUES($1,$2,$3,$4)',
        // 补充的短评一律比手写的那几条新，这样详情页顶部展示的是有信息量的那几条
        [id, who, text, ago(1 + Math.floor(rnd() * 16))]);
      n++;
    }
  }
  console.log(`[seed] 讨论 ${n} 条`);

  await query('SELECT recalc_hot_scores()');

  const { rows: sum } = await query(`
    SELECT status::text AS status, count(*)::int AS n, sum(vote_count)::int AS votes
    FROM ideas GROUP BY status ORDER BY status`);
  console.log('[seed] 完成：');
  for (const r of sum) console.log(`        ${r.status.padEnd(10)} ${String(r.n).padStart(3)} 条，共 ${r.votes} 票`);
} catch (e) {
  console.error('[seed] 失败：', e.message);
  process.exitCode = 1;
} finally {
  await close();
}

/** 真实地插入 N 张票（从用户池里挑，不重复），让票数和 idea_votes 表对得上 */
async function castVotes(ideaId, count, since) {
  const pool = [...allUsersRef()];
  // 用 id 做种子打乱，保证每次 seed 结果一致
  let s = ideaId * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, Math.min(count, pool.length));
  for (const u of picked) {
    await query('INSERT INTO idea_votes(idea_id, user_id, created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [ideaId, u, since]);
  }
}
function allUsersRef() { return globalThis.__users; }
