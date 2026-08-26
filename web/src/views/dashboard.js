/**
 * 今日工作台。
 *
 * IdeaHub 已经不只是灵感池。这个首页不再重复展示“系统里一共有多少条”，
 * 而是把需要处理、需要跟进和可以继续沉淀的事情放到登录后的第一屏。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { ICON } from '../icons.js';
import { toast } from '../toast.js';

let me = null;
let lastAt = 0;
let loadSeq = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

export function setMe(user) {
  me = user;
  // 同一浏览器换账号时，不保留上一位用户的工作台摘要。
  try {
    const keep = `ideahub-dashboard-v2:${user.id}`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith('ideahub-dashboard-v2:') && key !== keep) localStorage.removeItem(key);
    }
  } catch { /* 存储不可用时忽略 */ }
}

const cacheKey = () => me?.id ? `ideahub-dashboard-v2:${me.id}` : '';
function readCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
    return saved?.at && Date.now() - saved.at < CACHE_TTL ? saved.data : null;
  } catch { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), data })); }
  catch { /* 隐私模式或空间不足时只是不缓存，不影响首页 */ }
}
export function clearCache() {
  try { if (cacheKey()) localStorage.removeItem(cacheKey()); } catch {}
}

const greeting = () => {
  const h = new Date().getHours();
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
};

const dateText = () => new Intl.DateTimeFormat('zh-CN', {
  month: 'long', day: 'numeric', weekday: 'long',
}).format(new Date());

const stageLabel = {
  lead: '新客资', wechat: '已加微信', profiled: '已建档', consulted: '已咨询',
  coaching: '陪跑中', renewed: '已续费', lost: '已流失',
};

function focusItem({ tone = 'blue', eyebrow, title, meta, board, entity, id }) {
  return `<button class="dash-focus-item tone-${tone}" data-goto="${esc(board)}"
      ${entity ? `data-entity="${esc(entity)}"` : ''}${id ? ` data-ref="${Number(id)}"` : ''}>
    <i></i><span><small>${esc(eyebrow)}</small><b>${esc(title)}</b><em>${esc(meta || '')}</em></span>
    <strong>处理 <span>→</span></strong>
  </button>`;
}

export async function render({ force = false } = {}) {
  if (!force && lastAt && Date.now() - lastAt < 30_000) return;
  const root = $('#v-home');
  const cached = root.querySelector('.dash-hero') ? null : readCache();
  if (cached) paintDashboard(root, cached);
  else if (!root.querySelector('.dash-hero')) {
    root.innerHTML = `<div class="dash-loading"><i></i><span>正在整理今天的工作…</span></div>`;
  }
  const requestId = ++loadSeq;

  let stats, ideas, clients, reports, demands;
  try {
    [stats, ideas, clients, reports, demands] = await Promise.all([
      api.stats(), api.ideas({ status: 'pool', sort: 'hot' }), api.clients(),
      api.reports({ scope: 'review' }), api.demands(),
    ]);
  } catch (e) {
    if (requestId !== loadSeq) return;
    if (e.message === '请先登录') return;
    if (root.querySelector('.dash-hero')) {
      toast('info', '网络暂时较慢，当前显示上次同步的数据');
      return;
    }
    root.innerHTML = `<div class="empty"><b>工作台暂时没有加载出来</b><span>${esc(e.message || '请稍后刷新')}</span></div>`;
    toast('info', e.message || '工作台加载失败');
    return;
  }
  if (requestId !== loadSeq) return;
  lastAt = Date.now();
  const data = { stats, ideas, clients, reports, demands };
  writeCache(data);
  paintDashboard(root, data);
}

