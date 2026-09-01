/**
 * 内置演示数据。后端没起时前端自动用这份，界面完全可点。
 * 内容和 server/src/seed.mjs 保持一致，方便对照。
 *
 * 只在浏览器内存里改动，刷新即还原 —— 演示场合正好合适。
 */
import { logApi, logSql, logQueue } from './apilog.js';

const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
function strictMockBody(body,allowed,required=[]){const value=body&&typeof body==='object'&&!Array.isArray(body)?body:{};const unknown=Object.keys(value).filter(key=>!allowed.includes(key));if(unknown.length)throw Object.assign(new Error(`不支持的字段：${unknown.join('、')}`),{status:400});const missing=required.filter(key=>value[key]==null||value[key]===''||(Array.isArray(value[key])&&!value[key].length));if(missing.length)throw Object.assign(new Error(`缺少必填字段：${missing.join('、')}`),{status:400});return value;}
const mockRole = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('mockRole') : '';
const STAGE3_DEMO = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).has('stage3') : false;
const ME = { id: 1, name: '陈屿', dept: '产品部', role: ['member','reviewer'].includes(mockRole) ? mockRole : 'admin' };

let seq = 100;
let codeSeq = 38;
const IDEA_FILES=new Map();

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
  fileCount:(IDEA_FILES.get(o.id)||[]).length,
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

