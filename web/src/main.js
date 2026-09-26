/** 入口：把各视图接起来 */
import { api, probe, state } from './api.js';
import { $, avatarColor, initial } from './util.js';
import { toast } from './toast.js';
import * as pool from './views/pool.js';
import * as formal from './views/formal.js';
import * as stats from './views/stats.js';
import * as drawer from './views/drawer.js';
import * as modal from './views/modal.js';
import * as review from './views/review.js';
import * as account from './views/account.js';
import { celebrateAdopt } from './views/celebrate.js';
import * as live from './live.js';
import * as board from './views/board.js';
import * as bench from './views/bench.js';
import * as funnel from './views/funnel.js';
import * as notify from './views/notify.js';
import * as chat from './views/chat.js';
import { ICON } from './icons.js';
import * as alertBox from './views/alert.js';
import { BOARD_ORDER, BOARD_CREATE } from './boards.js';
import * as search from './views/search.js';
import * as clientDetail from './views/client.js';
import * as tagadmin from './views/tagadmin.js';
import * as tagfilter from './views/tagfilter.js';
import * as importer from './views/importer.js';
import * as dashboard from './views/dashboard.js';
import * as expenses from './views/expenses.js';
import * as purchases from './views/purchases.js';
import { initMotion } from './motion.js';
import { openLook, savedLooks, useSaved } from './look.js';
import { startTour } from './tour.js';
import { reduced, skeleton } from './anim.js';
import { bindPalette, togglePalette } from './views/palette.js';
import { openShortcuts } from './views/shortcuts.js';
import { initPrefsSync } from './prefs-sync.js';
import { initErrorReporting } from './errlog.js';
import { setTheme } from './theme.js';
import { bindSheetPreview } from './sheet-preview.js';
import { bindDocPreview } from './doc-preview.js';
import { bindImagePreview } from './lightbox.js';

let view = 'home';
let currentMe = null;

/**
 * 按需加载的页面（2026-09-26）：样本库那一组（对比 / 研究 / 洞察 / 组件 / 账号研究）、内容采集、学习、项目功能树
 * 只有少数人、少数时候用，代码不进首屏的 app.js（约占一半体积），第一次打开时才下载。
 * 下载期间页面上先放骨架；下载失败（比如断网）给出「重试」。首屏空闲后在后台悄悄预取，真点进去时基本不用等。
 *
 * 「重试」是刷新整页：浏览器会记住某个 import() 失败过，同一个页面里再 import 直接返回那次失败、
 * 根本不重新下载（Chrome 152 实测）；后台预取碰上断网也一样会把它记成失败。只有刷新能清掉。
 * 刷新前把要去的页面记在 sessionStorage，启动完直接回到那一页。
 */
const LAZY_RETRY_KEY = 'ideahub.lazyRetry';
const LAZY = {
  samples: () => import('./views/samples.js'),
  collector: () => import('./views/collector.js'),
  learning: () => import('./views/learning.js'),
  functionTree: () => import('./views/function-tree.js'),
};
const lazyMods = {};
const lazyWait = {};
function page(name) {
  return lazyWait[name] ||= LAZY[name]().then(m => {
    lazyMods[name] = m;
    wireLazy(name, m);
    return m;
  }, err => {
    delete lazyWait[name];   // 下次再试
    throw err;
  });
}
/** 模块第一次到手时要接的线：原来在启动时一次接好，现在挪到这里 */
function wireLazy(name, m) {
  if (name === 'collector') {
    if (currentMe) m.setMe(currentMe);
    m.events.addEventListener('open-sample', event => {
      page('samples').then(s => { s.openSample(event.detail.sampleId); go('samples'); });
    });
  }
  if (name === 'learning') m.events.addEventListener('back', () => go('home'));
  if (name === 'functionTree') {
    m.events.addEventListener('navigate', event => {
      const { action, target, section } = event.detail;
      if (action === 'search') { focusGlobalSearch(); return; }
      if (action === 'import') { importer.open(); return; }
      if (target === 'learning') { openLearning(section || 'framework'); return; }
      if (target) go(target);
    });
  }
}
/** 打开学习页的某一栏：先把栏目交给学习模块，再切页（切页时才渲染） */
function openLearning(section) {
  page('learning').then(l => { l.setSection(section); go('learning'); }, () => go('learning'));
}
/** 切到按需加载的页面：没下载过先放骨架，到手后再渲染（期间又切走了就不渲染） */
function showLazy(name) {
  const host = $('#v-' + name);
  if (!lazyMods[name] && !host.childElementCount) {
    host.innerHTML = `<div class="lazy-wait">${skeleton('task', { n: 4, label: '正在打开…' })}</div>`;
  }
  page(name).then(m => { if (view === name) m.render(); }, () => {
    if (view !== name) return;
    host.innerHTML = `<div class="lazy-fail" role="alert"><b>这个页面没打开</b><span>网络可能断了一下，点「重试」再打开一次</span>
      <button type="button" class="btn btn-primary" data-lazy-retry="${name}">重试</button></div>`;
  });
}

/**
 * 顶部只显示「我现在在哪」和「此页最常用的动作」。
 * 业务模块已经从 3 个长到 14 个，继续让全站按钮永远写着「提交灵感」会让人误以为
 * 客户、作品、交付页都只是灵感库的附属页。
 */
