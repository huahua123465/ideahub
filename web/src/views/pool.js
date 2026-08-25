/** 灵感池：卡片墙 */
import { api } from '../api.js';
import { avatarColor, initial, fromNow, esc, PILL, catColor, $ } from '../util.js';
import { countTo, pulse, ring, skeletonCards, reduced } from '../anim.js';
import { toast } from '../toast.js';
import { openDrawer } from './drawer.js';
import { ICON, STATUS_ICON } from '../icons.js';

/**
 * 灵感池的筛选条件。
 *
 * 没有 status 这一项是有意的：池子里就是 pending + reviewing，界面上不再按状态筛。
 * 原来那两个「待评审 / 评审中」的按钮已经去掉 —— 改成「人人可评审」之后
 * reviewing 就没有任何入口能设置了，那个按钮永远筛出空列表；
 * 而「待评审」筛出来的又恰好是池子的全部，和「全部」一模一样。
 */
export const filters = {
  category: '', mine: '', sort: 'hot', q: '',
  // 统一标签筛选（任务 6）和「已转正式」视角（任务 7）
  tagIds: [], status: 'pool', sourceType: '',
};

/** 发给 /api/ideas 的查询参数。render 和 patch 必须用同一份，
    否则筛选完再来一次后台推送，列表会悄悄换回没筛选的样子。 */
const queryOf = () => ({
  status: filters.status,
  category: filters.category,
  mine: filters.mine,
  sort: filters.sort,
  q: filters.q,
  tagIds: filters.tagIds.join(','),
  sourceType: filters.sourceType,
});
export let items = [];

/**
 * 热度条的分母：按当前这一屏的最高热度归一化。
 * 用全局最大值的话，一个爆款会把其它所有卡片压成一条看不见的线。
 *
 * 乘 1.2 是留出余量。不留的话榜首那张卡恒等于 100%，投票再多热度条也纹丝不动 ——
 * 而榜首恰恰是大家最常点的那张，「点了支持热度没反应」就是这么来的。
 */
const HEAD_ROOM = 1.2;
let hotMax = 1;
const heatPct = hot => Math.round((hot || 0) / hotMax * 100);

/** 后台刷新时发现的新灵感。不直接插进列表 —— 正在读的东西被挤走是最糟的体验，
    攒在这里由顶部的胶囊提示，用户点了才重排。 */
const pendingNew = new Set();

/** 正在投票（乐观更新已经画上去、请求还没回来）的卡片。
    后台刷新撞进来会拿服务端旧值盖掉乐观值、请求回来又改回去，数字闪两下。 */
const inFlight = new Set();

/** 正在演动画的卡片别去动它 */
const busy = el => el.classList.contains('adopting')
               || el.classList.contains('enter')
               || el.classList.contains('flash');

/** 加一个一次性的动画 class，放完自己摘掉。
    不摘的话 busy() 会永远认为这张卡在演动画，从此不再接受任何后台更新。 */
