/**
 * 业务板块的通用渲染器。
 *
 * 五个板块（真人作品 / 矩阵作品 / 真人直播 / 销售转化 / 后端交付）的界面
 * 都由这一个文件画出来，字段定义在 boards.js 里。不为每个板块写一套表格代码 ——
 * 那会变成五份互相抄的东西，改一个列宽要改五个地方。
 */
import { api, state } from '../api.js';
import { esc, $ } from '../util.js';
import { toast } from '../toast.js';
import { BOARDS, STAGE } from '../boards.js';
import { ICON } from '../icons.js';
import { tagDict, KIND_ORDER, KIND_LABEL, SOURCE_LABEL } from '../tagstore.js';
import * as links from './links.js';
import * as tagfilter from './tagfilter.js';
import * as bench from './bench.js';
import { openLightbox } from '../lightbox.js';
import { confirmAction } from '../confirm.js';

/** 每个板块各自记住当前选中的小板块和数据，切走再切回来不用重新选 */
const st = {};
const stateOf = key => (st[key] ||= {
  tab: BOARDS[key].tabs[0].key, renderedTab: null,
  items: [], accounts: [], clients: [], people: [], showAccounts: false,
  showFilters: false,
  // 统一标签筛选（任务 6）。放在板块状态里，切走再切回来筛选还在
  tagIds: [], sourceType: '',
  // 从统计漏斗跳进来时携带的业务筛选。单独保存，避免和页面自己的等级 tab 混在一起。
  contextQuery: {}, contextLabel: '',
});

let editing = null;   // { boardKey, id | null }

/** 板块往外发的事件。目前只有一件：客户档案的行被点开，该去详情页 */
export const events = new EventTarget();
let me = { id: 0, role: 'member' };
export const setMe = u => { me = u; };

/* ---------------- 取数 ---------------- */

/** 当前小板块该显示哪些列 / 该有哪些表单字段。
    tabExtra 让每个小板块只带自己用得上的维度，不用共用一套满是空列的表头。 */
function extraOf(key) {
  const b = BOARDS[key];
  return b.tabExtra?.[stateOf(key).tab] || [];
}
const columnsOf = key =>
  [...BOARDS[key].columns, ...extraOf(key).map(f => ({ key: 'meta.' + f, label: f, width: 118 }))];
const fieldsOf = key =>
  [...BOARDS[key].fields, ...extraOf(key).map(f => ({ key: 'meta.' + f, label: f, type: 'text' }))];

/** 拼这个板块当前该发的查询参数。渲染器不认识任何具体板块，全靠配置。 */
function paramsOf(key) {
  const b = BOARDS[key];
  const s = stateOf(key);
  const p = { ...(b.query || {}) };
  if (b.tabParam && s.tab) p[b.tabParam] = s.tab;
  if (s.tagIds.length) p.tagIds = s.tagIds.join(',');
  // 板块自己已经按来源分了小板块（用户需求）时，别再拿筛选条去覆盖它
  if (s.sourceType && b.tabParam !== 'sourceType') p.sourceType = s.sourceType;
  Object.assign(p, s.contextQuery);
  return p;
}

async function fetchItems(key) {
  const b = BOARDS[key];
  const s = stateOf(key);
  const [main, accounts, clients, people] = await Promise.all([
    api[b.api](paramsOf(key)),
    b.accounts ? api.accounts({ channel: b.channel, side: s.tab }) : Promise.resolve({ items: [] }),
    // 案例要关联客户，下拉框得有人选
    b.fields.some(f => f.type === 'client') ? api.clients({}) : Promise.resolve({ items: [] }),
    b.fields.some(f => f.type === 'person') ? api.people() : Promise.resolve({ items: [] }),
  ]);
  // 标签字典和这个板块的数据一起拉。openEdit 是同步函数，画标签选择器时
  // 已经来不及再发请求了 —— 那会先画出一个空的选择器再突然多出一排标签。
  if (b.fields.some(f => f.type === 'tags')) {
    await tagDict().then(setDict).catch(() => {});
  }
  s.items = main.items;
  s.accounts = accounts.items;
  s.clients = clients.items;
  s.people = people.items;
}

/** 已经缓存好的标签字典。fetchItems 保证了打开弹窗时它一定在（拉失败则为 null） */
let dictCache = null;
export const setDict = d => { dictCache = d; };
const tagDictSync = () => dictCache;

/** 取一行里某一列的值。带点号的走 JSONB 分组（metrics.曝光 / female.年龄） */
function valueOf(row, key) {
  const dot = key.indexOf('.');
  if (dot > 0) {
    const group = key.slice(0, dot);
    return row[group]?.[key.slice(dot + 1)] ?? '';
  }
  return row[key] ?? '';
}

/* ---------------- 渲染 ---------------- */

/**
 * 渲染一个板块。
 *
 * 已经有数据就先把旧的画出来、再去后台拉新的（stale-while-revalidate）——
 * 切回一个来过的板块时不该再看一次骨架屏，那半秒空白是纯粹的等待感。
 * 数据真变了才会重画，没变的话用户什么都不会察觉。
 */
export async function render(key) {
  const b = BOARDS[key];
  const s = stateOf(key);
  const root = $('#v-' + key);
  if (!root.dataset.built) build(key, root);
  paintContextFilter(key, root);

  const body = root.querySelector('.bd-body');
  const cached = s.items.length > 0 && s.renderedTab === s.tab;

  if (cached) {
    // 旧数据先上屏，一眼就有东西看
    paintHead(key, root);
    paintRows(key, root);
    paintAccounts(key, root);
  } else if (!body.children.length) {
    body.innerHTML = `<div class="board-sk-grid">${Array.from({ length: 4 }, () => `
      <div class="record-card board-sk-card">
        <i></i><b></b><span></span><span></span><em></em>
      </div>`).join('')}</div>`;
  }

  try {
    await fetchItems(key);
  } catch (e) {
    if (e.message === '请先登录') return;
    // 已经有旧数据顶着的话，拉失败就别弹提示打扰人 —— 屏幕上不是空的
    if (!cached) toast('info', e.message || '加载失败');
    return;
  }
  s.renderedTab = s.tab;

  // 小板块 tab 的选中态
  for (const t of root.querySelectorAll('.bd-tab')) {
    t.classList.toggle('on', t.dataset.tab === s.tab);
  }
  root.querySelector('.bd-count').textContent = s.items.length;

  paintAccounts(key, root);
  paintHead(key, root);
  paintRows(key, root);
}