const CHROME = {
  home:         { group: '总览', title: '今日工作台' },
  functionTree: { group: '总览', title: '项目功能树' },
  pool:         { group: '市场与内容', title: '灵感池',   create: '提交灵感' },
  demands:      { group: '市场与内容', title: '用户需求', create: BOARD_CREATE.demands },
  formal:       { group: '市场与内容', title: '正式库',   create: '提交灵感' },
  persona:      { group: '内容运营', title: '真人作品', create: BOARD_CREATE.persona },
  matrix:       { group: '内容运营', title: '矩阵作品', create: BOARD_CREATE.matrix },
  live:         { group: '内容运营', title: '真人直播', create: BOARD_CREATE.live },
  sales:        { group: '销售与客户', title: '销售转化', create: BOARD_CREATE.sales },
  clients:      { group: '销售与客户', title: '客户档案', create: BOARD_CREATE.clients },
  clientDetail: { group: '销售与客户', title: '客户详情' },
  delivery:     { group: '交付与案例', title: '后端交付', create: BOARD_CREATE.delivery },
  cases:        { group: '交付与案例', title: '案例库', create: BOARD_CREATE.cases },
  reports:      { group: '团队', title: '工作提交', create: BOARD_CREATE.reports },
  expenses:     { group: '团队', title: '报销审批', create: '发起报销' },
  purchases:    { group: '团队', title: '采购', create: '发起采购' },
  tagadmin:     { group: '团队', title: '标签与对接' },
  funnel:       { group: '数据', title: '数据漏斗' },
  stats:        { group: '数据', title: '统计看板' },
  collector:    { group: '数据', title: '内容采集' },
  samples:      { group: '数据', title: '样本库' },
  learning:     { group: '学习中心', title: '站内学习' },
};

function paintChrome(next = view) {
  const c = CHROME[next] || { group: 'IdeaHub', title: '团队业务工作台' };
  document.documentElement.dataset.view = next;   // 顶栏「编辑布局」只在首页出现（soft.css）
  $('#pageGroup').textContent = c.group;
  $('#pageContext').textContent = c.title;
  document.title = `${c.title} · IdeaHub`;

  const create = $('#btnNew');
  $('#btnNewLabel').textContent = c.create || '';
  // 手机顶栏放不下四个字，只留动作的对象：「发起报销」→「报销」。读屏软件读的还是完整说法（aria-label）
  $('#btnNewShort').textContent = (c.create || '').replace(/^(提交|新增|发起)/, '');
  create.setAttribute('aria-label', c.create || '');
  create.classList.toggle('is-hidden', !c.create);
  create.setAttribute('aria-hidden', c.create ? 'false' : 'true');

  for (const g of document.querySelectorAll('.navgrp')) {
    g.classList.toggle('active', !!g.querySelector('button.on'));
  }
}

/**
 * 侧栏分组的开合。默认全部展开（用户 09-24 定的：新人第一次进来要看得到全部入口，
 * 任务表第 1 条的「6 组分法」也要一眼看得出），谁嫌长谁自己收，收起的组记在这台设备上。
 * 存的是「收起了哪些组」而不是「展开了哪些」：以后新加的组默认就是展开的。
 */
const NAV_COLLAPSE_KEY = 'ideahub.navCollapsed.v1';

