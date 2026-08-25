/**
 * 内置演示数据。后端没起时前端自动用这份，界面完全可点。
 * 内容和 server/src/seed.mjs 保持一致，方便对照。
 *
 * 只在浏览器内存里改动，刷新即还原 —— 演示场合正好合适。
 */
import { logApi, logSql, logQueue } from './apilog.js';

const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
const ME = { id: 1, name: '陈屿', dept: '产品部', role: 'admin' };

let seq = 100;
let codeSeq = 38;

/** 和 server/src/schema.sql 的 hot_of 保持一致：支持 2 分、评论 1 分、按天衰减。
    演示模式是一份独立的假后端，热度条要能动起来就得在这儿也算一遍。 */
const hotOf = (votes, comments, createdAt) =>
  (votes * 2 + comments + 1) /
  Math.pow((Date.now() - new Date(createdAt).getTime()) / 86400000 + 2, 1.5);

const mk = (o) => ({
  id: o.id, code: o.code || null, title: o.title, content: o.content,
  category: o.category, tags: o.tags || [], status: o.status,
  author: o.anon ? { id: null, name: '匿名' } : { id: o.authorId ?? 2, name: o.author },
  isAnonymous: !!o.anon,
  voteCount: o.votes || 0, commentCount: (COMMENTS[o.id] || []).length,
  hotScore: hotOf(o.votes || 0, (COMMENTS[o.id] || []).length, o.createdAt),
  viewCount: o.views || 40 + (o.votes || 0) * 3, voted: false,
  owner: o.owner ? { id: 2, name: o.owner } : null,
  adoptedAt: o.adoptedAt || null, progress: o.progress || 0,
  docUrl: o.code ? `https://docs.internal/${o.code.toLowerCase()}` : null,
  createdAt: o.createdAt, updatedAt: o.createdAt,
  activities: o.activities || [],
});

const COMMENTS = {
  1: [
    { id: 901, author: { id: 3, name: '苏禾' }, createdAt: hoursAgo(50),
      body: '客服组去年统计过，工单里 60% 是物流和退款两类，这两类特征很明显，模型不用很大就能做到 90% 准确率。' },
    { id: 902, author: { id: 6, name: '何叙' }, createdAt: hoursAgo(46),
      body: '技术上没问题。建议先跑影子模式：模型打标但不生效，跟人工结果比对两周，准确率达标再切。' },
    { id: 903, author: { id: 4, name: '周未' }, createdAt: hoursAgo(20),
      body: '+1。另外希望保留人工修正的入口，修正数据可以回流去做微调。' },
  ],
  3: [
    { id: 904, author: { id: 2, name: '林知远' }, createdAt: hoursAgo(80),
      body: '支持。但异步文档要有人真的写，不然就变成会也不开、文档也没有。建议轮值。' },
    { id: 905, author: { id: 5, name: '叶昭' }, createdAt: hoursAgo(30),
      body: '市场这边周会本来就短，可以先在我们组试两周看看效果。' },
  ],
  4: [
    { id: 906, author: { id: 4, name: '周未' }, createdAt: hoursAgo(60),
      body: '销售那边最想要这个。现在演示环境要提前一天申请，客户在电话里等不了。' },
  ],
};

