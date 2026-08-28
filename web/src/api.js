/**
 * 接口层。
 *
 * 后端起着就走真实接口；后端没起（比如只想看界面）就自动降级到内置 mock 数据，
 * 界面照样完全可点。这样「给人看效果」和「真开发」用的是同一套前端代码。
 */
import { logApi } from './apilog.js';
import * as mock from './mock.js';

/** 前端和后端同源时留空；开发时前端在 5173、后端在 3000 */
const BASE = location.port === '5173'
  ? `${location.protocol}//${location.hostname}:3000`
  : '';

export const state = { mode: 'live' };   // live | mock

/** 启动时探一次后端。探不到就整场用 mock。 */
export async function probe() {
  // 生产环境的静态页面和 /api 都由同一个 Node 进程提供：index.html 能打开，
  // 就没必要再串行请求一次 /api/health 后才去拿登录用户。跨洋网络下这会白等
  // 一个完整 RTT。本地 5173 才需要探测 3000 端口并决定是否降级到 mock。
  if (!BASE) {
    state.mode = 'live';
    return state.mode;
  }
  try {
    const r = await fetch(BASE + '/api/health', {
      signal: AbortSignal.timeout(2500), credentials: 'include',
    });
    const d = await r.json();
    state.mode = d.ok ? 'live' : 'mock';
  } catch {
    state.mode = 'mock';
  }
  if (state.mode === 'mock') {
    console.info('[IdeaHub] 后端没连上，已切换到内置演示数据。启动后端后刷新即可使用真实数据。');
  }
  return state.mode;
}

async function call(method, path, body) {
  if (state.mode === 'mock') return mock.handle(method, path, body);

  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',      // 登录态在 HttpOnly cookie 里，跨域时必须显式带
  });
  logApi(method, path, r.status);

  // 会话过期或被踢下线：直接送回登录页，别让用户对着一堆报错猜发生了什么。
  // 带上 next=当前页，登录完能回到原来的地方。
  if (r.status === 401 && !path.startsWith('/api/auth/')) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('请先登录');
  }

  let data = null;
  try { data = await r.json(); } catch { /* 空响应体 */ }
  if (!r.ok) {
    const e = new Error(data?.error || `请求失败（${r.status}）`);
    e.status = r.status;
    e.detail = data?.detail;
    throw e;
  }
  return data;
}

const qs = o => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