function initNavCollapse() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) || '[]'); } catch { /* 存储不可用就全展开 */ }
  for (const g of document.querySelectorAll('.navgrp')) {
    g.classList.toggle('collapsed', Array.isArray(saved) && saved.includes(g.dataset.group));
    g.querySelector('.navtop').setAttribute('aria-expanded', String(!g.classList.contains('collapsed')));
    const n = document.createElement('span');
    n.className = 'navtop-todo';
    n.hidden = true;
    g.querySelector('.caret').before(n);
  }
  // 待办数由各自页面写进导航角标（expenses.js / purchases.js 的 paintBadge），这里只跟着看
  const watch = new MutationObserver(paintNavTodo);
  for (const b of document.querySelectorAll('.nav [data-todo]')) {
    watch.observe(b, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  paintNavTodo();
}

/**
 * 侧栏（09-24 晚改成原型的样式）：每一项前面加图标、文字包进 .nav-label；当前项底下垫一块跟着滑动的实心色块；
 * 桌面上可以收成只剩图标的窄栏（记在这台设备上，<head> 里的外观引擎会在首次绘制前把 .nav-rail 加上，不会先宽后窄）。
 */
/**
 * 跟手的动效（09-25 按原型）：鼠标划过卡片时卡片朝光标方向微微倾斜（3D）；顶栏的圆形按钮被光标轻轻吸过去。
 * 只对鼠标生效（触屏没有悬停）；「配色与外观」里动效调成简洁 / 关闭、或系统开了减弱动态效果时不做。
 * 大卡片倾斜角度按宽度缩小，宽卡片不会翘得太夸张；首页排版编辑、拖动时不倾斜。
 */
const TILT = '.dash-hot, .dash-client, .dash-quick button, .dash-action-grid>button, .record-card, #poolGrid .idea-card, .overview-cell';
const MAGNET = '.topbar :is(.top-icon, .notifbtn, .smart-import-trigger, #btnNew, .avatar)';
const RIPPLE = '.btn, .rip, .top-icon, .smart-import-trigger, .dash-quick button, .dash-hot-go, .dash-focus-open, .dash-client, .cmdk-item';
let tiltEl = null;
let magnetEl = null;
function pointerFx(e) {
  const mouse = e && e.pointerType === 'mouse' && !reduced();
  const tilt = mouse ? e.target.closest?.(TILT) : null;
  if (tiltEl && tiltEl !== tilt) { tiltEl.style.transform = ''; tiltEl = null; }
  if (tilt && !tilt.closest('.editing') && !tilt.classList.contains('dragging')) {
    const r = tilt.getBoundingClientRect();
    const k = Math.min(1, 420 / r.width);
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    tilt.style.transform = `perspective(900px) rotateX(${(-py * 7 * k).toFixed(2)}deg) rotateY(${(px * 8 * k).toFixed(2)}deg) translateY(-3px)`;
    tiltEl = tilt;
  }
  const mag = mouse ? e.target.closest?.(MAGNET) : null;
  if (magnetEl && magnetEl !== mag) { magnetEl.style.translate = ''; magnetEl = null; }
  if (mag) {
    const r = mag.getBoundingClientRect();
    mag.style.translate = `${((e.clientX - r.left - r.width / 2) * 0.25).toFixed(1)}px ${((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1)}px`;
    magnetEl = mag;
  }
}

const NAV_ICON = {
  home: 'home', functionTree: 'tree', pool: 'bulb', demands: 'comment', formal: 'archive',
  persona: 'film', matrix: 'grid', live: 'live', sales: 'trend', clients: 'users',
  delivery: 'box', cases: 'briefcase', reports: 'send', expenses: 'receipt', purchases: 'cart',
  tagadmin: 'tag', funnel: 'funnel', stats: 'chart', samples: 'database', collector: 'download',
};
const NAV_RAIL_KEY = 'ideahub.navRail.v1';
const desktopNav = matchMedia('(min-width:1181px)');

function decorateNav() {
  const nav = $('#appNav');
  for (const b of nav.querySelectorAll('.navmenu button[data-go]')) {
    const texts = [...b.childNodes].filter(n => n.nodeType === 3);
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = texts.map(n => n.textContent).join('').trim();
    texts.forEach(n => n.remove());
    b.prepend(label);
    b.insertAdjacentHTML('afterbegin', `<span class="nav-ic">${ICON[NAV_ICON[b.dataset.go]] || ICON.layers}</span>`);
    b.title = label.textContent;
  }

  // 桌面侧栏卡片里只有菜单这一段滚动（09-25）：「收起侧栏」按钮排在滚动区外面，
  // 不会盖住最底下那一项，菜单项也不会从顶上的 Logo 底下穿过去。窄屏上这层是 display:contents，布局和原来一样
  const scroller = document.createElement('div');
  scroller.className = 'nav-scroll';
  const groups = nav.querySelectorAll(':scope > .navgrp');
  groups[0].before(scroller);
  scroller.append(...groups);

  const ind = document.createElement('i');
  ind.className = 'nav-ind';
  ind.setAttribute('aria-hidden', 'true');
  scroller.appendChild(ind);
  let first = true;
  const place = () => {
    const on = nav.querySelector('.navmenu button.on');
    if (!desktopNav.matches || !on || !on.getClientRects().length) { ind.style.opacity = '0'; return; }
    let top = 0;
    for (let el = on; el && el !== scroller; el = el.offsetParent) top += el.offsetTop;
    if (first) { ind.style.transition = 'none'; requestAnimationFrame(() => { ind.style.transition = ''; }); first = false; }
    ind.style.opacity = '1';
    ind.style.height = `${on.offsetHeight}px`;
    ind.style.transform = `translateY(${top}px)`;
  };
  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
  new MutationObserver(schedule).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', schedule);
  desktopNav.addEventListener('change', schedule);

  const rail = document.createElement('button');
  rail.type = 'button';
  rail.className = 'nav-rail-btn';
  rail.id = 'navRailBtn';
  rail.innerHTML = `<span class="nav-ic">${ICON.sidebar}</span><span class="nav-label"></span>`;
  nav.appendChild(rail);
  const setRail = on => {
    document.documentElement.classList.toggle('nav-rail', on);
    rail.setAttribute('aria-pressed', String(on));
    rail.title = on ? '展开侧栏' : '收起侧栏';
    rail.querySelector('.nav-label').textContent = rail.title;
    try { localStorage.setItem(NAV_RAIL_KEY, on ? '1' : '0'); } catch { /* 记不住只影响这一次 */ }
    setTimeout(schedule, 450);   // 等宽度动画走完再对位
  };
  rail.addEventListener('click', () => {
    setRail(!document.documentElement.classList.contains('nav-rail'));
    // 收起 / 展开后侧栏高度变了，把当前页那一项滚回看得见的地方（点的是最底下的按钮，不处理就停在底部）
    setTimeout(() => {
      const on = nav.querySelector('.navmenu button.on');
      if (!on) return;
      let top = 0;
      for (let el = on; el && el !== scroller; el = el.offsetParent) top += el.offsetTop;
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'smooth' });
    }, 460);
  });
  setRail(document.documentElement.classList.contains('nav-rail'));
  schedule();
}

function saveNavCollapse() {
  const keys = [...document.querySelectorAll('.navgrp.collapsed')].map(g => g.dataset.group);
  try { localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(keys)); } catch { /* 隐私模式下只是记不住 */ }
}

/**
 * 收起的组把里面「待我处理」的数加起来挂在组标题上 —— 报销待审被收进「团队」里看不见，
 * 收纳就成了漏事。灵感池、正式库那种角标是总条数不是待办，不算（只认带 data-todo 的）。
 */
function paintNavTodo() {
  for (const g of document.querySelectorAll('.navgrp')) {
    const el = g.querySelector('.navtop-todo');
    if (!el) continue;
    const n = [...g.querySelectorAll('[data-todo]')]
      .reduce((sum, b) => sum + (b.classList.contains('is-empty') ? 0 : Number(b.textContent) || 0), 0);
    const show = g.classList.contains('collapsed') && n > 0;
    el.hidden = !show;
    el.textContent = show ? String(n) : '';
    const top = g.querySelector('.navtop');
    const name = top.firstChild.textContent.trim();
    if (show) top.setAttribute('aria-label', `${name}，${n} 项待我处理`);
    else top.removeAttribute('aria-label');
  }
}

function closeMobileNav() {
  $('#appNav').classList.remove('mobile-open');
  $('#navMask').classList.remove('on');
  $('#navToggle').setAttribute('aria-expanded', 'false');
}

function openMobileNav() {
  $('#appNav').classList.add('mobile-open');
  $('#navMask').classList.add('on');
  $('#navToggle').setAttribute('aria-expanded', 'true');
}

function closeMobileSearch() {
  document.querySelector('.topbar .search')?.classList.remove('mobile-open');
  document.body.classList.remove('mobile-search-open');
}

function focusGlobalSearch() {
  const box = document.querySelector('.topbar .search');
  if (innerWidth <= 1180) {
    box.classList.add('mobile-open');
    document.body.classList.add('mobile-search-open');
  }
  setTimeout(() => $('#q').focus(), 30);
}