function once(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

export function cardHTML(x, index = 0) {
  const [pc, pt] = PILL[x.status] || PILL.pending;
  const cc = catColor(x.category);
  const ranked = filters.sort === 'hot' && filters.status === 'pool';
  const serial = String(index + 1).padStart(2, '0');
  const rankClass = ranked && index < 3 ? ' idea-card-top' : '';
  return `<article class="card idea-card${rankClass}" data-id="${x.id}"
      style="--cat:${cc};--i:${Math.min(index, 8)}" tabindex="0">
    <header class="idea-card-head">
      <span class="idea-index">${ranked ? `${ICON.flame} 热榜` : 'IDEA'} <b>${serial}</b></span>
      <div class="idea-card-meta">
        <span class="cat"><i class="dot"></i>${esc(x.category)}</span>
        <span class="pill ${pc}">${STATUS_ICON[x.status] || ''}${pt}</span>
      </div>
    </header>
    <div class="idea-card-copy">
      <h3>${esc(x.title)}</h3>
      <p>${esc(x.content)}</p>
    </div>
    <div class="tags idea-tags">${x.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <footer class="card-foot idea-card-foot">
      <span class="who idea-author">
        <span class="av" style="background:${avatarColor(x.author.name)}">${esc(initial(x.author.name))}</span>
        <span class="idea-author-copy"><b>${esc(x.author.name)}</b><small>${fromNow(x.createdAt)}提出</small></span>
      </span>
      <span class="idea-signal" aria-hidden="true">
        <small>正在形成共识</small>
        <b><span class="signal-votes">${x.voteCount}</span> 人支持</b>
        <em><span class="signal-comments">${x.commentCount}</span> 条讨论</em>
      </span>
      <span class="acts idea-engagement">
        <span class="cmt" title="${x.commentCount} 条讨论">${ICON.comment}<span class="cn">${x.commentCount}</span></span>
        <button class="vote${x.voted ? ' voted' : ''}" data-vote="${x.id}"
          aria-label="支持这条灵感" aria-pressed="${x.voted ? 'true' : 'false'}">
          <span class="arrow">${ICON.up}</span><span class="vote-label">支持</span><span class="vn">${x.voteCount}</span></button>
      </span>
    </footer>
  </article>`;
}

/** 空态分两种：池子里真的一条都没有，和「筛完之后没结果」。
    后者提示用户去清筛选，而不是劝他再提一条 —— 他要找的东西可能就在筛选外面。 */
const EMPTY_FILTERED = `
  <div class="empty">
    <svg viewBox="0 0 120 96" aria-hidden="true">
      <circle cx="54" cy="44" r="22"/><path d="M70 60l18 18"/>
      <path d="M46 44h16" class="ray"/>
    </svg>
    <b>没有匹配的灵感</b>
    <span>换个关键词，或者把筛选条件清掉再看看。</span>
    <button class="btn btn-ghost" data-clear>清空筛选</button>
  </div>`;

const EMPTY_HTML = `
  <div class="empty">
    <svg viewBox="0 0 120 96" aria-hidden="true">
      <path d="M60 14c-13 0-23 10-23 22 0 8 4 13 8 17 2 3 3 5 3 8h24c0-3 1-5 3-8 4-4 8-9 8-17 0-12-10-22-23-22Z"/>
      <path d="M50 71h20M53 79h14"/>
      <path d="M60 4v6M31 16l4 4M89 16l-4 4M18 44h6M96 44h6" class="ray"/>
    </svg>
    <b>这里还没有灵感</b>
    <span>空池子没人愿意当第一个提的人 —— 不如你先来一条？</span>
    <button class="btn btn-primary" data-first>提第一条</button>
  </div>`;

export async function render({ flashId, flashIds } = {}) {
  const grid = $('#poolGrid');
  const flash = new Set(flashIds || []);
  if (flashId) flash.add(flashId);

  // 先铺骨架屏。以前这里是空白，网络稍慢就像页面坏了。
  if (!grid.children.length || grid.querySelector('.empty')) grid.innerHTML = skeletonCards(6);

  const data = await api.ideas(queryOf());
  items = data.items;
  hotMax = Math.max(1, ...items.map(i => i.hotScore || 0)) * HEAD_ROOM;
  $('#poolN').textContent = data.total;

  const filtered = !!(filters.q || filters.category || filters.mine
                   || filters.tagIds.length || filters.sourceType || filters.status !== 'pool');
  grid.classList.remove('pool-ready');
  grid.innerHTML = items.length ? items.map(cardHTML).join('')
    : (filtered ? EMPTY_FILTERED : EMPTY_HTML);
  // Motion Primitives 式的轻量错峰进入。只在整页重排时触发，后台增量 patch 不动 DOM。
  requestAnimationFrame(() => grid.classList.add('pool-ready'));

  // 重排完了，攒着的新灵感已经在列表里，胶囊可以收了
  pendingNew.clear();
  showPill();

  for (const fid of flash) {
    const el = grid.querySelector(`.card[data-id="${fid}"]`);
    if (!el) continue;
    once(el, 'enter', 450);
    setTimeout(() => once(el, 'flash', 1600), 120);
  }
}

/**
 * 静默增量刷新：只改数字，不动顺序，不重建 DOM。
 *
 * 全量 render() 会把 #poolGrid 整个 innerHTML 换掉 —— 键盘焦点、hover、正在演的动画
 * 全部作废，按热度排序时卡片还会自己换位置。所以后台推送走的是这条路径，
 * 真正的重排只在用户主动点胶囊/改筛选时才发生。
 */
export async function patch() {
  const grid = $('#poolGrid');
  // 空态和骨架屏没什么交互状态可保，直接全量，省得再写一套空态切换
  if (!grid.children.length || grid.querySelector('.empty') || grid.querySelector('.sk')) return render();

  const data = await api.ideas(queryOf());
  $('#poolN').textContent = data.total;

  const seen = new Set();
  for (const x of data.items) {
    seen.add(x.id);
    const el = grid.querySelector(`.card[data-id="${x.id}"]`);
    if (el) applyCard(el, x);
    else if (!items.some(i => i.id === x.id)) pendingNew.add(x.id);
  }

  // DOM 里有、结果里没有了 = 被采纳/否决/归档，出池了。
  // 不摘掉：把用户正在看的卡片抽走，比让它多留一会儿更糟。淡化一下，
  // 真正的清除留给下一次全量 render()。
  for (const el of grid.querySelectorAll('.card[data-id]')) {
    const id = Number(el.dataset.id);
    if (seen.has(id) || busy(el) || inFlight.has(id)) continue;
    el.classList.add('is-stale');
  }

  // 本地缓存跟着更新，但保持原顺序 —— items 是 doVote 乐观更新的基准值
  for (const it of items) {
    const fresh = data.items.find(d => d.id === it.id);
    if (fresh && !inFlight.has(it.id)) Object.assign(it, fresh);
  }

  showPill();
}

/** 把一张已经在 DOM 里的卡片更新到最新数据。顺序和节点本身都不动。 */
function applyCard(el, x) {
  if (busy(el) || inFlight.has(x.id)) return;
  el.classList.remove('is-stale');

  patchVote(x.id, x.voteCount, x.voted, { animate: false });
  patchComment(x.id, x.commentCount);

  const [pc, pt] = PILL[x.status] || PILL.pending;
  const pill = el.querySelector('.pill');
  if (pill && pill.textContent.trim() !== pt) {
    pill.className = 'pill ' + pc;
    pill.innerHTML = (STATUS_ICON[x.status] || '') + esc(pt);
  }

  const h3 = el.querySelector('h3');
  if (h3 && h3.textContent !== x.title) h3.textContent = x.title;
  const body = el.querySelector('p');
  if (body && body.textContent !== x.content) body.textContent = x.content;

  // 热度条：分母沿用当前这一屏的 hotMax，重算会让所有卡片的条一起跳
  paintHeat(el, x.hotScore);
}

function showPill() {
  const el = $('#poolNewPill');
  if (!el) return;
  const n = pendingNew.size;
  el.hidden = n === 0;
  if (n) el.textContent = `有 ${n} 条新灵感 · 点击查看`;
}

/** 只更新一张卡片的票数，不整页重渲染 —— 避免用户正在看的列表跳动 */
export function patchVote(id, voteCount, voted, { animate = true, hotScore } = {}) {
  const it = items.find(i => i.id === id);
  if (it) {
    it.voteCount = voteCount;
    it.voted = voted;
    if (Number.isFinite(hotScore)) it.hotScore = hotScore;
  }
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;

  // 热度条跟着一起动。以前这里只改票数、不碰热度条，
  // 点完支持热度一动不动，看起来就像投票和热度是两件互不相干的事。
  paintHeat(card, Number.isFinite(hotScore) ? hotScore : it?.hotScore);

  const btn = card.querySelector('[data-vote]');
  if (!btn) return;
  btn.classList.toggle('voted', voted);
  btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
  const n = btn.querySelector('.vn');
  const signal = card.querySelector('.signal-votes');
  if (signal) signal.textContent = voteCount;
  if (animate) { countTo(n, voteCount, { ms: 300 }); pulse(btn, 'bump', 420); }
  else n.textContent = voteCount;
}

/**
 * 把一张卡片的热度条画到对应宽度。
 *
 * 热度不足 5% 时 cardHTML 压根不画 .heat 元素，所以这里要能把它补出来 ——
 * 一条冷灵感被投上来之后应该长出热度条，而不是空着等下一次整页重渲染。
 */
function paintHeat(card, hot) {
  // 热榜编号已经表达热度，支持数又表达共识；第三套热度条只会制造视觉噪音。
  // 保留函数入口，增量更新逻辑无需分叉。
  void card; void hot;
}

export function patchComment(id, count) {
  const it = items.find(i => i.id === id);
  if (it) it.commentCount = count;
  const el = document.querySelector(`.card[data-id="${id}"] .cmt`);
  const n = el?.querySelector('.cn');
  if (n) n.textContent = count;
  else if (el) el.innerHTML = `${ICON.comment}<span class="cn">${count}</span>`;
  const signal = document.querySelector(`.card[data-id="${id}"] .signal-comments`);
  if (signal) signal.textContent = count;
}

/** 采纳后把卡片飞走再从列表移除 */
export function flyAway(id) {
  return new Promise(resolve => {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (!el || reduced()) return resolve();
    el.classList.add('adopting');
    setTimeout(resolve, 780);
  });
}

export function bind(root) {
  // Magic Card 式鼠标聚光：只更新当前卡片的两个 CSS 变量，不创建额外 DOM。
  // 触屏和“减少动态效果”下完全不启用，卡片仍是普通静态内容。
  if (matchMedia('(pointer:fine)').matches && !reduced()) {
    let raf = 0, target = null, clientX = 0, clientY = 0;
    root.addEventListener('pointermove', e => {
      target = e.target.closest('.idea-card');
      if (!target) return;
      clientX = e.clientX; clientY = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        const r = target?.getBoundingClientRect();
        if (r) {
          target.style.setProperty('--mx', `${clientX - r.left}px`);
          target.style.setProperty('--my', `${clientY - r.top}px`);
        }
        raf = 0;
      });
    });
  }

  root.addEventListener('click', async e => {
    if (e.target.closest('[data-first]')) return document.querySelector('#btnNew').click();
    if (e.target.closest('[data-clear]')) return clearFilters();

    const voteBtn = e.target.closest('[data-vote]');
    if (voteBtn) {
      e.stopPropagation();
      return doVote(Number(voteBtn.dataset.vote), voteBtn);
    }
    const card = e.target.closest('.card[data-id]');
    if (card) openDrawer(Number(card.dataset.id), items.find(i => i.id === Number(card.dataset.id)));
  });

  // 顶部的「有 N 条新灵感」胶囊：点了才重排列表
  $('#poolNewPill').addEventListener('click', async () => {
    const fresh = [...pendingNew];
    $('#main').scrollTop = 0;
    await render({ flashIds: fresh });
  });

  // 卡片能用键盘打开 —— 有了 tabindex 就得有回车
  root.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card[data-id]');
    if (!card) return;
    e.preventDefault();
    openDrawer(Number(card.dataset.id), items.find(i => i.id === Number(card.dataset.id)));
  });
}

