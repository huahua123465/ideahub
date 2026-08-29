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
import { BOARD_ORDER } from './boards.js';
import * as search from './views/search.js';
import * as clientDetail from './views/client.js';
import * as tagadmin from './views/tagadmin.js';
import * as tagfilter from './views/tagfilter.js';
import * as importer from './views/importer.js';
import * as dashboard from './views/dashboard.js';
import * as learning from './views/learning.js';
import * as collector from './views/collector.js';
import * as samples from './views/samples.js';
import { initMotion } from './motion.js';

let view = 'home';

/**
 * 顶部只显示「我现在在哪」和「此页最常用的动作」。
 * 业务模块已经从 3 个长到 14 个，继续让全站按钮永远写着「提交灵感」会让人误以为
 * 客户、作品、交付页都只是灵感库的附属页。
 */
const CHROME = {
  home:         { group: '总览', title: '今日工作台' },
  pool:         { group: '市场与内容', title: '灵感池',   create: '提交灵感' },
  demands:      { group: '市场与内容', title: '用户需求', create: '新增需求' },
  formal:       { group: '市场与内容', title: '正式库',   create: '提交灵感' },
  persona:      { group: '内容运营', title: '真人作品', create: '新增作品' },
  matrix:       { group: '内容运营', title: '矩阵作品', create: '新增作品' },
  live:         { group: '内容运营', title: '真人直播', create: '新增直播' },
  sales:        { group: '销售与客户', title: '销售转化', create: '新增规则' },
  clients:      { group: '销售与客户', title: '客户档案', create: '新增客户' },
  clientDetail: { group: '销售与客户', title: '客户详情' },
  delivery:     { group: '交付与案例', title: '后端交付', create: '新增交付项' },
  cases:        { group: '交付与案例', title: '案例库', create: '新增案例' },
  reports:      { group: '团队', title: '工作提交', create: '提交工作' },
  tagadmin:     { group: '团队', title: '标签与对接' },
  funnel:       { group: '数据', title: '数据漏斗' },
  stats:        { group: '数据', title: '统计看板' },
  collector:    { group: '数据', title: '内容采集' },
  samples:      { group: '数据', title: '样本库' },
  learning:     { group: '学习中心', title: '站内学习' },
};

function paintChrome(next = view) {
  const c = CHROME[next] || { group: 'IdeaHub', title: '团队业务工作台' };
  $('#pageGroup').textContent = c.group;
  $('#pageContext').textContent = c.title;
  document.title = `${c.title} · IdeaHub`;

  const create = $('#btnNew');
  $('#btnNewLabel').textContent = c.create || '';
  create.classList.toggle('is-hidden', !c.create);
  create.setAttribute('aria-hidden', c.create ? 'false' : 'true');

  for (const g of document.querySelectorAll('.navgrp')) {
    g.classList.toggle('active', !!g.querySelector('button.on'));
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
  if (BOARD_ORDER.includes(view)) {
    document.querySelector(`#v-${view} .bd-add`)?.click();
    return;
  }
  // 正式库的内容也来自灵感池，不能在这里凭空新建一条正式记录。
  if (view === 'pool' || view === 'formal') modal.open();
}

async function boot() {
  initMotion();
  // HTML 里只放了 data-ico 占位，图标本体在 icons.js（模块，HTML 直接取不到）
  for (const el of document.querySelectorAll('[data-ico]')) {
    el.innerHTML = ICON[el.dataset.ico] || '';
  }

  await probe();

  const me = await api.me();
  drawer.setMe(me);
  account.setMe(me);
  board.setMe(me);
  chat.setMe(me);
  tagadmin.setMe(me);
  dashboard.setMe(me);
  collector.setMe(me);
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
  await Promise.all([dashboard.render(), pool.render(), formal.render()]);

  // 页面从此自己保持最新：后端推事件，连不上就退回轮询
  notify.bind();
  notify.refresh();
  chat.bind();
  chat.refresh();
  alertBox.bind();
  // 只读一下当前权限，不在这里申请 —— 申请必须由用户点击触发
  // （消息面板顶部那条「开启桌面通知」），否则 Edge 的静默通知请求会把它吞掉。
  // 没开启时仍有标题未读数 + 提示音 + favicon 红点兜底。
  alertBox.initSystem();

  bindLive();
  live.start();
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
  ]));
}

function syncDrawerVote(d) {
  if (d?.id != null) drawer.syncVote(d.id, d.voteCount);
}

/** 所有一级视图。
    clientDetail 没有对应的导航按钮 —— 它是从客户档案点进去的二级页面，
    所以下面切视图时要单独处理它的 tab 高亮（客户档案那颗仍然亮着）。 */
const VIEWS = ['home', 'pool', 'formal', 'stats', 'funnel', 'samples', 'collector', 'clientDetail', 'tagadmin', 'learning', ...BOARD_ORDER];

function go(next) {
  // 全局搜索只服务当前操作，不把上一页关键词带进下一个业务页面。
  search.reset();
  if (next === view) return;
  if (view === 'collector') collector.leave();
  if (view === 'samples') samples.leave();
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
  if (next === 'learning') learning.render();
  if (next === 'collector') collector.render();
  if (next === 'samples') samples.render();
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
  account.bindMenu();
  importer.bind();

  // 工作台快捷入口：先切到目标板块，再复用该页面自己的新增逻辑。
  $('#v-home').addEventListener('click', e => {
    const study = e.target.closest('[data-dash-learning]');
    if (study) {
      e.preventDefault();
      learning.setSection(study.dataset.dashLearning);
      go('learning');
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
  learning.events.addEventListener('back', () => go('home'));

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
  document.querySelector('.nav').addEventListener('click', e => {
    const top = e.target.closest('.navtop');
    if (top) {
      const grp = top.closest('.navgrp');
      grp.classList.toggle('collapsed');
      top.setAttribute('aria-expanded', String(!grp.classList.contains('collapsed')));
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
  search.bind();
  search.events.addEventListener('goto', e => openAnywhere(e.detail));
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
  $('#anon').addEventListener('click', e => e.currentTarget.classList.toggle('on'));
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
  $('#cmtAnon').addEventListener('click', e => e.currentTarget.classList.toggle('on'));
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
    if (e.key === 'Escape') closeAll();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusGlobalSearch();
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey &&
        !e.target.closest('input,textarea,select,[contenteditable]')) {
      e.preventDefault();
      focusGlobalSearch();
    }
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

function closeAll() {
  closeMobileNav();
  closeMobileSearch();
  notify.close();
  chat.closePick();
  // 聊天面板不跟着 Esc / 遮罩一起关：它是常驻工具，不是弹窗，
  // 关掉正在打的字比留着更烦人。只有点它自己的 ✕ 才收。
  modal.close();
  review.close();
  account.close();
  importer.close();
  board.closeEdit();
  bench.close();
  drawer.closeDrawer();
  // 抽屉开着的时候被跳过的表格刷新，现在补上
  formal.flush();
}

boot().catch(err => {
  console.error(err);
  // 没登录时 api.js 已经在跳转登录页了，这里再弹一条「初始化失败」纯属吓人
  if (err.status === 401 || err.message === '请先登录') return;
  toast('info', '初始化失败：' + err.message);
});