function createForCurrentView() {
  if (view === 'expenses') {
    expenses.openCreate();
    return;
  }
  if (view === 'purchases') {
    purchases.openCreate();
    return;
  }
  if (BOARD_ORDER.includes(view)) {
    document.querySelector(`#v-${view} .bd-add`)?.click();
    return;
  }
  // 正式库的内容也来自灵感池，不能在这里凭空新建一条正式记录。
  if (view === 'pool' || view === 'formal') modal.open();
}

initErrorReporting();   // 越早越好：启动过程里的错也要能收到

async function boot() {
  initMotion();
  // HTML 里只放了 data-ico 占位，图标本体在 icons.js（模块，HTML 直接取不到）
  for (const el of document.querySelectorAll('[data-ico]')) {
    el.innerHTML = ICON[el.dataset.ico] || '';
  }
  decorateNav();

  await probe();

  const me = await api.me();
  drawer.setMe(me);
  account.setMe(me);
  board.setMe(me);
  chat.setMe(me);
  tagadmin.setMe(me);
  dashboard.setMe(me);
  currentMe = me;
  lazyMods.collector?.setMe(me);
  initPrefsSync(me);   // 配色与外观跟着账号走：不等它，页面照常往下画
  expenses.setMe(me);
  purchases.setMe(me);
  const av = $('#meAvatar');
  av.textContent = initial(me.name);
  av.style.background = avatarColor(me.name);
  av.title = `${me.name}${me.dept ? ' · ' + me.dept : ''}（${
    { admin: '管理员', reviewer: '评审委员', member: '成员' }[me.role] || me.role}）`;

  paintChrome(view);

  if (state.mode === 'mock') {
    toast('info', '当前是演示数据（后端未连接），改动刷新后还原');
  }

  bind();
  expenses.bind();
  purchases.bind();
  await Promise.all([dashboard.render(), pool.render(), formal.render()]);

  // 页面从此自己保持最新：后端推事件，连不上就退回轮询
  notify.bind();
  notify.refresh();
  expenses.refreshBadge();
  purchases.refreshBadge();
  chat.bind();
  bindSheetPreview();
  bindDocPreview();
  bindImagePreview();
  chat.refresh();
  alertBox.bind();
  // 只读一下当前权限，不在这里申请 —— 申请必须由用户点击触发
  // （消息面板顶部那条「开启桌面通知」），否则 Edge 的静默通知请求会把它吞掉。
  // 没开启时仍有标题未读数 + 提示音 + favicon 红点兜底。
  alertBox.initSystem();

  bindLive();
  live.start();
  // 按需加载页面点了「重试」刷新过来的：回到那一页
  let retryView = '';
  try { retryView = sessionStorage.getItem(LAZY_RETRY_KEY) || ''; sessionStorage.removeItem(LAZY_RETRY_KEY); } catch { /* 存储不可用就留在首页 */ }
  if (retryView in LAZY) go(retryView);
  // 首屏稳定之后，在浏览器空闲时把按需加载的页面预取下来：不跟首屏抢带宽，真点进去时基本不用等
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 200));
  setTimeout(() => idle(() => Object.keys(LAZY).forEach(name => page(name).catch(() => {}))), 5000);
}

/**
 * 把推送事件接到各个视图上。
 *
 * 事件本身只是「哪条变了」的信号，真数据一律走原来的 REST 接口重新拉 ——
 * 所以这里每个分支做的都是「去刷新某个视图」，而不是拿事件体直接画 DOM。
 * 轮询降级时收不到具体事件，统一走 sweep 分支。
 */
function bindLive() {
  const on = (type, fn) => live.events.addEventListener(type, e => {
    Promise.resolve(fn(e.detail)).catch(err => console.warn('[live]', type, err));
  });

  // 灵感池永远走增量：只改数字、不动顺序，新灵感攒进顶部胶囊
  const touchPool = () => pool.patch();

  on('idea:created', touchPool);
  on('idea:updated', d => {
    syncDrawerVote(d);
    // project 标记只有进度/方案文档变了才为真。否则每投一票都去重拉正式库那张表纯属浪费
    return Promise.all([touchPool(), d?.project ? formal.refresh() : null]);
  });
  on('hot:recalced', touchPool);
  on('idea:bulk',    touchPool);

  on('idea:status', d => Promise.all([
    touchPool(),
    d?.to === 'adopted' ? formal.refresh() : null,
    stats.refresh(),
  ]));

  on('comment:created', d => Promise.all([
    touchPool(),
    drawer.syncComments(d?.ideaId),
  ]));

  // 有人录了台账。只刷新当前正开着的那个板块，五个都拉一遍纯属浪费
  // 有人给你留了反馈 / 把东西交给你审核
  on('notify:ping', () => notify.refresh());
  // 报销单有流转：导航徽标跟着变；页面开着就刷新列表和正在看的那张单
  on('expense:updated', () => expenses.refresh(view));
  // 采购同理：徽标、列表、正在看的那张单（每日交付提醒也会推这个事件）
  on('purchase:updated', () => purchases.refresh(view));
  // 有人给你发消息了
  on('chat:ping', () => chat.refreshSoon());

  on('board:updated', d => Promise.all([
    d?.board ? board.refresh(d.board, view) : null,
    // 详情页开着的时候别让它停在旧数据上（比如技术2 刚推了新的 AI 分析）
    view === 'clientDetail' && d?.board === 'clients' ? clientDetail.refresh() : null,
    // 台账一变漏斗就该跟着动 —— 漏斗的每一层都是从这些台账数出来的
    funnel.refresh(view),
    view === 'home' ? dashboard.refresh() : null,
  ]));

  // 轮询模式 / 切回前台 / 后端重启后的全量补拉
  on('sweep', () => Promise.all([
    touchPool(),
    formal.refresh(),
    stats.refresh(),
    drawer.isOpen() && drawer.current() ? drawer.syncComments(drawer.current().id) : null,
    BOARD_ORDER.includes(view) ? board.refresh(view, view) : null,
    funnel.refresh(view),
    dashboard.refresh(),
    expenses.refresh(view),
    purchases.refresh(view),
  ]));
}