/** 第一次进这个板块时才搭骨架，之后只换数据 */
function build(key, root) {
  const b = BOARDS[key];
  root.dataset.built = '1';
  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-kicker">${esc(MODULE_KICKER[key] || '团队资料库')}</div>
        <h1>${esc(b.title)}</h1>
        <div class="sub">${esc(SUBTITLE[key] || '')}</div>
      </div>
    </div>
    <div class="board-toolbar">
      <div class="bd-tabs" role="tablist">
        ${b.tabs.map(t => `<button class="bd-tab" role="tab" data-tab="${t.key}">${esc(t.label)}</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <span class="bd-n"><b class="bd-count">0</b> 条</span>
      ${b.entity ? '<button class="board-tool bd-filter-toggle">筛选</button>' : ''}
      ${b.accounts ? `<button class="btn btn-ghost bd-acct-toggle">账号台账</button>` : ''}
      <button class="btn btn-primary bd-add">＋ 新增</button>
    </div>
    <div class="board-context-filter" hidden>
      <span>当前查看</span><b></b><button type="button">查看全部客户</button>
    </div>
    ${b.entity ? `<div class="bd-filter-panel" hidden>
      <div class="filter-caption"><b>筛选内容</b><span>可以同时选多个标签，来源只能选一个</span></div>
      <div class="tagfilter bd-tagfilter"></div>
    </div>` : ''}
    ${b.accounts ? `<div class="acctbox" hidden></div>` : ''}
    <div class="board-overview" hidden></div>
    <div class="bd-body board-grid board-${esc(key)}"></div>`;

  root.querySelector('.bd-tabs').addEventListener('click', e => {
    const t = e.target.closest('.bd-tab');
    if (!t) return;
    const st_ = stateOf(key);
    st_.tab = t.dataset.tab;
    st_.items = [];            // 换了筛选，旧数据不能拿来顶，否则会闪一下别的内容
    st_.renderedTab = null;
    render(key);
  });
  root.querySelector('.bd-add').addEventListener('click', () => openEdit(key, null));
  root.querySelector('.board-context-filter button').addEventListener('click', () => {
    const s = stateOf(key);
    s.contextQuery = {};
    s.contextLabel = '';
    s.items = [];
    s.renderedTab = null;
    paintContextFilter(key, root);
    render(key);
  });

  root.querySelector('.bd-filter-toggle')?.addEventListener('click', () => {
    const s = stateOf(key);
    s.showFilters = !s.showFilters;
    paintFilterState(key, root);
  });

  // 标签 + 来源筛选条。字典是异步拉的，挂上去之后自己会画出来
  const tf = root.querySelector('.bd-tagfilter');
  if (tf) {
    tagfilter.mount(tf, {
      withSource: BOARDS[key].tabParam !== 'sourceType',
      onChange: ({ tagIds, sourceType }) => {
        const s_ = stateOf(key);
        s_.tagIds = tagIds;
        s_.sourceType = sourceType;
        s_.showFilters = true;
        s_.items = [];          // 换了筛选，旧数据不能拿来顶
        s_.renderedTab = null;
        paintFilterState(key, root);
        render(key);
      },
    });
  }
  root.querySelector('.bd-acct-toggle')?.addEventListener('click', () => {
    const s = stateOf(key);
    s.showAccounts = !s.showAccounts;
    paintAccounts(key, root);
  });
  root.querySelector('.bd-body').addEventListener('click', e => {
    if (e.target.closest('a')) return;                 // 点链接是去打开作品，不是编辑
    const del = e.target.closest('[data-del]');
    if (del) {
      const menu = del.closest('details');
      menu?.removeAttribute('open');
      // 确认框取消后要回到一个仍然可见的控件，不能回到已收起菜单里的隐藏按钮。
      menu?.querySelector('summary')?.focus();
      return removeRow(key, Number(del.dataset.del));
    }
    const purge = e.target.closest('[data-purge]');
    if (purge) {
      const menu = purge.closest('details');
      menu?.removeAttribute('open');
      menu?.querySelector('summary')?.focus();
      return purgeRow(key, Number(purge.dataset.purge));
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) return openEdit(key, Number(ed.dataset.edit));
    // 删除收进更多菜单，避免手机上每张卡都常驻一个红色危险操作。
    // 点菜单本身不能顺带打开整张卡。
    if (e.target.closest('.record-menu')) return;
    const card = e.target.closest('[data-id]');
    if (!card) return;
    const id = Number(card.dataset.id);
    // 有详情页的板块（客户档案）点行进详情，编辑要从详情页里点 ——
    // 客户信息有九个区，塞进一个弹窗谁也看不清
    if (BOARDS[key].detail) {
      events.dispatchEvent(new CustomEvent('open-detail', { detail: { id, key } }));
    } else {
      // 技术1 分析过的对标作品点开是只读拆解，不是编辑表单 ——
      // 那份数据有九个区，而且改了就和技术1 那边对不上。
      // 要改标题或写「为什么值得对标」，走卡片右上角的更多菜单。
      const row = stateOf(key).items.find(r => r.id === id);
      if (row?.analysis) bench.open(id, row);
      else openEdit(key, id);
    }
  });
  root.querySelector('.bd-body').addEventListener('keydown', e => {
    if (!['Enter', ' '].includes(e.key) || e.target.closest('button,a')) return;
    const card = e.target.closest('[data-id]');
    if (!card) return;
    e.preventDefault();
    card.click();
  });
  paintFilterState(key, root);
}

function paintContextFilter(key, root = $('#v-' + key)) {
  const box = root?.querySelector('.board-context-filter');
  if (!box) return;
  const label = stateOf(key).contextLabel;
  box.hidden = !label;
  box.querySelector('b').textContent = label || '';
}

/**
 * 统计看板点击某一层后，把该层对应的真实查询条件带到业务列表。
 * 这里只设置状态，页面切换仍由 main.js 统一负责。
 */
export function setContextFilter(key, query = {}, label = '') {
  if (!BOARDS[key]) return;
  const s = stateOf(key);
  s.contextQuery = { ...query };
  s.contextLabel = String(label || '').trim();
  // 销售漏斗跨全部客资等级，不能叠加用户上一次停留的 S/A/B/C tab。
  if (key === 'clients') s.tab = '';
  s.items = [];
  s.renderedTab = null;
}

const SUBTITLE = {
  persona: '真人 IP 负责「说服人」。四大内容支柱：强判断 / 识人 / 案例拆解 / 方法论。',
  matrix: '矩阵负责「捞人」。批量生产、多账号分发、关键词引流，目标是持续拿到低成本线索。',
  live: '直播负责「现场证明能力」—— 让用户亲眼看到你们怎么从零散信息里判断人、关系和策略。',
  reports: '把当天的工作成果交给自己指定的审核人。只有你、审核人和管理员看得到。',
  sales: '把有限的后端产能给到高价值客户：先分级、再建档、后诊断。',
  delivery: '陪跑的价值必须从「代聊」中脱离 —— 卖的是关系决策系统，不是随叫随到。',
};

const MODULE_KICKER = {
  demands: '用户洞察', persona: '内容表现', matrix: '内容增长', live: '直播复盘',
  sales: '成交方法', clients: '客户经营', delivery: '服务交付', cases: '经验资产', reports: '团队协作',
};

function paintFilterState(key, root) {
  const s = stateOf(key);
  const panel = root.querySelector('.bd-filter-panel');
  const btn = root.querySelector('.bd-filter-toggle');
  if (!panel || !btn) return;
  const n = s.tagIds.length + (s.sourceType ? 1 : 0);
  panel.hidden = !s.showFilters;
  btn.classList.toggle('on', s.showFilters || n > 0);
  btn.textContent = n ? `筛选 · ${n}` : (s.showFilters ? '收起筛选' : '筛选');
}

function paintHead(key, root) {
  const box = root.querySelector('.board-overview');
  const s = stateOf(key);
  const items = s.items;
  let cells = [];
  const sumMetric = name => items.reduce((n, row) => n + Number(row.metrics?.[name] || 0), 0);
  // 对标那一侧是别人家的作品。曝光、私信、预约这些只有自己后台看得到 ——
  // 对标账号的公开页面上根本没有这些数，用同一组格子去画只会得到一排 0，
  // 而一排 0 看上去像是「数据没同步」，比不显示更糟。
  // 换成公开页面上真的有的那三个数（也正是技术1 推过来的 engagement）。
  const bench = s.tab === 'benchmark';

  if (['persona', 'matrix'].includes(key)) cells = bench ? [
    ['对标作品', items.length, '当前筛选'],
    ['点赞', compact(sumMetric('点赞')), '公开互动'],
    ['收藏', compact(sumMetric('收藏')), '内容价值信号'],
    ['评论', compact(sumMetric('评论')), '讨论热度'],
  ] : [
    ['近 7 日发布', items.filter(x => x.publishedAt && Date.now() - new Date(x.publishedAt).getTime() < 7 * 864e5).length, '保持更新频率'],
    ['总曝光', compact(sumMetric('曝光')), '当前筛选'],
    ['收藏', compact(sumMetric('收藏')), '内容价值信号'],
    ['私信', compact(sumMetric('私信')), '转化意向'],
  ];
  if (key === 'live') cells = bench ? [
    ['对标场次', items.length, '当前筛选'],
    ['点赞', compact(sumMetric('点赞')), '公开互动'],
    ['收藏', compact(sumMetric('收藏')), '内容价值信号'],
    ['评论', compact(sumMetric('评论')), '讨论热度'],
  ] : [
    ['直播场次', items.length, '当前筛选'],
    ['在线峰值', compact(Math.max(0, ...items.map(x => Number(x.metrics?.['在线峰值'] || 0)))), '单场最高'],
    ['总私信', compact(sumMetric('私信')), '现场意向'],
    ['总预约', compact(sumMetric('预约')), '转化结果'],
  ];
  if (key === 'demands') cells = [
    ['待补原话', items.filter(x => !x.quote).length, '缺少用户证据'],
    ['待明确目标', items.filter(x => !x.realGoal).length, '需要继续归纳'],
    ['可追溯来源', items.filter(x => x.sourceUrl || x.sourceType && x.sourceType !== 'manual').length, '外部证据'],
  ];
  if (key === 'clients') cells = [
    ['待完成初筛', items.filter(x => ['lead','wechat'].includes(x.stage)).length, '优先补齐档案'],
    ['高价值待跟进', items.filter(x => x.tier === 'S' && !['renewed','lost'].includes(x.stage)).length, 'S 级客户'],
    ['服务中', items.filter(x => ['coaching','renewed'].includes(x.stage)).length, '陪跑 / 续费'],
    ['缺少报告', items.filter(x => !Number(x.fileCount)).length, '资料待补'],
  ];
  if (key === 'cases') cells = [
    ['待补判断', items.filter(x => !x.judgement).length, '复盘未完成'],
    ['正向结果', items.filter(x => ['推进成功','复合','长期稳定'].includes(x.outcome)).length, '可继续沉淀'],
    ['可复用', items.filter(x => x.reusable).length, '可反哺内容'],
  ];
  if (key === 'reports') cells = [
    ['待审核', items.filter(x => String(x.status).includes('待')).length, '需要处理'],
    ['需要协助', items.filter(x => x.needHelp).length, '团队卡点'],
    ['缺少结果链接', items.filter(x => !x.resultUrl).length, '产物待补'],
  ];

  box.hidden = !cells.length || !items.length;
  box.innerHTML = cells.map(([label, value, note]) => `<div class="overview-cell">
    <span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small>
  </div>`).join('');
}

function paintRows(key, root) {
  const s = stateOf(key);
  const body = root.querySelector('.bd-body');
  body.className = `bd-body board-grid board-${key} mode-${s.tab || 'all'}`;

  if (!s.items.length) {
    body.innerHTML = `<div class="board-empty"><div class="empty sm">
        <svg viewBox="0 0 120 96" aria-hidden="true">
          <path d="M26 30h68v46H26zM26 30l8-12h52l8 12"/><path d="M52 52h16" class="ray"/>
        </svg>
        <b>这个视图还是空的</b>
        <span>点顶部主按钮添加第一条记录。</span>
      </div></div>`;
    return;
  }

  const renderers = {
    demands: demandCard, persona: workCard, matrix: workCard, live: workCard,
    sales: playbookCard, delivery: playbookCard, clients: clientCard,
    cases: caseCard, reports: reportCard,
  };
  const renderer = renderers[key] || genericCard;
  renderKey = key;
  body.innerHTML = s.items.map((row, i) => renderer(row, i, key, s.tab)).join('');
}

const compact = n => {
  const v = Number(n || 0);
  if (v >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 1 : 2).replace(/\.0+$/, '')}万`;
  return new Intl.NumberFormat('zh-CN').format(v);
};
const textOr = (v, fallback = '待补充') => v == null || v === ''
  ? `<span class="soft-empty">${fallback}</span>` : esc(v);
const tagsHtml = row => (row.tags || []).length
  ? `<div class="record-tags">${row.tags.map(t => `<span class="tag tag-${esc(t.kind)}">${esc(t.name)}</span>`).join('')}</div>`
  : '';
const sourceHtml = row => {
  const label = SOURCE_LABEL[row.sourceType] || row.source || '人工录入';
  return row.sourceUrl
    ? `<a class="record-source" href="${esc(row.sourceUrl)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`
    : `<span class="record-source">${esc(label)}</span>`;
};
const deleteHtml = row => `<details class="record-menu">
  <summary aria-label="更多操作">${ICON.more}</summary>
  <div>
    <button data-del="${row.id}">${ICON.trash}<span>删除记录</span></button>
    ${purgeBtn(row)}
  </div>
</details>`;
/** 点开是只读详情的卡片（技术1 分析过的对标作品）要在菜单里补一个入口，
    否则「改个标题、写一句为什么值得对标」这件事在界面上没有任何办法做到。 */
const menuHtml = row => `<details class="record-menu">
  <summary aria-label="更多操作">${ICON.more}</summary>
  <div>
    <button data-edit="${row.id}">${ICON.pencil}<span>编辑台账字段</span></button>
    <button data-del="${row.id}">${ICON.trash}<span>删除记录</span></button>
    ${purgeBtn(row)}
  </div>
</details>`;
const cardAttrs = row => `data-id="${row.id}" role="button" tabindex="0"`;

/**
 * 当前正在渲染的板块。
 *
 * 卡片模板（deleteHtml / menuHtml）是纯字符串函数，拿不到 key，而
 * 「要不要显示永久删除」取决于这个板块是不是软删。给八个模板逐个加参数
 * 改动面更大，而列表渲染是**同步**的一次 map —— 渲染前设一下就够用。
 */
let renderKey = null;

/** 永久删除只给管理员，而且只在软删板块出现：
    非软删的板块本来就是真删，两个菜单项做同一件事只会让人犹豫该点哪个。 */
const canPurge = () => me.role === 'admin' && !!BOARDS[renderKey]?.softDelete;
const purgeBtn = row => (canPurge()
  ? `<button data-purge="${row.id}" class="menu-danger">${ICON.trash}<span>永久删除</span></button>`
  : '');

function demandCard(row, i) {
  return `<article class="record-card insight-card" ${cardAttrs(row)}>
    <header class="record-top"><span class="record-index">洞察 ${String(i + 1).padStart(2, '0')}</span>${sourceHtml(row)}${deleteHtml(row)}</header>
    <h3>${textOr(row.title)}</h3>
    <blockquote>${row.quote ? `“${esc(row.quote)}”` : '<span class="soft-empty">还没有记录用户原话</span>'}</blockquote>
    <div class="insight-goal"><span>真正想解决</span><b>${textOr(row.realGoal)}</b></div>
    <footer><span class="scene-pill">${esc(row.scene || '场景待补')}</span>${tagsHtml(row)}</footer>
  </article>`;
}

function workCard(row, i, key) {
  // 技术1 推过来的对标作品有一整份采集分析（封面、账号、互动、AI 拆解）。
  // 那些东西和「自己账号的曝光/完播」不是一套 —— 对标账号的公开页面上根本没有曝光数，
  // 用同一张卡去画只会得到一排 0。所以它有自己的卡片。
  if (row.analysis) return benchCard(row, i, key);
  const metrics = BOARDS[key].metrics || [];
  const metricHtml = metrics.map(m => `<div class="metric-cell"><span>${esc(m)}</span><b>${compact(row.metrics?.[m])}</b></div>`).join('');
  return `<article class="record-card content-card tone-${i % 4}" ${cardAttrs(row)}>
    <div class="content-cover">
      <div class="cover-top"><span>${esc(row.pillar || (key === 'live' ? '直播复盘' : '内容表现'))}</span><i>${String(i + 1).padStart(2, '0')}</i></div>
      <h3>${textOr(row.title)}</h3>
      <div class="cover-account">${esc(row.accountName || '账号待关联')} ${row.publishedAt ? `· ${esc(row.publishedAt)}` : ''}</div>
    </div>
    <div class="content-detail">
      <div class="record-top"><span class="record-index">${key === 'live' ? '场次数据' : '表现数据'}</span>${row.url ? `<a class="record-source" href="${esc(row.url)}" target="_blank" rel="noopener">打开原内容 ↗</a>` : ''}${deleteHtml(row)}</div>
      <div class="metric-grid">${metricHtml}</div>
      ${row.note ? `<p class="content-note">${esc(row.note)}</p>` : ''}
      ${tagsHtml(row)}
    </div>
  </article>`;
}

/**
 * 技术1 分析过的对标作品。
 *
 * 卡片上只放判断得起来的那几样：封面、标题、账号和粉丝数、公开互动数、
 * AI 的一句话主题。剩下的（逐字稿、评论原文、七问五问）点开看 ——
 * 一条分析 30KB，全铺在列表上一屏放不下两条。
 */
function benchCard(row, i, key) {
  const d = row.analysis || {};
  const eng = d.engagement || {};
  const acc = d.account || {};
  const cells = [['点赞', eng.likes], ['收藏', eng.collects], ['评论', eng.comments]]
    .filter(([, v]) => v != null && v !== '');
  // 封面优先走本地那张（收到推送时下下来的）。平台给的地址带时间签名，
  // 几天后就 404，而且页面是 HTTPS、它是 http:// 的，浏览器会当混合内容拦掉。
  // 本地那张没有（下载失败）才退回原地址，再挂就把整块图收起来 ——
  // 别在卡片顶上留一个碎图标。
  const coverSrc = d.coverLocal ? `/api/works/${row.id}/cover` : d.cover;
  const cover = coverSrc
    ? `<img src="${esc(coverSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer"
         onerror="this.closest('.bench-card').classList.add('no-cover')">`
    : '';
  const extras = [
    d.transcriptChars ? `逐字稿 ${d.transcriptChars} 字` : null,
    d.imageCount ? `图文 ${d.imageCount} 张` : null,
    d.commentsScanned ? `扫了 ${d.commentsScanned} 条评论` : null,
    d.aiVideoCount ? `AI 拆解 ${d.aiVideoCount + d.aiCommentCount} 条` : null,
  ].filter(Boolean);

  return `<article class="record-card bench-card ${cover ? '' : 'no-cover'}" ${cardAttrs(row)}>
    <div class="bench-card-cover">${cover}
      <span class="bench-card-plat">${esc(d.platformLabel || '对标')}</span>
      ${d.duration ? `<span class="bench-card-dur">${esc(d.duration)}</span>`
        // 图文笔记没有时长，标它有几张图 —— 这一格空着的话卡片右下角会缺一块，
        // 而且「这条是视频还是图文」是选对标时第一眼要判断的事
        : d.imageCount ? `<span class="bench-card-dur">图文 ${d.imageCount} 张</span>` : ''}
    </div>
    <div class="bench-card-main">
      <div class="record-top">
        <span class="record-index">对标 ${String(i + 1).padStart(2, '0')}</span>
        ${row.url ? `<a class="record-source" href="${esc(row.url)}" target="_blank" rel="noopener">原作品 ↗</a>` : ''}
        ${menuHtml(row)}
      </div>
      <h3>${textOr(row.title)}</h3>
      <div class="bench-card-acct">
        <b>${esc(acc.name || row.accountName || '账号未识别')}</b>
        ${acc.followers ? `<span>${compact(acc.followers)} 粉</span>` : ''}
      </div>
      ${cells.length ? `<div class="metric-grid">${cells.map(([k, v]) =>
        `<div class="metric-cell"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
      ${d.mainTopic ? `<p class="bench-card-topic"><span>这条讲什么</span>${esc(d.mainTopic)}</p>` : ''}
      ${(d.topics || []).length ? `<div class="bench-card-tags">${
        d.topics.map(t => `<span>#${esc(t)}</span>`).join('')}${
        d.topicCount > d.topics.length ? `<span class="more">+${d.topicCount - d.topics.length}</span>` : ''}</div>` : ''}
      ${tagsHtml(row)}
      <footer class="bench-card-foot">
        <span>${esc(extras.join(' · ') || '技术1 采集分析')}</span><b>看完整拆解 →</b>
      </footer>
    </div>
  </article>`;
}

function playbookCard(row, i, key, tab) {
  const meta = Object.entries(row.meta || {});
  const isFlow = key === 'delivery' && tab === 'flow';
  const isScript = key === 'sales' && tab === 'script';
  return `<article class="record-card playbook-card ${isFlow ? 'flow-card' : ''} ${isScript ? 'script-card' : ''}" ${cardAttrs(row)}>
    <header class="record-top">
      <span class="playbook-no">${isFlow ? '步骤' : '方法'} ${String(i + 1).padStart(2, '0')}</span>
      ${meta.map(([k, v]) => `<span class="meta-pill"><i>${esc(k)}</i>${esc(v)}</span>`).join('')}
      ${deleteHtml(row)}
    </header>
    <div class="playbook-label">${esc(row.label || '未分类')}</div>
    <h3>${textOr(row.title)}</h3>
    <div class="playbook-body">${textOr(row.body, '还没有补充说明')}</div>
    <footer><span>点击卡片编辑内容</span><b>编辑 →</b></footer>
  </article>`;
}

const NEXT_ACTION = {
  lead:'完成客资初筛', wechat:'补齐客户档案', profiled:'安排首次诊断',
  consulted:'跟进陪跑转化', coaching:'记录本周交付', renewed:'维护续费与转介绍', lost:'补充流失原因',
};
function clientCard(row) {
  const initial = [...String(row.alias || '?')][0];
  return `<article class="record-card client-card tier-${esc(String(row.tier || '').toLowerCase())}" ${cardAttrs(row)}>
    <header>
      <div class="client-avatar">${esc(initial)}</div>
      <div><div class="client-name"><h3>${textOr(row.alias)}</h3><span class="tier-badge">${esc(row.tier || '—')} 级</span></div>
      <p>${esc(row.female?.['城市'] || '城市待补')} · ${esc(row.female?.['年龄'] || '年龄待补')} · ${esc(row.source || '来源待补')}</p></div>
      <span class="stagepill s-${esc(row.stage)}">${esc(STAGE[row.stage] || row.stage || '未分阶段')}</span>
      ${deleteHtml(row)}
    </header>
    <div class="client-focus"><span>当前判断</span><p>${textOr(row.note, '还没有补充判断')}</p></div>
    <div class="client-next"><span>下一步</span><b>${esc(NEXT_ACTION[row.stage] || '安排下一次跟进')}</b><i>查看完整档案 →</i></div>
    <footer>${tagsHtml(row)}<span class="file-count">${ICON.clip}${Number(row.fileCount || 0)} 份资料</span></footer>
  </article>`;
}

function caseCard(row) {
  const good = ['推进成功','复合','长期稳定'].includes(row.outcome);
  return `<article class="record-card case-card" ${cardAttrs(row)}>
    <header class="record-top"><span class="case-code">${esc(row.code || '案例待编号')}</span><span class="outcome-pill ${good ? 'good' : ''}">${esc(row.outcome || '进行中')}</span>${deleteHtml(row)}</header>
    <h3>${textOr(row.title)}</h3>
    <div class="case-client">客户 <b>${esc(row.clientAlias || '未关联')}</b>${row.clientTags ? `<span>${esc(row.clientTags)}</span>` : ''}</div>
    <div class="case-journey">
      <div><i>01</i><span>初始问题</span><p>${textOr(row.problem)}</p></div>
      <div><i>02</i><span>判断结论</span><p>${textOr(row.judgement)}</p></div>
      <div><i>03</i><span>策略动作</span><p>${textOr(row.strategy)}</p></div>
    </div>
    <footer>${tagsHtml(row)}${row.reusable ? `<span class="reusable-pill">${ICON.check}可反哺内容</span>` : ''}</footer>
  </article>`;
}

function reportCard(row) {
  const statusClass = String(row.status || '').includes('待') ? 'wait' : 'done';
  return `<article class="record-card report-card" ${cardAttrs(row)}>
    <header class="record-top"><time>${esc(row.reportDate || '日期待补')}</time><span class="report-status ${statusClass}">${esc(row.status || '待审核')}</span>${deleteHtml(row)}</header>
    <h3>${textOr(row.title)}</h3>
    <div class="report-route"><b>${esc(row.authorName || '我')}</b><i>→</i><span>${esc(row.reviewerName || '审核人待选')}</span></div>
    ${row.summary ? `<p class="report-summary">${esc(row.summary)}</p>` : ''}
    ${row.needHelp ? `<div class="report-callout help"><span>需要协助</span>${esc(row.needHelp)}</div>` : ''}
    ${row.feedback ? `<div class="report-callout feedback"><span>审核反馈</span>${esc(row.feedback)}</div>` : ''}
    <footer><span class="file-count">${ICON.clip}${Number(row.fileCount || 0)} 个附件</span><b>打开记录 →</b></footer>
  </article>`;
}

function genericCard(row, i, key) {
  return `<article class="record-card generic-record" ${cardAttrs(row)}>
    <header class="record-top"><span class="record-index">${String(i + 1).padStart(2, '0')}</span>${deleteHtml(row)}</header>
    <h3>${textOr(row.title || row.alias || row.label)}</h3>
    <div class="generic-fields">${columnsOf(key).slice(0, 5).map(c => `<div><span>${esc(c.label)}</span><b>${textOr(valueOf(row, c.key))}</b></div>`).join('')}</div>
  </article>`;
}

function paintAccounts(key, root) {
  const box = root.querySelector('.acctbox');
  if (!box) return;
  const s = stateOf(key);
  box.hidden = !s.showAccounts;
  if (!s.showAccounts) return;

  box.innerHTML = `
    <div class="sec-title">账号台账（${esc(BOARDS[key].tabs.find(t => t.key === s.tab).label)}）</div>
    ${s.accounts.length ? s.accounts.map(a => `
      <div class="acct">
        <b>${esc(a.handle)}</b>
        <span class="tag">${esc(a.platform)}</span>
        ${a.followers ? `<span class="dim">${a.followers} 粉</span>` : ''}
        ${a.url ? `<a class="link" href="${esc(a.url)}" target="_blank" rel="noopener">主页 ↗</a>` : ''}
        <div class="acct-note">${esc(a.positioning || '')}${a.note ? ' · ' + esc(a.note) : ''}</div>
      </div>`).join('')
    : '<div class="dim" style="padding:6px 0">还没有账号，先在「＋ 新增」里建作品时会用到。</div>'}`;
}

/* ---------------- 编辑弹窗 ---------------- */

function openEdit(key, id) {
  const b = BOARDS[key];
  const s = stateOf(key);
  const fields = fieldsOf(key);
  const row = id ? s.items.find(i => i.id === id) : null;
  editing = { key, id };

  // 新增时把当前小板块对应的字段预填上：在「S 级」标签下点新增，等级就该默认是 S。
  // 不预填的话新建出来的东西不匹配当前筛选，存完直接从眼前消失 ——
  // 用户看到的是「点了保存啥也没发生」。
  const preset = {};
  if (!id && b.tabParam && s.tab) preset[b.tabParam] = s.tab;
  // 新建时日期一律默认今天。填日期的场景里「今天」是绝大多数，
  // 空着不填的结果是表格里一整列横杠，按日期排序也没了意义。想改随时能改。
  if (!id) {
    const today = new Date();
    const ymd = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
    for (const f of fields) if (f.type === 'date') preset[f.key] = ymd;
  }

  $('#bdTitle').textContent = (row ? '编辑 · ' : '新增 · ') + b.title;
  // 只有审核人（和管理员）才看得到「审核反馈」这一栏。
  // 不藏的话提交人会以为自己该填，填了又被后端拒掉。
  // 「审核反馈」只在编辑已有记录、且自己是审核人（或管理员）时才出现。
  // 新建那一刻还没人审核，这栏摆在那儿只会让提交人以为自己该填。
  const visible = fields.filter(f => !f.reviewerOnly
    || (row && (me.role === 'admin' || Number(row.reviewerId) === Number(me.id))));

  $('#bdForm').innerHTML = visible.map(f => {
    const v = row ? valueOf(row, f.key) : (preset[f.key] ?? '');
    const id_ = 'bdf_' + f.key.replace(/[^\w]/g, '_');
    let input;
    if (f.type === 'textarea') {
      input = `<textarea class="inp" id="${id_}" rows="3">${esc(v)}</textarea>`;
    } else if (f.type === 'select') {
      input = `<select class="inp" id="${id_}">
        <option value="">—</option>
        ${f.options.map(o => {
          const val = typeof o === 'object' ? o.value : o;
          const lab = typeof o === 'object' ? o.label : o;
          return `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(lab)}</option>`;
        }).join('')}
      </select>`;
    } else if (f.type === 'account' || f.type === 'client' || f.type === 'person') {
      const list = f.type === 'account' ? s.accounts
                 : f.type === 'client' ? (s.clients || []) : (s.people || []);
      const nameOf = o => (f.type === 'account' ? o.handle : (o.alias || o.name));
      input = `<select class="inp" id="${id_}">
        <option value="">—</option>
        ${list.map(a => `<option value="${a.id}"${Number(v) === a.id ? ' selected' : ''}>${esc(nameOf(a))}</option>`).join('')}
      </select>`;
    } else if (f.type === 'tags') {
      // 四类标签各一行，点一下选中/取消。用 chip 而不是多选下拉：
      // 多选下拉在触屏上要按住 Ctrl，业务人员根本选不出第二个。
      const selected = new Set((row?.tagIds || []).map(Number));
      const dict = tagDictSync();
      input = `<div class="tagpick" id="${id_}">${KIND_ORDER.map(kind => {
        const list = (dict?.byKind?.[kind] || []);
        if (!list.length) return '';
        return `<div class="tagrow">
          <span class="tagkind">${esc(KIND_LABEL[kind])}</span>
          ${list.map(t => `<button type="button" class="chip tagchip${
            selected.has(t.id) ? ' on' : ''}" data-tag="${t.id}">${esc(t.name)}</button>`).join('')}
        </div>`;
      }).join('') || '<div class="dim">标签字典还没加载出来</div>'}</div>`;
    } else if (f.type === 'bool') {
      input = `<select class="inp" id="${id_}">
        <option value=""${!v ? ' selected' : ''}>否</option>
        <option value="1"${v ? ' selected' : ''}>是</option>
      </select>`;
    } else {
      const t = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
      input = `<input class="inp" id="${id_}" type="${t}" value="${esc(v)}"${
        f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>`;
    }
    return `<div class="field"><label for="${id_}">${esc(f.label)}${
      f.required ? ' <span>*</span>' : ''}</label>${input}</div>`;
  }).join('');

  // 附件区只在编辑已存在的记录时出现 —— 还没保存的客户没有 id，文件挂不上去
  const fbox = $('#bdFiles');
  pendingFiles = [];
  if (b.files) {
    fbox.dataset.scope = typeof b.files === 'string' ? b.files : 'clients';
    fbox.hidden = false;
    fbox.dataset.clientId = id || '';
    if (id) {
      fbox.innerHTML = '<div class="sec-title">附件</div><div class="filelist dim">加载中…</div>';
      loadFiles(id, key, fbox.dataset.scope);
    } else {
      // 新建时记录还没有 id，文件挂不上去。以前是让用户「先保存再回来传」——
      // 多一步来回，而且很多人保存完就走了，附件永远补不上。
      // 改成先收在内存里，记录一存好立刻替他传上去。
      paintPending();
    }
  } else {
    fbox.hidden = true;
    fbox.innerHTML = '';
  }

  // 标签 chip 的选中态就地切换，保存时再统一收集
  $('#bdForm').querySelectorAll('.tagchip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('on'));
  });

  // 关联资料（任务 8）。和附件一样只在编辑已有记录时出现
  const lbox = $('#bdLinks');
  lbox.hidden = !b.entity;
  if (b.entity && id) {
    links.mount(lbox, b.entity, id);
  } else if (b.entity) {
    // 新建时还没有 id，关联挂不上去。说明白比藏起来好 —— 
    // 藏起来的话用户会以为这个模块没有关联功能。
    lbox.innerHTML = '<div class="sec-title">关联资料</div>'
      + '<div class="dim">先保存这一条，保存后再打开就能把它和别的资料关联起来。</div>';
  } else {
    lbox.innerHTML = '';
  }

  $('#mask').classList.add('on');
  $('#bdModal').classList.add('on');
}

const FMT = n => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB'
               : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

/** 新建时还没 id，选中的文件先攒在这里，记录保存好之后再补传 */
let pendingFiles = [];

const UPLOAD_HINT = '选择图片或文件上传（图片 / PDF / Word / Excel，单个最大 20MB）';

/** 手机相册选出来的照片多半是 HEIC 或 WebP，只写死几个扩展名会把它们挡在文件选择框外面。
    再补一个 image/* ，让手机上「从相册选」直接能用。 */
const UPLOAD_ACCEPT = 'image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.heic,.heif,'
                    + '.html,.htm,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md';

/** 能在浏览器里直接显示的图。
    HEIC/HEIF 除了 Safari 都显示不了 —— 收得下但画不出来，
    所以不当图片处理，退化成一行文件，另外给一句提示。 */
const isImage = f => /^image\//.test(f?.mime || '') && !/heic|heif/i.test(f.mime);
const isHeic  = f => /heic|heif/i.test(f?.mime || '');

function paintPending() {
  const fbox = $('#bdFiles');
  fbox.innerHTML = `
    <div class="sec-title">附件</div>
    <div class="filelist">
      ${pendingFiles.length ? pendingFiles.map((f, i) => `
        <div class="fileitem">
          ${/^image\//.test(f.type) && !/heic|heif/i.test(f.type)
            // 保存前就把选中的图显示出来。选错了要在这一步发现，
            // 而不是等记录建好、传完了才看出传错人/传错图。
            ? `<img class="pendthumb" src="${URL.createObjectURL(f)}" alt="">` : ''}
          <span>${esc(f.name)}</span>
          <span class="dim">${FMT(f.size)} · <b style="color:var(--warn)">待上传</b></span>
          <div class="spacer"></div>
          <button class="btn btn-ghost fdel" data-pending="${i}">移除</button>
        </div>`).join('')
        : '<div class="dim">还没有附件。选好文件，保存时会一起传上去。</div>'}
    </div>
    <label class="fileup">
      <input type="file" id="bdFileInput" multiple
        accept="${UPLOAD_ACCEPT}">
      <span>${UPLOAD_HINT}</span>
    </label>`;

  $('#bdFileInput').addEventListener('change', e => {
    pendingFiles.push(...e.target.files);
    paintPending();
  });
  fbox.querySelectorAll('[data-pending]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFiles.splice(Number(btn.dataset.pending), 1);
      paintPending();
    });
  });
}