export const api = {
  me:        ()            => call('GET',   '/api/me'),
  logout:    ()            => call('POST',  '/api/auth/logout'),
  users:     ()            => call('GET',   '/api/admin/users'),
  /** 可被指派为负责人的人。和上面那个 admin 接口不是一回事 ——
      admin/users 是用户管理（要管理员权限），这个任何登录用户都能读。 */
  people:    ()            => call('GET',   '/api/users'),
  setRole:   (id, role)    => call('PATCH', `/api/admin/users/${id}/role`, { role }),
  resetPw:   (id, password)=> call('POST',  `/api/admin/users/${id}/reset-password`, { password }),
  changePw:  (oldPassword, newPassword) =>
                              call('POST',  '/api/auth/password', { oldPassword, newPassword }),
  ideas:     (opts = {})   => call('GET',   '/api/ideas' + qs(opts)),
  idea:      (id)          => call('GET',   `/api/ideas/${id}`),
  create:    (payload)     => call('POST',  '/api/ideas', payload),
  patch:     (id, payload) => call('PATCH', `/api/ideas/${id}`, payload),
  vote:      (id)          => call('POST',  `/api/ideas/${id}/vote`),
  comment:   (id, body, isAnonymous = false) =>
                              call('POST',  `/api/ideas/${id}/comments`, { body, isAnonymous }),
  comments:  (id)          => call('GET',   `/api/ideas/${id}/comments`),
  setStatus: (id, status, extra = {}) => call('PATCH', `/api/ideas/${id}/status`, { status, ...extra }),
  similar:   (q)           => call('GET',   '/api/ideas/similar' + qs({ q })),
  stats:     ()            => call('GET',   '/api/stats/overview'),
  ideaDelete:(id, purge)   => call('DELETE', `/api/ideas/${id}${purge ? '?purge=1' : ''}`),

  /* ---------- 第一版团队资料库 ---------- */
  // 统一标签（任务 3）
  tags:        ()            => call('GET',    '/api/tags'),
  tagsAll:     ()            => call('GET',    '/api/tags?all=1'),
  tagCreate:   (payload)     => call('POST',   '/api/tags', payload),
  tagPatch:    (id, payload) => call('PATCH',  `/api/tags/${id}`, payload),
  tagDelete:   (id)          => call('DELETE', `/api/tags/${id}`),

  // 用户需求（任务 2）
  demands:       (opts = {})   => call('GET',    '/api/demands' + qs(opts)),
  demandsCreate: (payload)     => call('POST',   '/api/demands', payload),
  demandsPatch:  (id, payload) => call('PATCH',  `/api/demands/${id}`, payload),
  demandsDelete: (id, purge)   => call('DELETE', `/api/demands/${id}${purge ? '?purge=1' : ''}`),

  // 全局搜索（任务 5）
  search:      (q, opts = {}) => call('GET', '/api/search' + qs({ q, ...opts })),

  // 智能导入：先结构化预览，再由用户确认统一写入。
  smartImportAnalyze: (payload) => call('POST', '/api/import/analyze', payload),
  smartImportCommit:  (payload) => call('POST', '/api/import/commit', payload),
  smartImportProvider: () => call('GET', '/api/import/provider'),
  smartImportModels:   (payload) => call('POST', '/api/import/provider/models', payload),
  smartImportProviderSave: (payload) => call('POST', '/api/import/provider', payload),

  // 资料关联（任务 8）
  links:       (entity, id)  => call('GET',    '/api/links' + qs({ entity, id })),
  linkCreate:  (payload)     => call('POST',   '/api/links', payload),
  linkDelete:  (id)          => call('DELETE', `/api/links/${id}`),

  // 客户详情页 / 交付记录 / 转案例（任务 9、12）
  client:          (id)          => call('GET',    `/api/clients/${id}`),
  deliveryCreate:  (id, payload) => call('POST',   `/api/clients/${id}/deliveries`, payload),
  deliveryDelete:  (id, did)     => call('DELETE', `/api/clients/${id}/deliveries/${did}`),
  clientToCase:    (id, payload = {}) => call('POST', `/api/clients/${id}/to-case`, payload),

  // 对接密钥（任务 10、11，管理员）
  apiKeys:      ()        => call('GET',    '/api/admin/api-keys'),
  apiKeyCreate: (payload) => call('POST',   '/api/admin/api-keys', payload),
  apiKeyRevoke: (id)      => call('DELETE', `/api/admin/api-keys/${id}`),

  /* ---------- 业务板块台账 ----------
     真人作品 / 矩阵作品 / 真人直播共用 works + accounts（靠 channel、side 区分）；
     销售转化 / 后端交付共用 playbook（靠 board、section 区分）。
     命名带 Create/Patch/Delete 后缀是给 views/board.js 用的 ——
     它按 `api[b.api + 'Create']` 这种方式取，五个板块共用一套调用代码。 */
  accounts:       (opts = {})   => call('GET',    '/api/accounts' + qs(opts)),
  accountsCreate: (payload)     => call('POST',   '/api/accounts', payload),
  accountsPatch:  (id, payload) => call('PATCH',  `/api/accounts/${id}`, payload),
  accountsDelete: (id, purge)   => call('DELETE', `/api/accounts/${id}${purge ? '?purge=1' : ''}`),

  works:          (opts = {})   => call('GET',    '/api/works' + qs(opts)),
  worksCreate:    (payload)     => call('POST',   '/api/works', payload),
  worksPatch:     (id, payload) => call('PATCH',  `/api/works/${id}`, payload),
  worksDelete:    (id, purge)   => call('DELETE', `/api/works/${id}${purge ? '?purge=1' : ''}`),
  /** 技术1 推过来的那份完整采集分析。约 30KB 一条，只在点开某条对标时才拉 ——
      列表里带的是 row.analysis 那一小块摘要（见 boards.mjs 的注释）。 */
  workAnalysis:   (id)          => call('GET',    `/api/works/${id}/analysis`),

  playbook:       (opts = {})   => call('GET',    '/api/playbook' + qs(opts)),
  playbookCreate: (payload)     => call('POST',   '/api/playbook', payload),
  playbookPatch:  (id, payload) => call('PATCH',  `/api/playbook/${id}`, payload),
  playbookDelete: (id, purge)   => call('DELETE', `/api/playbook/${id}${purge ? '?purge=1' : ''}`),

  clients:        (opts = {})   => call('GET',    '/api/clients' + qs(opts)),
  clientsCreate:  (payload)     => call('POST',   '/api/clients', payload),
  clientsPatch:   (id, payload) => call('PATCH',  `/api/clients/${id}`, payload),
  clientsDelete:  (id, purge)   => call('DELETE', `/api/clients/${id}${purge ? '?purge=1' : ''}`),

  cases:          (opts = {})   => call('GET',    '/api/cases' + qs(opts)),
  casesCreate:    (payload)     => call('POST',   '/api/cases', payload),
  casesPatch:     (id, payload) => call('PATCH',  `/api/cases/${id}`, payload),
  casesDelete:    (id, purge)   => call('DELETE', `/api/cases/${id}${purge ? '?purge=1' : ''}`),

  /* ---------- 客户档案的附件 ----------
     上传不能走 call()：那个函数会把 body 序列化成 JSON 并设 content-type。
     文件是当原始字节直接发的（服务端也是这么读的），所以单独写一个。 */
  clientFiles:  (id)      => call('GET',    `/api/clients/${id}/files`),
  fileDelete:   (fileId)  => call('DELETE', `/api/files/${fileId}`),
  fileUpload:   async (id, file, note) => {
    const qs2 = new URLSearchParams({ name: file.name });
    if (note) qs2.set('note', note);
    const r = await fetch(`${BASE}/api/clients/${id}/files?${qs2}`, {
      method: 'POST',
      body: file,                 // 原始字节，不包 multipart
      credentials: 'include',
    });
    logApi('POST', `/api/clients/${id}/files`, r.status);
    let d = null;
    try { d = await r.json(); } catch { /* 空响应体 */ }
    if (!r.ok) throw new Error(d?.error || `上传失败（${r.status}）`);
    return d;
  },

  /* ---------- 工作提交 ---------- */
  reports:       (opts = {})   => call('GET',    '/api/reports' + qs(opts)),
  reportsCreate: (payload)     => call('POST',   '/api/reports', payload),
  reportsPatch:  (id, payload) => call('PATCH',  `/api/reports/${id}`, payload),
  reportsDelete: (id)          => call('DELETE', `/api/reports/${id}`),
  reportFiles:   (id)          => call('GET',    `/api/reports/${id}/files`),
  reportUpload:  async (id, file) => {
    const r = await fetch(`${BASE}/api/reports/${id}/files?name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file, credentials: 'include' });
    logApi('POST', `/api/reports/${id}/files`, r.status);
    let d = null;
    try { d = await r.json(); } catch { /* 空响应体 */ }
    if (!r.ok) throw new Error(d?.error || `上传失败（${r.status}）`);
    return d;
  },

  /* ---------- 站内消息 ---------- */
  notifications: ()   => call('GET',  '/api/notifications'),
  /** 不传 id 就是全部标已读 */
  notifRead:     (id) => call('POST', '/api/notifications/read', id ? { id } : {}),

  /* ---------- 聊天 ---------- */
  chatPeers:    ()            => call('GET',  '/api/chat/peers'),
  /** kind 是 'user' 或 'group'，路径差一段，其余完全一样 —— 用一个前缀统一掉 */
  chatWith:     (kind, id)        => call('GET',  `/api/chat/${kind === 'group' ? 'group/' : ''}${id}`),
  chatSend:     (kind, id, body)  => call('POST', `/api/chat/${kind === 'group' ? 'group/' : ''}${id}`, { body }),
  chatRead:     (kind, id)        => call('POST', `/api/chat/${kind === 'group' ? 'group/' : ''}${id}/read`, {}),
  chatSendFile: async (kind, id, file) => {
    const path = `/api/chat/${kind === 'group' ? 'group/' : ''}${id}/files`;
    const r = await fetch(`${BASE}${path}?name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file, credentials: 'include' });
    logApi('POST', path, r.status);
    let d = null;
    try { d = await r.json(); } catch { /* 空响应体 */ }
    if (!r.ok) throw new Error(d?.error || `发送失败（${r.status}）`);
    return d;
  },
  chatGroupCreate:  (name, memberIds) => call('POST', '/api/chat/groups', { name, memberIds }),
  chatGroupMembers: (id)              => call('GET',  `/api/chat/groups/${id}/members`),
  chatGroupInvite:  (id, memberIds)   => call('POST', `/api/chat/groups/${id}/members`, { memberIds }),
  chatGroupDelete:  (id)              => call('DELETE', `/api/chat/groups/${id}`),
  chatRecall:       (mid)             => call('POST', `/api/chat/messages/${mid}/recall`, {}),
  chatEdit:         (mid, body)       => call('PATCH', `/api/chat/messages/${mid}`, { body }),
  chatDelete:       (mid)             => call('DELETE', `/api/chat/messages/${mid}`),

  /** 漏斗看板是只读的算出来的，没有增删改 */
  funnel:         ()            => call('GET',    '/api/funnel'),

  /* ---------- 内容采集 ----------
     Collector 只在 Docker 内网可见；浏览器始终请求 IdeaHub 的同源代理，
     内部令牌、平台 Cookie 和 AI 密钥都不会进入前端。 */
  collectorHealth:      ()            => call('GET',    '/api/collector/health'),
  collectorLoginStatus: ()            => call('GET',    '/api/collector/login/xiaohongshu/status'),
  collectorLoginStart:  (switchAccount = false) => call('POST', '/api/collector/login/xiaohongshu',
    switchAccount ? { mode: 'switch', force_fresh: true } : {}),
  collectorAccountSync: ()            => call('POST',   '/api/collector/login/xiaohongshu/account', {}),
  collectorAccountLabel:(label)       => call('POST',   '/api/collector/login/xiaohongshu/label', { label }),
  collectorAccountLogout:()           => call('POST',   '/api/collector/login/xiaohongshu/logout', {}),
  collectorTasks:       ()            => call('GET',    '/api/collector/tasks'),
  collectorCreate:      (url, sessionMode = 'saved') => call('POST', '/api/collector/tasks', { url, session_mode: sessionMode }),
  collectorTaskStatus:  (id)          => call('GET',    `/api/collector/tasks/${encodeURIComponent(id)}/status`),
  collectorResult:      (id)          => call('GET',    `/api/collector/tasks/${encodeURIComponent(id)}/result`),
  collectorRefresh:     (id)          => call('POST',   `/api/collector/tasks/${encodeURIComponent(id)}/refresh`, {}),
  collectorAnalysis:    (id, payload) => call('PATCH',  `/api/collector/tasks/${encodeURIComponent(id)}/analysis`, payload),
  collectorPush:        (id, channel) => call('POST',   `/api/collector/tasks/${encodeURIComponent(id)}/push`, { channel }),
  collectorDelete:      (id)          => call('DELETE', `/api/collector/tasks/${encodeURIComponent(id)}`),
};

