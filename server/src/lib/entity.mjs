/**
 * 实体登记表 —— 全局搜索、资料关联、统一标签这三件事共用的一份定义。
 *
 * 为什么要有这张表：这三个功能都需要回答同一个问题「系统里有哪些种类的资料、
 * 每种资料的标题在哪一列、怎么判断它还活着」。分别在三个文件里各写一份的话，
 * 以后加第八种资料要改三个地方，漏掉一个就变成「能搜到但关联不上」这种鬼故事。
 *
 * board 是前端的板块 key（web/src/boards.js），点击搜索结果要靠它跳转。
 */
export const ENTITIES = {
  idea: {
    label: '灵感 / 正式库', table: 'ideas', title: 'title',
    text: ['title', 'content'], board: 'pool', alive: 'deleted_at IS NULL',
    // 灵感和正式内容是同一张表的不同 status，搜索结果里要分开显示
    boardCol: `CASE WHEN status = 'adopted' THEN 'formal' ELSE 'pool' END`,
    subLabel: `CASE WHEN status = 'adopted' THEN '正式库' ELSE '灵感池' END`,
  },
  demand: {
    label: '用户需求', table: 'demands', title: 'title',
    text: ['title', 'quote', 'scene', 'real_goal', 'note'],
    board: 'demands', alive: 'deleted_at IS NULL',
  },
  client: {
    label: '客户档案', table: 'clients', title: 'alias',
    text: ['alias', 'note', 'timeline', 'evidence'], board: 'clients',
    alive: 'deleted_at IS NULL',
  },
  case: {
    label: '案例库', table: 'cases', title: 'title',
    text: ['title', 'problem', 'judgement', 'strategy', 'feedback', 'outcome',
           'client_tags', 'male_tags'],
    board: 'cases', alive: 'deleted_at IS NULL',
  },
  work: {
    label: '作品 / 直播', table: 'works', title: 'title',
    text: ['title', 'pillar', 'note'], board: 'persona', alive: 'deleted_at IS NULL',
    // 作品分三个板块，跳转要跳对地方
    boardCol: `CASE channel WHEN 'matrix' THEN 'matrix' WHEN 'live' THEN 'live' ELSE 'persona' END`,
  },
  playbook: {
    label: '销售 / 交付', table: 'playbook_items', title: 'title',
    text: ['title', 'body', 'label'], board: 'sales', alive: 'deleted_at IS NULL',
    boardCol: `CASE board WHEN 'delivery' THEN 'delivery' ELSE 'sales' END`,
  },
  report: {
    label: '工作提交', table: 'work_reports', title: 'title',
    text: ['title', 'summary', 'feedback'], board: 'reports',
  },
};

/** 能打标签、能被关联的实体（工作提交不需要，它是流水不是资料） */
export const TAGGABLE = ['idea', 'demand', 'client', 'case', 'work'];

export const isEntity = (k) => Object.prototype.hasOwnProperty.call(ENTITIES, k);

export function assertEntity(k, what = '资料类型') {
  if (!isEntity(k)) {
    const e = new Error(`${what}不合法：${k}`);
    e.status = 400;
    throw e;
  }
  return ENTITIES[k];
}

/* ---------------- 来源三件套 ---------------- */

/** 来源类型。任务表原文：人工录入、技术1、技术2、客户资料、短视频链接、评论 */
export const SOURCE_TYPES = {
  manual:      '人工录入',
  tech1:       '技术1（市场分析）',
  tech2:       '技术2（客户分析）',
  client_file: '客户资料',
  video:       '短视频链接',
  comment:     '评论',
};

export const isSourceType = (t) => Object.prototype.hasOwnProperty.call(SOURCE_TYPES, t);

/**
 * 从请求体里取来源三件套，给 INSERT / UPDATE 用。
 * 没传就是人工录入 —— 业务人员在界面上新增的资料本来就是这个来源，
 * 不该逼着他们每次去下拉框里选一次。
 */
export function sourceOf(b, { partial = false } = {}) {
  const out = {};
  if (b.sourceType !== undefined || !partial) {
    const t = b.sourceType || 'manual';
    if (!isSourceType(t)) {
      const e = new Error(`来源类型不合法：${t}`);
      e.status = 400;
      throw e;
    }
    out.source_type = t;
  }
  if (b.sourceUrl !== undefined || !partial) out.source_url = str(b.sourceUrl);
  if (b.sourceRef !== undefined || !partial) out.source_ref = str(b.sourceRef);
  return out;
}

/** 把一行里的来源三件套转成前端字段 */
export const sourceRow = (r) => ({
  sourceType: r.source_type || 'manual',
  sourceLabel: SOURCE_TYPES[r.source_type] || '人工录入',
  sourceUrl: r.source_url || null,
  sourceRef: r.source_ref || null,
});

export const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