let IDEAS = [
  mk({ id:1, title:'用大模型自动给客服工单打标签', category:'技术', tags:['AI','降本'], status:'reviewing',
    votes:34, author:'林知远', createdAt:hoursAgo(75),
    content:'客服每天手动给几百条工单分类，既慢又不一致。可以接一个小模型，工单进来自动打「退款 / 物流 / 功能建议」等标签，人工只需复核。预计能省掉客服团队每天 2 小时。',
    activities:[{ id:1, text:'林知远 提交了这条灵感', createdAt:hoursAgo(75) },
                { id:2, text:'陈屿 认领评审，状态 → 评审中', createdAt:hoursAgo(48) }] }),
  mk({ id:2, title:'新人入职「第一周清单」自动化', category:'流程', tags:['入职','效率'], status:'pending',
    votes:28, author:'周未', createdAt:hoursAgo(123),
    content:'现在新人入职靠 HR 手动拉群、发文档、约人。做一个入职流程引擎：入职当天自动建群、推送必读文档、按角色约好 5 场 1v1。',
    activities:[{ id:3, text:'周未 提交了这条灵感', createdAt:hoursAgo(123) }] }),
  mk({ id:3, title:'把周会改成异步文档 + 15 分钟决策会', category:'流程', tags:['会议','协作'], status:'pending',
    votes:41, anon:true, author:'匿名', createdAt:hoursAgo(147),
    content:'现在的周会 60 分钟里有 45 分钟在同步信息，这部分完全可以写成文档提前读。会上只留需要当场拍板的事。',
    activities:[{ id:4, text:'匿名 提交了这条灵感', createdAt:hoursAgo(147) }] }),
  mk({ id:4, title:'官网加一个「三分钟试用」的沙箱环境', category:'产品', tags:['增长','转化'], status:'reviewing',
    votes:52, author:'苏禾', createdAt:hoursAgo(171),
    content:'潜在客户现在必须注册才能看到产品长什么样，流失很大。做一个免注册的只读沙箱，塞进预置数据，让人三分钟内摸清楚。',
    activities:[{ id:5, text:'苏禾 提交了这条灵感', createdAt:hoursAgo(171) },
                { id:6, text:'陈屿 认领评审，状态 → 评审中', createdAt:hoursAgo(40) }] }),
  mk({ id:5, title:'内部工具统一登录（SSO）', category:'技术', tags:['基建'], status:'pending',
    votes:19, author:'林知远', createdAt:hoursAgo(175),
    content:'现在内部有 7 个系统 7 套密码，新人入职要开 7 次账号，离职要关 7 次。接一套 SSO，一次登录全部打通。',
    activities:[{ id:7, text:'林知远 提交了这条灵感', createdAt:hoursAgo(175) }] }),
  mk({ id:6, title:'客户成功案例做成短视频而不是 PDF', category:'运营', tags:['内容','品牌'], status:'pending',
    votes:23, author:'叶昭', createdAt:hoursAgo(179),
    content:'现在的案例是 8 页 PDF，销售发出去基本没人看完。改成 90 秒竖版短视频，客户自己出镜讲，转发率会高很多。',
    activities:[{ id:8, text:'叶昭 提交了这条灵感', createdAt:hoursAgo(179) }] }),
  mk({ id:7, title:'给报表系统加一个「订阅推送」', category:'产品', tags:['数据'], status:'pending',
    votes:17, author:'苏禾', createdAt:hoursAgo(219),
    content:'用户每天上来手动看同一张报表。加个订阅：选好报表和频率，到点自动推到企业微信。',
    activities:[{ id:9, text:'苏禾 提交了这条灵感', createdAt:hoursAgo(219) }] }),
  mk({ id:8, title:'把构建流水线从 12 分钟压到 3 分钟', category:'技术', tags:['CI','效率'], status:'pending',
    votes:31, author:'何叙', createdAt:hoursAgo(267),
    content:'现在每次提交要等 12 分钟才知道有没有挂。用远程缓存 + 只跑受影响的测试，应该能压到 3 分钟以内。',
    activities:[{ id:10, text:'何叙 提交了这条灵感', createdAt:hoursAgo(267) }] }),
  mk({ id:9, title:'季度 OKR 复盘改成「灯塔案例」分享', category:'运营', tags:['文化'], status:'pending',
    votes:14, anon:true, author:'匿名', createdAt:hoursAgo(291),
    content:'OKR 复盘现在是每个组念 PPT。改成每季度选 3 个做得最好的案例深讲，其余书面提交。',
    activities:[{ id:11, text:'匿名 提交了这条灵感', createdAt:hoursAgo(291) }] }),

  mk({ id:10, code:'IDEA-2026-0038', title:'搜索结果加入个性化排序', category:'产品', status:'adopted',
    votes:47, author:'苏禾', owner:'苏禾', adoptedAt:'2026-07-14T02:00:00Z', progress:80, createdAt:'2026-06-24T02:00:00Z',
    content:'所有人搜同一个词看到的结果完全一样。按用户所在团队和历史点击做一层轻量重排。' }),
  mk({ id:11, code:'IDEA-2026-0037', title:'移动端离线草稿箱', category:'产品', status:'adopted',
    votes:39, author:'何叙', owner:'何叙', adoptedAt:'2026-06-30T02:00:00Z', progress:100, createdAt:'2026-06-10T02:00:00Z',
    content:'地铁上写到一半网断了内容就没了。本地先存，联网后自动补传。' }),
  mk({ id:12, code:'IDEA-2026-0036', title:'客户健康分预警看板', category:'运营', status:'adopted',
    votes:44, author:'叶昭', owner:'叶昭', adoptedAt:'2026-06-11T02:00:00Z', progress:55, createdAt:'2026-05-22T02:00:00Z',
    content:'客户流失前通常有征兆：登录频次下降、工单变多。把这些指标合成一个分数，跌破阈值就提醒客户成功团队。' }),
  mk({ id:13, code:'IDEA-2026-0035', title:'内部 API 网关限流改造', category:'技术', status:'adopted',
    votes:26, author:'林知远', owner:'林知远', adoptedAt:'2026-05-22T02:00:00Z', progress:100, createdAt:'2026-05-02T02:00:00Z',
    content:'一个下游服务抖动就把整条链路拖垮。网关层加令牌桶和熔断。' }),
  mk({ id:14, code:'IDEA-2026-0034', title:'新官网信息架构重做', category:'产品', status:'adopted',
    votes:33, author:'周未', owner:'周未', adoptedAt:'2026-04-30T02:00:00Z', progress:35, createdAt:'2026-04-10T02:00:00Z',
    content:'现在官网导航是按内部组织架构分的，客户根本看不懂。改成按「你想解决什么问题」组织。' }),
  mk({ id:15, code:'IDEA-2026-0033', title:'销售线索自动分配规则引擎', category:'运营', status:'adopted',
    votes:21, author:'苏禾', owner:'苏禾', adoptedAt:'2026-04-08T02:00:00Z', progress:100, createdAt:'2026-03-19T02:00:00Z',
    content:'线索现在靠销售主管手动分，经常压着几十条没人跟。做一套按地区、行业、负载自动分配的规则。' }),
];

/*
 * 团队资料库演示数据。
 * 早期 mock 只覆盖灵感池 / 正式库 / 统计，新增的十来个页面点进去会直接报
 * 「mock 没实现」。这会让“只看界面”失去意义，也没法做手机端视觉验收。
 * 下面只放少量但有代表性的记录，结构和真实接口保持一致。
 */
const TAGS = [
  { id:1, kind:'relation_stage', name:'暧昧期', active:true, usedBy:5 },
  { id:2, kind:'relation_stage', name:'已分手', active:true, usedBy:3 },
  { id:3, kind:'problem_type', name:'关系推进', active:true, usedBy:6 },
  { id:4, kind:'problem_type', name:'识人判断', active:true, usedBy:4 },
  { id:5, kind:'demand', name:'判断对方意图', active:true, usedBy:5 },
  { id:6, kind:'demand', name:'长期择偶', active:true, usedBy:2 },
  { id:7, kind:'content_type', name:'案例拆解', active:true, usedBy:7 },
  { id:8, kind:'content_type', name:'方法论', active:true, usedBy:4 },
];
const tagsOf = (...ids) => TAGS.filter(t => ids.includes(t.id));

