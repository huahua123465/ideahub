/**
 * 五个业务板块的字段定义 —— 纯数据，不含逻辑。
 *
 * views/board.js 是一个通用渲染器，读这份定义画出小板块 tab、表格和编辑弹窗。
 * 五个板块 = 一份渲染器 + 五段配置，加第六个板块只要在这里加一段。
 *
 * 业务依据：《情感赛道全链路业务 1.0》，见 docs/新增板块-实现任务.md
 */

import { SOURCE_OPTIONS } from './tagstore.js';

/**
 * 每条重要资料都要能看到来源（任务 4）和相关标签（任务 3）。
 * 做成一个共用的字段组，而不是在六个板块里各抄一遍 ——
 * 抄六遍的结果就是过两周某个板块的来源下拉少了一项，谁都不知道为什么。
 */
const SOURCE_FIELDS = [
  { key: 'sourceType', label: '来源', type: 'select', options: SOURCE_OPTIONS },
  { key: 'sourceUrl', label: '原始链接（能存就存）', type: 'url',
    placeholder: 'https://…  原视频 / 评论 / 客户资料的地址' },
];
const TAG_FIELD = { key: 'tagIds', label: '相关标签', type: 'tags' };
/** 表格里显示标签和来源的两列 */
const TAG_COL = { key: 'tags', label: '标签', width: 190, tags: true };
const SOURCE_COL = { key: 'sourceType', label: '来源', width: 96, source: true };

/** 内容层指标（PDF 11 页）。真人作品和矩阵作品共用 */
const CONTENT_METRICS = ['曝光', '完播', '收藏', '私信', '主页访问'];
/** 直播层指标（PDF 11 页） */
const LIVE_METRICS = ['在线峰值', '停留分钟', '连麦数', '私信', '预约'];

/** 客户阶段的下拉选项（值 → 中文在 STAGE 里） */
const STAGE_OPTIONS = [
  { value: 'lead', label: '新客资' }, { value: 'wechat', label: '已加微' },
  { value: 'profiled', label: '已建档' }, { value: 'consulted', label: '已咨询' },
  { value: 'coaching', label: '已陪跑' }, { value: 'renewed', label: '已续费' },
  { value: 'lost', label: '已流失' },
];

const PLATFORMS = ['小红书', '抖音', '视频号', '快手', '微博', 'B站', '其他'];

/** 真人 IP 四大内容支柱（PDF 02 页） */
const PERSONA_PILLARS = ['A 强判断内容', 'B 识人内容', 'C 案例拆解', 'D 方法论内容', '其他'];
/** 矩阵内容特征（PDF 02 页） */
const MATRIX_PILLARS = ['高频问题', '情绪痛点', '男女差异', '识人信号', '其他'];
/** 直播结构（PDF 03 页） */
const LIVE_PILLARS = ['主题干货', '案例拆解', '连麦诊断', '其他'];

/** 作品类板块（真人 / 矩阵 / 直播）长得一样，用同一个工厂生成 */
function worksBoard({ key, title, sub, pillars, pillarLabel, metrics, titleLabel }) {
  return {
    key,
    title,
    api: 'works',
    channel: key,
    /** 固定查询参数 + 小板块对应哪个参数 —— 渲染器靠这两项拼请求，不用认识具体板块 */
    query: { channel: key },
    tabParam: 'side',
    /** 哪些字段前缀是 JSONB 分组（metrics.曝光 会被打包进 metrics 对象） */
    jsonGroups: ['metrics'],
    /** 小板块：自己 / 对标 */
    tabs: [
      { key: 'own', label: sub[0] },
      { key: 'benchmark', label: sub[1] },
    ],
    /** 账号台账（折叠区）也用同一个 channel */
    accounts: true,
    /** 表格列。key 前缀 m: 表示取自 metrics */
    columns: [
      { key: 'title', label: titleLabel, grow: true },
      { key: 'accountName', label: '账号', width: 120 },
      { key: 'pillar', label: pillarLabel, width: 128 },
      { key: 'publishedAt', label: '日期', width: 100 },
      ...metrics.map(m => ({ key: 'metrics.' + m, label: m, width: 74, num: true })),
      { key: 'url', label: '链接', width: 60, link: true },
      TAG_COL,
    ],
    /** 编辑弹窗的字段 */
    fields: [
      { key: 'title', label: titleLabel, type: 'text', required: true },
      { key: 'accountId', label: '账号', type: 'account' },
      { key: 'pillar', label: pillarLabel, type: 'select', options: pillars },
      { key: 'publishedAt', label: '日期', type: 'date' },
      { key: 'url', label: '链接', type: 'url', placeholder: 'https://…' },
      ...metrics.map(m => ({ key: 'metrics.' + m, label: m, type: 'number' })),
      { key: 'note', label: '备注 / 复盘', type: 'textarea' },
      TAG_FIELD,
      ...SOURCE_FIELDS,
    ],
    entity: 'work',
    softDelete: true,
    metrics,
    pillars,
    platforms: PLATFORMS,
  };
}