function syncDrawerVote(d) {
  if (d?.id != null) drawer.syncVote(d.id, d.voteCount);
}

/** 所有一级视图。
    clientDetail 没有对应的导航按钮 —— 它是从客户档案点进去的二级页面，
    所以下面切视图时要单独处理它的 tab 高亮（客户档案那颗仍然亮着）。 */
const VIEWS = ['home', 'functionTree', 'pool', 'formal', 'stats', 'funnel', 'samples', 'collector', 'clientDetail', 'tagadmin', 'learning', 'expenses', 'purchases', ...BOARD_ORDER];

function go(next) {
  // 全局搜索只服务当前操作，不把上一页关键词带进下一个业务页面。
  search.reset();
  if (next === view) return;
  if (view === 'collector') lazyMods.collector?.leave();
  if (view === 'samples') lazyMods.samples?.leave();
  if (view === 'functionTree') lazyMods.functionTree?.leave();
  if (view === 'home') dashboard.leave();   // 离开首页时收掉专注模式、退出布局编辑
  view = next;
  for (const k of VIEWS) {
    $('#v-' + k).classList.toggle('on', k === next);
    // 客户详情页没有自己的导航按钮，跳过它；高亮留给「客户档案」
    const tab = $('#tab-' + k);
    if (tab) {
      const current = k === next;
      tab.classList.toggle('on', current);
      if (current) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
  }
  if (next === 'clientDetail') {
    const clientsTab = $('#tab-clients');
    clientsTab?.classList.add('on');
    clientsTab?.setAttribute('aria-current', 'page');
  }
  // 当前页面藏在某个分组里时，把组标题也点亮 —— 否则收起来之后看不出自己在哪
  for (const g of document.querySelectorAll('.navgrp')) {
    g.classList.toggle('active', !!g.querySelector('button.on'));
  }
  paintChrome(next);
  closeMobileNav();
  closeMobileSearch();
  $('#main').scrollTop = 0;

  if (next === 'stats') { stats.reset(); stats.render(); }
  if (next === 'home') dashboard.render();
  if (next === 'formal') formal.render();
  if (next === 'pool') pool.render();
  if (BOARD_ORDER.includes(next)) board.render(next);
  if (next === 'funnel') funnel.render();
  if (next === 'tagadmin') tagadmin.render();
  if (next in LAZY) showLazy(next);
  if (next === 'expenses') expenses.render();
  if (next === 'purchases') purchases.render();
}

/**
 * 跳到任意一条资料并打开它。
 *
 * 搜索结果、关联资料、客户详情里的案例链接都走这里 ——
 * 「能搜到但点不开」和没搜到差不多，所以跳转必须真的把那一条打开，
 * 而不是把人送到板块首页让他自己再找一遍。
 */
async function openAnywhere({ board: boardKey, entity, refId, filters, filterLabel }) {
  if (!boardKey) return;
  if (boardKey === 'expenses') {
    go('expenses');
    if (refId) expenses.openDetail(Number(refId));
    return;
  }
  if (boardKey === 'purchases') {
    go('purchases');
    if (refId) purchases.openDetail(Number(refId));
    return;
  }
  // 灵感和正式内容都在灵感库里，用抽屉打开而不是表格
  if (entity === 'idea' || boardKey === 'pool' || boardKey === 'formal') {
    go(boardKey === 'formal' ? 'formal' : 'pool');
    if (refId) drawer.openDrawer(Number(refId));
    return;
  }
  if (entity === 'client' || boardKey === 'clients') {
    if (refId) return openClient(Number(refId));
    if (filters) board.setContextFilter('clients', filters, filterLabel);
    go('clients');
    return;
  }
  go(boardKey);
  if (refId && BOARD_ORDER.includes(boardKey) && !await board.openRow(boardKey, refId)) {
    toast('info', '这条已经不在了，可能被删掉了');
  }
}

/** 打开客户详情页（任务 9） */
async function openClient(id) {
  go('clientDetail');
  await clientDetail.open(id);
}

function bind() {
  initModalAccessibility();
  account.bindMenu();
  importer.bind();

  // 工作台快捷入口：先切到目标板块，再复用该页面自己的新增逻辑。
  $('#v-home').addEventListener('click', e => {
    const study = e.target.closest('[data-dash-learning]');
    if (study) {
      e.preventDefault();
      openLearning(study.dataset.dashLearning);
      return;
    }
    const create = e.target.closest('[data-dash-create]');
    if (create) {
      e.preventDefault();
      go(create.dataset.dashCreate);
      setTimeout(createForCurrentView, 0);
      return;
    }
    if (e.target.closest('[data-dash-action="import"]')) {
      e.preventDefault();
      importer.open();
    }
  });
  // 按需加载的页面下载失败时的「重试」
  document.addEventListener('click', e => {
    const retry = e.target.closest('[data-lazy-retry]');
    if (!retry || retry.dataset.lazyRetry !== view) return;
    try { sessionStorage.setItem(LAZY_RETRY_KEY, view); } catch { /* 记不住就回首页，至少页面能用 */ }
    location.reload();
  });

  // 客户档案的行点击进详情页，不是直接弹编辑框 —— 
  // 任务 9 要的是「查看一个客户不用在多个模块来回找」，那得先有个能看的页面
  board.events.addEventListener('open-detail', e => openClient(e.detail.id));

  // 客户详情页上的动作
  clientDetail.events.addEventListener('back', () => go('clients'));
  clientDetail.events.addEventListener('edit', e => board.openEditById('clients', e.detail.id));
  clientDetail.events.addEventListener('goto-case', e =>
    openAnywhere({ board: 'cases', entity: 'case', refId: e.detail.id }));

  // 关联资料 / 客户详情里的「点开对面那一条」
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-goto]');
    if (!a || a.closest('#searchPop')) return;   // 搜索面板有自己的处理
    e.preventDefault();
    modal.close?.();
    board.closeEdit();
    openAnywhere({
      board: a.dataset.goto,
      entity: a.dataset.entity,
      refId: Number(a.dataset.ref),
      filters: a.dataset.stages ? { stages: a.dataset.stages } : null,
      filterLabel: a.dataset.filterLabel,
    });
  });

  // 导航。桌面是常驻侧栏，手机是抽屉；组标题只负责折叠自己的页面列表。
  initNavCollapse();
  document.querySelector('.nav').addEventListener('click', e => {
    const top = e.target.closest('.navtop');
    if (top) {
      const grp = top.closest('.navgrp');
      grp.classList.toggle('collapsed');
      top.setAttribute('aria-expanded', String(!grp.classList.contains('collapsed')));
      saveNavCollapse();
      paintNavTodo();
      return;
    }
    const b = e.target.closest('[data-go]');
    if (b) go(b.dataset.go);
  });

  $('#navToggle').addEventListener('click', () =>
    $('#appNav').classList.contains('mobile-open') ? closeMobileNav() : openMobileNav());
  $('#navClose').addEventListener('click', closeMobileNav);
  $('#navMask').addEventListener('click', closeMobileNav);
  $('#mobileSearchBtn').addEventListener('click', focusGlobalSearch);

  $('#miNotifications').addEventListener('click', () => {
    account.close();
    notify.toggle(true);
  });

  // 点搜索框以外收起手机搜索；桌面搜索本身始终留在顶栏。
  document.addEventListener('click', e => {
    if (!e.target.closest('.search') && !e.target.closest('#mobileSearchBtn')) closeMobileSearch();
  });

  // 灵感池卡片（投票 / 打开详情）
  pool.bind($('#poolGrid'));

  // 标签项很多，默认收起；一级分类和排序仍然常驻。
  // 这样首屏先看灵感，而不是先读两行筛选器。
  const poolFilterPanel = $('#poolFilterPanel');
  const poolFilterToggle = $('#poolFilterToggle');
  let poolExtraCount = 0;
  const paintPoolFilter = () => {
    const open = !poolFilterPanel.hidden;
    poolFilterToggle.classList.toggle('on', open || poolExtraCount > 0);
    poolFilterToggle.textContent = poolExtraCount
      ? `标签与来源 · ${poolExtraCount}`
      : (open ? '收起标签筛选' : '标签与来源筛选');
  };
  poolFilterToggle.addEventListener('click', () => {
    poolFilterPanel.hidden = !poolFilterPanel.hidden;
    paintPoolFilter();
  });

  // 灵感池的统一标签筛选（任务 6）。和客户档案、案例库用同一套字典和同一个组件
  tagfilter.mount($('#poolTagFilter'), {
    withSource: true,
    onChange: ({ tagIds, sourceType }) => {
      pool.filters.tagIds = tagIds;
      pool.filters.sourceType = sourceType;
      poolExtraCount = tagIds.length + (sourceType ? 1 : 0);
      paintPoolFilter();
      pool.render();
    },
  });

  // 筛选条：同组互斥，「我提的」可以反选
  $('#poolFilters').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const { f, v } = chip.dataset;
    if (f === 'scope') {
      // 「全部」和「我提的」是互斥的一组，任何时候必须有一个亮着
      for (const c of $('#poolFilters').querySelectorAll('.chip[data-f="scope"]')) c.classList.remove('on');
      chip.classList.add('on');
      pool.filters.mine = v === 'mine' ? '1' : '';
    } else if (f === 'category' && chip.classList.contains('on')) {
      // 分类没有「全部」这一项，所以再点一次选中的分类就是取消筛选。
      // 没有这个的话用户一旦点进某个分类就出不来了。
      chip.classList.remove('on');
      pool.filters.category = '';
    } else if (f === 'status') {
      // 「已转正式」是个可反选的视角：再点一次回到普通灵感池
      const on = chip.classList.toggle('on');
      pool.filters.status = on ? 'promoted' : 'pool';
    } else if (f === 'sort') {
      // 排序必须始终有一个选中，不允许取消
      for (const c of $('#poolFilters').querySelectorAll('.chip[data-f="sort"]')) c.classList.remove('on');
      chip.classList.add('on');
      pool.filters.sort = v;
    } else {
      for (const c of $('#poolFilters').querySelectorAll(`.chip[data-f="${f}"]`)) c.classList.remove('on');
      chip.classList.add('on');
      pool.filters[f] = v;
    }
    pool.render();
  });

  // 顶栏搜索现在是全局搜索：一个词跨灵感 / 需求 / 正式库 / 客户 / 案例 / 台账。
  // 原来它只筛灵感池 —— 那正是任务表里说的「每个页面单独搜」。
  // 灵感池自己的关键词筛选仍然在，只是不再占用这个入口。
  // 列表卡片跟着光标走的一圈柔光（09-24，样式在 soft.css）：全站一个监听，只记位置，不重绘
  document.addEventListener('pointermove', e => {
    const card = e.target.closest?.('.record-card, .exp-card, .cdcard, #poolGrid .idea-card');
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    pointerFx(e);
  }, { passive: true });
  document.addEventListener('mouseleave', () => pointerFx(null));
  // 按下时从指针位置荡开一圈水波纹（全站主要按钮）
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest?.(RIPPLE);
    if (!b || reduced() || b.disabled) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const w = document.createElement('span');
    w.className = 'fx-ripple';
    w.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(w);
    setTimeout(() => w.remove(), 650);
  });
  $('#lookBtn').addEventListener('click', openLook);
  bindPalette(openAnywhere);
  search.bind();
  search.events.addEventListener('goto', e => openAnywhere(e.detail));
  // 搜索框里的命令（09-24）：没字时列出常用的，打字时名字对得上的排在搜索结果上面
  search.setCommands(() => {
    const pages = [...document.querySelectorAll('#appNav [data-go]')].map(b => {
      const name = (b.querySelector('.nav-label')?.textContent || b.textContent).trim();
      return { group: '跳转', label: `打开「${name}」`, keywords: name, icon: ICON.layers, featured: ['home', 'pool', 'clients', 'reports'].includes(b.dataset.go), run: () => go(b.dataset.go) };
    });
    const create = (label, target, keywords) => ({ group: '新建', label, keywords, icon: ICON.plus, featured: true,
      run: () => { go(target); setTimeout(createForCurrentView, 0); } });
    const looks = (window.IdeaHubLook?.FAMILIES || []).map(f => ({ group: '外观',
      label: f.id === 'default' ? '配色恢复默认（跟随系统）' : `配色换成「${f.name}」${f.mode === 'dark' ? '（深色）' : ''}`,
      keywords: `配色 主题 ${f.name} ${f.mode === 'dark' ? '深色 暗色' : '浅色'}`,
      icon: ICON.sparkle, run: () => { window.IdeaHubLook.set({ family: f.id, mine: '' }); setTheme(f.mode || 'auto'); } }));
    // 自己存的「我的配色」也能一下切过去
    looks.push(...savedLooks().map(m => ({ group: '外观', label: `配色换成「${m.name}」（我的配色）`, keywords: `配色 主题 我的 自定义 ${m.name}`,
      icon: ICON.sparkle, run: () => useSaved(m.id) })));
    return [
      create('记一条灵感', 'pool', '新建 灵感 想法'), create('新增客户', 'clients', '新建 客户'),
      { group: '新建', label: '智能导入资料', keywords: '导入 上传', icon: ICON.download, run: () => importer.open() },
      { group: '首页', label: '专注模式（25 分钟）', keywords: '专注 番茄 计时', hint: 'F', icon: ICON.clock, featured: true,
        run: () => { go('home'); setTimeout(() => dashboard.command('focus'), 60); } },
      ...(innerWidth > 1180 ? [{ group: '首页', label: '编辑首页布局', keywords: '布局 排版 拖动', hint: 'E', icon: ICON.layers,
        run: () => { go('home'); setTimeout(() => dashboard.command('edit'), 60); } }] : []),
      { group: '帮助', label: '快捷键一览', keywords: '快捷键 键盘 按键 帮助', hint: '?', icon: ICON.sparkle, run: openShortcuts },
      { group: '首页', label: '新功能介绍', keywords: '引导 教程 帮助 新功能 介绍', icon: ICON.sparkle, run: () => { go('home'); startTour(); } },
      { group: '外观', label: '配色与外观…', keywords: '主题 颜色 配色 圆角 密度 动效', icon: ICON.sparkle, featured: true, run: openLook },
      { group: '外观', label: '切换到深色', keywords: '深色 暗色 夜间 主题', icon: ICON.eye, run: () => setTheme('dark') },
      { group: '外观', label: '切换到浅色', keywords: '浅色 亮色 主题', icon: ICON.eye, run: () => setTheme('light') },
      { group: '外观', label: '外观跟随系统', keywords: '跟随系统 自动 主题', icon: ICON.eye, run: () => setTheme('auto') },
      ...looks,
      ...pages,
    ];
  });
  importer.events.addEventListener('goto', e => openAnywhere(e.detail));
  importer.events.addEventListener('committed', e => {
    const boards = new Set(e.detail.items.map(x => x.board));
    if (boards.has('pool')) pool.render();
    if (BOARD_ORDER.includes(view) && boards.has(view)) board.render(view);
  });

  // 页面主动作：随当前板块变化，避免用户在客户页仍只看到「提交灵感」。
  $('#btnNew').addEventListener('click', createForCurrentView);
  $('#btnSubmit').addEventListener('click', modal.submit);
  $('#fTitle').addEventListener('input', modal.onTitleInput);
  bindAccessibleCheck($('#anon'));
  $('#dupe').addEventListener('click', e => {
    const a = e.target.closest('[data-open]');
    if (a) { modal.close(); drawer.openDrawer(Number(a.dataset.open)); }
  });
  $('#fBody').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') modal.submit();
  });

  // 抽屉
  $('#dVote').addEventListener('click', drawer.voteHere);
  $('#btnComment').addEventListener('click', drawer.postComment);
  bindAccessibleCheck($('#cmtAnon'));
  $('#dStages').addEventListener('click', drawer.onStageClick);
  $('#btnBdSave').addEventListener('click', board.saveEdit);
  $('#btnBdExpand').addEventListener('click', board.toggleEditSize);
  $('#btnSaveProject').addEventListener('click', drawer.saveProject);
  $('#dCmtInput').addEventListener('keydown', e => { if (e.key === 'Enter') drawer.postComment(); });
  $('#btnAdopt').addEventListener('click', drawer.requestAdopt);
  $('#btnIdeaDel').addEventListener('click', drawer.removeCurrent);
  drawer.events.addEventListener('deleted', () => Promise.all([pool.render(), formal.render()]));
  $('#btnReject').addEventListener('click', drawer.requestReject);

  // 评审弹窗
  $('#btnAdoptConfirm').addEventListener('click', review.confirmAdopt);
  $('#btnRejectConfirm').addEventListener('click', review.confirmReject);
  $('#rejectReason').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') review.confirmReject();
  });
  // 抽屉关掉的同时立刻把遮罩留住，否则中间会闪一下白
  const handoff = fn => e => { drawer.closeDrawer(); $('#mask').classList.add('on'); fn(e.detail); };
  drawer.events.addEventListener('want-adopt', handoff(review.openAdopt));
  drawer.events.addEventListener('want-reject', handoff(review.openReject));

  // 关闭：遮罩、关闭按钮、Esc
  $('#mask').addEventListener('click', closeAll);
  document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeAll(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab' && trapModalFocus(e)) return;
    if (e.key === 'Escape') closeAll();
    // Ctrl K / ⌘K 打开屏幕中间的命令面板（09-25 按原型）；「/」仍是直接聚焦顶栏搜索框
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      togglePalette();
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey &&
        !e.target.closest('input,textarea,select,[contenteditable]')) {
      e.preventDefault();
      focusGlobalSearch();
    }
    // 「?」打开快捷键一览（09-26）；打字时不触发
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey &&
        !e.target.closest('input,textarea,select,[contenteditable]')) {
      e.preventDefault();
      openShortcuts();
    }
  });

  // 搜索框里的快捷键提示：Mac 上是 ⌘K，其余是 Ctrl K（上面的 keydown 两个都认）
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
  if (isMac) $('#searchKbd').textContent = '⌘K';

  // 手机上页面说明先收成一行（soft.css），点一下展开 / 收起。只有真被截断了才响应，免得点一行字没反应也没意义
  document.addEventListener('click', e => {
    const sub = e.target.closest('.page-head .sub');
    if (!sub || !matchMedia('(max-width:560px)').matches) return;
    if (sub.classList.contains('open') || sub.scrollHeight > sub.clientHeight + 1) sub.classList.toggle('open');
  });

  // 视图之间的联动
  modal.events.addEventListener('created', e => pool.render({ flashId: e.detail.id }));
  drawer.events.addEventListener('vote', e =>
    pool.patchVote(e.detail.id, e.detail.voteCount, e.detail.voted, { hotScore: e.detail.hotScore }));
  drawer.events.addEventListener('comment', e => pool.patchComment(e.detail.id, e.detail.count));
  // 点消息 → 跳到对应板块，并把那条记录直接打开。
  // 只把人送到板块首页、让他自己去列表里找，等于没实现「点击打开」。
  notify.events.addEventListener('goto', async e => {
    const { board: board_, refId } = e.detail;
    // 报销单不是台账，用自己的详情弹窗打开
    if (board_ === 'expenses') {
      go('expenses');
      if (refId) expenses.openDetail(Number(refId));
      return;
    }
    // 采购同理
    if (board_ === 'purchases') {
      go('purchases');
      if (refId) purchases.openDetail(Number(refId));
      return;
    }
    go(board_);
    // board.openRow 会挨个小板块找 —— 「等你审核」的那条不在默认的「我提交的」里
    if (refId && !await board.openRow(board_, refId)) {
      toast('info', '这条已经不在了，可能被删掉了');
    }
  });

  // 进度改了，正式库那一行的进度条要跟着动。
  // 这里必须绕开 refresh() 的「抽屉开着就跳过」—— 保存的那一刻抽屉正开着，
  // 走 refresh() 会被自己挡掉，用户看到的就是「保存了但界面没反应」。
  drawer.events.addEventListener('project', () => formal.render());
  review.events.addEventListener('rejected', () => pool.render());
  review.events.addEventListener('adopted', async e => {
    await pool.flyAway(e.detail.id);       // 卡片先飞走
    formal.markFlash(e.detail.code);
    // 庆祝动画和后台刷新并行跑：动画在演的时候顺便把两个列表拉好，
    // 演完就是最新的，不会先弹完再卡一下。
    await Promise.all([
      celebrateAdopt(e.detail),
      pool.render(),
      formal.render(),
    ]);
    toast('ok', `已采纳 · 编号 ${e.detail.code} · 负责人 ${e.detail.owner}`);
  });
}