let DEMANDS = [
  { id:201, title:'想知道对方是不是还在认真推进', quote:'他每天都会回消息，但从不主动约下一次见面。',
    scene:'暧昧两个月', realGoal:'判断是否值得继续投入', note:'来自评论区高频问题',
    sourceType:'comment', sourceUrl:'', tags:tagsOf(3,5), tagIds:[3,5], createdByName:'陈屿', createdAt:hoursAgo(18) },
  { id:202, title:'分手后什么时候适合重新联系', quote:'已经断联两周，我怕再等下去他就彻底忘了。',
    scene:'刚分手', realGoal:'获得明确的行动节点和退出条件', note:'',
    sourceType:'tech1', sourceUrl:'', tags:tagsOf(2,3), tagIds:[2,3], createdByName:'技术1', createdAt:hoursAgo(30) },
  { id:203, title:'建立一套长期择偶筛选标准', quote:'每次都被情绪浓度吸引，稳定之后才发现不合适。',
    scene:'无单一对象', realGoal:'减少重复进入同类关系', note:'高价值长期需求',
    sourceType:'manual', sourceUrl:'', tags:tagsOf(4,6), tagIds:[4,6], createdByName:'苏禾', createdAt:hoursAgo(44) },
];

let ACCOUNTS = [
  { id:301, channel:'persona', side:'own', platform:'小红书', handle:'主理人真人号', followers:28600,
    positioning:'强判断、案例拆解、方法论', note:'建立深度信任' },
  { id:302, channel:'persona', side:'benchmark', platform:'抖音', handle:'对标账号 A', followers:183000,
    positioning:'案例拆解型', note:'推理链展示完整' },
  { id:303, channel:'matrix', side:'own', platform:'小红书', handle:'矩阵号 01', followers:9200,
    positioning:'高频问题、情绪痛点', note:'关键词引流' },
  { id:304, channel:'live', side:'own', platform:'视频号', handle:'主理人直播间', followers:28600,
    positioning:'现场诊断与关系决策', note:'每周三、周六直播' },
];

let WORKS = [
  { id:401, channel:'persona', side:'own', accountId:301, accountName:'主理人真人号',
    title:'暧昧三个月突然变冷，问题出在哪一步', pillar:'C 案例拆解', publishedAt:'2026-08-22',
    url:'https://example.com/work/401', metrics:{ 曝光:63000, 完播:21000, 收藏:5800, 私信:380, 主页访问:2900 },
    note:'推理链完整，私信质量高', sourceType:'manual', tags:tagsOf(7), tagIds:[7] },
  { id:402, channel:'persona', side:'own', accountId:301, accountName:'主理人真人号',
    title:'我们怎么做一次完整的关系诊断', pillar:'D 方法论内容', publishedAt:'2026-08-20',
    url:'https://example.com/work/402', metrics:{ 曝光:35000, 完播:11800, 收藏:4200, 私信:265, 主页访问:2020 },
    note:'收藏率稳定', sourceType:'manual', tags:tagsOf(8), tagIds:[8] },
  { id:403, channel:'persona', side:'benchmark', accountId:302, accountName:'对标账号 A',
    title:'高价值关系里最容易忽略的三个信号', pillar:'B 识人内容', publishedAt:'2026-08-19',
    url:'https://example.com/work/403', metrics:{ 曝光:128000, 完播:53000, 收藏:9100, 私信:620, 主页访问:5100 },
    note:'开头强结论值得拆解', sourceType:'tech1', tags:tagsOf(4), tagIds:[4] },
  { id:404, channel:'matrix', side:'own', accountId:303, accountName:'矩阵号 01',
    title:'他为什么总是秒回却从不主动约我', pillar:'高频问题', publishedAt:'2026-08-23',
    url:'https://example.com/work/404', metrics:{ 曝光:12400, 完播:5900, 收藏:880, 私信:132, 主页访问:710 },
    note:'标题可继续做系列', sourceType:'manual', tags:tagsOf(5), tagIds:[5] },
  { id:405, channel:'live', side:'own', accountId:304, accountName:'主理人直播间',
    title:'关系推进中的三个验证节点', pillar:'连麦诊断', publishedAt:'2026-08-21',
    url:'https://example.com/work/405', metrics:{ 在线峰值:610, 停留分钟:19, 连麦数:7, 私信:156, 预约:31 },
    note:'连麦段预约转化最好', sourceType:'manual', tags:tagsOf(3), tagIds:[3] },
];

let PLAYBOOK = [
  { id:501, board:'sales', section:'tier', label:'S 级', title:'明确对象＋高紧迫度＋高支付能力',
    body:'直接进入单次咨询，重点转陪跑。', meta:{ 优先级:'最高' }, sort:10 },
  { id:502, board:'sales', section:'filter', label:'真实问题', title:'是否有明确对象和具体关系节点',
    body:'确认是否能提供关键事实与行为证据。', meta:{}, sort:10 },
  { id:503, board:'sales', section:'intake', label:'关系信息', title:'统一收集关系阶段与时间线',
    body:'认识方式、见面次数、公开度、关键事件、当前状态。', meta:{}, sort:10 },
  { id:504, board:'sales', section:'script', label:'私信初筛', title:'先判断问题，不急着成交',
    body:'先确认真实问题、紧迫度、支付可能性和配合度。', meta:{ 场景:'私信' }, sort:10 },
  { id:505, board:'delivery', section:'product', label:'阶梯 4', title:'单次咨询',
    body:'完成完整诊断，并判断是否值得进入陪跑。', meta:{ 类型:'咨询', 层级:'核心', 指标:'转陪跑率' }, sort:40 },
  { id:506, board:'delivery', section:'flow', label:'节点 3', title:'制定策略',
    body:'明确短期动作、中期目标、验证节点和退出条件。', meta:{ 负责人:'后端咨询师' }, sort:30 },
];

