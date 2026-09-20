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
import { confirmAction } from '../confirm.js';

let me = null;
let lastAt = 0;
let loadSeq = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * 「每日总结」现在写的是哪一天。空字符串 = 今天。
 *
 * 忘了记的那几天要能补回来，所以这块不再钉死在「今天」上。
 * 它记在模块级而不是 DOM 上：这个视图是整块 innerHTML 重绘的，
 * 存在节点上的话，后台每 30 秒一次的刷新会把正在补记的那天弹回今天。
 */
let pickedDay = '';

/** 我自己的日报按日期索引。切日期直接查这张表，不用为了看一眼那天写没写再跑一趟接口。 */
let myByDate = new Map();

const ymdOf = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);
const todayYmd = () => ymdOf(new Date());

/** 日期在界面上的说法。近三天用「今天/昨天/前天」，再往前用「9月18日」。 */
function dayLabel(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return String(ymd || '');
  const today = todayYmd();
  if (ymd === today) return '今天';
  const diff = Math.round(
    (new Date(`${today}T00:00:00`) - new Date(`${ymd}T00:00:00`)) / 86400000);
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
    .format(new Date(`${ymd}T00:00:00`));
}

/** 保存按钮的文案。补记过去某天时必须把那天说出来，否则按下去不知道写到哪儿了。 */
function saveLabel(day, report) {
  if (day === todayYmd()) return report ? '更新今天的总结' : '保存';
  return report ? `更新${dayLabel(day)}的总结` : `补记${dayLabel(day)}的总结`;
}

/** 日期栏右边那句话。今天不用解释；补记时要说清会写到哪天、会不会盖掉已有的。 */
function whenNote(day, report) {
  if (day === todayYmd()) return '';
  return report ? `${dayLabel(day)}已经有一条，保存就是改它` : `正在补记${dayLabel(day)}`;
}