function bindAccessibleCheck(node) {
  const toggle = () => {
    const checked = node.classList.toggle('on');
    node.setAttribute('aria-checked', String(checked));
  };
  node.addEventListener('click', toggle);
  node.addEventListener('keydown', event => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    toggle();
  });
}

function initModalAccessibility() {
  let lastOutsideFocus = document.activeElement;
  const returnFocus = new WeakMap();
  document.addEventListener('focusin', event => {
    if (!event.target.closest('.modal,.confirm-layer')) lastOutsideFocus = event.target;
  });

  for (const modalElement of document.querySelectorAll('.modal')) {
    let wasOpen = modalElement.classList.contains('on');
    new MutationObserver(() => {
      const open = modalElement.classList.contains('on');
      if (open === wasOpen) return;
      wasOpen = open;
      if (open) {
        returnFocus.set(modalElement, lastOutsideFocus);
        requestAnimationFrame(() => {
          if (!modalElement.classList.contains('on') || modalElement.contains(document.activeElement)) return;
          modalFocusable(modalElement)[0]?.focus();
        });
        return;
      }
      const target = returnFocus.get(modalElement);
      returnFocus.delete(modalElement);
      queueMicrotask(() => {
        if (document.querySelector('.modal.on,.confirm-layer.on')) return;
        if (target?.isConnected && target.getClientRects().length) target.focus();
        else document.querySelector('#appNav [aria-current="page"],#btnNew')?.focus();
      });
    }).observe(modalElement, { attributes: true, attributeFilter: ['class'] });
  }
}