let CLIENTS = [
  { id:601, alias:'阿柚', tier:'S', stage:'coaching', source:'小红书私信', sourceType:'manual', ownerName:'苏禾',
    female:{ 年龄:29, 城市:'上海', 职业:'产品经理', 收入区间:'30–50w', 当前诉求:'推进确定关系' },
    male:{ 年龄:33, 职业:'投行', 经济状况:'好', 家庭:'独子，父母本地' },
    relation:{ 认识时间:'5个月', 方式:'朋友介绍', 见面次数:'11', 关系阶段:'暧昧后期', 当前状态:'稳定但不推进' },
    timeline:'认识 → 升温 → 一起出差 → 回避谈未来 → 见面频率下降', evidence:'聊天记录、朋友圈、约会照片',
    note:'重点验证长择意愿，已进入关系陪跑。', tags:tagsOf(1,3), tagIds:[1,3], fileCount:2,
    aiSituation:'关系有稳定投入，但承诺议题持续被回避。当前适合降低追问频率，观察对方是否主动补位。',
    aiUser:'执行力强，但焦虑时容易用追问换安全感。需要先稳定自己的行动边界。',
    deal:{ 产品:'关系陪跑', 金额:'¥12,800', 状态:'进行中' } },
  { id:602, alias:'小林', tier:'A', stage:'consulted', source:'直播连麦', sourceType:'manual', ownerName:'叶昭',
    female:{ 年龄:26, 城市:'杭州', 职业:'运营', 当前诉求:'看懂对方意图' }, male:{ 年龄:28, 职业:'程序员' },
    relation:{ 认识时间:'2个月', 方式:'同事', 关系阶段:'暧昧中', 当前状态:'升温中' },
    timeline:'同事认识 → 频繁吃饭 → 主动送生日礼物', evidence:'聊天记录、朋友圈', note:'已完成单次咨询。',
    tags:tagsOf(1,5), tagIds:[1,5], fileCount:1, deal:{ 产品:'单次咨询', 金额:'¥1,299', 状态:'已完成' } },
  { id:603, alias:'Nana', tier:'S', stage:'renewed', source:'转介绍', sourceType:'manual', ownerName:'陈屿',
    female:{ 年龄:34, 城市:'北京', 职业:'创业者', 当前诉求:'长期择偶系统' }, male:{},
    relation:{ 关系阶段:'无单一对象', 当前状态:'主动筛选中' }, timeline:'建立自己的识人和择偶判断标准。',
    evidence:'过往三段关系复盘', note:'已续费第二期。', tags:tagsOf(4,6), tagIds:[4,6], fileCount:0,
    deal:{ 产品:'成长陪跑', 金额:'¥28,000', 状态:'已续费' } },
];

let CASES = [
  { id:701, clientId:601, clientAlias:'阿柚', code:'CASE-2026-001', title:'高价值男性回避承诺，如何验证长择意愿',
    clientTags:'29岁 / 上海 / 暧昧后期', maleTags:'33岁 / 投行 / 回避承诺', problem:'稳定见面但不推进',
    judgement:'长择意愿存在，但需要验证主动补位。', strategy:'降低追问、建立边界、观察主动投入。',
    feedback:'第六周主动谈及同居。', outcome:'推进成功', reusable:true, tags:tagsOf(3,7), tagIds:[3,7] },
  { id:702, clientId:602, clientAlias:'小林', code:'CASE-2026-002', title:'暧昧升温期如何判断真实投入',
    clientTags:'26岁 / 杭州 / 暧昧中', maleTags:'28岁 / 程序员', problem:'有互动但缺少明确推进',
    judgement:'需要用行动节点而不是聊天频率判断。', strategy:'设置两周观察窗口。', feedback:'进行中。',
    outcome:'进行中', reusable:false, tags:tagsOf(1,4), tagIds:[1,4] },
];

let REPORTS = [
  { id:801, authorId:1, authorName:'陈屿', reviewerId:2, reviewerName:'苏禾', reportDate:'2026-08-24',
    title:'完成客户详情页信息复核', summary:'核对九区信息和技术2分析字段。', resultUrl:'', blockers:'',
    needHelp:'请复核 AI 分析区的业务文案', feedback:'结构清楚，补一个空态说明即可。', status:'已反馈', fileCount:1 },
  { id:802, authorId:1, authorName:'陈屿', reviewerId:3, reviewerName:'叶昭', reportDate:'2026-08-23',
    title:'整理本周高频用户需求', summary:'从私信和评论中归并出 12 个高频问题。', resultUrl:'', blockers:'',
    needHelp:'需要内容组确认优先级', feedback:'', status:'待审核', fileCount:0 },
];

const PEOPLE = [
  { id:1, name:'陈屿', dept:'产品部' }, { id:2, name:'苏禾', dept:'内容组' },
  { id:3, name:'叶昭', dept:'运营组' }, { id:4, name:'林知远', dept:'技术组' },
];

/** 和后端一致的热度公式 */
const hot = i => (i.voteCount + i.commentCount * 2) /
  Math.pow((Date.now() - new Date(i.createdAt)) / 3.6e6 + 2, 1.5);