/** 附件列表 + 上传框。挂在编辑弹窗底部。 */
async function loadFiles(clientId, boardKey, scope = 'clients') {
  const API = scope === 'reports'
    ? { list: api.reportFiles, up: api.reportUpload }
    : { list: api.clientFiles, up: api.fileUpload };
  const fbox = $('#bdFiles');
  let items = [];
  try {
    ({ items } = await API.list(clientId));
  } catch (e) {
    fbox.innerHTML = `<div class="sec-title">附件 · 分析报告</div><div class="dim">读取失败：${esc(e.message)}</div>`;
    return;
  }
  // 弹窗可能已经被关掉或换了一条记录，别把结果画到错的地方
  if (fbox.dataset.clientId !== String(clientId)) return;

  // 图片和普通文件分开画。审核人打开一条提交，要的是「一眼看到图里干了什么」，
  // 而不是一串叫 IMG_2381.jpg 的链接 —— 那等于逼他一个个下载。
  const imgs = items.filter(isImage);
  const docs = items.filter(f => !isImage(f));
  const who = f => `${FMT(f.size)}${f.uploaderName ? ' · ' + esc(f.uploaderName) : ''}`
                 + (f.side === 'review' ? ' · <b style="color:var(--blue-dk)">审核方</b>' : '');

  fbox.innerHTML = `
    <div class="sec-title">附件${imgs.length ? `（${imgs.length} 张图）` : ''}</div>
    ${imgs.length ? `<div class="imggrid">
      ${imgs.map(f => `
        <figure class="imgcard" data-fid="${f.id}">
          <img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" data-full="${esc(f.url)}">
          <figcaption title="${esc(f.name)}">${esc(f.name)}<span class="dim">${who(f)}</span></figcaption>
          <button class="imgdel fdel" data-fid="${f.id}" title="删除这张图">×</button>
        </figure>`).join('')}
    </div>` : ''}
    <div class="filelist">
      ${docs.length ? docs.map(f => `
        <div class="fileitem" data-fid="${f.id}">
          <a class="link" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>
          <span class="dim">${who(f)}${isHeic(f)
            ? ' · <b style="color:var(--warn)">iPhone 原图，需下载查看</b>' : ''}</span>
          <div class="spacer"></div>
          <a class="link dim" href="${esc(f.url)}?download=1">下载</a>
          <button class="btn btn-ghost fdel" data-fid="${f.id}">删除</button>
        </div>`).join('')
        : (imgs.length ? '' : '<div class="dim">还没有报告。</div>')}
    </div>
    <label class="fileup">
      <input type="file" id="bdFileInput" multiple
        accept="${UPLOAD_ACCEPT}">
      <span>${UPLOAD_HINT}</span>
    </label>
    <div class="dim" id="bdFileMsg"></div>`;

  $('#bdFileInput').addEventListener('change', async e => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    const msg = $('#bdFileMsg');
    for (const [i, file] of files.entries()) {
      msg.textContent = `正在上传 ${file.name}…（${i + 1}/${files.length}）`;
      try { await API.up(clientId, file); }
      catch (err) { toast('info', `${file.name}：${err.message || '上传失败'}`); }
    }
    msg.textContent = '';
    toast('ok', files.length > 1 ? `已上传 ${files.length} 个` : '已上传');
    await loadFiles(clientId, boardKey, scope);
    // 直接 render 而不是 refresh()：refresh 里有「弹窗开着就跳过」的守卫，
    // 而上传的那一刻弹窗正开着，走 refresh 会被自己挡掉 ——
    // 用户看到的就是「传上去了但表格里的计数没变」。
    if (boardKey) await render(boardKey);
  });

  // 一条提交常常是好几张截图，审核人要能在大图里直接翻，不用退回去再点
  const shots = [...fbox.querySelectorAll('.imgcard img')];
  shots.forEach((im, i) => {
    im.addEventListener('click', () =>
      openLightbox(shots.map(x => ({ url: x.dataset.full, name: x.alt })), i));
  });

  fbox.querySelectorAll('.fdel').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isImg = btn.closest('.imgcard');
      const name = isImg
        ? (btn.closest('.imgcard')?.querySelector('img')?.alt || '这张图')
        : (btn.closest('.fileitem')?.querySelector('a')?.textContent || '这个附件');
      const ok = await confirmAction({
        eyebrow: '不可恢复操作',
        title: isImg ? '删除这张图？' : '删除这个附件？',
        message: `「${name}」会从这条记录上移除。`,
        note: '文件本体会一起删掉，删除后无法恢复。',
        confirmLabel: '确认删除',
      });
      if (!ok) return;
      try {
        await api.fileDelete(Number(btn.dataset.fid));
        toast('ok', '已删除');
        await loadFiles(clientId, boardKey, scope);
        if (boardKey) await render(boardKey);
      } catch (err) { toast('info', err.message || '删除失败'); }
    });
  });
}