function paintDashboard(root, { stats, ideas, clients, reports, demands }) {
  const ideaItems = ideas.items || [];
  const clientItems = clients.items || [];
  const reportItems = reports.items || [];
  const demandItems = demands.items || [];
  const reviewing = ideaItems.filter(x => x.status === 'reviewing');
  const pendingReports = reportItems.filter(x => String(x.status || '').includes('待'));
  const serviceClients = clientItems.filter(x => ['consulted', 'coaching'].includes(x.stage));
  const incompleteClients = clientItems.filter(x => !x.note || !Number(x.fileCount || 0));

  const focus = [];
  for (const row of pendingReports.slice(0, 2)) focus.push(focusItem({
    tone: 'amber', eyebrow: '待我审核', title: row.title || '未命名工作提交',
    meta: `${row.authorName || '同事'} 提交${row.needHelp ? ' · 需要协助' : ''}`,
    board: 'reports', entity: 'report', id: row.id,
  }));
  for (const row of reviewing.slice(0, Math.max(1, 3 - focus.length))) focus.push(focusItem({
    tone: 'violet', eyebrow: '评审进行中', title: row.title,
    meta: `${row.voteCount || 0} 人支持 · ${row.commentCount || 0} 条讨论`,
    board: 'pool', entity: 'idea', id: row.id,
  }));
  for (const row of serviceClients.slice(0, Math.max(1, 4 - focus.length))) focus.push(focusItem({
    tone: 'green', eyebrow: '客户跟进', title: row.alias || '未命名客户',
    meta: `${stageLabel[row.stage] || '待分阶段'}${row.ownerName ? ` · ${row.ownerName}负责` : ''}`,
    board: 'clients', entity: 'client', id: row.id,
  }));
  if (!focus.length) focus.push(focusItem({
    tone: 'blue', eyebrow: '当前无待办', title: '去灵感池看看团队正在讨论什么',
    meta: '保持资料流动，下一步才会自然出现', board: 'pool',
  }));

  const library = stats.library || [];
  const sales = stats.salesFunnel || [];
  const maxSales = Math.max(1, ...sales.map(x => Number(x.value || 0)));

  root.innerHTML = `
    <section class="dash-hero">
      <div>
        <div class="page-kicker">${esc(dateText())}</div>
        <h1>${greeting()}，${esc(me?.name || '伙伴')}</h1>
        <p>先处理需要判断的事，再把结果沉淀成团队资产。</p>
      </div>
      <div class="dash-quick" aria-label="快捷操作">
        <button data-dash-action="import">${ICON.sparkle}<span><b>AI 整理</b><small>粘贴内容</small></span></button>
        <button data-dash-create="pool">${ICON.bulb}<span><b>记一条灵感</b><small>发起讨论</small></span></button>
        <button data-dash-create="clients">${ICON.users}<span><b>新增客户</b><small>跟进信息</small></span></button>
        <button data-dash-learning="framework">${ICON.layers}<span><b>框架学习</b><small>判断链路</small></span></button>
        <button data-dash-learning="detail">${ICON.book}<span><b>详细学习</b><small>专业详解</small></span></button>
      </div>
    </section>

    <section class="dash-action-grid">
      <button data-goto="reports"><span class="dash-action-icon amber">${ICON.check}</span><small>待我审核</small><b>${pendingReports.length}</b><em>${pendingReports.length ? '需要给出反馈' : '当前已清空'}</em></button>
      <button data-goto="pool"><span class="dash-action-icon violet">${ICON.eye}</span><small>评审中的灵感</small><b>${reviewing.length}</b><em>${reviewing.length ? '正在形成共识' : '暂无评审中项目'}</em></button>
      <button data-goto="clients"><span class="dash-action-icon green">${ICON.users}</span><small>服务中客户</small><b>${serviceClients.length}</b><em>${incompleteClients.length} 份档案待补完整</em></button>
      <button data-goto="demands"><span class="dash-action-icon blue">${ICON.search}</span><small>用户需求</small><b>${demandItems.length}</b><em>${demandItems.filter(x => !x.quote).length} 条缺少原话证据</em></button>
    </section>

    <div class="dash-layout">
      <section class="dash-panel dash-focus">
        <header><div><span>优先处理</span><h2>今天值得推进的事</h2></div><small>按待审核、评审、客户跟进排序</small></header>
        <div class="dash-focus-list">${focus.slice(0, 4).join('')}</div>
      </section>

      <section class="dash-panel dash-pipeline">
        <header><div><span>经营脉搏</span><h2>客户转化</h2></div><button data-goto="funnel">看完整漏斗 →</button></header>
        <div class="dash-pipeline-list">${sales.map((step, index) => `
          <button data-goto="clients" data-stages="${esc((step.stages || []).join(','))}"
              data-filter-label="销售漏斗 · ${esc(step.name)}">
            <span><i>${String(index + 1).padStart(2, '0')}</i><b>${esc(step.name)}</b></span>
            <div><i style="width:${Math.max(8, Number(step.value || 0) / maxSales * 100)}%"></i></div>
            <strong>${Number(step.value || 0)}</strong>
            <em>${index ? `${step.conversion ?? '—'}%` : '起点'}</em>
          </button>`).join('')}</div>
      </section>
    </div>

    <section class="dash-panel dash-library">
      <header><div><span>团队资产</span><h2>持续沉淀，而不是散落在聊天里</h2></div><button data-goto="stats">查看统计 →</button></header>
      <div>${library.map(item => `<button data-goto="${esc(item.board)}"><small>${esc(item.name)}</small><b>${Number(item.value || 0)}</b><em>${esc(item.note || '')}</em><span>打开 →</span></button>`).join('')}</div>
    </section>`;
}

export async function refresh() {
  if (!document.querySelector('#v-home.on')) return;
  return render({ force: true });
}