/** 把 mock 当成一个假后端来用，路径和真接口完全一致 */
export async function handle(method, path, body) {
  await new Promise(r => setTimeout(r, 90));   // 假装有网络延迟，动画才自然
  const [p, search] = path.split('?');
  const q = new URLSearchParams(search || '');
  logApi(method, path, 200);

  if (p === '/api/me') return ME;

  if (p === '/api/import/provider' && method === 'GET') {
    return { configured:false, canManage:true, baseUrl:'https://ai.cangyuansuanli.cn/v1',
      model:'', source:'environment', hasKey:false };
  }
  if (p === '/api/import/provider/models' && method === 'POST') {
    return { baseUrl:'https://ai.cangyuansuanli.cn/v1',
      models:['gpt-5.4-mini','gpt-5.4','gpt-5.5','gpt-5.6-terra','claude-sonnet-4-6'] };
  }
  if (p === '/api/import/provider' && method === 'POST') {
    return { configured:true, canManage:true, baseUrl:'https://ai.cangyuansuanli.cn/v1',
      model:body.model, source:'saved', hasKey:true };
  }

  /* 智能导入的纯前端演示兜底。真实后端会调用 OpenAI；这里明确标成 rules，
     只为了断网看界面时仍能走完整个预览和确认流程。 */
  if (p === '/api/import/analyze' && method === 'POST') {
    const text = String(body?.text || '').trim();
    const keys = ['content','category','quote','scene','realGoal','note','url','pillar','side','section','label','body',
      'alias','tier','stage','source','timeline','problem','judgement','strategy','outcome','summary','blockers','needHelp','resultUrl'];
    const data = values => Object.fromEntries(keys.map(k => [k, String(values?.[k] || '')]));
    const title = (text.split(/[。！？!?\n]/).find(Boolean) || '待整理内容').slice(0, 42);
    const suggestions = [];
    if (/(张总|客户|咨询|微信|跟进)/.test(text)) suggestions.push({
      target:'client', board:'clients', confidence:.76, reason:'识别到具体客户和跟进信息', title:'张总',
      tags:['客户跟进'], data:data({ alias:'张总', stage:text.includes('微信')?'wechat':'lead', source:'智能导入', note:text, timeline:text }),
    });
    if (/(反馈|希望|需要|想要|痛点)/.test(text)) suggestions.push({
      target:'demand', board:'demands', confidence:.72, reason:'识别到明确的用户诉求', title,
      tags:['用户需求'], data:data({ quote:text, realGoal:title }),
    });
    if (/(流程|机制|SOP|话术|自动通知)/i.test(text)) suggestions.push({
      target:'playbook', board:'sales', confidence:.68, reason:'识别到可复用的跟进流程', title:'客户首次响应与提醒流程',
      tags:['跟进','流程'], data:data({ body:text, section:'rule', label:'跟进机制' }),
    });
    if (!suggestions.length) suggestions.push({
      target:'idea', board:'pool', confidence:.64, reason:'当前更像一条值得讨论的新想法', title,
      tags:['智能导入'], data:data({ content:text, category:/系统|接口|AI|自动/.test(text)?'技术':'其他' }),
    });
    return { mode:'rules', importId:'demo-smart-import-001', overview:`已整理成 ${suggestions.length} 条可编辑草稿`, suggestions,
      warning:'当前为演示数据，本次使用基础规则识别。' };
  }

  if (p === '/api/import/commit' && method === 'POST') {
    const now = new Date().toISOString();
    const saved = (body?.items || []).map(s => {
      const id = ++seq, d = s.data || {};
      if (s.target === 'idea') IDEAS.unshift(mk({ id, title:s.title, content:d.content||s.title,
        category:d.category||'其他', tags:s.tags||[], status:'pending', votes:0, author:ME.name, authorId:ME.id, createdAt:now }));
      if (s.target === 'demand') DEMANDS.unshift({ id, title:s.title, quote:d.quote, scene:d.scene, realGoal:d.realGoal,
        note:d.note, sourceType:'manual', sourceUrl:body.sourceUrl||'', tags:[], tagIds:[], createdByName:ME.name, createdAt:now });
      if (s.target === 'work') WORKS.unshift({ id, channel:s.board, side:d.side||'own', title:s.title, url:d.url||body.sourceUrl||'',
        pillar:d.pillar, publishedAt:new Date().toISOString().slice(0,10), metrics:{}, note:d.note, sourceType:'manual', tags:[], tagIds:[] });
      if (s.target === 'playbook') PLAYBOOK.unshift({ id, board:s.board, section:d.section||'rule', label:d.label,
        title:s.title, body:d.body, meta:{}, sort:0 });
      if (s.target === 'client') CLIENTS.unshift({ id, alias:d.alias||s.title, tier:d.tier||'', stage:d.stage||'lead',
        source:d.source||'智能导入', sourceType:'manual', ownerName:ME.name, female:{}, male:{}, relation:{},
        timeline:d.timeline, evidence:'', note:d.note, tags:[], tagIds:[], fileCount:0, deal:{} });
      if (s.target === 'case') CASES.unshift({ id, title:s.title, clientTags:'', maleTags:'', problem:d.problem,
        judgement:d.judgement, strategy:d.strategy, feedback:'', outcome:d.outcome, reusable:false, tags:[], tagIds:[] });
      if (s.target === 'report') REPORTS.unshift({ id, authorId:ME.id, authorName:ME.name, reviewerId:null, reviewerName:'',
        reportDate:new Date().toISOString().slice(0,10), title:s.title, summary:d.summary, resultUrl:d.resultUrl,
        blockers:d.blockers, needHelp:d.needHelp, feedback:'', status:'待审核', fileCount:0 });
      return { id, target:s.target, board:s.board, title:s.title, created:true };
    });
    return { ok:true, items:saved, created:saved.length, existed:0 };
  }

  /* ---------- 团队资料库：演示模式读取 ---------- */
  if (p === '/api/tags' && method === 'GET') {
    const byKind = {};
    for (const t of TAGS) (byKind[t.kind] ||= []).push(t);
    return { items: TAGS, byKind, kinds: Object.keys(byKind) };
  }
  if (p === '/api/users' && method === 'GET') return { items: PEOPLE };
  if (p === '/api/admin/api-keys' && method === 'GET') return { items: [] };

  if (p === '/api/demands' && method === 'GET') {
    let items = DEMANDS;
    if (q.get('sourceType')) items = items.filter(x => x.sourceType === q.get('sourceType'));
    return { items: [...items] };
  }
  if (p === '/api/accounts' && method === 'GET') {
    let items = ACCOUNTS;
    if (q.get('channel')) items = items.filter(x => x.channel === q.get('channel'));
    if (q.get('side')) items = items.filter(x => x.side === q.get('side'));
    return { items: [...items] };
  }
  if (p === '/api/works' && method === 'GET') {
    let items = WORKS;
    if (q.get('channel')) items = items.filter(x => x.channel === q.get('channel'));
    if (q.get('side')) items = items.filter(x => x.side === q.get('side'));
    return { items: [...items] };
  }
  if (p === '/api/playbook' && method === 'GET') {
    let items = PLAYBOOK;
    if (q.get('board')) items = items.filter(x => x.board === q.get('board'));
    if (q.get('section')) items = items.filter(x => x.section === q.get('section'));
    return { items: [...items] };
  }
  if (p === '/api/clients' && method === 'GET') {
    let items = CLIENTS;
    if (q.get('tier')) items = items.filter(x => x.tier === q.get('tier'));
    if (q.get('stage')) items = items.filter(x => x.stage === q.get('stage'));
    return { items: [...items] };
  }
  if (p === '/api/cases' && method === 'GET') {
    let items = CASES;
    if (q.get('outcome')) items = items.filter(x => x.outcome === q.get('outcome'));
    return { items: [...items] };
  }
  if (p === '/api/reports' && method === 'GET') {
    const scope = q.get('scope') || 'mine';
    const items = scope === 'review' ? REPORTS.filter(x => x.reviewerId === ME.id)
      : scope === 'mine' ? REPORTS.filter(x => x.authorId === ME.id) : REPORTS;
    return { items: [...items] };
  }

  const clientDetail = p.match(/^\/api\/clients\/(\d+)$/);
  if (clientDetail && method === 'GET') {
    const c = CLIENTS.find(x => x.id === Number(clientDetail[1]));
    if (!c) throw Object.assign(new Error('没有这个客户'), { status:404 });
    return {
      ...c,
      deliveries: c.id === 601 ? [
        { id:1, happenedAt:'2026-08-21', kind:'陪跑复盘', summary:'复盘边界动作和对方反馈，进入第二轮验证。', createdByName:'苏禾' },
        { id:2, happenedAt:'2026-08-14', kind:'策略会', summary:'确定降低追问频率和 60 天退出条件。', createdByName:'苏禾' },
      ] : [],
      cases: CASES.filter(x => x.clientId === c.id).map(x => ({
        id:x.id, code:x.code, title:x.title, outcome:x.outcome, reusable:x.reusable,
      })),
      files: c.fileCount ? [{ id:1, name:'聊天记录分析报告.pdf', size:248000, createdAt:'2026-08-18' }] : [],
    };
  }

  if (/^\/api\/(clients|reports)\/\d+\/files$/.test(p) && method === 'GET') return { items: [] };

  if (p === '/api/funnel' && method === 'GET') {
    return {
      principle:'不要只看播放量。更重要的是每 100 个精准曝光最终产生多少有效客资、咨询和陪跑收入。',
      steps:[
        { name:'曝光', value:118400, source:'作品指标' },
        { name:'主页访问', value:5630, conv:4.8, source:'作品指标' },
        { name:'私信', value:933, conv:16.6, source:'作品 + 直播指标' },
        { name:'有效客资', value:186, conv:19.9, source:'客户档案' },
        { name:'加微信', value:121, conv:65.1, source:'客户档案' },
        { name:'付费咨询', value:47, conv:38.8, source:'客户档案' },
        { name:'陪跑成交', value:16, conv:34, source:'客户档案' },
        { name:'续费/转介绍', value:6, conv:37.5, source:'客户档案' },
      ],
      layers:[
        { name:'内容层', metrics:{ 曝光:118400, 完播:38700, 收藏:10880, '主页访问率(%)':4.8 }, watch:'选题和表达是否吸引精准用户' },
        { name:'直播层', metrics:{ 在线峰值:610, 停留分钟:19, 连麦数:7, 私信:156, 预约:31 }, watch:'现场信任与成交结构是否有效' },
        { name:'私域层', metrics:{ 有效客资:186, 加微:121, '加微率(%)':65.1 }, watch:'筛选与承接是否顺畅' },
        { name:'咨询层', metrics:{ 付费咨询:47, '转陪跑率(%)':34 }, watch:'诊断产品是否有价值与升级空间' },
        { name:'陪跑层', metrics:{ 陪跑成交:16, 续费:6, '续费率(%)':37.5 }, watch:'高客单交付是否健康' },
        { name:'产品层', metrics:{ 案例入库:4, 可复用案例:3, '可复用率(%)':75 }, watch:'标准化产品是否真正承接需求' },
      ],
      clientsByStage:{ consulted:1, coaching:1, renewed:1 },
    };
  }

  if (p === '/api/links' && method === 'GET') {
    const entity = q.get('entity');
    const id = Number(q.get('id'));
    const items = entity === 'idea' && id === 1 ? [
      { id:1, entity:'demand', entityLabel:'用户需求', board:'demands', refId:201,
        title:'想知道对方是不是还在认真推进', note:'同类判断需求' },
    ] : entity === 'client' && id === 601 ? [
      { id:2, entity:'case', entityLabel:'案例', board:'cases', refId:701,
        title:'高价值男性回避承诺，如何验证长择意愿', note:'由客户转入' },
    ] : [];
    return { items };
  }

  if (p === '/api/search' && method === 'GET') {
    const kw = (q.get('q') || '').trim().toLowerCase();
    const smart = q.get('mode') === 'smart';
    const terms = [kw];
    if (smart && /(不回|没回|不联系|消息不理|联系不上)/.test(kw)) terms.push('断联', '失联', '冷处理');
    if (smart && /(客服.*慢|回复.*慢|响应.*慢)/.test(kw)) terms.push('回复超时', '跟进慢', '首次响应');
    if (smart && /(想法|点子)/.test(kw)) terms.push('灵感', '创意');
    const all = [
      ...IDEAS.map(x => ({ id:x.id, entity:'idea', board:x.status === 'adopted' ? 'formal' : 'pool',
        title:x.title, module:x.status === 'adopted' ? '正式库' : '灵感池', snippet:x.content, tags:x.tags || [] })),
      ...DEMANDS.map(x => ({ id:x.id, entity:'demand', board:'demands', title:x.title,
        module:'用户需求', snippet:x.realGoal, tags:x.tags.map(t => t.name) })),
      ...WORKS.map(x => ({ id:x.id, entity:'work', board:x.channel, title:x.title,
        module:{ persona:'真人作品', matrix:'矩阵作品', live:'真人直播' }[x.channel], snippet:x.note, tags:x.tags.map(t => t.name) })),
      ...CLIENTS.map(x => ({ id:x.id, entity:'client', board:'clients', title:x.alias,
        module:'客户档案', snippet:[x.note,x.timeline,x.evidence].filter(Boolean).join(' '), tags:x.tags.map(t => t.name) })),
      ...CASES.map(x => ({ id:x.id, entity:'case', board:'cases', title:x.title,
        module:'案例库', snippet:x.judgement, tags:x.tags.map(t => t.name) })),
      ...REPORTS.map(x => ({ id:x.id, entity:'report', board:'reports', title:x.title,
        module:'工作提交', snippet:x.summary, tags:[] })),
    ];
    const entity = q.get('entity');
    const items = all.filter(x => (!entity || x.entity === entity) &&
      (!kw || terms.some(term => `${x.title} ${x.snippet} ${x.tags.join(' ')}`.toLowerCase().includes(term))))
      .map(x => {
        const blob = `${x.title} ${x.snippet} ${x.tags.join(' ')}`.toLowerCase();
        const exact = blob.includes(kw);
        return { ...x, matchType: exact ? 'keyword' : 'semantic',
          matchedTerm: exact ? '' : terms.slice(1).find(term => blob.includes(term)) || '' };
      }).slice(0, Number(q.get('limit')) || 30);
    const groupMap = new Map();
    for (const x of items) if (!groupMap.has(x.entity)) groupMap.set(x.entity, x.module);
    return {
      items, groups:[...groupMap].map(([entity_,label]) => ({ entity:entity_, label })),
      q:kw, total:items.length, mode:smart ? 'smart' : 'keyword',
      requestedMode:smart ? 'smart' : 'keyword', terms, intent:kw, fallback:false, warning:'',
    };
  }

  if (p === '/api/notifications' && method === 'GET') return { items:[], unread:0 };
  if (p === '/api/chat/peers' && method === 'GET') return { items:[], groups:[], unreadTotal:0 };

  // 「只看界面」模式下没有后端，也就没有账号体系。
  // 这里把账号相关的接口都兜住，免得点了用户管理或退出登录就报错。
  if (p === '/api/auth/logout') { location.replace('/login.html'); return { ok: true }; }
  if (p === '/api/admin/users') {
    return { items: [{ ...ME, username: 'demo', ideaCount: 3, lastLoginAt: new Date().toISOString() }] };
  }
  if (p.startsWith('/api/admin/') || p === '/api/auth/password') {
    throw Object.assign(new Error('演示模式下不能改账号，连上后端才行'), { status: 400 });
  }

  if (p === '/api/ideas' && method === 'GET') {
    const status = q.get('status') || 'pool';
    let items = IDEAS.filter(i =>
      status === 'pool' ? ['pending', 'reviewing'].includes(i.status)
      : status === 'all' ? true
      : i.status === status);
    if (q.get('category')) items = items.filter(i => i.category === q.get('category'));
    if (q.get('mine') === '1') items = items.filter(i => i.author.id === ME.id);
    const kw = q.get('q');
    if (kw) items = items.filter(i => (i.title + i.content).includes(kw));

    const sort = q.get('sort') || 'hot';
    items = [...items].sort(
      sort === 'new'     ? (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    : sort === 'adopted' ? (a, b) => new Date(b.adoptedAt || 0) - new Date(a.adoptedAt || 0)
    :                      (a, b) => hot(b) - hot(a));
    // 列表返回独立快照，模拟真实 HTTP 的 JSON 反序列化边界。
    // 否则前端乐观投票会先改到 IDEAS 本体，假接口再反转一次，演示模式下票数就会原地复原。
    const snapshots = items.map(i => ({ ...i, author: { ...i.author }, tags: [...(i.tags || [])] }));
    return { items: snapshots, total: snapshots.length, page: 1, pageSize: 30 };
  }

  if (p === '/api/ideas/similar') {
    const kw = (q.get('q') || '').trim();
    if (kw.length < 4) return { items: [] };
    const bigrams = s => new Set([...s.replace(/[\s，。、；：？！「」（）]/g, '')]
      .map((_, i, a) => a.slice(i, i + 2).join('')).slice(0, -1));
    const A = bigrams(kw);
    return {
      items: IDEAS.map(i => {
        const B = bigrams(i.title);
        const inter = [...A].filter(x => B.has(x)).length;
        const union = new Set([...A, ...B]).size;
        return { id: i.id, title: i.title, status: i.status, score: Math.round(inter / (union || 1) * 100) };
      }).filter(x => x.score > 20).sort((a, b) => b.score - a.score).slice(0, 3),
    };
  }

  const detail = p.match(/^\/api\/ideas\/(\d+)$/);
  if (detail && method === 'GET') {
    const i = IDEAS.find(x => x.id === +detail[1]);
    if (!i) throw Object.assign(new Error('找不到这条灵感'), { status: 404 });
    return { ...i, comments: COMMENTS[i.id] || [], activities: i.activities || [] };
  }

  if (p === '/api/ideas' && method === 'POST') {
    logSql(`BEGIN; INSERT INTO ideas(...) VALUES(...) RETURNING id;`);
    logSql(`INSERT INTO idea_activities(action='created'); COMMIT;`);
    logQueue('→ 企业微信群机器人：新灵感待评审');
    const i = mk({
      id: ++seq, title: body.title, content: body.content, category: body.category,
      tags: body.tags?.length ? body.tags : [], status: 'pending', votes: 0,
      anon: body.isAnonymous, author: body.isAnonymous ? '匿名' : ME.name,
      authorId: ME.id, createdAt: new Date().toISOString(), views: 1,
      activities: [{ id: ++seq, text: `${body.isAnonymous ? '匿名' : ME.name} 提交了这条灵感`, createdAt: new Date().toISOString() }],
    });
    IDEAS.unshift(i);
    return i;
  }

  const edit = p.match(/^\/api\/ideas\/(\d+)$/);
  if (edit && method === 'PATCH') {
    const i = IDEAS.find(x => x.id === +edit[1]);
    Object.assign(i, body);
    return i;
  }

  const vote = p.match(/^\/api\/ideas\/(\d+)\/vote$/);
  if (vote) {
    const i = IDEAS.find(x => x.id === +vote[1]);
    i.voted = !i.voted;
    i.voteCount += i.voted ? 1 : -1;
    i.hotScore = hotOf(i.voteCount, i.commentCount, i.createdAt);
    return { voted: i.voted, voteCount: i.voteCount, hotScore: i.hotScore };
  }

  const cmt = p.match(/^\/api\/ideas\/(\d+)\/comments$/);
  if (cmt && method === 'GET') {
    const i = IDEAS.find(x => x.id === +cmt[1]);
    return { items: COMMENTS[i?.id] || [] };
  }
  if (cmt && method === 'POST') {
    logSql('INSERT INTO idea_comments; UPDATE ideas SET comment_count=comment_count+1');
    const i = IDEAS.find(x => x.id === +cmt[1]);
    const c = {
      id: ++seq,
      author: body.isAnonymous ? { id: null, name: '匿名' } : { id: ME.id, name: ME.name },
      isAnonymous: !!body.isAnonymous,
      body: body.body,
      createdAt: new Date().toISOString(),
    };
    (COMMENTS[i.id] ||= []).push(c);
    i.commentCount = COMMENTS[i.id].length;
    i.hotScore = hotOf(i.voteCount, i.commentCount, i.createdAt);
    return { ...c, commentCount: i.commentCount };
  }

  const st = p.match(/^\/api\/ideas\/(\d+)\/status$/);
  if (st) {
    const i = IDEAS.find(x => x.id === +st[1]);
    const from = i.status;
    if (from === body.status) throw Object.assign(new Error(`这条灵感已经是「${body.status}」了`), { status: 409 });
    if (body.status === 'rejected' && !(body.reason || '').trim()) {
      throw Object.assign(new Error('否决必须填写理由'), { status: 400 });
    }
    logSql(`BEGIN; SELECT … FOR UPDATE;`);
    i.status = body.status;
    if (body.status === 'adopted') {
      i.code = `IDEA-2026-${String(++codeSeq).padStart(4, '0')}`;
      i.adoptedAt = new Date().toISOString();
      i.owner = { id: 2, name: '林知远' };
      i.progress = 0;
      i.docUrl = `https://docs.internal/${i.code.toLowerCase()}`;
      logSql(`UPDATE ideas SET status='adopted', code='${i.code}', adopted_at=now();`);
      logSql(`INSERT INTO idea_activities(from_status='${from}', to_status='adopted'); COMMIT;`);
      logQueue('→ 通知提交人 + 群机器人播报');
    }
    (i.activities ||= []).push({
      id: ++seq, toStatus: body.status, highlight: body.status === 'adopted',
      text: `${ME.name} ${body.status === 'adopted' ? '采纳了这条灵感并立项' : '把状态改为「' + body.status + '」'}`,
      reason: body.reason || null, createdAt: new Date().toISOString(),
    });
    return { ...i, transition: { from, to: body.status, code: i.code } };
  }

  if (p === '/api/stats/overview') {
    const by = {};
    for (const i of IDEAS) by[i.status] = (by[i.status] || 0) + 1;
    const total = IDEAS.length;
    const adopted = by.adopted || 0;
    const reviewed = adopted + (by.rejected || 0);
    const cats = { 产品:0, 技术:0, 运营:0, 流程:0, 其他:0 };   // 为 0 的分类也要出现在图上
    for (const i of IDEAS) cats[i.category] = (cats[i.category] || 0) + 1;
    const reached = stages => CLIENTS.filter(client => stages.includes(client.stage)).length;
    const salesFunnel = [
      { name:'有效客资', value:reached(['lead','wechat','profiled','consulted','coaching','renewed']),
        stages:['lead','wechat','profiled','consulted','coaching','renewed'], source:'客户档案 · 排除已流失' },
      { name:'已加微信', value:reached(['wechat','profiled','consulted','coaching','renewed']),
        stages:['wechat','profiled','consulted','coaching','renewed'], source:'客户阶段 · 已加微信及以后' },
      { name:'已咨询', value:reached(['consulted','coaching','renewed']),
        stages:['consulted','coaching','renewed'], source:'客户阶段 · 已咨询及以后' },
      { name:'陪跑成交', value:reached(['coaching','renewed']),
        stages:['coaching','renewed'], source:'客户阶段 · 陪跑中及以后' },
      { name:'续费/转介绍', value:reached(['renewed']),
        stages:['renewed'], source:'客户阶段 · 已续费' },
    ];
    salesFunnel.forEach((step, index) => {
      step.conversion = index === 0 ? 100 : salesFunnel[index - 1].value
        ? Math.round(step.value / salesFunnel[index - 1].value * 1000) / 10 : null;
    });
    return {
      tiles: {
        total, pending: (by.pending || 0) + (by.reviewing || 0), adopted,
        adoptRate: reviewed ? Math.round(adopted / reviewed * 100) : 0,
        newThisMonth: 3, adoptedThisMonth: 1,
        oldestPendingDays: 12,
      },
      byCategory: Object.entries(cats).map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value),
      funnel: [
        { name: '提交',     value: total },
        { name: '进入评审', value: total - (by.pending || 0) },
        { name: '已采纳',   value: adopted },
        { name: '已落地',   value: IDEAS.filter(i => i.status === 'adopted' && i.progress >= 100).length },
      ],
      library: [
        { name:'灵感池', value:IDEAS.filter(i => ['pending','reviewing'].includes(i.status)).length,
          board:'pool', note:'待评审 + 评审中' },
        { name:'用户需求', value:DEMANDS.length, board:'demands', note:'需求记录' },
        { name:'正式内容', value:adopted, board:'formal', note:'已采纳的灵感' },
        { name:'客户', value:CLIENTS.length, board:'clients', note:'客户档案' },
        { name:'案例', value:CASES.length, board:'cases', note:'案例库' },
      ],
      salesFunnel,
      byStatus: by,
    };
  }

  throw Object.assign(new Error('mock 没实现这个接口：' + path), { status: 404 });
}