export function closeEdit() {
  const key = editing?.key;
  $('#bdModal').classList.remove('on');
  $('#mask').classList.remove('on');
  editing = null;
  // 弹窗开着时被 refresh() 跳过的那次刷新，现在补上。
  // 「跳过」不等于「算了」—— 不补的话关掉弹窗看到的还是旧数据。
  if (key && skipped.has(key)) { skipped.delete(key); render(key); }
}

/** 记下「因为弹窗开着而被跳过」的刷新，等弹窗关掉再补 */
const skipped = new Set();

export async function saveEdit() {
  if (!editing) return;
  const { key, id } = editing;
  const b = BOARDS[key];
  const s = stateOf(key);

  const payload = {};
  const fields = fieldsOf(key).filter(f => document.getElementById('bdf_' + f.key.replace(/[^\w]/g, '_')));
  const groups = Object.fromEntries((b.jsonGroups || []).map(g => [g, {}]));

  for (const f of fields) {
    // 标签是一排 chip，没有 .value，下面单独收 —— 放进这个循环会直接抛异常
    if (f.type === 'tags') continue;
    const el = document.getElementById('bdf_' + f.key.replace(/[^\w]/g, '_'));
    if (!el) continue;
    let v = el.value.trim();
    if (f.type === 'number') v = v === '' ? 0 : Number(v);
    if (f.type === 'bool') v = v === '1';

    const dot = f.key.indexOf('.');
    const group = dot > 0 ? f.key.slice(0, dot) : null;
    if (group && groups[group]) {
      // 空字符串不往 JSONB 里塞，免得攒出一堆 "": "" 的噪音。
      // 但 0 必须留下 —— 把某个指标改回 0 也是一次有意义的修改，
      // 跟着空值一起丢掉的话用户会发现"改不回去"。
      if (v !== '') groups[group][f.key.slice(dot + 1)] = v;
    } else {
      payload[f.key] = v;
    }
  }
  // 标签是 chip 不是 input，上面那个循环取不到，单独收
  const pick = $('#bdForm').querySelector('.tagpick');
  if (pick) {
    payload.tagIds = [...pick.querySelectorAll('.tagchip.on')].map(c => Number(c.dataset.tag));
  }
  Object.assign(payload, groups, b.query || {});
  // 小板块对应的参数（side / section / tier / outcome）。
  // 表单里已经有这个字段时不能覆盖 —— 否则在「S 级」标签下把客户改成 A 级，
  // 一保存又被标签页拉回 S 级。只有表单里没有它时才拿当前标签兜底。
  if (b.tabParam && s.tab && !fields.some(f => f.key === b.tabParam)) {
    payload[b.tabParam] = s.tab;
  }
  if ('accountId' in payload) payload.accountId = payload.accountId || null;
  if ('clientId' in payload) payload.clientId = payload.clientId || null;

  // 每个板块的必填项不一样：作品/案例是 title，客户档案是 alias
  const req = fields.find(f => f.required);
  if (req && !payload[req.key]) return toast('info', req.label + '不能为空');

  const btn = $('#btnBdSave');
  btn.disabled = true;
  try {
    const saved = id ? await api[b.api + 'Patch'](id, payload)
                     : await api[b.api + 'Create'](payload);

    // 新建时攒在内存里的附件，现在记录有 id 了，补传上去
    if (!id && pendingFiles.length && saved?.id) {
      const scope = typeof b.files === 'string' ? b.files : 'clients';
      const up = scope === 'reports' ? api.reportUpload : api.fileUpload;
      const failed = [];
      for (const f of pendingFiles) {
        try { await up(saved.id, f); }
        catch (e) { failed.push(`${f.name}：${e.message}`); }
      }
      pendingFiles = [];
      // 记录已经存好了，附件传失败不该让人以为整条都没保存 —— 分开说清楚
      if (failed.length) toast('info', '记录已保存，但有附件没传上去 · ' + failed[0]);
    }

    closeEdit();
    toast('ok', id ? '已保存' : '已新增');
    await render(key);

    // 兜底：存完的东西如果不属于当前筛选（比如在「S 级」标签下把等级改成了 A），
    // 自动跳到能看见它的那个标签，并说明一句。默默消失是最难排查的一种"没反应"。
    if (saved?.id && !stateOf(key).items.some(i => i.id === saved.id)) {
      const val = b.tabParam ? (saved[b.tabParam] ?? '') : '';
      const target = b.tabs.find(t => t.key === val) || b.tabs.find(t => t.key === '');
      if (target && target.key !== stateOf(key).tab) {
        stateOf(key).tab = target.key;
        await render(key);
        toast('info', `已存好，它属于「${target.label}」，已经帮你切过去了`);
      }
    }
  } catch (e) {
    toast('info', e.message || '保存失败');
  } finally {
    btn.disabled = false;
  }
}