/** 文档类板块（销售转化 / 后端交付）也长得一样 */
/**
 * 文档类板块（销售转化 / 后端交付）。
 *
 * tabExtra 是「哪个小板块该多出哪几列」。原来所有小板块共用一套列，
 * 结果「客资分级」下挂着一整列空的「场景」、「交付产品」下挂着一整列空的「负责人」——
 * 一眼扫过去全是横杠，既占地方又让人以为是漏填了。
 */
function playbookBoard({ key, title, board, tabs, tabExtra = {} }) {
  return {
    key,
    title,
    api: 'playbook',
    board,
    query: { board },
    tabParam: 'section',
    jsonGroups: ['meta'],
    tabs,
    tabExtra,
    accounts: false,
    softDelete: true,
    columns: [
      { key: 'label', label: '分类', width: 130 },
      { key: 'title', label: '标题', width: 240 },
      { key: 'body', label: '说明', grow: true, wrap: true },
    ],
    fields: [
      { key: 'label', label: '分类', type: 'text' },
      { key: 'title', label: '标题', type: 'text', required: true },
      { key: 'body', label: '说明', type: 'textarea' },
      { key: 'sort', label: '排序', type: 'number' },
    ],
  };
}

export const BOARDS = {
  /* ---------- 前端获客（PDF 02） ---------- */
  persona: worksBoard({
    key: 'persona',
    title: '真人作品',
    sub: ['自己账号', '对标账号'],
    titleLabel: '作品标题',
    pillars: PERSONA_PILLARS,
    pillarLabel: '内容支柱',
    metrics: CONTENT_METRICS,
  }),

  matrix: worksBoard({
    key: 'matrix',
    title: '矩阵作品',
    sub: ['自己账号', '对标账号'],
    titleLabel: '作品标题',
    pillars: MATRIX_PILLARS,
    pillarLabel: '选题方向',
    metrics: CONTENT_METRICS,
  }),

  /* ---------- 直播（PDF 03） ---------- */
  live: worksBoard({
    key: 'live',
    title: '真人直播',
    sub: ['自己直播', '对标直播'],
    titleLabel: '直播主题',
    pillars: LIVE_PILLARS,
    pillarLabel: '环节',
    metrics: LIVE_METRICS,
  }),

  /* ---------- 中端成交（PDF 04 / 05 / 06） ---------- */
  sales: playbookBoard({
    key: 'sales',
    title: '销售转化',
    board: 'sales',
    tabs: [
      { key: 'tier', label: '客资分级' },
      { key: 'filter', label: '四维筛选' },
      { key: 'intake', label: '建档字段' },
      { key: 'script', label: '话术库' },
    ],
    // 分级看优先级，话术看场景 —— 四维筛选和建档字段本来就没有额外维度
    tabExtra: { tier: ['优先级'], script: ['场景'] },
  }),

  /* ---------- 后端交付（PDF 07 / 08） ---------- */
  delivery: playbookBoard({
    key: 'delivery',
    title: '后端交付',
    board: 'delivery',
    tabs: [
      { key: 'product', label: '交付产品' },
      { key: 'flow', label: '交付流程' },
    ],
    // 产品看类型/层级/指标，流程看负责人
    tabExtra: { product: ['类型', '层级', '指标'], flow: ['负责人'] },
  }),

  /* ---------- 客户档案（PDF 05） ---------- */
  clients: {
    key: 'clients',
    title: '客户档案',
    api: 'clients',
    query: {},
    /** 按客资等级分小板块 —— PDF 04 的核心是「把有限后端产能给到高价值客户」，
        所以第一眼该看到的是等级分布，而不是按阶段翻页。阶段作为一列显示。 */
    tabParam: 'tier',
    tabs: [
      { key: '', label: '全部' },
      { key: 'S', label: 'S 级' },
      { key: 'A', label: 'A 级' },
      { key: 'B', label: 'B 级' },
      { key: 'C', label: 'C 级' },
    ],
    jsonGroups: ['female', 'male', 'relation'],
    accounts: false,
    /** 这个板块的编辑弹窗里带附件区（聊天记录分析报告等） */
    files: true,
    columns: [
      { key: 'alias', label: '化名', width: 110 },
      { key: 'tier', label: '等级', width: 60 },
      { key: 'stage', label: '阶段', width: 84, map: 'STAGE' },
      { key: 'source', label: '来源', width: 100 },
      { key: 'female.年龄', label: '年龄', width: 66, num: true },
      { key: 'female.城市', label: '城市', width: 70 },
      { key: 'relation.关系阶段', label: '关系阶段', width: 100 },
      { key: 'note', label: '判断 / 备注', grow: true, wrap: true },
      TAG_COL,
      { key: 'fileCount', label: '报告', width: 72, files: true },
    ],
    fields: [
      { key: 'alias', label: '化名', type: 'text', required: true, placeholder: '不要填真名' },
      { key: 'tier', label: '客资等级', type: 'select', options: ['S', 'A', 'B', 'C'] },
      { key: 'stage', label: '阶段', type: 'select', options: STAGE_OPTIONS },
      { key: 'source', label: '来源', type: 'select', options: ['小红书私信', '直播连麦', '转介绍', '其他'] },
      // PDF 05 五类信息之一：女方基础信息
      { key: 'female.年龄', label: '女方·年龄', type: 'number' },
      { key: 'female.城市', label: '女方·城市', type: 'text' },
      { key: 'female.职业', label: '女方·职业', type: 'text' },
      { key: 'female.收入区间', label: '女方·收入区间', type: 'text' },
      { key: 'female.婚恋史', label: '女方·婚恋史', type: 'text' },
      { key: 'female.当前诉求', label: '女方·当前诉求', type: 'text' },
      // 男方基础信息
      { key: 'male.年龄', label: '男方·年龄', type: 'text' },
      { key: 'male.职业', label: '男方·职业', type: 'text' },
      { key: 'male.经济状况', label: '男方·经济状况', type: 'text' },
      { key: 'male.家庭', label: '男方·家庭', type: 'text' },
      { key: 'male.婚恋史', label: '男方·婚恋史', type: 'text' },
      { key: 'male.社会关系', label: '男方·社会关系', type: 'text' },
      // 关系信息
      { key: 'relation.认识时间', label: '关系·认识时间', type: 'text' },
      { key: 'relation.方式', label: '关系·认识方式', type: 'text' },
      { key: 'relation.见面次数', label: '关系·见面次数', type: 'text' },
      { key: 'relation.关系阶段', label: '关系·阶段', type: 'text' },
      { key: 'relation.公开度', label: '关系·公开度', type: 'text' },
      { key: 'relation.当前状态', label: '关系·当前状态', type: 'text' },
      // 时间线 + 证据材料
      { key: 'timeline', label: '时间线（认识→升温→关键事件→矛盾→变化→现在）', type: 'textarea' },
      { key: 'evidence', label: '证据材料清单（只记有哪些，不上传文件）', type: 'textarea' },
      { key: 'note', label: '判断 / 备注', type: 'textarea' },
      TAG_FIELD,
      ...SOURCE_FIELDS,
    ],
    entity: 'client',
    softDelete: true,
    /** 客户要有真正的详情页（任务 9），点行不是打开编辑弹窗而是进详情 */
    detail: 'client',
  },

  /* ---------- 案例库（PDF 09） ---------- */
  cases: {
    key: 'cases',
    title: '案例库',
    api: 'cases',
    query: {},
    tabParam: 'outcome',
    tabs: [
      { key: '', label: '全部' },
      { key: '推进成功', label: '推进成功' },
      { key: '复合', label: '复合' },
      { key: '长期稳定', label: '长期稳定' },
      { key: '进行中', label: '进行中' },
      { key: '退出', label: '退出' },
    ],
    jsonGroups: [],
    accounts: false,
    columns: [
      { key: 'code', label: '编号', width: 146 },
      { key: 'title', label: '案例', width: 250 },
      { key: 'clientAlias', label: '客户', width: 106 },
      { key: 'problem', label: '初始问题', width: 190 },
      { key: 'judgement', label: '判断结论', grow: true, wrap: true },
      { key: 'outcome', label: '结果', width: 88 },
      TAG_COL,
      { key: 'reusable', label: '可复用', width: 84, bool: true },
    ],
    fields: [
      { key: 'code', label: '编号', type: 'text', placeholder: 'CASE-2026-00X' },
      { key: 'title', label: '案例标题', type: 'text', required: true },
      { key: 'clientId', label: '关联客户', type: 'client' },
      { key: 'outcome', label: '最终结果', type: 'select',
        options: ['推进成功', '复合', '长期稳定', '进行中', '退出'] },
      { key: 'reusable', label: '可反哺内容', type: 'bool' },
      { key: 'clientTags', label: '客户标签（年龄/职业/城市/关系阶段/需求类型）', type: 'text' },
      { key: 'maleTags', label: '男方标签（职业/家庭/性格/依恋/社交特征）', type: 'text' },
      { key: 'problem', label: '初始问题', type: 'textarea' },
      { key: 'judgement', label: '判断结论（核心卡点 / 风险 / 概率判断）', type: 'textarea' },
      { key: 'strategy', label: '策略动作（沟通 / 见面 / 边界 / 验证 / 退出条件）', type: 'textarea' },
      { key: 'feedback', label: '执行反馈（对方反应 / 关系变化 / 执行偏差）', type: 'textarea' },
      TAG_FIELD,
      ...SOURCE_FIELDS,
    ],
    entity: 'case',
    softDelete: true,
  },

  /* ---------- 用户需求（任务 2） ----------
     第一版只保存任务表里点名的七项，一项不多：
     需求名称、用户原话/证据、发生场景、用户真正想解决什么、来源、相关标签、备注。
     这是「现有框架里最需要补的一块」，所以字段克制比字段齐全重要 ——
     字段一多，业务人员就不录了。 */
  demands: {
    key: 'demands',
    title: '用户需求',
    api: 'demands',
    query: {},
    /** 按来源分小板块：手工录的和技术1 分析出来的，看的时候通常是两件事 */
    tabParam: 'sourceType',
    tabs: [
      { key: '', label: '全部' },
      { key: 'manual', label: '人工整理' },
      { key: 'tech1', label: '来自技术1' },
      { key: 'video', label: '来自短视频' },
      { key: 'comment', label: '来自评论' },
    ],
    jsonGroups: [],
    accounts: false,
    entity: 'demand',
    /** 软删：记录留在库里，误删能找回来。确认文案要跟着说实话 */
    softDelete: true,
    columns: [
      { key: 'title', label: '需求名称', width: 210 },
      { key: 'realGoal', label: '真正想解决什么', width: 220, wrap: true },
      { key: 'scene', label: '发生场景', width: 150 },
      { key: 'quote', label: '用户原话 / 证据', grow: true, wrap: true },
      TAG_COL,
      SOURCE_COL,
    ],
    fields: [
      { key: 'title', label: '需求名称', type: 'text', required: true,
        placeholder: '用用户的话说，比如「想知道对方是不是还在意我」' },
      { key: 'quote', label: '用户原话 / 证据', type: 'textarea',
        placeholder: '原话、评论截图里的文字、私信内容…' },
      { key: 'scene', label: '发生场景', type: 'text', placeholder: '冷战第3天 / 刚分手 / 暧昧期停滞…' },
      { key: 'realGoal', label: '用户真正想解决什么', type: 'textarea',
        placeholder: '往下想一层：他嘴上问的和实际想要的往往不是一件事' },
      TAG_FIELD,
      ...SOURCE_FIELDS,
      { key: 'note', label: '备注', type: 'textarea' },
    ],
  },

  /* ---------- 工作提交 ---------- */
  reports: {
    key: 'reports',
    title: '工作提交',
    api: 'reports',
    query: {},
    /** 三个视角：我交的 / 等我看的 / 全部（管理员才看得全，
        普通人选「全部」也只会看到和自己有关的，后端兜着） */
    tabParam: 'scope',
    tabs: [
      { key: 'mine', label: '我提交的' },
      { key: 'review', label: '待我审核' },
      { key: 'all', label: '全部' },
    ],
    jsonGroups: [],
    accounts: false,
    /** 附件区：提交人传成果，审核人可以传文件回去 */
    files: 'reports',
    columns: [
      { key: 'reportDate', label: '日期', width: 100 },
      { key: 'title', label: '工作内容', width: 220 },
      { key: 'authorName', label: '提交人', width: 90 },
      { key: 'reviewerName', label: '审核人', width: 90 },
      { key: 'status', label: '状态', width: 80 },
      { key: 'fileCount', label: '附件', width: 68, files: true },
      { key: 'needHelp', label: '需要协助', width: 140, wrap: true },
      { key: 'feedback', label: '审核反馈', grow: true, wrap: true },
    ],
    fields: [
      { key: 'title', label: '工作内容', type: 'text', required: true },
      { key: 'reportDate', label: '日期', type: 'date' },
      { key: 'reviewerId', label: '给谁看（审核人）', type: 'person' },
      { key: 'summary', label: '做了什么', type: 'textarea' },
      { key: 'resultUrl', label: '结果链接 / 产物', type: 'url', placeholder: 'https://… 或说明产物在哪（附件也可以直接传下面）' },
      { key: 'blockers', label: '遇到的问题', type: 'textarea' },
      { key: 'needHelp', label: '需要协助什么', type: 'textarea' },
      { key: 'feedback', label: '审核反馈（只有审核人能写）', type: 'textarea', reviewerOnly: true },
    ],
  },
};