const mockReportFiles = () => {
  const names = ['01_封面.png', '02_护子痛点.png', '03_明天找你.png', '04_整理夜眼神.png', '05_节奏总结.png'];
  return names.map((name, i) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="720" height="480" rx="24" fill="#fbefe2"/><rect x="28" y="28" width="664" height="76" rx="16" fill="#f6cfc2"/><text x="52" y="77" font-family="sans-serif" font-size="30" font-weight="700" fill="#c75e55">审核材料 ${String(i + 1).padStart(2, '0')}</text><rect x="42" y="134" width="636" height="304" rx="18" fill="#fffaf3"/><text x="68" y="205" font-family="sans-serif" font-size="24" fill="#695e59">${name}</text><path d="M68 250h500M68 292h430M68 334h470" stroke="#d9c8bd" stroke-width="14" stroke-linecap="round"/></svg>`;
    return { id: 820 + i, name, size: 940000 + i * 42000, mime: 'image/svg+xml',
      url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), uploaderName: '李华', side: 'submit' };
  });
};

let REPORTS = [
  { id:801, authorId:1, authorName:'陈屿', reviewerId:2, reviewerName:'苏禾', reportDate:'2026-08-24',
    title:'完成客户详情页信息复核', summary:'核对九区信息和技术2分析字段。', resultUrl:'', blockers:'',
    needHelp:'请复核 AI 分析区的业务文案', feedback:'结构清楚，补一个空态说明即可。', status:'已反馈', fileCount:1 },
  { id:802, authorId:3, authorName:'李华', reviewerId:1, reviewerName:'陈屿', reportDate:'2026-08-25',
    title:'情感赛道', summary:'完成五张内容卡片，整理了开场钩子、护子痛点与节奏总结。',
    resultUrl:'https://example.com/result/802', blockers:'部分标题需要进一步压缩字数。',
    needHelp:'请确认内容节奏和视觉层级是否适合发布。', feedback:'', status:'待审核', fileCount:5,
    files:mockReportFiles() },
];

/* 内容采集演示数据：状态会在当前页面生命周期内真实流转，刷新后还原。
   不使用 localStorage，避免演示任务和真实用户数据混在一起。 */
const collectorCover = (title, bg = '#eeeaf4', ink = '#68455f') => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="720" height="960" rx="38" fill="${bg}"/><circle cx="590" cy="150" r="110" fill="#fff" opacity=".52"/><text x="58" y="118" font-family="sans-serif" font-size="27" font-weight="700" fill="${ink}">内容样本</text><foreignObject x="58" y="250" width="604" height="430"><div xmlns="http://www.w3.org/1999/xhtml" style="font:700 58px/1.35 sans-serif;color:${ink};word-break:break-all">${title}</div></foreignObject><text x="58" y="890" font-family="sans-serif" font-size="23" fill="${ink}" opacity=".72">IdeaHub · 采集预览</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const collectorAnalysis = () => ({
  status:'ok', notice:'AI 结论仅作辅助整理，请结合原始内容与评论证据判断。',
  video:{ status:'ok', items:{
    main_topic:{ label:'这条主要讲什么', summary:'通过三个常见互动细节，判断一段关系是否仍在稳定推进。' },
    target_audience:{ label:'适合谁看', summary:'处于暧昧或关系降温期，希望减少情绪猜测的人。' },
    user_need:{ label:'解决什么需求', summary:'把模糊的不安还原为可观察、可验证的行动信号。' },
    content_structure:{ label:'内容结构', summary:'痛点开场、三个信号、反例说明与两周观察建议。' },
    solution:{ label:'给出的办法', summary:'降低追问频率，设定观察窗口，记录对方是否主动补位。' },
  }},
  comments:{ status:'ok', sample_size:36, items:{
    main_questions:{ label:'大家主要在问什么', summary:'如何区分短期忙碌和长期回避，以及观察窗口应该多长。', evidence_comments:[{ id:'c-1', author:'小葵', like_count:86, text:'如果他最近工作真的很忙，也要按两周来观察吗？' }] },
    high_frequency_needs:{ label:'高频真实需求', summary:'希望得到明确的判断标准和不伤自尊的行动步骤。', evidence_comments:[] },
    worries:{ label:'最担心什么', summary:'担心减少主动后关系直接断掉，也担心继续投入是在自我消耗。', evidence_comments:[] },
    unclear_points:{ label:'还没讲清楚什么', summary:'不同关系阶段的观察周期可以进一步拆开说明。', evidence_comments:[] },
    key_comments:{ label:'哪些评论值得重点看', entries:[{ reason:'提出了反例边界，适合补进后续内容。', comment:{ id:'c-1', author:'小葵', like_count:86, text:'如果他最近工作真的很忙，也要按两周来观察吗？' } }] },
    topic_extensions:{ label:'可以延伸什么选题', entries:[{ idea:'忙碌和回避的五个区别', evidence_comments:[] }] },
  }},
});

let collectorLogin = {
  status:'saved', message:'登录有效，但平台暂未返回账号资料', qr_available:false, expires_at:null, saved:true,
  account:{}, account_label:'VPS 采集专用号', identity_verified:false,
};
let collectorLoginPolls = 0;
let collectorTaskSeq = 3;
let COLLECTOR_TASKS = [
  { id:'demo-done-1', url:'https://www.xiaohongshu.com/explore/demo1', source:'xiaohongshu',
    title:'关系降温后，先看清这三个信号', account_name:'关系研究所', owner_id:'1', status:'done',
    created_at:hoursAgo(2), updated_at:hoursAgo(1.8) },
  { id:'demo-failed-2', url:'https://www.douyin.com/video/demo2', source:'douyin',
    title:'采集失败的演示记录', account_name:'关系研究所', owner_id:'1', status:'failed',
    error_msg:'原链接已失效或平台暂时限制访问，请检查链接后重试。', created_at:hoursAgo(9), updated_at:hoursAgo(8.8) },
  { id:'demo-interrupted-3', url:'https://www.xiaohongshu.com/explore/demo3', source:'xiaohongshu',
    title:'服务重启后的任务', account_name:'关系研究所', owner_id:'1', status:'interrupted',
    error_msg:'服务重启导致任务中断，请手动重试。', created_at:hoursAgo(22), updated_at:hoursAgo(21.8) },
];
const collectorPolls = new Map();
const collectorAnalyses = new Map();
const cloneCollectorData = value => JSON.parse(JSON.stringify(value));
const analysisFor = id => {
  if (!collectorAnalyses.has(id)) collectorAnalyses.set(id, collectorAnalysis());
  return collectorAnalyses.get(id);
};
const collectorResult = task => ({
  task_id:task.id, owner_id:task.owner_id, status:'done', schema_version:2,
  session_mode:task.session_mode || 'saved',
  title:task.title, post_title:task.title, display_title:task.title, platform:task.source,
  source_url:task.url, author:'关系研究所', description:'从可验证的行动证据出发，减少在关系中的反复猜测。',
  topics:['关系判断','行动验证','停止内耗'], media_type:'image_post',
  account:{ name:'关系研究所', nickname:'关系研究所', follower_count:'12.8万', likes_and_collections_count:'186.4万', bio:'关系判断与行动建议' },
  engagement:{ likes:'1.6万', collects:'8,206', comments:'436' },
  images:[
    { index:1, filename:'cover-1.png', url:collectorCover('关系降温后，先看清这三个信号'), text:'关系降温后，先看清这三个信号', stored_locally:false },
    { index:2, filename:'detail-2.png', url:collectorCover('不要猜，观察对方是否主动补位','#f5eee7','#6f5148'), text:'不要猜，观察对方是否主动补位', stored_locally:false },
  ],
  video_text:'', comments:[
    { id:'c-1', author:'小葵', like_count:86, text:'如果他最近工作真的很忙，也要按两周来观察吗？' },
    { id:'c-2', author:'秋叶', like_count:52, text:'减少主动之后，反而更容易看清关系。' },
  ],
  ai_analysis:cloneCollectorData(analysisFor(task.id)), media_assets:{ video:{} }, data_updated_at:hoursAgo(1.8),
});

let sampleSeq = 3;
let SAMPLE_ITEMS = [
  { id:1, canonicalKey:'xiaohongshu:id:sample-1', platform:'xiaohongshu', platformLabel:'小红书', platformContentId:'sample-1', sourceUrl:'https://www.xiaohongshu.com/explore/sample-1', title:'关系降温后，先看清这三个信号', bodyExcerpt:'从可验证的行动证据出发，减少在关系中的反复猜测。', bodyText:'从可验证的行动证据出发，减少在关系中的反复猜测。先观察对方是否主动补位，再决定下一步。', contentType:'image_post', accountName:'关系研究所', publishedAt:hoursAgo(26), metrics:{likes:'1.6万',collects:'8206',comments:'436',shares:'128',views:'12.4万'}, archiveStatus:'complete', completenessScore:100, missingFields:[], captureCount:2, assetCount:2, coverAssetId:101, coverUrl:collectorCover('关系降温后，先看清这三个信号'), createdAt:hoursAgo(25), updatedAt:hoursAgo(1) },
  { id:2, canonicalKey:'manual:sample-2', platform:'manual', platformLabel:'手动归档', platformContentId:null, sourceUrl:null, title:'等待补媒体的案例拆解', bodyExcerpt:'已经先保存标题和正文，后续补充封面与视频。', bodyText:'已经先保存标题和正文，后续补充封面与视频。', contentType:'video', accountName:'', publishedAt:null, metrics:{}, archiveStatus:'partial', completenessScore:45, missingFields:['account','published_at','metrics','cover','media'], captureCount:1, assetCount:0, coverAssetId:null, createdAt:hoursAgo(8), updatedAt:hoursAgo(8) },
];
if(STAGE3_DEMO){
  const demoTitles=['把复杂判断讲清楚的五步框架','一个真实案例如何承接专业观点','短视频开头的三种信息密度','从误区切入的关系沟通方法','长标题如何保持阅读节奏','行动清单不等于万能答案'];
  Array.from({length:25},(_,index)=>demoTitles[index%demoTitles.length]).forEach((title,index)=>{const id=index+3,platform=index%2?'douyin':'xiaohongshu';SAMPLE_ITEMS.push({id,canonicalKey:`stage3:sample-${id}`,platform,platformLabel:platform==='douyin'?'抖音':'小红书',platformContentId:`stage3-${id}`,sourceUrl:`https://example.test/sample/${id}`,title:index===4?`${title}：这是一个用于验证六列比较工作台不会挤压页面的超长样本标题`:`${title} · ${index+1}`,bodyExcerpt:'通过可核验的内容片段说明结构、表达和行动承接方式。',bodyText:'通过可核验的内容片段说明结构、表达和行动承接方式。结论只适用于当前样本与观察窗口。',contentType:index%2?'video':'image_post',accountName:`研究账号 ${id}`,publishedAt:hoursAgo(36+index*9),metrics:{likes:String(9800+index*1730),collects:index===2?null:String(2100+index*620),comments:String(140+index*31),shares:index===3?null:String(38+index*17),views:String(52000+index*9100)},archiveStatus:'complete',completenessScore:100,missingFields:[],captureCount:1,assetCount:1,coverAssetId:null,createdAt:hoursAgo(40+index),updatedAt:hoursAgo(index+1)});});
  sampleSeq=28;
}
const sampleAsset = (sampleId, id, kind, mimeType, name, url) => ({ id, sampleId, captureId:sampleId, kind, originalName:name, mimeType, byteSize:245760, sha256:'demo-sha256', width:1080, height:1440, durationMs:null, sourceUrl:null, archiveQuality:'original_images', createdAt:hoursAgo(1), contentUrl:url });
const sampleDetail = item => ({ ...item, firstIngestMethod:item.platform==='manual'?'manual':'link', lastIngestMethod:item.platform==='manual'?'manual':'link', captureTotal:Number(item.captureCount||1), captures:Array.from({length:Math.min(20,Number(item.captureCount||1))},(_,index)=>({id:item.id*100+index+1,sampleId:item.id,captureKey:`demo-${item.id}-${index+1}`,captureType:item.platform==='manual'?'manual':'link',capturedAt:new Date(new Date(item.updatedAt).valueOf()-index*86400000).toISOString(),sourceUrl:item.sourceUrl,normalizedPayload:{title:item.title},payloadSha256:'demo',completenessScore:item.completenessScore,missingFields:item.missingFields,createdAt:item.createdAt})), assets:item.id===1?[sampleAsset(1,101,'cover','image/svg+xml','cover.svg',collectorCover('关系降温后，先看清这三个信号')),sampleAsset(1,102,'image','image/svg+xml','detail.svg',collectorCover('不要猜，观察是否主动补位','#f5eee7','#6f5148'))]:[] });

/* ---------- 样本库第二阶段：可核验的十五维研究演示 ---------- */
const SAMPLE_DIMENSIONS = [
  ['audience','用户对象','受众与需求'],['user_need','用户需求','受众与需求'],['topic','选题','受众与需求'],
  ['core_viewpoint','核心观点','观点与爆点'],['breakout_point','爆点','观点与爆点'],
  ['title_mechanism','标题机制','标题与开头'],['opening_method','开头方式','标题与开头'],
  ['content_structure','内容结构','结构与论证'],['argumentation_method','论证方式','结构与论证'],
  ['language_style','语言风格','表达与篇幅'],['length','篇幅','表达与篇幅'],['layout','排版','表达与篇幅'],
  ['visual_style','视觉风格','视听与行动'],['bgm','BGM','视听与行动'],['cta','CTA','视听与行动'],
].map(([key,label,group],index)=>({key,label,group,sortOrder:index+1}));
const SAMPLE_TAGS = [
  {id:101,kind:'audience',kindLabel:'用户对象',name:'女性用户',sort:10,active:true},
  {id:102,kind:'user_need',kindLabel:'用户需求',name:'关系判断需求',sort:10,active:true},
  {id:103,kind:'title_mechanism',kindLabel:'标题机制',name:'强结论标题',sort:10,active:true},
  {id:104,kind:'content_structure',kindLabel:'内容结构',name:'案例拆解结构',sort:10,active:true},
  {id:105,kind:'topic',kindLabel:'选题',name:'女性情感赛道',sort:10,active:true},
  {id:106,kind:'language_style',kindLabel:'语言风格',name:'专业解释',sort:10,active:true},
];
const SAMPLE_TAG_NAMES={audience:['高敏感用户','决策犹豫者'],user_need:['行动步骤需求','情绪安定需求'],topic:['沟通边界','长期关系'],core_viewpoint:['行动证据优先','尊重个体差异','保留判断边界'],breakout_point:['反常识切入','冲突场景','可验证窗口'],title_mechanism:['场景提问','数字清单'],opening_method:['误区切入','案例切入','问题切入'],content_structure:['步骤清单','正反例结构'],argumentation_method:['行为证据','对照论证','边界说明'],language_style:['克制短句','口语解释'],length:['短篇','中篇','长篇'],layout:['卡片分段','关键词高亮','留白排版'],visual_style:['低饱和暖色','人物弱化','文字主导'],bgm:['无背景音乐','轻音乐','节奏型音乐'],cta:['收藏执行','评论补充','私信咨询']};
let sampleTagId=200;for(const dimension of SAMPLE_DIMENSIONS){const existing=SAMPLE_TAGS.filter(tag=>tag.kind===dimension.key);for(const name of SAMPLE_TAG_NAMES[dimension.key]||[]){if(existing.length>=3)break;const row={id:++sampleTagId,kind:dimension.key,kindLabel:dimension.label,name,sort:(existing.length+1)*10,active:true};SAMPLE_TAGS.push(row);existing.push(row);}while(existing.length<3){const row={id:++sampleTagId,kind:dimension.key,kindLabel:dimension.label,name:`${dimension.label}标签 ${existing.length+1}`,sort:(existing.length+1)*10,active:true};SAMPLE_TAGS.push(row);existing.push(row);}}
let SAMPLE_TAG_LINKS = {1:[101,102,103,104,105,106],2:[101,102,104]};
let researchVersionSeq=3,researchDecisionSeq=10,researchEvaluationSeq=4,researchJobSeq=0;
const demoValues={audience:'在关系降温阶段反复猜测的女性',user_need:'判断对方是否仍在投入，并获得下一步行动标准',topic:'用行动证据判断关系降温',core_viewpoint:'不要用回复频率猜测关系，要看对方是否主动补位',breakout_point:'把情绪问题改写成可观察的两周验证窗口',title_mechanism:'痛点场景 + 强判断 + 数字承诺',opening_method:'先否定常见误区，再给出判断标准',content_structure:'问题场景 → 三个信号 → 观察窗口 → 行动建议',argumentation_method:'行为证据归纳 + 正反例边界',language_style:'克制、直接、短句判断',length:'中篇，约 900 字',layout:'封面强标题，正文卡片分段并突出关键词',visual_style:'低饱和暖色卡片，人物弱化，文字为主',bgm:null,cta:'收藏后按两周窗口执行，并留言描述观察结果'};
function researchElements(source='ai'){
  return SAMPLE_DIMENSIONS.map((dim,index)=>({id:index+1,dimensionKey:dim.key,label:dim.label,status:dim.key==='bgm'?'insufficient':'ok',aiValue:source==='manual'?null:demoValues[dim.key],effectiveValue:source==='manual'?null:demoValues[dim.key],function:dim.key==='title_mechanism'?'在进入正文前同时完成场景识别与价值承诺':dim.key==='content_structure'?'把焦虑引导到可执行的判断步骤':'承担该部分在作品中的具体沟通任务',confidence:source==='manual'?null:(dim.key==='bgm'?.18:.82-index*.008),evidenceStrength:dim.key==='bgm'?'none':'strong',applicability:'适用于需要明确判断标准的关系内容',limitations:'不适合替代个体咨询或推断对方内心',decisionStatus:index<5?'confirmed':'pending',decision:index<5?{decision:'confirmed',createdAt:hoursAgo(2),createdByName:'陈屿'}:null,tags:SAMPLE_TAGS.filter(tag=>tag.kind===dim.key).slice(0,index%3===0?1:0),evidence:dim.key==='bgm'?[]:[{id:8000+index,sourceId:`body:p${index%3+1}`,sourceType:'正文',quote:index%2?'先观察对方是否主动补位，再决定下一步。':'从可验证的行动证据出发，减少在关系中的反复猜测。',locator:`正文第 ${index%3+1} 段`,verified:true}]}));
}
let SAMPLE_RESEARCH_VERSIONS={1:[
  {id:1,sampleId:1,revision:2,source:'ai',isCurrent:true,status:'completed',model:'gpt-4o · prompt v2',inputSha256:'9f01a4f09bde1122',createdAt:hoursAgo(2),elements:researchElements('ai')},
  {id:2,sampleId:1,revision:1,source:'legacy',isCurrent:false,status:'completed',model:'历史分析迁移',inputSha256:'6c881f09aa118922',createdAt:hoursAgo(24),elements:researchElements('ai').map(e=>({...e,decisionStatus:'pending',decision:null}))},
],2:[]};
let SAMPLE_EVALUATIONS={1:[
  {id:1,target:'traffic',source:'manual',strengths:'标题场景明确，收藏理由充分。',weaknesses:'首屏情绪张力仍可提高。',learnable:'强判断标题与三点结构。',avoid:'不要照搬两周这个时间值。',hypothesis:'给焦虑用户可执行的观察窗口，降低理解成本。',createdAt:hoursAgo(1)},
  {id:2,target:'expertise',source:'ai',strengths:'使用行为证据而非动机猜测。',weaknesses:'样本边界没有展开。',learnable:'正反例边界和证据链。',avoid:'不能把归纳写成普遍因果。',hypothesis:'清晰判断标准形成专业可信度。',createdAt:hoursAgo(3)},
]};
let SAMPLE_METRICS={1:[
  {id:1,observedAt:hoursAgo(24),likes:8200,saves:4100,comments:210,shares:54,views:68000},
  {id:4,observedAt:hoursAgo(18),likes:null,saves:null,comments:260,shares:null,views:81000},
  {id:2,observedAt:hoursAgo(12),likes:12600,saves:6400,comments:342,shares:91,views:96000},
  {id:3,observedAt:hoursAgo(1),likes:16000,saves:8206,comments:436,shares:128,views:124000},
]};
const RESEARCH_JOBS=new Map();
const currentResearchVersion=id=>(SAMPLE_RESEARCH_VERSIONS[id]||[]).find(v=>v.isCurrent)||null;
const researchSummary=id=>({sampleId:id,currentAnalysisVersionId:currentResearchVersion(id)?.id||null,sourceCaptureId:id*100+1,tags:(SAMPLE_TAG_LINKS[id]||[]).map(tagId=>SAMPLE_TAGS.find(t=>t.id===tagId)).filter(Boolean),versions:(SAMPLE_RESEARCH_VERSIONS[id]||[]).map(({elements,...v})=>({...v,elementCount:elements.length,confirmedElementCount:elements.filter(e=>['confirmed','edited'].includes(e.decisionStatus)).length})),evaluations:SAMPLE_EVALUATIONS[id]||[],metrics:SAMPLE_METRICS[id]||[]});

/* ---------- Sample library stage 3 deterministic demo state ---------- */
let comparisonSeq=40,assessmentSeq=80,assessmentJobSeq=0,relationSeq=50,extractionSeq=30,componentSeq=20,componentRevisionSeq=60;
const COMPARISON_JOBS=new Map();
const selectedComparisonIds=STAGE3_DEMO?[1,3,4,5,6,7]:[1,2];
const frozenMember=(sampleId,ordinal)=>{const item=SAMPLE_ITEMS.find(value=>Number(value.id)===Number(sampleId))||SAMPLE_ITEMS[0];const elements=researchElements('ai').map((element,index)=>({...element,id:sampleId*1000+index+1,snapshotId:sampleId*1000+index+1,effectiveValue:index%4===0?`${element.effectiveValue}（样本 ${ordinal}）`:element.effectiveValue,decisionStatus:index<8?'confirmed':'pending'}));return {id:sampleId,sampleId,ordinal,title:item.title,accountName:item.accountName,platform:item.platform,platformLabel:item.platformLabel,publishedAt:item.publishedAt,analysisVersionId:sampleId===1?1:700+sampleId,analysisRevision:sampleId===1?2:1,latestDecisionCount:8,elements,metricObservedAt:hoursAgo(ordinal),observationWindowSeconds:ordinal===2?null:86400+ordinal*3600,metrics:{observedAt:hoursAgo(ordinal),likes:item.metrics?.likes??null,saves:item.metrics?.collects??null,comments:item.metrics?.comments??null,shares:item.metrics?.shares??null,views:item.metrics?.views??null}};};
const buildScope=(id,memberIds,revision=1,topic='观察标题、结构与行动承接在不同作品中的局部差异')=>{const members=memberIds.map((sampleId,index)=>frozenMember(sampleId,index+1)),coverage=Object.fromEntries(['likes','saves','comments','shares','views'].map(key=>[key,{available:members.filter(member=>member.metrics?.[key]!=null).length,total:members.length}])),mixedPlatforms=new Set(members.map(member=>member.platform)).size>1;return{id,scopeId:id,comparisonId:id===301?31:32,revision,scopeRevision:revision,status:'complete',topic,topicBasis:topic,claimPolicy:'observation_hypothesis_recommendation',causalClaimsAllowed:false,sampleSize:memberIds.length,metricCoverage:coverage,mixedPlatforms,rankingPolicy:mixedPlatforms?'mixed_platforms_not_directly_rankable':'descriptive_only',dimensions:SAMPLE_DIMENSIONS,members,stale:false,staleReasons:[],createdAt:hoursAgo(7)};};
let COMPARISONS=[
  {id:31,name:'关系判断内容的结构对照',topic:'观察标题承诺、论证结构与 CTA 的局部差异',currentScopeId:301,currentScopeRevision:1,memberCount:selectedComparisonIds.length,targets:{traffic:true,persona:false,expertise:true,conversion:false},createdAt:hoursAgo(8),updatedAt:hoursAgo(1)},
  {id:32,name:'手动归档补全前后研究',topic:'核对资料完整度变化是否影响可研究维度',currentScopeId:302,currentScopeRevision:2,memberCount:2,targets:{traffic:false,persona:true,expertise:false,conversion:false},createdAt:hoursAgo(30),updatedAt:hoursAgo(12)},
];
let COMPARISON_SCOPES={301:buildScope(301,selectedComparisonIds,1),302:buildScope(302,[1,2],2,'核对资料补全前后的可研究维度')};
let COMPARISON_ASSESSMENTS={31:[
  {id:71,comparisonId:31,scopeId:301,scopeRevision:1,target:'traffic',source:'manual',revision:2,isCurrent:true,commonPoints:['都在开头快速建立问题场景。'],keyDifferences:['标题承诺的具体程度与正文承接路径不同。'],strengths:['结构线索清晰，便于核对。'],limitations:['成员跨平台，指标不能直接排序。'],worthLearning:['标题承诺与首段证据保持一致。'],doNotCopy:['不要复制具体时间值或绝对判断。'],hypotheses:[{claimText:'明确路径可能降低理解成本。',limitations:'需要补充更多同平台观察窗口。'}],openQuestions:['需要补充更多同平台观察窗口。'],methodLimitations:['当前仅比较固定范围内的内容快照。'],findings:[],createdAt:hoursAgo(1)},
  {id:70,comparisonId:31,scopeId:301,scopeRevision:1,target:'traffic',source:'ai',revision:1,isCurrent:false,confidence:.72,commonPoints:['标题均包含明确场景。'],keyDifferences:['部分样本用数字承诺，部分使用问题反转。'],strengths:['信息入口清楚。'],limitations:['证据量有限。'],worthLearning:['先建立场景，再提供判断步骤。'],doNotCopy:['避免复用具体人物与结论。'],hypotheses:[{claimText:'信息分层可能帮助读者快速定位。',limitations:'不同发布时间的观察窗口需要统一。'}],openQuestions:['不同发布时间的观察窗口需要统一。'],methodLimitations:['不允许从相关性推断因果。'],findings:[],createdAt:hoursAgo(3)},
  {id:72,comparisonId:31,scopeId:301,scopeRevision:1,target:'expertise',source:'ai',revision:1,isCurrent:true,confidence:.68,commonPoints:['均给出判断依据。'],keyDifferences:['证据类型与边界说明完整度不同。'],strengths:['可核验片段较多。'],limitations:['部分样本没有反例。'],worthLearning:['把判断拆成可检查步骤。'],doNotCopy:['不照搬个案结论。'],hypotheses:[{claimText:'证据链可能增强可理解性。',limitations:'需补充反例来源。'}],openQuestions:['需补充反例来源。'],methodLimitations:['只描述当前范围。'],findings:[],createdAt:hoursAgo(2)},
],32:[]};
if(STAGE3_DEMO){for(let index=0;index<12;index++)COMPARISON_ASSESSMENTS[31].push({id:90+index,comparisonId:31,scopeId:301,target:'traffic',source:index%2?'manual':'ai',revision:3+index,isCurrent:false,commonPoints:[`历史版本 ${index+1} 的共同观察`],keyDifferences:[],strengths:[],limitations:['仅用于验证长历史按需读取'],worthLearning:[],doNotCopy:[],hypotheses:[],openQuestions:[],methodLimitations:['固定范围历史'],findings:[],createdAt:hoursAgo(40+index)});}
let SAMPLE_RELATIONS=[
  {id:41,relationType:'citation',state:'confirmed',subject:{sampleId:selectedComparisonIds[1]||1,analysisVersionId:700+(selectedComparisonIds[1]||1),title:SAMPLE_ITEMS.find(item=>item.id===(selectedComparisonIds[1]||1))?.title},object:{sampleId:1,analysisVersionId:1,title:SAMPLE_ITEMS[0].title},rationale:'主作品在方法说明中明确引用了客作品的判断框架。',text:'主作品引用客作品的判断框架',evidence:[{id:1,elementEvidenceId:8001,quoteText:'沿用先观察行动证据的判断框架。',locator:'主作品正文第 3 段'}],events:[{event:'confirmed',createdAt:hoursAgo(2)}]},
  {id:42,relationType:'variant',state:'proposed',proposedBy:1,subject:{sampleId:selectedComparisonIds[2]||1,analysisVersionId:700+(selectedComparisonIds[2]||1),title:SAMPLE_ITEMS.find(item=>item.id===(selectedComparisonIds[2]||1))?.title},object:{sampleId:selectedComparisonIds[3]||2,analysisVersionId:700+(selectedComparisonIds[3]||2),title:SAMPLE_ITEMS.find(item=>item.id===(selectedComparisonIds[3]||2))?.title},rationale:'两篇作品使用相同问题入口，但展开媒介与段落节奏不同。',text:'两篇作品互为变体',evidence:[],events:[{event:'proposed',createdAt:hoursAgo(1)}]},
];
let SAMPLE_EXTRACTIONS=[
  {id:21,comparisonId:31,scopeId:301,assessmentId:null,dimensionKey:'title_mechanism',origin:'manual',patternText:'场景限定 + 可检查步骤',functionText:'在首屏完成受众识别与阅读价值说明',createdAt:hoursAgo(2)},
  {id:22,comparisonId:31,scopeId:301,assessmentId:null,dimensionKey:'content_structure',origin:'ai',patternText:'误区 → 证据 → 边界 → 行动',functionText:'把抽象判断转为可复核的阅读路径',createdAt:hoursAgo(1)},
];
let CONTENT_COMPONENTS=[
  {id:11,name:'场景限定型标题入口',dimensionKey:'title_mechanism',lifecycleState:'active',currentApprovedRevisionId:51,revisions:[
    {id:52,revision:2,state:'draft',origin:'manual',dimensionKey:'title_mechanism',name:'场景限定型标题入口 · 边界补充',pattern:'场景限定 + 可检查步骤 + 适用边界',functionText:'完成受众识别与价值说明',applicability:'方法型内容',limitations:'需要正文立即承接',doNotCopy:'不复制具体数字与结论',extractionIds:[21],tags:[{id:101,name:'方法型'}],createdAt:hoursAgo(1)},
    {id:51,revision:1,state:'approved',origin:'manual',dimensionKey:'title_mechanism',name:'场景限定型标题入口',pattern:'场景限定 + 可检查步骤',functionText:'完成受众识别与阅读价值说明',applicability:'方法型内容',limitations:'不适合无正文承接的标题',doNotCopy:'不复制具体数字与结论',extractionIds:[21],tags:[{id:101,name:'方法型'}],reviewNote:'证据与边界完整。',createdAt:hoursAgo(20)},
  ],lifecycleEvents:[{event:'activated',createdAt:hoursAgo(20)}]},
  {id:12,name:'误区到行动的四段结构',dimensionKey:'content_structure',lifecycleState:'active',currentApprovedRevisionId:null,revisions:[{id:53,revision:1,state:'submitted',origin:'ai',dimensionKey:'content_structure',name:'误区到行动的四段结构',pattern:'误区 → 证据 → 边界 → 行动',functionText:'建立可复核阅读路径',applicability:'案例拆解',limitations:'需要人工核对反例',doNotCopy:'不可省略边界段',extractionIds:[22],tags:[{id:102,name:'结构'}],createdAt:hoursAgo(3)}],lifecycleEvents:[{event:'activated',createdAt:hoursAgo(3)}]},
  {id:13,name:'证据先行的专业表达',dimensionKey:'argumentation_method',lifecycleState:'active',currentApprovedRevisionId:null,revisions:[{id:54,revision:1,state:'changes_requested',origin:'manual',dimensionKey:'argumentation_method',name:'证据先行的专业表达',pattern:'先证据后判断',functionText:'减少动机猜测',applicability:'判断类内容',limitations:'缺少来源说明',doNotCopy:'不要把个案写成普遍结论',extractionIds:[21],tags:[],reviewNote:'请补充同维度主要来源。',createdAt:hoursAgo(5)}],lifecycleEvents:[{event:'activated',createdAt:hoursAgo(5)}]},
  {id:14,name:'温和行动型 CTA',dimensionKey:'cta',lifecycleState:'retired',currentApprovedRevisionId:55,revisions:[{id:55,revision:1,state:'approved',origin:'manual',dimensionKey:'cta',name:'温和行动型 CTA',pattern:'低门槛行动 + 反馈入口',functionText:'承接下一步行动',applicability:'教程与方法内容',limitations:'不适合紧急处置',doNotCopy:'不要承诺确定结果',extractionIds:[21],tags:[{id:103,name:'行动'}],createdAt:hoursAgo(40)}],lifecycleEvents:[{event:'activated',createdAt:hoursAgo(40)},{event:'retired',createdAt:hoursAgo(6)}]},
  {id:15,name:'人物立场记忆点',dimensionKey:'core_viewpoint',lifecycleState:'active',currentApprovedRevisionId:null,revisions:[{id:56,revision:1,state:'draft',origin:'ai',dimensionKey:'core_viewpoint',name:'人物立场记忆点',pattern:'一致立场 + 可核对表述',functionText:'形成稳定记忆线索',applicability:'系列内容',limitations:'需要更多范围验证',doNotCopy:'不复制人物经历',extractionIds:[21],tags:[],createdAt:hoursAgo(2)}],lifecycleEvents:[{event:'activated',createdAt:hoursAgo(2)}]},
];
const componentDetail=item=>{const revisions=[...(item.revisions||[])].sort((a,b)=>Number(b.revision)-Number(a.revision));const currentApprovedRevision=revisions.find(revision=>Number(revision.id)===Number(item.currentApprovedRevisionId))||null;return {...item,revisions,currentApprovedRevision};};

/* ---------- 样本库第四阶段：安全 DTO 演示 ---------- */
const STAGE4_RELIABILITY={strongerDescriptive:{n:100,groups:30,accounts:10,coverage:.9},directional:{n:30,groups:10,accounts:5,coverage:.8},exploratory:{n:10,groups:5,accounts:3},fallback:'insufficient'};
const STAGE4_LIMITS={vectorSize:256,dimensionsPerSample:15,retrieveBodyBytes:16384,queryFieldChars:1000,minimumNormalizedTokens:8,tagIdsMax:20,excludeSampleIdsMax:100,sampleLimitDefault:10,sampleLimitMax:30,componentLimitDefault:8,componentLimitMax:20,sampleShortlistMax:600,componentShortlistMax:300,retrieveResponseBytesMax:524288,retrievePerUserConcurrent:2,retrieveGlobalConcurrent:4,statementTimeoutMs:2000,similarLimitMax:30,clusterNeighborK:12,clusterMinScore:.58,clusterMinSharedDimensions:6,clusterMinMembers:3,combinationsPerRunMax:20,combinationSizeMax:3,bootstrapReplicates:2000,pageSizeDefault:20,pageSizeMax:100,insightRequestBodyBytes:65536,insightNameChars:200,accountKeysMax:100,accountKeyChars:240,userNeedTagIdsMax:20,singleTagIdsMax:50,observationTargetSecondsMin:60,observationTargetSecondsMax:31536000,observationToleranceSecondsMax:2592000};
const stage4Reason=(dimensionKey,index=0)=>({dimensionKey,sourceChannels:index?['topic','core_viewpoint']:['userNeed','user_need'],cosine:.86-index*.06,contribution:.22-index*.04,summary:index?'从可观察行为展开论证，并保留适用边界。':'需求与样本中的行动判断语境相近。',decision:index?'reviewed':null,evidenceState:index?'medium':'strong',matchedTags:index?[]:[{id:102,name:'关系判断需求',source:'element_tag'}]});
const stage4SampleResult=(item,index,tagIds=[])=>({id:item.id,title:item.title,platform:item.platform,account:{name:item.accountName||null,handle:null},archiveStatus:item.archiveStatus,currentAnalysisVersionId:item.id===1?1:700+item.id,profileId:9000+item.id,score:.88-index*.045,coverage:.94-index*.025,confidence:{score:.86-index*.04,label:index<2?'high':'medium'},reasons:[stage4Reason('user_need'),stage4Reason('content_structure',1),stage4Reason('title_mechanism',2)],applicability:[{dimensionKey:'user_need',text:'适用于需要把模糊焦虑转成可观察步骤的内容。'}],limitations:[{dimensionKey:'content_structure',text:'只说明结构对应，不推断指标表现或来源关系。'}],matchedTagFilters:SAMPLE_TAGS.filter(tag=>tagIds.includes(tag.id)&&(SAMPLE_TAG_LINKS[item.id]||[]).includes(tag.id)).map(tag=>({id:tag.id,kind:tag.kind,name:tag.name,source:'sample_tag'})),stale:false});
const STAGE4_CLUSTERS=[
  {id:501,runId:501,name:'当前结构聚类 · 15维',current:true,stale:false,clusterCount:2,profileCount:18,completedAt:hoursAgo(3)},
  {id:499,runId:499,name:'历史结构聚类 · 上一选择',current:false,stale:true,staleReasons:['活动算法选择已更新','4 篇源样本画像已变化'],clusterCount:2,profileCount:16,completedAt:hoursAgo(55)},
];
const stage4ClusterDetail=id=>{const run=STAGE4_CLUSTERS.find(value=>value.id===Number(id))||STAGE4_CLUSTERS[0],members=(start,count)=>SAMPLE_ITEMS.slice(start,start+count).map(item=>({sampleId:item.id,title:item.title,platform:item.platform,platformLabel:item.platformLabel}));return {...run,algorithmSelectionId:12,method:'mutual-knn/1',clusters:[{id:701,ordinal:1,label:'关系判断需求 · 案例拆解结构',summary:'9 篇作品在用户需求、内容结构、论证方式呈现相近特征',cohesion:.72,memberCount:9,commonTags:[{id:102,name:'关系判断需求'},{id:104,name:'案例拆解结构'}],distinguishingTags:[{id:103,name:'强结论标题'}],topDimensions:[{dimensionKey:'user_need',label:'用户需求',contribution:.74},{dimensionKey:'content_structure',label:'内容结构',contribution:.69},{dimensionKey:'argumentation_method',label:'论证方式',contribution:.63}],members:members(0,9),limitations:'仅描述冻结范围内的结构接近，不表示因果、来源关系或指标表现。'},{id:702,ordinal:2,label:'女性情感赛道 · 专业解释',summary:'6 篇作品在用户对象、选题、语言风格呈现相近特征',cohesion:.64,memberCount:6,commonTags:[{id:101,name:'女性用户'},{id:106,name:'专业解释'}],distinguishingTags:[{id:105,name:'女性情感赛道'}],topDimensions:[{dimensionKey:'audience',label:'用户对象',contribution:.66},{dimensionKey:'topic',label:'选题',contribution:.62},{dimensionKey:'language_style',label:'语言风格',contribution:.58}],members:members(9,6),limitations:'成员缺失维度不会被推断为不在场。'}],outliers:members(15,3)};};
let stage4RunSeq=802;
const STAGE4_RUNS=[
  {id:801,runId:801,name:'小红书关系判断 · 7天收藏观察',status:'complete',platform:'xiaohongshu',platformLabel:'小红书',goal:'traffic',metric:'saves',sampleSize:42,createdAt:hoursAgo(28),completedAt:hoursAgo(27),polls:3,context:{cohort:{platform:'xiaohongshu',analysisTrust:'human_confirmed',archiveStatuses:['usable','complete'],observationWindow:{targetSeconds:604800,toleranceBeforeSeconds:86400,toleranceAfterSeconds:86400}}},coverage:{eligible:42,outcome:.86,trustedFeature:.81},exclusions:{missing_metric:4,parse_warning:1,missing_published_at:1},warnings:['结论仅适用于当前平台、发布时间范围与观察窗口。','描述性关联不表示因果。']},
  {id:802,runId:802,name:'抖音专业解释 · 3天评论观察',status:'complete',platform:'douyin',platformLabel:'抖音',goal:'expertise',metric:'comments_per_view',sampleSize:12,createdAt:hoursAgo(8),completedAt:hoursAgo(7),polls:3,context:{cohort:{platform:'douyin',analysisTrust:'reviewed_or_manual_tag',archiveStatuses:['usable','complete'],observationWindow:{targetSeconds:259200,toleranceBeforeSeconds:43200,toleranceAfterSeconds:43200}}},coverage:{eligible:12,outcome:.75,trustedFeature:.67},exclusions:{missing_metric:2,parse_warning:1},warnings:['样本和账号分布较少，统计项按探索性观察或样本不足呈现。','目标通过代理指标观察，不表示因果。']},
];
const stage4Stats=id=>Number(id)===802?[{id:1,featureType:'single_tag',featureLabel:'专业解释',dimensionKey:'language_style',dimensionLabel:'语言风格',metric:'comments_per_view',nEligible:12,nObserved:8,nPresent:4,nAbsent:4,reliability:'insufficient',medianDifference:null,confidenceInterval:null,limitations:'两组都少于 5 篇，只保留计数。'},{id:2,featureType:'combination',featureLabel:'案例拆解结构 + 专业解释',dimensionKey:'content_structure',dimensionLabel:'内容结构',metric:'comments_per_view',nEligible:12,nObserved:7,nPresent:3,nAbsent:4,reliability:'insufficient',medianDifference:null,confidenceInterval:null,limitations:'组合在场样本不足，未计算估计。'}]:[{id:3,featureType:'single_tag',featureLabel:'关系判断需求',dimensionKey:'user_need',dimensionLabel:'用户需求',metric:'saves',nEligible:42,nObserved:34,nPresent:19,nAbsent:15,reliability:'directional',medianDifference:184,confidenceInterval:[36,312],limitations:'方向只适用于当前冻结范围与账号分布。'},{id:4,featureType:'single_tag',featureLabel:'案例拆解结构',dimensionKey:'content_structure',dimensionLabel:'内容结构',metric:'saves',nEligible:42,nObserved:28,nPresent:16,nAbsent:12,reliability:'exploratory',medianDifference:96,confidenceInterval:[-18,205],limitations:'区间跨越零，只作为探索性观察。'},{id:5,featureType:'combination',featureLabel:'关系判断需求 + 案例拆解结构',dimensionKey:'content_structure',dimensionLabel:'内容结构',metric:'saves',nEligible:42,nObserved:21,nPresent:9,nAbsent:12,reliability:'exploratory',medianDifference:121,confidenceInterval:[-44,276],limitations:'组合样本较少，不进行排序。'}];
const STAGE4_OBSERVATIONS=[];

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

  const faultMap=globalThis.__IDEAHUB_MOCK_FAILURES__;
  const wildcardFault=faultMap&&Object.entries(faultMap).find(([pattern])=>{const split=pattern.indexOf(' ');if(split<0||pattern.slice(0,split)!==method)return false;const route=pattern.slice(split+1),expression=`^${route.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')}$`;return new RegExp(expression).test(p);});
  const fault=faultMap?.[`${method} ${p}`]||faultMap?.[p]||wildcardFault?.[1];
  if(fault&&(fault.remaining==null||fault.remaining>0)){
    if(Number.isFinite(fault.remaining))fault.remaining-=1;
    throw Object.assign(new Error(fault.message||'演示故障：请重试'),{status:fault.status||500,code:fault.code||'MOCK_FAILURE'});
  }
  if(/^\/api\/(sample-comparisons|sample-relations|content-components|sample-element-extractions)/.test(p)){
    (globalThis.__IDEAHUB_STAGE3_REQUESTS__||=[]).push({method,path:p,body:body==null?null:JSON.parse(JSON.stringify(body))});
  }
  if(/^\/api\/(sample-insights|sample-insight-runs|sample-clusters|sample-cluster-jobs|sample-retrieval|samples\/retrieve|samples\/\d+\/similar)|\/tag-observations$/.test(p)){
    (globalThis.__IDEAHUB_STAGE4_REQUESTS__||=[]).push({method,path:p,body:body==null?null:JSON.parse(JSON.stringify(body))});
  }

  if (p === '/api/me') return ME;

  /* ---------- Sample library stage 4 ---------- */
  if(p==='/api/sample-insights/config'&&method==='GET')return {dimensions:SAMPLE_DIMENSIONS,targets:['traffic','persona','expertise','conversion'],metrics:Object.keys({likes:1,saves:1,comments:1,shares:1,views:1,likes_per_view:1,saves_per_view:1,comments_per_view:1,shares_per_view:1}),trustPolicies:['human_confirmed','reviewed_or_manual_tag','all_effective'],algorithms:{vector:'fh15-q15/1',tokenizer:'zhmix/1',mapping:'retrieve-map/1',cluster:'mutual-knn/1',insight:'descriptive-tags/1'},reliabilityRules:STAGE4_RELIABILITY,limits:STAGE4_LIMITS,causalClaimsAllowed:false};
  if(p==='/api/samples/retrieve'&&method==='POST'){
    strictMockBody(body,['userNeed','topic','target','accountStyle','tagIds','platform','contentType','excludeSampleIds','sampleLimit','componentLimit'],['userNeed','topic','target','accountStyle']);
    if(!Object.keys({traffic:1,persona:1,expertise:1,conversion:1}).includes(body.target))throw Object.assign(new Error('target 不合法'),{status:400});
    const unique=new Set(`${body.userNeed} ${body.topic} ${body.accountStyle}`.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}\p{Script=Latin}\p{Number}]+/gu)||[]);if(unique.size<3)throw Object.assign(new Error('请补充更具体的查询语境'),{status:422,code:'QUERY_TOO_SHORT'});
    const excluded=new Set((body.excludeSampleIds||[]).map(Number)),tagIds=(body.tagIds||[]).map(Number),eligible=SAMPLE_ITEMS.filter(item=>!excluded.has(item.id)&&(!body.platform||item.platform===body.platform)&&(!tagIds.length||tagIds.every(tagId=>(SAMPLE_TAG_LINKS[item.id]||[]).includes(tagId))));
    const samples=eligible.slice(0,Math.min(Number(body.sampleLimit||10),30)).map((item,index)=>stage4SampleResult(item,index,tagIds));const components=CONTENT_COMPONENTS.filter(item=>item.lifecycleState==='active'&&item.currentApprovedRevisionId).slice(0,Math.min(Number(body.componentLimit||8),20)).map((item,index)=>{const revision=item.revisions.find(value=>value.id===item.currentApprovedRevisionId),revisionTags=revision.tags||[];return {id:item.id,revisionId:revision.id,selectionId:400+item.id,profileId:9500+item.id,dimensionKey:item.dimensionKey,name:item.name,summary:revision.patternText||revision.pattern||'',score:.31-index*.04,coverage:.36,confidence:{score:.61-index*.04,label:'medium'},reasons:[stage4Reason(item.dimensionKey,index)],sourceCount:(revision.extractionIds||[]).length,applicability:revision.applicability,limitations:revision.limitations,matchedTagFilters:revisionTags.filter(tag=>tagIds.includes(Number(tag.id))).map(tag=>({id:Number(tag.id),kind:item.dimensionKey,name:tag.name,source:'component_revision_tag'}))};});
    return {method:'deterministic_local_feature_hashing_lsh_exact_rerank',algorithmVersion:'fh15-q15/1',tokenizerVersion:'zhmix/1',mappingVersion:'retrieve-map/1',algorithmSelectionId:12,candidateCounts:{samples:eligible.length,components:components.length},shortlistCounts:{samples:samples.length,components:components.length},approximateRecallDisclosure:'候选经 LSH 近似召回后做精确余弦重排；当前返回不表示穷举全集。',causalClaimsAllowed:false,confidenceDefinition:'置信度综合维度覆盖、来源可靠性和查询信息量。',samples,components};
  }
  const stage4SimilarMatch=p.match(/^\/api\/samples\/(\d+)\/similar$/);
  if(stage4SimilarMatch&&method==='GET'){
    const source=SAMPLE_ITEMS.find(item=>item.id===Number(stage4SimilarMatch[1]));if(!source||source.id===2)throw Object.assign(new Error('该样本画像尚未就绪'),{status:409,code:'INDEX_NOT_READY'});const requested=(q.get('dimensionKeys')||SAMPLE_DIMENSIONS.map(value=>value.key).join(',')).split(',').filter(Boolean),minimum=Math.max(1,Number(q.get('minSharedDimensions')||3)),limit=Math.min(30,Math.max(1,Number(q.get('limit')||10)));
    const items=SAMPLE_ITEMS.filter(item=>item.id!==source.id&&item.id!==2).slice(0,limit).map((item,index)=>{const shared=requested.slice(0,Math.max(minimum,requested.length-index%3-1));const dimensions=shared.map((dimensionKey,order)=>({dimensionKey,cosine:Math.max(.28,.89-index*.025-order*.018),limitations:'该维度只比较双方都有内容的冻结画像。'})),coverage=shared.length/requested.length,reliability=.86-index*.03,confidence=Math.max(0,Math.min(1,coverage*reliability));return {sampleId:item.id,title:item.title,platform:item.platform,profileId:9000+item.id,pairSimilarity:dimensions.reduce((sum,value)=>sum+value.cosine,0)/dimensions.length,sharedDimensionCount:shared.length,coverage,dimensions,confidence:{score:confidence,label:confidence>=.75?'high':confidence>=.5?'medium':'low'},limitations:['结构相似度不表示来源关系或表现优劣。']};});return {algorithmSelectionId:12,anchorSampleId:source.id,dimensionKeys:requested,minSharedDimensions:minimum,items,causalClaimsAllowed:false};
  }
  if(p==='/api/sample-retrieval/status'&&method==='GET'){if(ME.role==='member')throw Object.assign(new Error('只有评审员或管理员可以查看索引状态'),{status:403});return {activeAlgorithm:{id:'12',algorithm_version:'fh15-q15/1',tokenizer_version:'zhmix/1',mapping_version:'retrieve-map/1'},coverage:{dirty_count:'1',missing_count:'1',failed_count:'0',total:'26'},latestBuild:{id:88,status:'succeeded',attempts:1,maxAttempts:3,eligibleCount:26,succeededCount:25,excludedCount:1,failedCount:0,errorCode:null,errorMessage:null,createdAt:hoursAgo(6),startedAt:hoursAgo(5),finishedAt:hoursAgo(4)}};}
  if(p==='/api/sample-clusters'&&method==='GET')return {items:STAGE4_CLUSTERS.map(run=>({id:run.id,profileCount:run.profileCount,clusterCount:run.clusterCount,outlierCount:3,completedAt:run.completedAt,selected:run.current,current:run.current,stale:run.stale,staleReasons:run.stale?run.staleReasons||['algorithm_selection_changed']:[],limitation:'聚类仅描述结构接近程度。'}))};
  const stage4ClusterMatch=p.match(/^\/api\/sample-clusters\/(\d+)$/);if(stage4ClusterMatch&&method==='GET'){const value=stage4ClusterDetail(stage4ClusterMatch[1]);return{id:value.id,algorithmSelectionId:value.algorithmSelectionId,profileCount:value.profileCount,current:value.current,stale:value.stale,staleReasons:value.staleReasons||[],limitation:'聚类仅描述结构接近程度。',clusters:value.clusters.map(cluster=>({id:cluster.id,ordinal:cluster.ordinal,clusterKey:`mock-cluster-${cluster.id}`,representativeSampleId:cluster.members[0]?.sampleId,label:cluster.label,summary:cluster.summary,cohesion:cluster.cohesion,commonTags:cluster.commonTags,distinguishingTags:cluster.distinguishingTags,dimensionContributions:cluster.topDimensions,limitation:cluster.limitations,members:cluster.members.map(member=>member.sampleId)})),outliers:value.outliers.map(member=>member.sampleId)}};
  const observationMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/(\d+)\/elements\/([^/]+)\/tag-observations$/);
  if(observationMatch&&method==='POST'){if(ME.role==='member')throw Object.assign(new Error('只有评审员或管理员可以补充标签观察'),{status:403});strictMockBody(body,['tagId','state','note'],['tagId','state']);if(!['present','absent'].includes(body.state))throw Object.assign(new Error('state 必须是 present 或 absent'),{status:400});const tag=SAMPLE_TAGS.find(value=>value.id===Number(body.tagId));if(!tag||tag.kind!==decodeURIComponent(observationMatch[3]))throw Object.assign(new Error('标签不属于该元素维度'),{status:422});const value={id:STAGE4_OBSERVATIONS.length+1,sampleId:Number(observationMatch[1]),analysisVersionId:Number(observationMatch[2]),dimensionKey:decodeURIComponent(observationMatch[3]),tagId:Number(body.tagId),state:body.state,note:body.note||null,createdAt:new Date().toISOString(),createdByName:ME.name};STAGE4_OBSERVATIONS.push(value);return value;}
  if(p==='/api/sample-insight-runs'&&method==='GET'){const status=q.get('status'),platform=q.get('platform'),goal=q.get('goal'),items=STAGE4_RUNS.filter(run=>(!status||run.status===status)&&(!platform||run.platform===platform)&&(!goal||run.goal===goal));return {items:items.map(run=>({id:run.id,name:run.name,status:run.status,platform:run.platform,goal:run.goal,outcome_metric:run.metric,analysis_trust:run.context?.cohort?.analysisTrust,eligible_count:run.coverage?.eligible,outcome_observed_count:Math.round((run.coverage?.eligible||0)*(run.coverage?.outcome||0)),created_at:run.createdAt,completed_at:run.completedAt})),total:items.length,page:1,pageSize:Number(q.get('pageSize')||20)};}
  if(p==='/api/sample-insight-runs'&&method==='POST'){
    if(ME.role==='member')throw Object.assign(new Error('只有评审员或管理员可以创建统计运行'),{status:403});strictMockBody(body,['name','cutoffAt','cohort','goal','outcome','features'],['name','cohort','goal','outcome','features']);strictMockBody(body.cohort,['platform','publishedFrom','publishedTo','accountKeys','userNeedTagIds','archiveStatuses','analysisTrust','observationWindow'],['platform','archiveStatuses','analysisTrust','observationWindow']);strictMockBody(body.cohort.observationWindow,['targetSeconds','toleranceBeforeSeconds','toleranceAfterSeconds'],['targetSeconds','toleranceBeforeSeconds','toleranceAfterSeconds']);strictMockBody(body.outcome,['metric','transform','proxyAcknowledged'],['metric','transform']);const ratioMetric=String(body.outcome.metric).includes('_per_view');if(ratioMetric?body.outcome.transform!=='raw_ratio':!['raw_count','log1p_count'].includes(body.outcome.transform))throw Object.assign(new Error('outcome.transform 与 metric 不匹配'),{status:400});strictMockBody(body.features,['dimensionKeys','singleTagIds','combinations']);if(!Array.isArray(body.features.dimensionKeys)||!body.features.dimensionKeys.length||!Array.isArray(body.features.singleTagIds)||!Array.isArray(body.features.combinations))throw Object.assign(new Error('features 必须包含维度、单标签和组合数组'),{status:400});const featureIds=[...new Set([...body.features.singleTagIds,...body.features.combinations.flat()])],featureTags=SAMPLE_TAGS.filter(tag=>featureIds.includes(Number(tag.id)));if(featureTags.length!==featureIds.length||featureTags.some(tag=>!body.features.dimensionKeys.includes(tag.kind)))throw Object.assign(new Error('feature tags 必须存在、启用且属于所选维度'),{status:400});if(body.cohort.platform==='manual')throw Object.assign(new Error('当前范围没有可用指标观察'),{status:422,code:'OUTCOME_DATA_UNAVAILABLE',data:{exclusions:{missing_metric:2}}});const id=++stage4RunSeq,value={id,runId:id,name:body.name,status:'queued',platform:body.cohort.platform,platformLabel:body.cohort.platform==='xiaohongshu'?'小红书':'抖音',goal:body.goal,metric:body.outcome.metric,sampleSize:18,createdAt:new Date().toISOString(),polls:0,context:{cohort:body.cohort,goal:body.goal,outcome:body.outcome,features:body.features},coverage:{eligible:18,outcome:.78,trustedFeature:.72},exclusions:{missing_metric:3,missing_published_at:1},warnings:['描述性关联不表示因果。']};STAGE4_RUNS.unshift(value);return {id,status:value.status};
  }
  const stage4StatsMatch=p.match(/^\/api\/sample-insight-runs\/(\d+)\/statistics$/);if(stage4StatsMatch&&method==='GET'){const run=STAGE4_RUNS.find(value=>value.id===Number(stage4StatsMatch[1]));if(!run)throw Object.assign(new Error('洞察运行不存在'),{status:404});const raw=stage4Stats(stage4StatsMatch[1]),items=raw.map(item=>({id:item.id,run_id:Number(stage4StatsMatch[1]),feature_key:`mock-${item.id}`,feature_type:item.featureType==='combination'?'combination':'single',dimension_key:item.dimensionKey,frozen_label:item.featureLabel,reliability:item.reliability,n_eligible:item.nEligible,n_outcome_observed:item.nObserved,n_feature_observed:item.nObserved,n_observed:item.nObserved,n_present:item.nPresent,n_absent:item.nAbsent,unique_accounts:8,outcome_coverage:.81,feature_coverage:.78,present_median:item.medianDifference==null?null:512,present_q1:item.medianDifference==null?null:420,present_q3:item.medianDifference==null?null:650,absent_median:item.medianDifference==null?null:512-item.medianDifference,absent_q1:item.medianDifference==null?null:350,absent_q3:item.medianDifference==null?null:560,median_difference:item.medianDifference,cliffs_delta:item.medianDifference==null?null:.18,median_difference_ci_low:item.confidenceInterval?.[0]??null,median_difference_ci_high:item.confidenceInterval?.[1]??null,cliffs_delta_ci_low:item.medianDifference==null?null:.04,cliffs_delta_ci_high:item.medianDifference==null?null:.31,direction:item.medianDifference==null?null:item.medianDifference>0?'positive':item.medianDifference<0?'negative':'neutral',limitation:item.limitations,created_at:hoursAgo(1)}));return {context:{platform:run.platform,goal:run.goal,outcomeMetric:run.metric,outcomeTransform:run.context.outcome?.transform||(run.metric.includes('_per_view')?'raw_ratio':'raw_count'),analysisTrust:run.context.cohort.analysisTrust,cutoffAt:new Date().toISOString()},items,total:items.length,page:1,pageSize:Number(q.get('pageSize')||20),causalClaimsAllowed:false};}
  const stage4RunCancelMatch=p.match(/^\/api\/sample-insight-runs\/(\d+)\/cancel$/);if(stage4RunCancelMatch&&method==='POST'){const run=STAGE4_RUNS.find(value=>value.id===Number(stage4RunCancelMatch[1]));if(!run)throw Object.assign(new Error('运行不存在'),{status:404});if(!['complete','failed','cancelled'].includes(run.status))run.status='cancelled';return {id:run.id,status:run.status};}
  const stage4RunMatch=p.match(/^\/api\/sample-insight-runs\/(\d+)$/);if(stage4RunMatch&&method==='GET'){const run=STAGE4_RUNS.find(value=>value.id===Number(stage4RunMatch[1]));if(!run)throw Object.assign(new Error('运行不存在'),{status:404});if(run.status==='queued'&&++run.polls>=1)run.status='running';else if(run.status==='running'&&++run.polls>=3){run.status='complete';run.completedAt=new Date().toISOString();}return {id:run.id,name:run.name,status:run.status,request:{cohort:run.context.cohort,goal:run.goal,outcome:run.context.outcome||{metric:run.metric},features:run.context.features||{}},manifestSha256:'mock-manifest',context:{platform:run.platform,goal:run.goal,outcomeMetric:run.metric,outcomeTransform:run.context.outcome?.transform||'raw_count',analysisTrust:run.context.cohort.analysisTrust,cutoffAt:new Date().toISOString()},coverage:{eligible:run.coverage.eligible,outcomeObserved:Math.round(run.coverage.eligible*run.coverage.outcome),featureObserved:Math.round(run.coverage.eligible*run.coverage.trustedFeature)},exclusionCounts:run.exclusions,warnings:run.warnings,causalClaimsAllowed:false,createdAt:run.createdAt,completedAt:run.completedAt};}

  /* ---------- Sample library stage 3 ---------- */
  if(p==='/api/sample-comparisons'&&method==='GET'){
    const keyword=String(q.get('q')||'').trim().toLowerCase(),target=q.get('target'),memberId=Number(q.get('memberId')||0),page=Math.max(1,Number(q.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(q.get('pageSize')||20)));
    const filtered=COMPARISONS.filter(item=>{const currentScope=COMPARISON_SCOPES[item.currentScopeId];return!item.deletedAt&&(!keyword||`${item.name} ${item.topic}`.toLowerCase().includes(keyword))&&(!target||Boolean(item.targets?.[target])||COMPARISON_ASSESSMENTS[item.id]?.some(value=>value.target===target))&&(!memberId||currentScope?.members?.some(member=>Number(member.sampleId)===memberId));});
    return {items:filtered.slice((page-1)*pageSize,page*pageSize).map(item=>{const history=COMPARISON_ASSESSMENTS[item.id]||[],assessmentCounts=Object.fromEntries(['traffic','persona','expertise','conversion'].map(target=>[target,history.filter(value=>value.target===target).length])),currentAssessments=Object.fromEntries(['traffic','persona','expertise','conversion'].map(target=>[target,history.find(value=>value.target===target&&value.isCurrent)]));return{...item,assessmentCounts,currentAssessments};}),total:filtered.length,page,pageSize};
  }
  if(p==='/api/sample-comparisons'&&method==='POST'){
    strictMockBody(body,['title','purpose','scope'],['title','scope']);const scopeInput=strictMockBody(body.scope,['memberIds','topicBasis','purpose'],['memberIds','topicBasis']);const memberIds=[...new Set((scopeInput.memberIds||[]).map(Number))];
    if(memberIds.length<2||memberIds.length>6)throw Object.assign(new Error('比较成员必须是 2–6 篇不同样本'),{status:400});
    const id=++comparisonSeq,scopeId=300+id;const comparison={id,title:body?.title||body?.name||`比较记录 ${id}`,name:body?.title||body?.name||`比较记录 ${id}`,purpose:body?.purpose||scopeInput.purpose||'',topic:scopeInput.topicBasis||scopeInput.topic||body?.purpose||'',currentScopeId:scopeId,currentScopeRevision:1,memberCount:memberIds.length,targets:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const nextScope={...buildScope(scopeId,memberIds,1,comparison.topic),comparisonId:id};COMPARISON_SCOPES[scopeId]=nextScope;COMPARISONS.unshift(comparison);COMPARISON_ASSESSMENTS[id]=[];return {id,comparison,scope:nextScope};
  }
  const comparisonRefreshMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/refresh$/);
  if(comparisonRefreshMatch&&method==='POST'){
    const source=COMPARISONS.find(value=>value.id===Number(comparisonRefreshMatch[1])&&!value.deletedAt);if(!source)throw Object.assign(new Error('比较记录不存在'),{status:404});const sourceScope=COMPARISON_SCOPES[source.currentScopeId];if(!sourceScope)throw Object.assign(new Error('比较记录还没有可重新生成的冻结范围'),{status:404});const id=++comparisonSeq,scopeId=300+id,title=`${String(source.title||source.name||'样本比较').replace(/(?: · 最新拆解)+$/u,'')} · 最新拆解`,memberIds=sourceScope.members.map(value=>Number(value.sampleId));const comparison={id,title,name:title,purpose:source.purpose||'',topic:sourceScope.topicBasis||source.topic,currentScopeId:scopeId,currentScopeRevision:1,memberCount:memberIds.length,targets:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};const nextScope={...buildScope(scopeId,memberIds,1,comparison.topic),comparisonId:id};COMPARISON_SCOPES[scopeId]=nextScope;COMPARISONS.unshift(comparison);COMPARISON_ASSESSMENTS[id]=[];return {...comparison,sourceComparisonId:source.id,scopes:[nextScope]};
  }
  const comparisonDeleteMatch=p.match(/^\/api\/sample-comparisons\/(\d+)$/);
  if(comparisonDeleteMatch&&method==='DELETE'){
    if(ME.role!=='admin')throw Object.assign(new Error('只有管理员可以删除比较记录'),{status:403});const item=COMPARISONS.find(value=>value.id===Number(comparisonDeleteMatch[1])&&!value.deletedAt);if(!item)throw Object.assign(new Error('比较记录不存在'),{status:404});item.deletedAt=new Date().toISOString();return {id:item.id,deleted:true};
  }
  const comparisonDetailMatch=p.match(/^\/api\/sample-comparisons\/(\d+)$/);
  if(comparisonDetailMatch&&method==='GET'){const item=COMPARISONS.find(value=>value.id===Number(comparisonDetailMatch[1])&&!value.deletedAt);if(!item)throw Object.assign(new Error('比较记录不存在'),{status:404});const history=COMPARISON_ASSESSMENTS[item.id]||[],currentAssessments=Object.fromEntries(['traffic','persona','expertise','conversion'].map(target=>[target,history.find(value=>value.target===target&&value.isCurrent)])),assessmentCounts=Object.fromEntries(['traffic','persona','expertise','conversion'].map(target=>[target,history.filter(value=>value.target===target).length]));return {...item,currentScope:COMPARISON_SCOPES[item.currentScopeId],currentAssessments,assessmentCounts};}
  const comparisonScopeCreateMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/scopes$/);
  if(comparisonScopeCreateMatch&&method==='POST'){const comparison=COMPARISONS.find(value=>value.id===Number(comparisonScopeCreateMatch[1]));if(!comparison)throw Object.assign(new Error('比较记录不存在'),{status:404});const memberIds=[...new Set((body?.memberIds||body?.sampleIds||[]).map(Number))];if(memberIds.length<2||memberIds.length>6)throw Object.assign(new Error('比较成员必须是 2–6 篇'),{status:400});const scopeId=Math.max(...Object.keys(COMPARISON_SCOPES).map(Number))+1,revision=Number(comparison.currentScopeRevision||1)+1,next={...buildScope(scopeId,memberIds,revision,body?.topic||comparison.topic),comparisonId:comparison.id};COMPARISON_SCOPES[scopeId]=next;Object.assign(comparison,{currentScopeId:scopeId,currentScopeRevision:revision,memberCount:memberIds.length,topic:body?.topic||comparison.topic,updatedAt:new Date().toISOString()});return {scope:next};}
  const comparisonScopeMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/scopes\/(\d+)$/);
  if(comparisonScopeMatch&&method==='GET'){const value=COMPARISON_SCOPES[Number(comparisonScopeMatch[2])];if(!value||Number(value.comparisonId)!==Number(comparisonScopeMatch[1]))throw Object.assign(new Error('冻结范围不存在'),{status:404});return JSON.parse(JSON.stringify(value));}
  const comparisonAssessmentsMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/assessments$/);
  if(comparisonAssessmentsMatch&&method==='GET'){const target=q.get('target'),all=COMPARISON_ASSESSMENTS[Number(comparisonAssessmentsMatch[1])]||[],items=(target?all.filter(value=>value.target===target):all).map(value=>({id:value.id,scopeId:value.scopeId,target:value.target,source:value.source,revision:value.revision,createdAt:value.createdAt}));return {items,total:items.length};}
  const comparisonManualAssessmentMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/scopes\/(\d+)\/assessments\/manual$/);
  if(comparisonManualAssessmentMatch&&method==='POST'){strictMockBody(body,['target','findings','commonPoints','keyDifferences','strengths','limitations','worthLearning','doNotCopy','hypotheses','openQuestions','methodLimitations'],['target','findings']);if(!['traffic','persona','expertise','conversion'].includes(body.target))throw Object.assign(new Error('target 不合法'),{status:400});for(const finding of body.findings){strictMockBody(finding,['kind','claimText','limitations','evidenceState','memberSampleId','evidenceTokens'],['kind','claimText','evidenceState']);if(!Array.isArray(finding.evidenceTokens))throw Object.assign(new Error('evidenceTokens 必须是数组'),{status:400});if(!['observation','hypothesis','recommendation'].includes(finding.kind))throw Object.assign(new Error('finding kind 不合法'),{status:400});}const comparisonId=Number(comparisonManualAssessmentMatch[1]),scopeId=Number(comparisonManualAssessmentMatch[2]),list=(COMPARISON_ASSESSMENTS[comparisonId]||=[]),target=body.target,revision=Math.max(0,...list.filter(value=>value.target===target).map(value=>Number(value.revision||0)))+1,value={id:++assessmentSeq,comparisonId,scopeId,scopeRevision:COMPARISON_SCOPES[scopeId]?.revision||1,target,source:'manual',revision,isCurrent:false,...body,createdAt:new Date().toISOString()};list.unshift(value);return value;}
  const comparisonAssessmentJobCreateMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/scopes\/(\d+)\/assessment-jobs$/);
  if(comparisonAssessmentJobCreateMatch&&method==='POST'){strictMockBody(body,['target'],['target']);const active=[...COMPARISON_JOBS.values()].find(job=>job.comparisonId===Number(comparisonAssessmentJobCreateMatch[1])&&job.scopeId===Number(comparisonAssessmentJobCreateMatch[2])&&job.target===body.target&&['queued','running'].includes(job.status));if(active)throw Object.assign(new Error('该范围和目标已有进行中的任务'),{status:409});const id=++assessmentJobSeq,job={id,jobId:id,comparisonId:Number(comparisonAssessmentJobCreateMatch[1]),scopeId:Number(comparisonAssessmentJobCreateMatch[2]),target:body.target,status:'queued',progress:5,message:'正在准备冻结快照…',polls:0};COMPARISON_JOBS.set(id,job);return {job:{...job},manualEntryAllowed:true};}
  const comparisonAssessmentJobMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/assessment-jobs\/(\d+)$/);
  if(comparisonAssessmentJobMatch&&method==='GET'){const job=COMPARISON_JOBS.get(Number(comparisonAssessmentJobMatch[2]));if(!job)throw Object.assign(new Error('评价任务不存在'),{status:404});job.polls+=1;if(job.polls===1)Object.assign(job,{status:'running',progress:56,message:'正在核对发现与证据归属…'});if(job.polls>=2&&job.status!=='succeeded'){const list=(COMPARISON_ASSESSMENTS[job.comparisonId]||=[]),revision=Math.max(0,...list.filter(value=>value.target===job.target).map(value=>Number(value.revision||0)))+1;const value={id:++assessmentSeq,comparisonId:job.comparisonId,scopeId:job.scopeId,scopeRevision:COMPARISON_SCOPES[job.scopeId]?.revision||1,target:job.target,source:'ai',revision,isCurrent:false,confidence:.7,commonPoints:['作品都提供清晰的问题入口。'],keyDifferences:['展开顺序与边界不同。'],strengths:['局部结构可核验。'],limitations:['固定范围较小。'],worthLearning:['保留证据与适用条件。'],doNotCopy:['不照搬具体人物和结论。'],hypotheses:[{claimText:'清晰路径可能降低理解成本。',limitations:'需补充同平台样本。'}],openQuestions:['需要补充同平台样本。'],methodLimitations:['不能据此宣称因果效果。'],findings:[],createdAt:new Date().toISOString()};list.unshift(value);Object.assign(job,{status:'succeeded',progress:100,message:'评价版本已生成',assessmentId:value.id});}return {job:{...job},manualEntryAllowed:true};}
  const comparisonAssessmentDetailMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/assessments\/(\d+)$/);
  if(comparisonAssessmentDetailMatch&&method==='GET'){const value=(COMPARISON_ASSESSMENTS[Number(comparisonAssessmentDetailMatch[1])]||[]).find(item=>item.id===Number(comparisonAssessmentDetailMatch[2]));if(!value)throw Object.assign(new Error('评价版本不存在'),{status:404});return value;}
  const comparisonAssessmentSelectMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/assessments\/(\d+)\/select$/);
  if(comparisonAssessmentSelectMatch&&method==='POST'){strictMockBody(body,['reason']);if(ME.role==='member')throw Object.assign(new Error('只有评审员或管理员可以选择官方版本'),{status:403});const list=COMPARISON_ASSESSMENTS[Number(comparisonAssessmentSelectMatch[1])]||[],value=list.find(item=>item.id===Number(comparisonAssessmentSelectMatch[2]));if(!value)throw Object.assign(new Error('评价版本不存在'),{status:404});list.filter(item=>item.target===value.target).forEach(item=>item.isCurrent=item.id===value.id);return {assessmentId:value.id,target:value.target};}

  if(p==='/api/sample-relations'&&method==='POST'){strictMockBody(body,['relationType','subjectSampleId','subjectAnalysisVersionId','objectSampleId','objectAnalysisVersionId','rationale'],['relationType','subjectSampleId','subjectAnalysisVersionId','objectSampleId','objectAnalysisVersionId']);const subjectSampleId=Number(body.subjectSampleId),objectSampleId=Number(body.objectSampleId);if(!subjectSampleId||subjectSampleId===objectSampleId)throw Object.assign(new Error('关系端点不合法'),{status:400});const subjectTitle=SAMPLE_ITEMS.find(item=>item.id===subjectSampleId)?.title,objectTitle=SAMPLE_ITEMS.find(item=>item.id===objectSampleId)?.title,labels={citation:'引用了',imitation:'模仿了',evolution:'演化自',variant:'互为变体'},value={id:++relationSeq,relationType:body.relationType,state:'proposed',proposedBy:ME.id,subject:{sampleId:subjectSampleId,analysisVersionId:Number(body.subjectAnalysisVersionId),title:subjectTitle},object:{sampleId:objectSampleId,analysisVersionId:Number(body.objectAnalysisVersionId),title:objectTitle},rationale:body.rationale||'',text:body.relationType==='variant'?`${subjectTitle} 与 ${objectTitle} 互为变体`:`${subjectTitle} ${labels[body.relationType]||body.relationType} ${objectTitle}`,evidence:[],events:[{event:'proposed',createdAt:new Date().toISOString()}]};SAMPLE_RELATIONS.unshift(value);return {...value,evidenceCount:0,hasVerifiedEvidence:false,permissions:{canWithdraw:true}};}
  const sampleRelationsMatch=p.match(/^\/api\/samples\/(\d+)\/relations$/);
  if(sampleRelationsMatch&&method==='GET'){const sampleId=Number(sampleRelationsMatch[1]),state=q.get('state'),items=SAMPLE_RELATIONS.filter(item=>((item.subjectSampleId??item.subject?.sampleId)===sampleId||(item.objectSampleId??item.object?.sampleId)===sampleId)&&(!state||item.state===state)).map(item=>({...item,evidenceCount:(item.evidence||[]).length,hasVerifiedEvidence:Boolean((item.evidence||[]).length),permissions:{canWithdraw:(['reviewer','admin'].includes(ME.role)&&['proposed','confirmed'].includes(item.state))||(ME.role==='member'&&item.state==='proposed'&&Number(item.proposedBy)===ME.id)}}));return {items,total:items.length};}
  const relationEvidenceMatch=p.match(/^\/api\/sample-relations\/(\d+)\/evidence$/);
  if(relationEvidenceMatch&&method==='POST'){strictMockBody(body,['endpointSampleId','endpointAnalysisVersionId','elementEvidenceId','note'],['endpointSampleId','endpointAnalysisVersionId','elementEvidenceId']);const relation=SAMPLE_RELATIONS.find(item=>item.id===Number(relationEvidenceMatch[1]));if(!relation)throw Object.assign(new Error('关系不存在'),{status:404});const endpoints=[relation.subjectSampleId??relation.subject?.sampleId,relation.objectSampleId??relation.object?.sampleId];if(!endpoints.includes(Number(body.endpointSampleId)))throw Object.assign(new Error('证据必须属于关系端点'),{status:400});const value={id:relation.evidence.length+1,relationId:relation.id,...body,verified:true,createdAt:new Date().toISOString()};relation.evidence.push(value);return value;}
  const relationEventMatch=p.match(/^\/api\/sample-relations\/(\d+)\/events$/);
  if(relationEventMatch&&method==='POST'){strictMockBody(body,['eventType','reason','supersededByRelationId'],['eventType']);const rawEvent=body.eventType,relation=SAMPLE_RELATIONS.find(item=>item.id===Number(relationEventMatch[1]));if(!relation)throw Object.assign(new Error('关系不存在'),{status:404});if(ME.role==='member'&&(rawEvent!=='withdrawn'||relation.state!=='proposed'||Number(relation.proposedBy)!==ME.id))throw Object.assign(new Error('成员只能撤回自己提出且仍待审核的关系'),{status:403});const transitions={proposed:['confirmed','rejected','withdrawn','superseded'],confirmed:['withdrawn','superseded'],withdrawn:['confirmed','superseded']};if(!(transitions[relation.state]||[]).includes(rawEvent))throw Object.assign(new Error('关系状态转换不合法'),{status:409});if(rawEvent==='confirmed'&&!relation.evidence.length)throw Object.assign(new Error('确认关系前至少需要一条端点已核验证据'),{status:409});relation.state=rawEvent;relation.events.push({event:relation.state,createdAt:new Date().toISOString()});return {...relation,evidenceCount:relation.evidence.length,hasVerifiedEvidence:Boolean(relation.evidence.length)};}

  if(p==='/api/sample-element-extractions'&&method==='GET'){const comparisonId=Number(q.get('comparisonId')||0),dimensionKey=q.get('dimensionKey'),page=Math.max(1,Number(q.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(q.get('pageSize')||20))),filtered=SAMPLE_EXTRACTIONS.filter(item=>(!comparisonId||item.comparisonId===comparisonId)&&(!dimensionKey||item.dimensionKey===dimensionKey)),dto=item=>({id:item.id,comparisonId:item.comparisonId,scopeId:item.scopeId,assessmentId:item.assessmentId??null,dimensionKey:item.dimensionKey,origin:item.origin,patternText:item.patternText,functionText:item.functionText,createdAt:item.createdAt});return {items:filtered.slice((page-1)*pageSize,page*pageSize).map(dto),total:filtered.length,page,pageSize};}
  const extractionCreateMatch=p.match(/^\/api\/sample-comparisons\/(\d+)\/scopes\/(\d+)\/extractions$/);
  if(extractionCreateMatch&&method==='POST'){strictMockBody(body,['dimensionKey','assessmentId','patternText','functionText','rationale','applicability','limitations','doNotCopy','sources'],['dimensionKey','patternText','functionText','rationale','applicability','limitations','doNotCopy','sources']);for(const source of body.sources)strictMockBody(source,['snapshotId','sourceRole','note'],['snapshotId','sourceRole']);if(!body.sources.some(source=>source.sourceRole==='primary'))throw Object.assign(new Error('至少选择一条主要来源快照'),{status:400});const value={id:++extractionSeq,comparisonId:Number(extractionCreateMatch[1]),scopeId:Number(extractionCreateMatch[2]),origin:'manual',...body,createdAt:new Date().toISOString()};SAMPLE_EXTRACTIONS.unshift(value);return value;}

  if(p==='/api/content-components'&&method==='GET'){
    const keyword=String(q.get('q')||'').trim().toLowerCase(),dimensionKey=q.get('dimensionKey'),state=q.get('state'),source=q.get('source'),page=Math.max(1,Number(q.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(q.get('pageSize')||20))),filtered=CONTENT_COMPONENTS.map(item=>{const detail=componentDetail(item),displayRevision=detail.revisions[0]||{},displayState=item.lifecycleState==='retired'?'retired':displayRevision.state;return {...item,displayRevision,state:displayState,currentApprovedRevision:detail.currentApprovedRevision};}).filter(item=>(!keyword||`${item.name} ${item.displayRevision.pattern} ${item.displayRevision.functionText}`.toLowerCase().includes(keyword))&&(!dimensionKey||item.dimensionKey===dimensionKey)&&(!state||item.state===state)&&(!source||(item.displayRevision.origin||item.displayRevision.source)===source));return {items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize};
  }
  if(p==='/api/content-components'&&method==='POST'){strictMockBody(body,['dimensionKey','name','patternText','functionText','applicability','limitations','doNotCopy','extractionIds','tagIds'],['dimensionKey','name','patternText','functionText','applicability','limitations','doNotCopy','extractionIds']);const extractionIds=body.extractionIds;if(!Array.isArray(body.tagIds))throw Object.assign(new Error('tagIds 必须是数组'),{status:400});if(!extractionIds.length)throw Object.assign(new Error('组件草稿至少需要一个同维度局部提取来源'),{status:400});const id=++componentSeq,revision={id:++componentRevisionSeq,revision:1,state:'draft',origin:'manual',...body,tags:body.tagIds.map((value,index)=>({id:Number(value)||500+index,name:`标签 #${value}`})),createdAt:new Date().toISOString()},value={id,name:body.name,dimensionKey:body.dimensionKey,lifecycleState:'active',currentApprovedRevisionId:null,revisions:[revision],lifecycleEvents:[{event:'activated',createdAt:new Date().toISOString()}]};CONTENT_COMPONENTS.unshift(value);return componentDetail(value);}
  if(p==='/api/reusable-components'&&method==='GET'){const keyword=String(q.get('q')||'').trim().toLowerCase(),dimensionKey=q.get('dimensionKey'),page=Math.max(1,Number(q.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(q.get('pageSize')||20))),filtered=CONTENT_COMPONENTS.filter(item=>item.lifecycleState!=='retired'&&item.currentApprovedRevisionId).map(item=>{const currentRevision=item.revisions.find(revision=>revision.id===item.currentApprovedRevisionId);return {id:item.id,name:item.name,dimensionKey:item.dimensionKey,currentRevision};}).filter(item=>(!keyword||`${item.name} ${item.currentRevision?.pattern} ${item.currentRevision?.functionText}`.toLowerCase().includes(keyword))&&(!dimensionKey||item.dimensionKey===dimensionKey));return {items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize};}
  const componentDetailMatch=p.match(/^\/api\/content-components\/(\d+)$/);
  if(componentDetailMatch&&method==='GET'){const item=CONTENT_COMPONENTS.find(value=>value.id===Number(componentDetailMatch[1]));if(!item)throw Object.assign(new Error('组件不存在'),{status:404});return componentDetail(item);}
  const componentRevisionCreateMatch=p.match(/^\/api\/content-components\/(\d+)\/revisions$/);
  if(componentRevisionCreateMatch&&method==='POST'){strictMockBody(body,['dimensionKey','name','patternText','functionText','applicability','limitations','doNotCopy','extractionIds','tagIds'],['dimensionKey','name','patternText','functionText','applicability','limitations','doNotCopy','extractionIds']);if(!Array.isArray(body.tagIds))throw Object.assign(new Error('tagIds 必须是数组'),{status:400});const item=CONTENT_COMPONENTS.find(value=>value.id===Number(componentRevisionCreateMatch[1]));if(!item)throw Object.assign(new Error('组件不存在'),{status:404});const revision={id:++componentRevisionSeq,revision:Math.max(0,...item.revisions.map(value=>Number(value.revision||0)))+1,state:'draft',origin:'manual',...body,tags:body.tagIds.map((value,index)=>({id:Number(value)||600+index,name:`标签 #${value}`})),createdAt:new Date().toISOString()};item.revisions.unshift(revision);return componentDetail(item);}
  const componentSubmitMatch=p.match(/^\/api\/content-components\/(\d+)\/revisions\/(\d+)\/submit$/);
  if(componentSubmitMatch&&method==='POST'){strictMockBody(body,['note']);const item=CONTENT_COMPONENTS.find(value=>value.id===Number(componentSubmitMatch[1])),revision=item?.revisions.find(value=>value.id===Number(componentSubmitMatch[2]));if(!revision||revision.state!=='draft')throw Object.assign(new Error('只有草稿可以提交审核'),{status:409});revision.state='submitted';revision.submittedAt=new Date().toISOString();return componentDetail(item);}
  const componentReviewMatch=p.match(/^\/api\/content-components\/(\d+)\/revisions\/(\d+)\/review$/);
  if(componentReviewMatch&&method==='POST'){strictMockBody(body,['decision','note'],['decision']);if(ME.role==='member')throw Object.assign(new Error('只有评审员或管理员可以审核组件'),{status:403});const item=CONTENT_COMPONENTS.find(value=>value.id===Number(componentReviewMatch[1])),revision=item?.revisions.find(value=>value.id===Number(componentReviewMatch[2]));if(!revision||revision.state!=='submitted')throw Object.assign(new Error('只有待审核修订可以形成审核决定'),{status:409});revision.state=body.decision;revision.reviewNote=body.note||'';revision.reviewedAt=new Date().toISOString();if(body.decision==='approved')item.currentApprovedRevisionId=revision.id;return componentDetail(item);}
  const componentLifecycleMatch=p.match(/^\/api\/content-components\/(\d+)\/lifecycle$/);
  if(componentLifecycleMatch&&method==='POST'){strictMockBody(body,['action','reason'],['action']);if(ME.role!=='admin')throw Object.assign(new Error('只有管理员可以停用或恢复组件'),{status:403});const item=CONTENT_COMPONENTS.find(value=>value.id===Number(componentLifecycleMatch[1]));if(!item)throw Object.assign(new Error('组件不存在'),{status:404});const event=body.action;if(event==='retire'&&item.lifecycleState==='retired'||event==='reactivate'&&item.lifecycleState!=='retired')throw Object.assign(new Error('生命周期事件与当前状态冲突'),{status:409});item.lifecycleState=event==='retire'?'retired':'active';item.lifecycleEvents.push({event:event==='retire'?'retired':'reactivated',createdAt:new Date().toISOString()});return componentDetail(item);}

  /* ---------- 样本库第二阶段 ---------- */
  if(p==='/api/sample-research/config'&&method==='GET')return {dimensions:SAMPLE_DIMENSIONS,tags:SAMPLE_TAGS,tagsByKind:Object.fromEntries(SAMPLE_DIMENSIONS.map(dim=>[dim.key,SAMPLE_TAGS.filter(tag=>tag.kind===dim.key)])),manualEntryAllowed:true,aiConfigured:true,quality:{overall:{total:45,reviewed:31,pending:14,confirmed:22,edited:7,rejected:2,reviewCoverage:.689,exactConfirmationRate:.71,correctionRate:.226,rejectionRate:.065},dimensions:SAMPLE_DIMENSIONS.map((dim,index)=>({dimensionKey:dim.key,total:3,reviewed:index%3===0?3:2,confirmed:index%3===0?1:2,edited:index%3===0?1:0,rejected:index%3===0?1:0,correctionRate:index%3===0?.333:0,rejectionRate:index%3===0?.333:0}))}};
  if(p==='/api/samples/search'&&method==='POST'){
    const keyword=String(body?.q||'').trim().toLowerCase(),platform=body?.platform,status=body?.archiveStatus;
    const flatTagIds=Array.isArray(body?.tagIds)?body.tagIds.map(Number):[];const selectedTagRows=SAMPLE_TAGS.filter(t=>flatTagIds.includes(Number(t.id)));const tagGroups=Object.values(selectedTagRows.reduce((out,t)=>{(out[t.kind]||={tagIds:[]}).tagIds.push(t.id);return out;},{}));const conditions=Array.isArray(body?.elements)?body.elements:[];
    const matched=SAMPLE_ITEMS.map(item=>{
      const version=currentResearchVersion(item.id),elements=version?.elements||[],tagIds=SAMPLE_TAG_LINKS[item.id]||[];
      const tagOk=tagGroups.every(group=>(group.tagIds||[]).some(id=>tagIds.includes(Number(id))));
      const elementMatches=conditions.map(condition=>{const element=elements.find(e=>e.dimensionKey===condition.dimensionKey&&!['rejected'].includes(e.decisionStatus));const value=String(element?.effectiveValue||'').toLowerCase();const facets=(condition.facets||[]).map(v=>String(v).toLowerCase());const ok=element&&(condition.facetMode==='all'?facets.every(f=>value.includes(f)):facets.some(f=>value.includes(f)));return ok?{dimensionKey:condition.dimensionKey,dimensionLabel:SAMPLE_DIMENSIONS.find(d=>d.key===condition.dimensionKey)?.label,effectiveValue:element.effectiveValue}:null;});
      if((keyword&&!`${item.title} ${item.bodyText} ${item.accountName} ${item.platformContentId||''}`.toLowerCase().includes(keyword))||(platform&&item.platform!==platform)||(status&&item.archiveStatus!==status)||!tagOk||elementMatches.some(x=>!x))return null;
      const matchedTags=tagGroups.flatMap(group=>(group.tagIds||[]).filter(id=>tagIds.includes(Number(id))).map(id=>SAMPLE_TAGS.find(t=>t.id===Number(id)))).filter(Boolean);
      return {...item,matchedTags,matchedElements:elementMatches.filter(Boolean),elementCount:elements.length,confirmedElementCount:elements.filter(e=>['confirmed','edited'].includes(e.decisionStatus)).length};
    }).filter(Boolean);
    const page=Math.max(1,Number(body?.page||1)),pageSize=Math.max(1,Number(body?.pageSize||24));
    return {items:matched.slice((page-1)*pageSize,page*pageSize).map(({bodyText,...item})=>item),total:matched.length,page,pageSize,summary:{total:SAMPLE_ITEMS.length,complete:SAMPLE_ITEMS.filter(i=>i.archiveStatus==='complete').length,incomplete:SAMPLE_ITEMS.filter(i=>i.archiveStatus!=='complete').length}};
  }
  const researchMatch=p.match(/^\/api\/samples\/(\d+)\/research$/);
  if(researchMatch&&method==='GET')return researchSummary(Number(researchMatch[1]));
  const analysesMatch=p.match(/^\/api\/samples\/(\d+)\/analyses$/);
  if(analysesMatch&&method==='GET')return {items:researchSummary(Number(analysesMatch[1])).versions};
  const manualAnalysisMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/manual$/);
  if(manualAnalysisMatch&&method==='POST'){
    const sampleId=Number(manualAnalysisMatch[1]),list=(SAMPLE_RESEARCH_VERSIONS[sampleId]||=[]);if(body?.selectOnSuccess)list.forEach(v=>v.isCurrent=false);
    const version={id:++researchVersionSeq,sampleId,revision:list.length+1,source:'manual',isCurrent:!!body?.selectOnSuccess,status:'completed',model:null,inputSha256:`manual-${Date.now()}`,createdAt:new Date().toISOString(),elements:researchElements('manual')};list.unshift(version);return version;
  }
  const analysisVersionMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/(\d+)$/);
  if(analysisVersionMatch&&method==='GET'){const version=(SAMPLE_RESEARCH_VERSIONS[Number(analysisVersionMatch[1])]||[]).find(v=>v.id===Number(analysisVersionMatch[2]));if(!version)throw Object.assign(new Error('分析版本不存在'),{status:404});return JSON.parse(JSON.stringify(version));}
  const selectVersionMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/(\d+)\/select$/);
  if(selectVersionMatch&&method==='POST'){const list=SAMPLE_RESEARCH_VERSIONS[Number(selectVersionMatch[1])]||[],id=Number(selectVersionMatch[2]);if(!list.some(v=>v.id===id))throw Object.assign(new Error('分析版本不存在'),{status:404});list.forEach(v=>v.isCurrent=v.id===id);return {ok:true,currentAnalysisVersionId:id};}
  const decisionMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/(\d+)\/elements\/([^/]+)\/decisions$/);
  if(decisionMatch&&method==='POST'){const version=(SAMPLE_RESEARCH_VERSIONS[Number(decisionMatch[1])]||[]).find(v=>v.id===Number(decisionMatch[2])),element=version?.elements.find(e=>e.dimensionKey===decodeURIComponent(decisionMatch[3]));if(!element)throw Object.assign(new Error('元素不存在'),{status:404});element.decisionStatus=body?.decision||'confirmed';element.effectiveValue=body?.decision==='edited'?body.value:body?.decision==='rejected'?null:element.aiValue;element.decision={id:++researchDecisionSeq,decision:element.decisionStatus,value:body?.value||null,createdAt:new Date().toISOString(),createdByName:ME.name};return {element};}
  const elementAiRerunMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/(\d+)\/elements\/([^/]+)\/ai-rerun$/);
  if(elementAiRerunMatch&&method==='POST'){const sampleId=Number(elementAiRerunMatch[1]),base=(SAMPLE_RESEARCH_VERSIONS[sampleId]||[]).find(v=>v.id===Number(elementAiRerunMatch[2])),key=decodeURIComponent(elementAiRerunMatch[3]);if(!base)throw Object.assign(new Error('分析版本不存在'),{status:404});const list=SAMPLE_RESEARCH_VERSIONS[sampleId]||=[],elements=JSON.parse(JSON.stringify(base.elements));const target=elements.find(element=>element.dimensionKey===key);if(!target)throw Object.assign(new Error('元素不存在'),{status:404});target.aiValue=`${target.aiValue||target.effectiveValue||key}（AI 单项重拆）`;target.effectiveValue=target.aiValue;target.decisionStatus='pending';target.decision=null;target.confidence=.86;list.forEach(version=>version.isCurrent=false);const version={...base,id:++researchVersionSeq,revision:list.length+1,isCurrent:true,source:'ai',model:'mock-single-ai',promptVersion:`mock:single:${key}:base:${base.id}`,inputSha256:`single-${Date.now()}`,createdAt:new Date().toISOString(),elements};list.unshift(version);return {version,baseVersionId:base.id,rerunDimensionKey:key};}
  const elementTagsMatch=p.match(/^\/api\/samples\/(\d+)\/analyses\/(\d+)\/elements\/([^/]+)\/tags$/);
  if(elementTagsMatch&&method==='POST'){const version=(SAMPLE_RESEARCH_VERSIONS[Number(elementTagsMatch[1])]||[]).find(v=>v.id===Number(elementTagsMatch[2])),element=version?.elements.find(e=>e.dimensionKey===decodeURIComponent(elementTagsMatch[3]));if(!element)throw Object.assign(new Error('元素不存在'),{status:404});const existing=new Set((element.tags||[]).map(t=>Number(t.id)));for(const id of body?.tagIds||[]){const tag=SAMPLE_TAGS.find(t=>t.id===Number(id)&&t.kind===element.dimensionKey);if(tag&&!existing.has(tag.id)){(element.tags||=[]).push(tag);existing.add(tag.id);}}return {items:element.tags||[]};}
  const jobsCreateMatch=p.match(/^\/api\/samples\/(\d+)\/analysis-jobs$/);
  if(jobsCreateMatch&&method==='POST'){const sampleId=Number(jobsCreateMatch[1]),id=++researchJobSeq,job={id,jobId:id,sampleId,status:'queued',progress:5,message:'正在准备证据…',polls:0,selectOnSuccess:body?.selectOnSuccess!==false};RESEARCH_JOBS.set(id,job);return {...job};}
  const jobMatch=p.match(/^\/api\/samples\/(\d+)\/analysis-jobs\/(\d+)$/);
  if(jobMatch&&method==='GET'){const job=RESEARCH_JOBS.get(Number(jobMatch[2]));if(!job)throw Object.assign(new Error('任务不存在'),{status:404});job.polls++;if(job.polls===1)Object.assign(job,{status:'running',progress:48,message:'正在核验证据与十五个维度…'});if(job.polls>=2){const list=(SAMPLE_RESEARCH_VERSIONS[job.sampleId]||=[]);if(!job.versionId){if(job.selectOnSuccess)list.forEach(v=>v.isCurrent=false);const version={id:++researchVersionSeq,sampleId:job.sampleId,revision:list.length+1,source:'ai',isCurrent:job.selectOnSuccess,status:'completed',model:'gpt-4o · prompt v3',inputSha256:`demo-${Date.now()}`,createdAt:new Date().toISOString(),elements:researchElements('ai').map(e=>({...e,decisionStatus:'pending',decision:null}))};list.unshift(version);job.versionId=version.id;}Object.assign(job,{status:'completed',progress:100,message:'拆解完成'});}return {...job};}
  const sampleTagsMatch=p.match(/^\/api\/samples\/(\d+)\/tags$/);
  if(sampleTagsMatch&&method==='GET')return {items:(SAMPLE_TAG_LINKS[Number(sampleTagsMatch[1])]||[]).map(id=>SAMPLE_TAGS.find(t=>t.id===id)).filter(Boolean)};
  if(sampleTagsMatch&&method==='POST'){SAMPLE_TAG_LINKS[Number(sampleTagsMatch[1])]=[...new Set((body?.tagIds||[]).map(Number))];return {items:SAMPLE_TAG_LINKS[Number(sampleTagsMatch[1])].map(id=>SAMPLE_TAGS.find(t=>t.id===id)).filter(Boolean)};}
  const evaluationsMatch=p.match(/^\/api\/samples\/(\d+)\/evaluations$/);
  if(evaluationsMatch&&method==='GET')return {items:SAMPLE_EVALUATIONS[Number(evaluationsMatch[1])]||[]};
  if(evaluationsMatch&&method==='POST'){const sampleId=Number(evaluationsMatch[1]),value={id:++researchEvaluationSeq,...body,createdAt:new Date().toISOString(),createdByName:ME.name};(SAMPLE_EVALUATIONS[sampleId]||=[]).unshift(value);return {evaluation:value};}
  const aiEvaluationMatch=p.match(/^\/api\/samples\/(\d+)\/evaluations\/ai$/);
  if(aiEvaluationMatch&&method==='POST'){const sampleId=Number(aiEvaluationMatch[1]),value={id:++researchEvaluationSeq,target:body?.target||'traffic',source:'ai',analysisVersionId:body?.analysisVersionId||null,strengths:['标题价值承诺清晰，进入正文前已完成受众筛选。'],weaknesses:['证据样本仍少，不能把当前表现解释成因果。'],worthLearning:['场景化强判断标题','逐步推进的案例结构'],avoidCopying:['不要照搬具体时间值和关系结论'],effectHypotheses:['明确判断标准降低理解成本，可能提升收藏。'],createdAt:new Date().toISOString(),createdByName:'AI'};(SAMPLE_EVALUATIONS[sampleId]||=[]).unshift(value);return value;}
  const metricsMatch=p.match(/^\/api\/samples\/(\d+)\/metrics$/);
  if(metricsMatch&&method==='GET')return {items:SAMPLE_METRICS[Number(metricsMatch[1])]||[]};

  /* ---------- 样本库阶段一 ---------- */
  if (p === '/api/samples' && method === 'GET') {
    const keyword=String(q.get('q')||'').trim().toLowerCase();const platform=q.get('platform');const status=q.get('archiveStatus');
    const filtered=SAMPLE_ITEMS.filter(item=>(!keyword||`${item.title} ${item.bodyText} ${item.accountName} ${item.platformContentId||''}`.toLowerCase().includes(keyword))&&(!platform||item.platform===platform)&&(!status||item.archiveStatus===status));
    const page=Math.max(1,Number(q.get('page')||1));const pageSize=Math.max(1,Number(q.get('pageSize')||24));const offset=(page-1)*pageSize;
    return {items:filtered.slice(offset,offset+pageSize).map(({bodyText,...item})=>({...item})),total:filtered.length,page,pageSize,summary:{total:SAMPLE_ITEMS.length,complete:SAMPLE_ITEMS.filter(item=>item.archiveStatus==='complete').length,incomplete:SAMPLE_ITEMS.filter(item=>item.archiveStatus!=='complete').length}};
  }
  if (p === '/api/samples' && method === 'POST') {
    const id=++sampleSeq;const missing=['account','published_at','cover','media'].filter(key=>key!=='account'||!body?.accountName).filter(key=>key!=='published_at'||!body?.publishedAt);
    const item={id,canonicalKey:`manual:new:${id}`,platform:body?.platform||'manual',platformLabel:body?.platform==='xiaohongshu'?'小红书':body?.platform==='douyin'?'抖音':'手动归档',platformContentId:body?.platformContentId||null,sourceUrl:body?.sourceUrl||null,title:body?.title||'未命名样本',bodyExcerpt:String(body?.bodyText||'').slice(0,280),bodyText:body?.bodyText||'',contentType:body?.contentType||'unknown',accountName:body?.accountName||'',publishedAt:body?.publishedAt||null,metrics:body?.metrics||{},archiveStatus:'partial',completenessScore:45,missingFields:missing,captureCount:1,assetCount:0,coverAssetId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};SAMPLE_ITEMS.unshift(item);return {sample:item,capture:sampleDetail(item).captures[0],created:true};
  }
  const sampleDetailMatch=p.match(/^\/api\/samples\/(\d+)$/);
  if(sampleDetailMatch&&method==='GET'){const item=SAMPLE_ITEMS.find(x=>x.id===Number(sampleDetailMatch[1]));if(!item)throw Object.assign(new Error('样本不存在'),{status:404});return sampleDetail(item);}
  if(sampleDetailMatch&&method==='PATCH'){const item=SAMPLE_ITEMS.find(x=>x.id===Number(sampleDetailMatch[1]));if(!item)throw Object.assign(new Error('样本不存在'),{status:404});Object.assign(item,{title:body?.title??item.title,bodyText:body?.bodyText??item.bodyText,bodyExcerpt:String(body?.bodyText??item.bodyText??'').slice(0,280),platform:body?.platform??item.platform,contentType:body?.contentType??item.contentType,accountName:body?.accountName??item.accountName,publishedAt:body?.publishedAt??item.publishedAt,sourceUrl:body?.sourceUrl??item.sourceUrl,metrics:{...(item.metrics||{}),...(body?.metrics||{})},updatedAt:new Date().toISOString(),captureCount:Number(item.captureCount||0)+1});item.missingFields=(item.missingFields||[]).filter(key=>key!=='account'||!item.accountName).filter(key=>key!=='published_at'||!item.publishedAt).filter(key=>key!=='metrics'||!Object.values(item.metrics||{}).some(Boolean)).filter(key=>key!=='body_text'||!item.bodyText);return {sample:item,capture:sampleDetail(item).captures[0],updated:true};}
  const sampleRawMatch=p.match(/^\/api\/samples\/(\d+)\/captures\/(\d+)\/raw$/);
  if(sampleRawMatch&&method==='GET'){const item=SAMPLE_ITEMS.find(x=>x.id===Number(sampleRawMatch[1]));if(!item)throw Object.assign(new Error('采集版本不存在'),{status:404});return {title:item.title,body_text:item.bodyText,platform:item.platform,metrics:item.metrics,source_url:item.sourceUrl};}
  const sampleCapturesMatch=p.match(/^\/api\/samples\/(\d+)\/captures$/);
  if(sampleCapturesMatch&&method==='GET'){const item=SAMPLE_ITEMS.find(x=>x.id===Number(sampleCapturesMatch[1]));if(!item)throw Object.assign(new Error('样本不存在'),{status:404});const page=Math.max(1,Number(q.get('page')||1));const pageSize=Math.max(1,Number(q.get('pageSize')||20));const all=Array.from({length:Number(item.captureCount||1)},(_,index)=>({id:item.id*100+index+1,sampleId:item.id,captureKey:`demo-${item.id}-${index+1}`,captureType:item.platform==='manual'?'manual':'link',capturedAt:new Date(new Date(item.updatedAt).valueOf()-index*86400000).toISOString(),sourceUrl:item.sourceUrl,normalizedPayload:{title:item.title},payloadSha256:'demo',completenessScore:item.completenessScore,missingFields:item.missingFields,createdAt:item.createdAt}));return {items:all.slice((page-1)*pageSize,page*pageSize),total:all.length,page,pageSize};}
  const sampleAssetCreateMatch=p.match(/^\/api\/samples(?:\/(\d+))?\/assets$/);
  if(sampleAssetCreateMatch&&method==='POST'){let item=SAMPLE_ITEMS.find(x=>x.id===Number(sampleAssetCreateMatch[1]));if(!item){const id=++sampleSeq;item={id,canonicalKey:`manual:upload:${id}`,platform:q.get('platform')||'manual',platformLabel:'手动归档',platformContentId:null,sourceUrl:q.get('sourceUrl')||null,title:q.get('title')||body?.name||'上传媒体',bodyExcerpt:'',bodyText:'',contentType:q.get('contentType')||'unknown',accountName:'',publishedAt:null,metrics:{},archiveStatus:'partial',completenessScore:55,missingFields:['body_text','account','published_at','metrics','cover'],captureCount:1,assetCount:0,coverAssetId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};SAMPLE_ITEMS.unshift(item);}item.assetCount+=1;if(q.get('kind')==='cover'){item.coverAssetId=900+item.assetCount;item.missingFields=item.missingFields.filter(x=>x!=='cover');}else item.missingFields=item.missingFields.filter(x=>x!=='media');item.completenessScore=Math.min(100,item.completenessScore+15);return {id:900+item.assetCount,sampleId:item.id,kind:q.get('kind')||'other',originalName:body?.name||q.get('name')||'media',mimeType:body?.type||'application/octet-stream',byteSize:body?.size||1024,archiveQuality:'user_upload',completeness:{score:item.completenessScore,missingFields:item.missingFields,archiveStatus:item.archiveStatus}};}

  /* ---------- 内容采集：完整的无后端交互链路 ---------- */
  if (p === '/api/collector/health' && method === 'GET') {
    return q.get('scenario') === 'down'
      ? { ok:false, collector:'down', error:'演示：采集服务暂时未启动' }
      : { ok:true, collector:'up' };
  }
  if (p === '/api/collector/login/xiaohongshu/status' && method === 'GET') {
    if (ME.role !== 'admin') throw Object.assign(new Error('只有管理员可以管理平台登录或删除采集记录'), { status:403 });
    if (collectorLogin.status === 'opening') {
      collectorLoginPolls += 1;
      collectorLogin = { ...collectorLogin, status:'waiting_scan', message:'请使用小红书扫码登录', qr_available:true,
        expires_at:Math.floor(Date.now() / 1000) + 180, saved:false, account:{} };
    } else if (collectorLogin.status === 'waiting_scan' && ++collectorLoginPolls >= 3) {
      collectorLogin = { status:'saved', message:'扫码成功，登录态已安全保存', qr_available:false, expires_at:null, saved:true,
        account:{ nickname:'关系研究所', red_id:'ideahub-demo', user_id:'demo-xhs-01', avatar_url:'', description:'关系判断与行动建议' },
        account_label:'', identity_verified:true };
    }
    return { ...collectorLogin, account:{ ...(collectorLogin.account || {}) } };
  }
  if (p === '/api/collector/login/xiaohongshu' && method === 'POST') {
    if (ME.role !== 'admin' || body?.mock_role === 'member') {
      throw Object.assign(new Error('只有管理员可以管理平台登录或删除采集记录'), { status:403 });
    }
    collectorLoginPolls = 0;
    collectorLogin = { status:'opening', message:body?.mode === 'switch' ? '正在准备切换账号…' : '正在打开登录页面…',
      qr_available:false, expires_at:null, saved:false, account:{}, account_label:'', identity_verified:false };
    return { ...collectorLogin };
  }
  if (p === '/api/collector/login/xiaohongshu/account' && method === 'POST') {
    if (ME.role !== 'admin') throw Object.assign(new Error('只有管理员可以管理平台账号'), { status:403 });
    if (!collectorLogin.saved) throw Object.assign(new Error('请先扫码登录小红书'), { status:409 });
    await new Promise(resolve => setTimeout(resolve, 260));
    collectorLogin = { ...collectorLogin, status:'saved', message:'当前登录账号已同步' };
    return { ...collectorLogin, account:{ ...collectorLogin.account } };
  }
  if (p === '/api/collector/login/xiaohongshu/label' && method === 'POST') {
    if (ME.role !== 'admin') throw Object.assign(new Error('只有管理员可以管理平台账号'), { status:403 });
    if (!collectorLogin.saved) throw Object.assign(new Error('请先登录采集账号'), { status:409 });
    collectorLogin = { ...collectorLogin, account_label:String(body?.label || '').trim().slice(0, 32) };
    return { ...collectorLogin, account:{ ...(collectorLogin.account || {}) } };
  }
  if (p === '/api/collector/login/xiaohongshu/logout' && method === 'POST') {
    if (ME.role !== 'admin') throw Object.assign(new Error('只有管理员可以管理平台账号'), { status:403 });
    collectorLogin = { status:'idle', message:'采集账号已退出', qr_available:false, expires_at:null,
      saved:false, account:{}, account_label:'', identity_verified:false };
    return { ...collectorLogin };
  }
  if (p === '/api/collector/tasks' && method === 'GET') {
    if (q.get('scenario') === 'empty') return [];
    return COLLECTOR_TASKS.map(item => ({ ...item }));
  }
  if (p === '/api/collector/tasks' && method === 'POST') {
    const raw = String(body?.url || '').trim();
    const matched = raw.match(/https?:\/\/[^\s<>"']+/i);
    const url = matched?.[0]?.replace(/[，。！？、；：,!?;:)\]}）】》]+$/, '') || '';
    if (!/^https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.(?:com|cn)|douyin\.com|v\.douyin\.com)\//i.test(url)) {
      throw Object.assign(new Error('目前只支持小红书或抖音分享链接'), { status:400 });
    }
    const id = `demo-new-${++collectorTaskSeq}`;
    const task = { id, url, source:/douyin/i.test(url) ? 'douyin' : 'xiaohongshu', title:'正在识别内容标题…',
      account_name:'', owner_id:String(ME.id), status:'pending', progress:0, message:'等待采集槽位…',
      session_mode:body?.session_mode === 'public' ? 'public' : 'saved',
      created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
    COLLECTOR_TASKS.unshift(task);
    collectorPolls.set(id, 0);
    return { task_id:id, status:'pending', session_mode:task.session_mode, owner_id:String(ME.id), max_concurrent:1 };
  }
  const collectorStatusMatch = p.match(/^\/api\/collector\/tasks\/([^/]+)\/status$/);
  if (collectorStatusMatch && method === 'GET') {
    const id = decodeURIComponent(collectorStatusMatch[1]);
    const task = COLLECTOR_TASKS.find(item => item.id === id);
    if (!task) throw Object.assign(new Error('找不到这条采集任务'), { status:404 });
    if (task.status === 'pending' || task.status === 'running') {
      const count = (collectorPolls.get(id) || 0) + 1;
      collectorPolls.set(id, count);
      if (count === 1) Object.assign(task, { status:'running', progress:46, message:'正在提取正文、图片和评论…' });
      else Object.assign(task, { status:'done', progress:100, message:'采集分析完成', title:'关系降温后，先看清这三个信号', account_name:'关系研究所' });
      task.updated_at = new Date().toISOString();
    } else if (task.refresh_status) {
      const count = (collectorPolls.get(`refresh:${id}`) || 0) + 1;
      collectorPolls.set(`refresh:${id}`, count);
      if (count >= 2) delete task.refresh_status;
      else task.refresh_status = 'running';
      task.progress = count >= 2 ? 100 : 62;
      task.message = count >= 2 ? '最新数据已更新' : '正在更新评论与互动数据…';
    }
    return { status:task.refresh_status || task.status, progress:task.progress ?? (task.status === 'done' ? 100 : 0),
      message:task.message || task.error_msg || '', owner_id:task.owner_id };
  }
  const collectorResultMatch = p.match(/^\/api\/collector\/tasks\/([^/]+)\/result$/);
  if (collectorResultMatch && method === 'GET') {
    const id = decodeURIComponent(collectorResultMatch[1]);
    const task = COLLECTOR_TASKS.find(item => item.id === id);
    if (!task) throw Object.assign(new Error('任务不存在'), { status:404 });
    if (task.status !== 'done') throw Object.assign(new Error('结果仍在生成中'), { status:409 });
    return collectorResult(task);
  }
  const collectorRefreshMatch = p.match(/^\/api\/collector\/tasks\/([^/]+)\/refresh$/);
  if (collectorRefreshMatch && method === 'POST') {
    const id = decodeURIComponent(collectorRefreshMatch[1]);
    const task = COLLECTOR_TASKS.find(item => item.id === id);
    if (!task || task.status !== 'done') throw Object.assign(new Error('只有已完成任务可以更新'), { status:409 });
    task.refresh_status = 'pending'; task.progress = 0; task.message = '等待更新槽位…';
    collectorPolls.set(`refresh:${id}`, 0);
    return { ok:true, status:'pending', task_id:id };
  }
  const collectorAnalysisMatch = p.match(/^\/api\/collector\/tasks\/([^/]+)\/analysis$/);
  if (collectorAnalysisMatch && method === 'PATCH') {
    const id = decodeURIComponent(collectorAnalysisMatch[1]);
    const task = COLLECTOR_TASKS.find(item => item.id === id);
    if (!task || task.status !== 'done') throw Object.assign(new Error('任务完成后才能编辑 AI 分析'), { status:409 });
    const analysis = analysisFor(id);
    for (const scope of ['video','comments']) {
      for (const [key, value] of Object.entries(body?.[scope] || {})) {
        if (analysis[scope]?.items?.[key]) analysis[scope].items[key].summary = String(value);
      }
    }
    const keyEntries = analysis.comments.items.key_comments.entries;
    (body?.key_comments || []).forEach((value, index) => { if (keyEntries[index]) keyEntries[index].reason = String(value); });
    const topicEntries = analysis.comments.items.topic_extensions.entries;
    (body?.topic_extensions || []).forEach((value, index) => { if (topicEntries[index]) topicEntries[index].idea = String(value); });
    analysis.manual_edit = { edited_at:new Date().toISOString(), edited_fields:Object.keys(body?.video || {}).length + Object.keys(body?.comments || {}).length + (body?.key_comments || []).length + (body?.topic_extensions || []).length };
    return { ok:true, ai_analysis:cloneCollectorData(analysis), manual_edit:{ ...analysis.manual_edit } };
  }
  const collectorPushMatch = p.match(/^\/api\/collector\/tasks\/([^/]+)\/push$/);
  if (collectorPushMatch && method === 'POST') {
    const id = decodeURIComponent(collectorPushMatch[1]);
    const task = COLLECTOR_TASKS.find(item => item.id === id);
    if (!task || task.status !== 'done') throw Object.assign(new Error('任务完成后才能推送'), { status:409 });
    const channel = body?.channel;
    if (!['persona','matrix'].includes(channel)) throw Object.assign(new Error('请选择真人作品或矩阵作品'), { status:400 });
    return { ok:true, channel, destination:channel === 'persona' ? '真人作品' : '矩阵作品', id:900 + collectorTaskSeq, record_id:900 + collectorTaskSeq };
  }
  const collectorDeleteMatch = p.match(/^\/api\/collector\/tasks\/([^/]+)$/);
  if (collectorDeleteMatch && method === 'DELETE') {
    if (ME.role !== 'admin') throw Object.assign(new Error('只有管理员可以删除采集记录'), { status:403 });
    const id = decodeURIComponent(collectorDeleteMatch[1]);
    const index = COLLECTOR_TASKS.findIndex(item => item.id === id);
    if (index < 0) throw Object.assign(new Error('任务不存在或已被删除'), { status:404 });
    COLLECTOR_TASKS.splice(index, 1);
    collectorAnalyses.delete(id);
    return { ok:true, task_id:id, deleted_files:4 };
  }

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
    const items=[...TAGS,...SAMPLE_TAGS].map(tag=>({...tag,sort:Number(tag.sort||0)})).sort((a,b)=>String(a.kind).localeCompare(String(b.kind))||Number(a.sort)-Number(b.sort)||Number(a.id)-Number(b.id));
    for (const t of items) (byKind[t.kind] ||= []).push(t);
    return { items, byKind, kinds: Object.keys(byKind) };
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

  if (/^\/api\/(clients|reports)\/\d+\/files$/.test(p) && method === 'GET') {
    const isReviewDemo = p === '/api/reports/802/files';
    if (!isReviewDemo) return { items: [] };
    return { items: mockReportFiles() };
  }

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

  const ideaFiles=p.match(/^\/api\/ideas\/(\d+)\/files$/);
  if(ideaFiles&&method==='GET'){
    const idea=IDEAS.find(item=>item.id===Number(ideaFiles[1]));if(!idea)throw Object.assign(new Error('找不到这条灵感'),{status:404});
    return{items:[...(IDEA_FILES.get(idea.id)||[])],canManage:true,maxFiles:8};
  }
  if(ideaFiles&&method==='POST'){
    const idea=IDEAS.find(item=>item.id===Number(ideaFiles[1]));if(!idea)throw Object.assign(new Error('找不到这条灵感'),{status:404});
    const list=IDEA_FILES.get(idea.id)||[];if(list.length>=8)throw Object.assign(new Error('每条灵感最多上传 8 个附件'),{status:400});
    const name=q.get('name')||body?.name||'附件.pdf',file={id:++seq,name,mime:body?.type||'application/octet-stream',size:Number(body?.size||1024),createdAt:new Date().toISOString(),url:'#'};list.unshift(file);IDEA_FILES.set(idea.id,list);idea.fileCount=list.length;return file;
  }
  const mockFileDelete=p.match(/^\/api\/files\/(\d+)$/);
  if(mockFileDelete&&method==='DELETE'){
    const id=Number(mockFileDelete[1]);for(const [ideaId,list]of IDEA_FILES){const next=list.filter(file=>file.id!==id);if(next.length!==list.length){IDEA_FILES.set(ideaId,next);const idea=IDEAS.find(item=>item.id===ideaId);if(idea)idea.fileCount=next.length;break;}}return{ok:true};
  }

  const detail = p.match(/^\/api\/ideas\/(\d+)$/);
  if (detail && method === 'GET') {
    const i = IDEAS.find(x => x.id === +detail[1]);
    if (!i) throw Object.assign(new Error('找不到这条灵感'), { status: 404 });
    return { ...i, comments: COMMENTS[i.id] || [], activities: i.activities || [],
      files:[...(IDEA_FILES.get(i.id)||[])],canManageFiles:true };
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