function modalFocusable(dialog) {
  return [...dialog.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )].filter(node => !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
}

function trapModalFocus(event) {
  if (document.querySelector('.confirm-layer.on')) return false;
  const dialogs = [...document.querySelectorAll('.modal.on')];
  const dialog = dialogs.at(-1);
  if (!dialog) return false;
  const focusable = modalFocusable(dialog);
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return true;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

function closeAll() {
  closeMobileNav();
  closeMobileSearch();
  notify.close();
  chat.closePick();
  chat.closeSetup();
  // 聊天面板不跟着 Esc / 遮罩一起关：它是常驻工具，不是弹窗，
  // 关掉正在打的字比留着更烦人。只有点它自己的 ✕ 才收。
  modal.close();
  review.close();
  account.close();
  importer.close();
  board.closeEdit();
  bench.close();
  drawer.closeDrawer();
  // 放在最后：提交中不允许关闭时，它们要把前面已经被收起的遮罩补回来
  purchases.close();
  expenses.close();
  // 抽屉开着的时候被跳过的表格刷新，现在补上
  formal.flush();
}

boot().catch(err => {
  console.error(err);
  // 没登录时 api.js 已经在跳转登录页了，这里再弹一条「初始化失败」纯属吓人
  if (err.status === 401 || err.message === '请先登录') return;
  toast('info', '初始化失败：' + err.message);
});