/** 客户阶段：既是档案里的状态，也是漏斗每一层的判定依据（PDF 11） */
export const STAGE = {
  lead: '新客资', wechat: '已加微', profiled: '已建档',
  consulted: '已咨询', coaching: '已陪跑', renewed: '已续费', lost: '已流失',
};

/** 导航顺序：按《技术3 第一版任务表》任务 1 的六组分法。
    ①市场与内容：灵感池、用户需求、正式库   ②内容运营：真人作品、矩阵作品、真人直播
    ③销售与客户：销售转化、客户档案         ④交付与案例：后端交付、案例库
    ⑤团队：工作提交                          ⑥数据：数据漏斗、统计
    灵感池 / 正式库 / 数据漏斗 / 统计不在这个数组里 —— 它们不是通用渲染器画的板块。 */
export const BOARD_ORDER = ['demands', 'persona', 'matrix', 'live', 'sales', 'clients', 'delivery', 'cases', 'reports'];

/**
 * 六组导航（任务 1）。
 *
 * 任务表要求的是「新人第一次进系统，能快速知道研究内容、做内容、管客户、
 * 做交付、看数据分别去哪里」—— 所以分组按业务动作切，不按数据结构切。
 */
export const NAV_GROUPS = [
  { label: '市场与内容', items: ['pool', 'demands', 'formal'] },
  { label: '内容运营',   items: ['persona', 'matrix', 'live'] },
  { label: '销售与客户', items: ['sales', 'clients'] },
  { label: '交付与案例', items: ['delivery', 'cases'] },
  { label: '团队',       items: ['reports'] },
  { label: '数据',       items: ['funnel', 'stats'] },
];

/** 导航项的显示名。BOARDS 里没有的（灵感池等）在这里补上 */
export const VIEW_TITLE = {
  pool: '灵感池', formal: '正式库', funnel: '数据漏斗', stats: '统计',
};