/**
 * 永久删除（管理员）。
 *
 * 和 removeRow 的差别不是"更狠一点"，是**没有后路**：软删的记录还躺在库里，
 * 找管理员就能捞回来；这个连同附件、标签、关联和磁盘上的图片一起抹掉，
 * 谁都恢复不了。所以措辞里不留任何"应该还能找回来"的暗示。
 */
async function purgeRow(key, id) {
  const b = BOARDS[key];
  const row = stateOf(key).items.find(x => Number(x.id) === id);
  const name = String(row?.title || '').trim();
  const ok = await confirmAction({
    eyebrow: '永久删除 · 无法恢复',
    title: '把这条记录从数据库里抹掉？',
    message: name
      ? `「${name}」及其附件、标签、关联关系会被一起删除。`
      : '这条记录及其附件、标签、关联关系会被一起删除。',
    note: '这不是普通删除：记录不会留在数据库里，管理员也无法恢复。'
        + '只想让它从列表里消失的话，请用「删除记录」。',
    confirmLabel: '我确定，永久删除',
  });
  if (!ok) return;
  try {
    const r = await api[b.api + 'Delete'](id, true);
    // 顺手把清理了什么报出来 —— 永久删除是不可逆的，做完让人看见到底动了什么
    const bits = [r?.attachments ? `附件 ${r.attachments}` : null,
                  r?.images ? `图片 ${r.images}` : null,
                  r?.links ? `关联 ${r.links}` : null].filter(Boolean);
    toast('ok', bits.length ? `已永久删除（含 ${bits.join('、')}）` : '已永久删除');
    await render(key);
  } catch (e) {
    toast('info', e.message || '永久删除失败');
  }
}

