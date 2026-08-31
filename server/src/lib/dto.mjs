/** 数据库行 → 前端用的对象。集中在一处，避免各路由各拼一套 */

export const POOL_STATUS = ['pending', 'reviewing'];

export function ideaRow(r) {
  return {
    id: Number(r.id),
    code: r.code || null,
    title: r.title,
    content: r.content,
    category: r.category,
    tags: r.tags || [],
    status: r.status,
    author: r.is_anonymous
      ? { id: null, name: '匿名' }
      : { id: Number(r.author_id), name: r.author_name },
    isAnonymous: r.is_anonymous,
    voteCount: Number(r.vote_count) || 0,
    commentCount: Number(r.comment_count) || 0,
    viewCount: Number(r.view_count) || 0,
    fileCount:Number(r.file_count)||0,
    // 卡片上的热度条要用。列是 schema.sql 里就有的，触发器自动维护，这里只是没往外吐过
    hotScore: Number(r.hot_score) || 0,
    voted: !!r.voted,
    owner: r.owner_id ? { id: Number(r.owner_id), name: r.owner_name } : null,
    adoptedAt: r.adopted_at || null,
    progress: Number(r.progress) || 0,
    docUrl: r.doc_url || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // 来源三件套（任务 4）：一条正式内容要能追回原视频/评论/客户资料，
    // 而不是只剩一句结论
    sourceType: r.source_type || 'manual',
    sourceUrl: r.source_url || null,
    sourceRef: r.source_ref || null,
    // 转正式之后原灵感留在池子里显示「已转正式」（任务 7）
    promotedAt: r.promoted_at || null,
  };
}

export function commentRow(r) {
  return {
    id: Number(r.id),
    // 和 ideaRow 一样：匿名的话连 id 都不能吐，否则前端拿 id 一比就把人认出来了
    author: r.is_anonymous
      ? { id: null, name: '匿名' }
      : { id: Number(r.user_id), name: r.user_name },
    isAnonymous: !!r.is_anonymous,
    body: r.body,
    createdAt: r.created_at,
  };
}

const ACTION_TEXT = {
  created: '提交了这条灵感',
  status_changed: null,    // 单独拼
  progress_changed: null,  // 单独拼，百分比存在 reason 列里
  owner_changed: null,     // 同上，新负责人的名字存在 reason 列里
  reopened: '重新提出了这条灵感',
};
const STATUS_TEXT = {
  draft: '草稿', pending: '待评审', reviewing: '评审中',
  adopted: '已采纳', rejected: '已否决', archived: '已归档',
};

/**
 * 流转记录的一行。
 *
 * anonymousActorId：这条灵感是匿名提交时，作者的 user id。
 * 凡是这个人做的动作都显示成「匿名」——否则「XXX 提交了这条灵感」这一行
 * 会把匿名作者直接点名，卡片上遮住了名字等于白遮。
 * 注意要遮的不只是 created：作者自己重新提出、自己归档，同样是在暴露他。
 */
export function activityRow(r, { anonymousActorId = null } = {}) {
  const who = anonymousActorId != null && r.actor_id != null
           && Number(r.actor_id) === Number(anonymousActorId)
    ? '匿名'
    : r.actor_name;

  let text;
  if (r.action === 'progress_changed') {
    text = `${who} 把进度更新到 ${r.reason || '?'}`;
  } else if (r.action === 'owner_changed') {
    text = `${who} 把负责人改为 ${r.reason || '未指派'}`;
  } else if (r.action === 'status_changed') {
    text = `${who} 把状态改为「${STATUS_TEXT[r.to_status] || r.to_status}」`;
    if (r.to_status === 'reviewing') text = `${who} 认领评审，状态 → 评审中`;
    if (r.to_status === 'adopted')   text = `${who} 采纳了这条灵感并立项`;
    if (r.to_status === 'rejected')  text = `${who} 否决了这条灵感`;
  } else {
    text = `${who} ${ACTION_TEXT[r.action] || r.action}`;
  }
  return {
    id: Number(r.id),
    action: r.action,
    toStatus: r.to_status || null,
    text,
    // progress_changed 借用了 reason 存百分比，已经拼进 text 了，
    // 再当「理由：60%」显示一遍就是重复
    reason: ['progress_changed', 'owner_changed'].includes(r.action) ? null : (r.reason || null),
    highlight: r.to_status === 'adopted',
    createdAt: r.created_at,
  };
}

/**
 * 列表和详情共用的 SELECT 片段。
 *
 * userParam 是「当前用户 id」占位符的序号，默认 $1。做成参数是因为：
 * pg 走的是扩展查询协议，**传入参数的个数必须和 SQL 里的占位符严格一致**，
 * 多传一个都会报 "bind message supplies N parameters, but prepared statement requires M"。
 * 列表接口要动态拼 WHERE，用户 id 的位置不固定，所以不能写死成 $1。
 */
export const ideaSelect = (userParam = 1) => `
  SELECT i.*,
         au.name AS author_name,
         ow.name AS owner_name,
         (SELECT count(*) FROM attachments f WHERE f.scope='idea' AND f.ref_id=i.id)::int AS file_count,
         EXISTS(SELECT 1 FROM idea_votes v WHERE v.idea_id = i.id AND v.user_id = $${userParam}) AS voted
  FROM ideas i
  JOIN users au ON au.id = i.author_id
  LEFT JOIN users ow ON ow.id = i.owner_id`;

/** 固定 $1 = 当前用户、$2 = 灵感 id 的常用形式 */
export const IDEA_SELECT = ideaSelect(1);