export function setMe(user) {
  me = user;
  pickedDay = '';
  myByDate = new Map();
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

/**
 * 「今天的总结」是首屏上唯一一个用户会往里打字的地方，而这个视图是整块
 * innerHTML 重绘的：SSE 推一条别人的更新过来，正在写的半句话就没了。
 * 所以只要框里有没保存的内容（或者光标还在里面），本轮重绘直接跳过 ——
 * 首页的统计数字晚 30 秒更新没有任何代价，丢掉用户写了一半的日报有。
 */
function composerBusy() {
  const box = document.querySelector('.dash-today');
  if (!box) return false;
  if (box.contains(document.activeElement)) return true;
  return box.dataset.dirty === '1';
}

export async function render({ force = false } = {}) {
  if (!force && lastAt && Date.now() - lastAt < 30_000) return;
  if (composerBusy()) return;
  const root = $('#v-home');
  const cached = root.querySelector('.dash-hero') ? null : readCache();
  if (cached) paintDashboard(root, cached);
  else if (!root.querySelector('.dash-hero')) {
    root.innerHTML = `<div class="dash-loading"><i></i><span>正在整理今天的工作…</span></div>`;
  }
  const requestId = ++loadSeq;

  let stats, ideas, clients, reports, demands, mine;
  try {
    [stats, ideas, clients, reports, demands, mine] = await Promise.all([
      api.stats(), api.ideas({ status: 'pool', sort: 'hot' }), api.clients(),
      api.reports({ scope: 'review' }), api.demands(), api.reports({ scope: 'mine' }),
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
  const data = { stats, ideas, clients, reports, demands, mine };
  writeCache(data);
  // 请求飞在路上的这几百毫秒里用户可能已经开始写了 —— 进函数时查过一次不算数，
  // 真正动 innerHTML 之前必须再查一次。
  if (composerBusy()) return;
  paintDashboard(root, data);
}

function paintDashboard(root, { stats, ideas, clients, reports, demands, mine }) {
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

  const today = todayYmd();
  // 一天一条：同一天写第二次是接着改，不是再开一条。列表按日期倒序、同日按 id 倒序，
  // 所以每天第一条就是最新那条，先到先得、后面的不覆盖。
  myByDate = new Map();
  for (const r of (mine?.items || [])) {
    if (r.reportDate && !myByDate.has(r.reportDate)) myByDate.set(r.reportDate, r);
  }
  // 默认写今天；挑了要补记的那天就停在那天。未来的日期不是合法的「总结」，退回今天。
  if (pickedDay && pickedDay >= today) pickedDay = '';
  const day = pickedDay || today;
  const dayReport = myByDate.get(day) || null;
  const defaultVis = me?.reportVisibilityDefault === 'public' ? 'public' : 'private';
  const curVis = dayReport ? dayReport.visibility : defaultVis;

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

    <section class="dash-panel dash-today" data-day="${esc(day)}"
        data-report-id="${dayReport ? Number(dayReport.id) : ''}">
      <header>
        <div><span>每日总结</span><h2 id="dashTodayHead">${esc(dayLabel(day))}做了什么</h2></div>
        <button data-goto="reports">看历史日报 →</button>
      </header>
      <div class="dash-today-body">
        <div class="dash-today-when">
          <label for="dashTodayDate">日期</label>
          <input class="inp" type="date" id="dashTodayDate" value="${esc(day)}" max="${esc(today)}">
          <button type="button" class="dash-today-back" id="dashTodayBack"${day === today ? ' hidden' : ''}>回到今天</button>
          <span class="dash-today-when-note" id="dashTodayWhen">${esc(whenNote(day, dayReport))}</span>
        </div>
        <input class="inp" id="dashTodayTitle" maxlength="120" aria-label="这条总结的重点"
          placeholder="一句话说清${esc(dayLabel(day))}的重点" value="${esc(dayReport?.title || '')}">
        <textarea class="inp" id="dashTodaySummary" rows="4" aria-label="这条总结的正文"
          placeholder="做了什么、卡在哪、需要谁搭把手">${esc(dayReport?.summary || '')}</textarea>
        <div class="dash-today-foot">
          <label for="dashTodayVis">谁能看</label>
          <select class="inp" id="dashTodayVis">
            <option value="private"${curVis === 'private' ? ' selected' : ''}>仅自己可见</option>
            <option value="public"${curVis === 'public' ? ' selected' : ''}>全员可见</option>
          </select>
          <span class="dash-today-hint" id="dashTodayHint"></span>
          <button class="btn btn-primary" id="dashTodaySave">${esc(saveLabel(day, dayReport))}</button>
        </div>
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

  bindToday(root);
}

/** 「每日总结」的交互。每次重绘都要重新绑一次 —— 上一批节点已经被 innerHTML 换掉了。 */
function bindToday(root) {
  const box = root.querySelector('.dash-today');
  if (!box) return;
  const dateInp = box.querySelector('#dashTodayDate');
  const backBtn = box.querySelector('#dashTodayBack');
  const head = box.querySelector('#dashTodayHead');
  const whenEl = box.querySelector('#dashTodayWhen');
  const title = box.querySelector('#dashTodayTitle');
  const summary = box.querySelector('#dashTodaySummary');
  const visSel = box.querySelector('#dashTodayVis');
  const btn = box.querySelector('#dashTodaySave');
  const hint = box.querySelector('#dashTodayHint');
  const defaultVis = me?.reportVisibilityDefault === 'public' ? 'public' : 'private';

  const markDirty = () => { box.dataset.dirty = '1'; };
  title.addEventListener('input', markDirty);
  summary.addEventListener('input', markDirty);
  visSel.addEventListener('change', markDirty);

  const showHint = m => { hint.textContent = m; };

  /** 切到某一天：把那天已经写过的内容调出来，整块文案跟着改口径。 */
  function showDay(day) {
    const report = myByDate.get(day) || null;
    const today = todayYmd();
    pickedDay = day === today ? '' : day;
    box.dataset.day = day;
    box.dataset.reportId = report ? String(report.id) : '';
    box.dataset.dirty = '0';
    dateInp.value = day;
    backBtn.hidden = day === today;
    head.textContent = `${dayLabel(day)}做了什么`;
    whenEl.textContent = whenNote(day, report);
    title.value = report?.title || '';
    title.placeholder = `一句话说清${dayLabel(day)}的重点`;
    summary.value = report?.summary || '';
    visSel.value = report
      ? (report.visibility === 'public' ? 'public' : 'private') : defaultVis;
    btn.textContent = saveLabel(day, report);
    showHint('');
  }

  dateInp.addEventListener('change', async () => {
    const cur = box.dataset.day || todayYmd();
    const next = dateInp.value;
    // 清空日期框不是一个有意义的状态：没有日期的总结落不了库，退回当前这天
    if (!next) { dateInp.value = cur; return; }
    if (next === cur) return;
    // 「总结」是对已经过去的那天说的，明天还没发生
    if (next > todayYmd()) {
      dateInp.value = cur;
      showHint('还没到那天，只能记今天或更早');
      return;
    }
    // 换一天等于把上面两个框整个换掉，没保存的内容先问一句
    const unsaved = box.dataset.dirty === '1' && (title.value.trim() || summary.value.trim());
    if (unsaved && !await confirmAction({
      eyebrow: '换一天记录', title: `切到${dayLabel(next)}？`,
      message: `${dayLabel(cur)}这条还没保存，切过去就会丢掉刚写的内容。`,
      note: '想留着就先取消，保存完再换日期。',
      confirmLabel: '不保存，切过去',
    })) { dateInp.value = cur; return; }
    showDay(next);
  });

  // 「回到今天」走同一条切换逻辑，没保存的内容一样会先被问一句
  backBtn.addEventListener('click', () => {
    dateInp.value = todayYmd();
    dateInp.dispatchEvent(new Event('change'));
  });

  btn.addEventListener('click', async () => {
    const day = box.dataset.day || todayYmd();
    const label = dayLabel(day);
    const t = title.value.trim();
    if (!t) { showHint(`先写一句${label}的重点`); title.focus(); return; }
    if (day > todayYmd()) { showHint('还没到那天，只能记今天或更早'); return; }

    // 日期跟着一起提交：补记的那条必须落在它该在的那天，
    // 后端缺了 reportDate 会按 current_date 兜底，那就又变成写今天了。
    const payload = {
      title: t, summary: summary.value.trim(), visibility: visSel.value, reportDate: day,
    };
    const id = box.dataset.reportId;
    btn.disabled = true;
    showHint('保存中…');
    try {
      const saved = id
        ? await api.reportsPatch(Number(id), payload)
        : await api.reportsCreate(payload);
      // 新建完把 id 记回去，同一次停留里再点保存就是改这一条，不会攒出两条；
      // 本地索引也一并更新，来回切日期看到的才是刚存进去的内容。
      box.dataset.reportId = String(saved.id);
      box.dataset.dirty = '0';
      myByDate.set(day, { ...saved, reportDate: day });
      btn.textContent = saveLabel(day, saved);
      whenEl.textContent = whenNote(day, saved);
      showHint('');
      // 首页的「待我审核」等数字跟这条无关，但缓存里得留下新内容，
      // 否则切走再切回来会看到保存前的样子
      clearCache();
      toast('ok', payload.visibility === 'public'
        ? `${label}的总结已保存，全员可见` : `${label}的总结已保存，只有你自己看得到`);
    } catch (e) {
      showHint(e.message || '没保存上，再试一次');
      toast('info', e.message || '保存失败');
    } finally {
      btn.disabled = false;
    }
  });
}

export async function refresh() {
  if (!document.querySelector('#v-home.on')) return;
  return render({ force: true });
}