async function removeRow(key, id) {
  const b = BOARDS[key];
  const row = stateOf(key).items.find(x => Number(x.id) === id);
  const name = String(row?.title || '').trim();
  // 软删和真删要说不一样的话。对软删的记录说「找不回来了」是在吓唬人，
  // 对真删的记录说「还能找回来」则是骗人 —— 两种都会让人下次不敢按这个按钮。
  const ok = await confirmAction({
    eyebrow: b.softDelete ? '可恢复删除' : '不可恢复操作',
    title: '删除这条记录？',
    message: name
      ? `「${name}」将不再出现在当前列表和全局搜索中。`
      : '这条记录将不再出现在当前列表和全局搜索中。',
    note: b.softDelete
      ? '记录仍保留在数据库中，需要时可由管理员恢复。'
      : '删除后无法恢复，请确认这不是误操作。',
    confirmLabel: '确认删除',
  });
  if (!ok) return;
  try {
    await api[b.api + 'Delete'](id);
    toast('ok', '已删除');
    await render(key);
  } catch (e) {
    toast('info', e.message || '删除失败');
  }
}

/**
 * 在某个板块里找到某一行并打开它，找不到就换个小板块继续找。
 *
 * 从消息点进来时，那条记录未必在默认的小板块里 ——
 * 比如「等你审核」的提交，默认落在「我提交的」标签下，怎么等都等不到。
 * 所以要挨个小板块试过去，而不是干等当前这个。
 */