/**
 * 投票走乐观更新：先动起来，再发请求，失败回滚。
 * 以前是 await 完才有反应，网络一慢点了跟没点一样，用户会连点好几次。
 */
async function doVote(id, btn) {
  const it = items.find(i => i.id === id);
  const before = { voteCount: it?.voteCount ?? 0, voted: !!it?.voted };
  const guess = { voted: !before.voted, voteCount: before.voteCount + (before.voted ? -1 : 1) };

  // 请求飞在路上的这段时间里，后台刷新必须绕开这张卡，
  // 否则服务端旧值会盖掉刚画上去的乐观值，请求回来再改回来 —— 数字闪两下
  inFlight.add(id);
  patchVote(id, guess.voteCount, guess.voted);
  if (guess.voted) ring(btn);

  try {
    const r = await api.vote(id);
    inFlight.delete(id);
    // 以服务端为准。并发下别人也投了的话，这里会把数字纠正过来。
    // hotScore 同样以服务端为准 —— 热度公式只有数据库里那一份
    patchVote(id, r.voteCount, r.voted, { animate: r.voteCount !== guess.voteCount, hotScore: r.hotScore });
  } catch (err) {
    inFlight.delete(id);
    patchVote(id, before.voteCount, before.voted, { animate: false });
    toast('info', err.message || '投票失败，请重试');
  }
}

/** 清空筛选：把 chip 的选中态和搜索框一起复位，只有排序保持不动 */
function clearFilters() {
  Object.assign(filters, { category: '', mine: '', q: '', tagIds: [], status: 'pool', sourceType: '' });
  const box = $('#poolFilters');
  for (const c of box.querySelectorAll('.chip')) {
    if (c.dataset.f !== 'sort') c.classList.toggle('on', c.dataset.f === 'scope' && c.dataset.v === '');
  }
  $('#q').value = '';
  render();
}