/** 二进制资源不经过 JSON call()；这里只生成固定、同源、已编码的安全路径。 */
export function collectorQrUrl(stamp = Date.now()) {
  if (state.mode === 'mock') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280"><rect width="280" height="280" rx="24" fill="#fff"/><g fill="#20242d"><path d="M28 28h72v72H28zm16 16v40h40V44zM180 28h72v72h-72zm16 16v40h40V44zM28 180h72v72H28zm16 16v40h40v-40z"/><path d="M124 28h20v20h-20zm24 24h20v24h-20zm-24 44h20v20h-20zm44 20h20v20h-20zm-44 20h20v20h-20zm28 12h20v20h-20zm40 0h20v20h-20zm-68 32h20v20h-20zm28 8h20v20h-20zm36-4h24v20h-24zm28 28h20v40h-20zm-68 16h20v24h-20zm32 0h20v20h-20z"/></g><text x="140" y="270" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#8b93a2">IdeaHub 演示二维码</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  return `${BASE}/api/collector/login/xiaohongshu/qr?t=${encodeURIComponent(stamp)}`;
}

export function collectorImageUrl(taskId, filename) {
  return `${BASE}/api/collector/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(filename)}`;
}

export function collectorMediaUrl(taskId, filename) {
  return `${BASE}/api/collector/tasks/${encodeURIComponent(taskId)}/media/${encodeURIComponent(filename)}`;
}