export async function openRow(key, refId) {
  const b = BOARDS[key];
  const s = stateOf(key);
  const order = [s.tab, ...b.tabs.map(t => t.key).filter(t => t !== s.tab)];
  for (const tab of order) {
    if (s.tab !== tab) { s.tab = tab; }
    await render(key);
    const row = document.querySelector(`#v-${key} .bd-body [data-id="${refId}"]`);
    if (row) { row.click(); return true; }
  }
  return false;
}

/**
 * 按 id 打开某个板块的编辑弹窗（客户详情页的「编辑资料」走这里）。
 *
 * 要先保证列表数据在手上 —— openEdit 是从 s.items 里找那一行的，
 * 直接进详情页的用户可能根本没打开过客户列表，那时 s.items 是空的。
 */
export async function openEditById(key, id) {
  const s = stateOf(key);
  if (!s.items.some(i => i.id === Number(id))) {
    try { await fetchItems(key); } catch { /* 拉不到就让 openEdit 走空表单 */ }
  }
  openEdit(key, Number(id));
}

/** 收到推送时静默刷新：只刷当前正开着的那个板块，别把五个都拉一遍 */
export async function refresh(key, visibleKey) {
  if (key !== visibleKey || state.mode === 'mock') return;
  // 正在编辑时别把表单底下的数据换掉，但要记下来，关掉弹窗时补刷新
  if (document.querySelector('#bdModal.on')) { skipped.add(key); return; }
  return render(key);
}
