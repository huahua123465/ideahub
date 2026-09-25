/**
 * 今日工作台。
 *
 * IdeaHub 已经不只是灵感池。这个首页不再重复展示“系统里一共有多少条”，
 * 而是把需要处理、需要跟进和可以继续沉淀的事情放到登录后的第一屏。
 */
import { api } from '../api.js';
import { skeleton, countTo, reduced } from '../anim.js';
import { esc, $, avatarColor, initial } from '../util.js';
import { ICON } from '../icons.js';
import { toast } from '../toast.js';
import { confirmAction } from '../confirm.js';
import { maybeStartTour } from '../tour.js';

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
/**
 * 「每日总结」默认收成一行（状态 + 「写日报」按钮），点开才是表单：
 * 大多数人打开首页是来看待办的，原来一整屏都是这张表单，待办要往下滑很远。
 * 手机先这么做（09-23），桌面 09-24 跟上 —— 桌面上那张空表单同样占掉了半个首屏。
 * 开合状态放在模块里而不是 DOM 上 —— 首页会被推送整块重绘，放 DOM 上一重绘就又收回去了。
 */
let todayOpen = false;
/**
 * 首页的动效（09-24）：模块依次滑入、数字滚动、漏斗条从零长出来。
 * 只在「这次打开页面第一次画出来」或「数字真的变了」时放 —— 后台每 30 秒重绘一次，
 * 要是每次都从 0 滚一遍，数字会一直闪，看起来像数据在跳。
 */
let entered = false;
const shownNums = new Map();
const todayStatus = (day, report) => report ? `已写：${report.title}` : `${dayLabel(day)}还没写`;
const todayToggleLabel = report => todayOpen ? '收起' : (report ? '修改' : '写日报');

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

/* ================= 首页拼贴（09-24）：待办勾选、进度环、漏斗切换、布局编辑、专注模式 ================= */

const RING = 326.7;                       // 进度环周长 2πr，r = 52
let focusRows = [];                       // 上一次画出来的待办（重绘之间筛选、勾选都基于它）
let focusFilter = 'all';
let pipeMode = 'count';
let editing = false;
let focusing = false;

const clockText = () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
setInterval(() => { const el = document.getElementById('dashClock'); if (el) el.textContent = clockText(); }, 20_000);

/**
 * 「今天已推进」：首页上把一条待办勾掉，只记在这台设备、只记今天。
 * 它不改后台状态（审核、跟进还是要点进去做），是给自己排当天节奏用的；明天还没处理完的会重新出现。
 */
const doneKey = () => me?.id ? `ideahub.dash.done.v1:${me.id}` : '';
function doneSet() {
  try {
    const saved = JSON.parse(localStorage.getItem(doneKey()) || 'null');
    return new Set(saved?.day === todayYmd() ? saved.ids : []);
  } catch { return new Set(); }
}
function saveDone(set) {
  try { localStorage.setItem(doneKey(), JSON.stringify({ day: todayYmd(), ids: [...set] })); } catch { /* 记不住只影响这一次 */ }
}

function focusRowHtml(r, done) {
  return `<div class="dash-focus-item tone-${r.tone}${done ? ' is-done' : ''}" data-fid="${esc(r.fid)}">
    <i></i>
    <button type="button" class="dash-check" aria-pressed="${done}" aria-label="${done ? '取消「今天已推进」' : '标记为今天已推进'}：${esc(r.title)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
    <button type="button" class="dash-focus-open rip" data-goto="${esc(r.board)}" data-entity="${esc(r.entity)}" data-ref="${Number(r.id)}">
      <span><small>${esc(r.eyebrow)}</small><b>${esc(r.title)}</b><em>${esc(r.meta || '')}</em></span>
      <strong>处理 <span>→</span></strong></button>
  </div>`;
}

/** 画待办列表。animate = true 时做 FLIP：勾掉的那条平滑沉到下面，其余的跟着让位 */
function paintFocus(animate) {
  const list = document.getElementById('dashFocusList');
  if (!list) return;
  const done = doneSet();
  const first = animate && !reduced()
    ? new Map([...list.querySelectorAll('.dash-focus-item')].map(el => [el.dataset.fid, el.getBoundingClientRect()])) : null;
  const shown = focusRows
    .filter(r => focusFilter === 'all' ? true : focusFilter === 'done' ? done.has(r.fid) : r.kind === focusFilter && !done.has(r.fid))
    .sort((a, b) => done.has(a.fid) - done.has(b.fid));
  list.innerHTML = shown.length ? shown.map(r => focusRowHtml(r, done.has(r.fid))).join('')
    : focusRows.length
      ? `<p class="dash-empty">${focusFilter === 'done' ? '今天还没有勾掉的事。' : '这一类今天都推进完了。'}</p>`
      : `<button class="dash-focus-open dash-focus-idle" data-goto="pool"><span><small>当前无待办</small><b>去灵感池看看团队正在讨论什么</b>
          <em>保持资料流动，下一步才会自然出现</em></span><strong>去看看 <span>→</span></strong></button>`;
  if (first) for (const el of list.querySelectorAll('.dash-focus-item')) {
    const a = first.get(el.dataset.fid);
    const b = el.getBoundingClientRect();
    if (a && a.top !== b.top) el.animate([{ transform: `translateY(${a.top - b.top}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,.9,.25,1.1)' });
    else if (!a) el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'ease-out' });
  }
  paintProgress(done);
  for (const seg of document.querySelectorAll('#v-home .dash-seg')) placePill(seg);
}

/** 进度环 + 问候下面那句话：跟着勾选实时变 */
function paintProgress(done = doneSet()) {
  const total = focusRows.length;
  const n = focusRows.filter(r => done.has(r.fid)).length;
  const bar = document.getElementById('dashRingBar');
  if (!bar) return;
  bar.style.strokeDashoffset = String(total ? RING * (1 - n / total) : 0);
  document.getElementById('dashRingNum').textContent = total ? `${n}/${total}` : '清空';
  document.getElementById('dashRing').setAttribute('aria-label', total ? `今天值得推进的 ${total} 件事，已推进 ${n} 件` : '今天没有待推进的事');
  document.getElementById('dashRing').classList.toggle('is-full', !total || n === total);
  const left = total - n;
  document.getElementById('dashHeroLine').textContent = !total
    ? '今天没有等你处理的事，可以去灵感池看看新想法。'
    : left ? `今天有 ${total} 件事值得推进，还剩 ${left} 件。先处理需要判断的事，再把结果沉淀成团队资产。`
      : '今天的事都推进过了，写完日报就可以收工。';
}

/** 分段按钮下面那块滑动的底 */
function placePill(seg) {
  const on = seg.querySelector('button[aria-pressed="true"]');
  const pill = seg.querySelector('.dash-seg-pill');
  if (!on || !pill) return;
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.transform = `translateX(${on.offsetLeft}px)`;
}

/** 勾选时的一小把彩纸（动效「完整」时才放） */
function burst(from) {
  if (reduced() || !from) return;
  const r = from.getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  const colors = ['--blue', '--good', '--warn', '--violet'].map(v => cs.getPropertyValue(v).trim() || '#999');
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('i');
    p.className = 'dash-confetti';
    p.style.left = `${r.left + r.width / 2}px`;
    p.style.top = `${r.top + r.height / 2}px`;
    p.style.background = colors[i % colors.length];
    document.body.appendChild(p);
    const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 90;
    p.animate([
      { transform: 'translate(-50%,-50%) rotate(0)', opacity: 1 },
      { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d + 50}px) rotate(${Math.random() * 540}deg)`, opacity: 0 },
    ], { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => p.remove();
  }
}

function toggleDone(fid, btn) {
  const set = doneSet();
  const row = focusRows.find(r => r.fid === fid);
  const nowDone = !set.has(fid);
  if (nowDone) set.add(fid); else set.delete(fid);
  saveDone(set);
  paintFocus(true);
  if (!nowDone || !row) return;
  burst(btn);
  const all = focusRows.every(r => set.has(r.fid));
  toast('ok', all ? '今天值得推进的事都推进过了' : `「${row.title}」标记为今天已推进`);
}

/* ---------- 布局编辑：拖动换位置、改宽度、先藏起来。只记在这台设备上 ---------- */
const TILES = {
  hero: { name: '问候', sizes: [8, 6, 12] },
  hot: { name: '待我审核', sizes: [4, 3, 6] },
  today: { name: '每日总结', sizes: [12, 6] },
  stats: { name: '数字概况', sizes: [12, 6] },
  focus: { name: '今天值得推进', sizes: [7, 6, 8, 12] },
  pipeline: { name: '客户转化', sizes: [5, 4, 6, 12] },
  library: { name: '团队资产', sizes: [7, 6, 12] },
  clients: { name: '服务中客户', sizes: [5, 6, 12] },
};
const DEFAULT_ORDER = Object.keys(TILES);
const LAYOUT_KEY = 'ideahub.dash.layout.v1';
function readLayout() {
  try {
    const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    const order = Array.isArray(s?.order) ? s.order.filter(k => TILES[k]) : [];
    for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k);
    return {
      order,
      hidden: Array.isArray(s?.hidden) ? s.hidden.filter(k => TILES[k]) : [],
      size: Object.fromEntries(Object.entries(s?.size || {}).filter(([k, v]) => TILES[k]?.sizes.includes(v))),
    };
  } catch { return { order: [...DEFAULT_ORDER], hidden: [], size: {} }; }
}
let layout = readLayout();
function saveLayout() {
  const bento = document.getElementById('dashBento');
  if (bento) layout.order = [...bento.children].map(el => el.dataset.tile).filter(Boolean);
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 记不住只影响这一次 */ }
}

function applyLayout() {
  const bento = document.getElementById('dashBento');
  if (!bento) return;
  for (const k of layout.order) {
    const el = bento.querySelector(`:scope > [data-tile="${k}"]`);
    if (el) bento.appendChild(el);
  }
  for (const el of bento.children) {
    const k = el.dataset.tile;
    const span = layout.size[k] || TILES[k].sizes[0];
    el.style.setProperty('--span', span);
    el.dataset.wide = span >= 7 ? '1' : '0';
    el.hidden = layout.hidden.includes(k);
  }
  const tray = document.getElementById('dashTray');
  if (tray) tray.innerHTML = layout.hidden.map(k => `<button type="button" class="dash-tool" data-tile-show="${k}">+ ${TILES[k].name}</button>`).join('');
}

/** 改布局时整块网格做一次 FLIP，卡片从旧位置滑到新位置 */
function flipTiles(change) {
  const bento = document.getElementById('dashBento');
  const before = new Map([...bento.children].filter(el => !el.hidden).map(el => [el, el.getBoundingClientRect()]));
  change();
  if (reduced()) return;
  for (const el of bento.children) {
    if (el.hidden) continue;
    const a = before.get(el), b = el.getBoundingClientRect();
    if (!a) { el.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: 'ease-out' }); continue; }
    if (a.left === b.left && a.top === b.top && a.width === b.width) continue;
    el.animate([
      { transformOrigin: 'top left', transform: `translate(${a.left - b.left}px,${a.top - b.top}px) scale(${a.width / b.width},${a.height / b.height})` },
      { transformOrigin: 'top left', transform: 'none' },
    ], { duration: 460, easing: 'cubic-bezier(.2,.9,.25,1.05)' });
  }
}

function enterEdit() {
  const bento = document.getElementById('dashBento');
  if (!bento) return;
  bento.classList.add('editing');
  document.getElementById('dashEditbar').hidden = false;
  for (const el of bento.children) {
    if (el.querySelector(':scope > .dash-tile-tools')) continue;
    const name = TILES[el.dataset.tile].name;
    el.insertAdjacentHTML('afterbegin', `<div class="dash-tile-tools">
      <button type="button" data-tile-move="-1" aria-label="${name}往前挪">←</button>
      <button type="button" data-tile-move="1" aria-label="${name}往后挪">→</button>
      <button type="button" data-tile-size aria-label="改变${name}的宽度">宽度</button>
      <button type="button" data-tile-hide aria-label="先藏起${name}">隐藏</button></div>`);
  }
  applyLayout();
}
function exitEdit() {
  const bento = document.getElementById('dashBento');
  editing = false;
  if (!bento) return;
  bento.classList.remove('editing');
  document.getElementById('dashEditbar').hidden = true;
  bento.querySelectorAll('.dash-tile-tools').forEach(t => t.remove());
  saveLayout();
  syncTools();
}
function setEditing(on) {
  if (on === editing) return;
  if (on && focusing) setFocusing(false);
  editing = on;
  if (on) { enterEdit(); toast('info', '拖动卡片换位置，改完点「完成」'); } else { exitEdit(); toast('ok', '首页布局已保存在这台设备上'); }
  syncTools();
}

/** 拖动换位置：按住卡片拖，经过别的卡片时换位，其余卡片 FLIP 让位 */
function bindDrag(root) {
  root.addEventListener('pointerdown', e => {
    if (!editing || e.button !== 0 || e.target.closest('.dash-tile-tools')) return;
    const bento = document.getElementById('dashBento');
    const tile = e.target.closest('#dashBento > [data-tile]');
    if (!tile) return;
    e.preventDefault();
    const start = tile.getBoundingClientRect();
    const ox = e.clientX - start.left, oy = e.clientY - start.top;
    tile.classList.add('dragging');
    try { tile.setPointerCapture(e.pointerId); } catch { /* 部分浏览器不给也能拖 */ }
    let last = null, cool = 0;
    const place = ev => {
      tile.style.transform = 'none';
      const b = tile.getBoundingClientRect();
      tile.style.transform = `translate(${ev.clientX - ox - b.left}px,${ev.clientY - oy - b.top}px) scale(1.02)`;
    };
    const move = ev => {
      place(ev);
      if (performance.now() < cool) return;
      const hit = document.elementsFromPoint(ev.clientX, ev.clientY)
        .map(n => n.closest?.('#dashBento > [data-tile]')).find(n => n && n !== tile);
      if (!hit) { last = null; return; }
      if (hit === last) return;
      const kids = [...bento.children];
      const others = kids.filter(n => n !== tile && !n.hidden);
      const before = new Map(others.map(n => [n, n.getBoundingClientRect()]));
      bento.insertBefore(tile, kids.indexOf(tile) < kids.indexOf(hit) ? hit.nextSibling : hit);
      if (!reduced()) for (const n of others) {
        const a = before.get(n), b = n.getBoundingClientRect();
        if (a.left !== b.left || a.top !== b.top) n.animate([{ transform: `translate(${a.left - b.left}px,${a.top - b.top}px)` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.2,.9,.25,1.1)' });
      }
      last = hit; cool = performance.now() + 260;
      place(ev);
    };
    const up = () => {
      tile.removeEventListener('pointermove', move);
      const cur = tile.style.transform;
      tile.style.transform = '';
      tile.classList.remove('dragging');
      if (!reduced() && cur) tile.animate([{ transform: cur }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.9,.25,1.1)' });
      saveLayout();
    };
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', up, { once: true });
    tile.addEventListener('pointercancel', up, { once: true });
  });
}

/* ---------- 专注模式：只留「今天值得推进的事」，顶部一个 25 分钟计时 ---------- */
const FOCUS_SECONDS = 25 * 60;
let focusLeft = FOCUS_SECONDS, focusRunning = true, focusTimer = null, focusBar = null;
function paintFocusBar() {
  if (!focusBar) return;
  const m = String(Math.floor(focusLeft / 60)).padStart(2, '0');
  const s = String(focusLeft % 60).padStart(2, '0');
  focusBar.querySelector('b').textContent = `${m}:${s}`;
  focusBar.querySelector('.bar').style.strokeDashoffset = String(113.1 * (1 - focusLeft / FOCUS_SECONDS));
  focusBar.querySelector('[data-focus="pause"]').textContent = focusRunning ? '暂停' : '继续';
}
function setFocusing(on) {
  if (on === focusing) return;
  if (on && editing) setEditing(false);
  focusing = on;
  document.getElementById('dashBento')?.classList.toggle('focusing', on);
  clearInterval(focusTimer);
  focusBar?.remove();
  focusBar = null;
  syncTools();
  if (!on) return;
  focusLeft = FOCUS_SECONDS;
  focusRunning = true;
  focusBar = document.createElement('div');
  focusBar.className = 'dash-focusbar';
  focusBar.setAttribute('role', 'status');
  focusBar.innerHTML = `<span class="ring"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="18"/><circle class="bar" cx="20" cy="20" r="18"/></svg></span>
    <span>专注中</span><b>25:00</b>
    <button type="button" data-focus="pause">暂停</button><button type="button" data-focus="end">结束</button>`;
  document.body.appendChild(focusBar);
  focusBar.addEventListener('click', e => {
    const b = e.target.closest('[data-focus]');
    if (!b) return;
    if (b.dataset.focus === 'pause') { focusRunning = !focusRunning; paintFocusBar(); }
    else { setFocusing(false); toast('ok', '专注结束，辛苦了'); }
  });
  focusTimer = setInterval(() => {
    if (!focusRunning) return;
    focusLeft = Math.max(0, focusLeft - 1);
    paintFocusBar();
    if (!focusLeft) { setFocusing(false); toast('ok', '25 分钟到了，起来活动一下'); }
  }, 1000);
  paintFocusBar();
  document.querySelector('#v-home .dash-focus')?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
}

function syncTools() {
  const f = document.getElementById('dashFocusBtn');
  const e = document.getElementById('dashEditBtn');
  if (f) f.setAttribute('aria-pressed', String(focusing));
  if (e) e.setAttribute('aria-pressed', String(editing));
}

/** 离开首页：专注计时停掉、布局编辑保存退出（main.js 的 go() 调用） */
export function leave() {
  if (focusing) setFocusing(false);
  if (editing) { editing = false; exitEdit(); }
}

/** 首页上的点击和快捷键。#v-home 本身不会被重绘，挂一次就够 */
let bound = false;
function bindHome(root) {
  if (bound) return;
  bound = true;
  bindDrag(root);
  // 编辑布局按钮在顶栏（09-25 按原型挪上去），不在 #v-home 里，单独挂一次
  document.getElementById('dashEditBtn')?.addEventListener('click', () => setEditing(!editing));
  // 问候区的两团光跟着鼠标轻轻反向移动（视差），样式在 soft.css 用 --px / --py
  root.addEventListener('pointermove', e => {
    const hero = e.target.closest?.('.dash-hero');
    if (!hero || reduced()) return;
    const r = hero.getBoundingClientRect();
    hero.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    hero.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  }, { passive: true });
  root.addEventListener('click', e => {
    const check = e.target.closest('.dash-check');
    if (check) { toggleDone(check.closest('.dash-focus-item').dataset.fid, check); return; }
    const filter = e.target.closest('[data-filter]');
    if (filter) {
      focusFilter = filter.dataset.filter;
      filter.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === filter)));
      paintFocus(true);
      return;
    }
    const pipe = e.target.closest('[data-pipe]');
    if (pipe) {
      pipeMode = pipe.dataset.pipe;
      pipe.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === pipe)));
      placePill(pipe.parentElement);
      root.querySelectorAll('.dash-pipeline-list i[data-w]').forEach(i => { i.style.width = pipeMode === 'rate' ? i.dataset.r : i.dataset.w; });
      return;
    }
    if (e.target.closest('#dashFocusBtn')) { setFocusing(!focusing); return; }
    const lay = e.target.closest('[data-dash-layout]');
    if (lay) {
      if (lay.dataset.dashLayout === 'done') setEditing(false);
      else { flipTiles(() => { layout = { order: [...DEFAULT_ORDER], hidden: [], size: {} }; applyLayout(); }); saveLayout(); toast('ok', '首页布局已恢复默认'); }
      return;
    }
    const show = e.target.closest('[data-tile-show]');
    if (show) { flipTiles(() => { layout.hidden = layout.hidden.filter(k => k !== show.dataset.tileShow); applyLayout(); }); saveLayout(); return; }
    const tile = e.target.closest('#dashBento > [data-tile]');
    if (!tile || !editing) return;
    const k = tile.dataset.tile;
    if (e.target.closest('[data-tile-hide]')) {
      flipTiles(() => { layout.hidden = [...new Set([...layout.hidden, k])]; applyLayout(); });
      saveLayout();
    } else if (e.target.closest('[data-tile-size]')) {
      const sizes = TILES[k].sizes;
      const cur = layout.size[k] || sizes[0];
      flipTiles(() => { layout.size[k] = sizes[(sizes.indexOf(cur) + 1) % sizes.length]; applyLayout(); });
      saveLayout();
    } else if (e.target.closest('[data-tile-move]')) {
      const step = Number(e.target.closest('[data-tile-move]').dataset.tileMove);
      const bento = tile.parentElement;
      const visible = [...bento.children].filter(n => !n.hidden);
      const target = visible[visible.indexOf(tile) + step];
      if (target) flipTiles(() => bento.insertBefore(tile, step < 0 ? target : target.nextSibling));
      saveLayout();
      e.target.closest('[data-tile-move]').focus();
    }
  });
  // 快捷键：F 专注、E 编辑布局。只在首页、没在打字、没有弹窗时生效
  document.addEventListener('keydown', e => {
    if (!root.classList.contains('on') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (focusing) setFocusing(false); if (editing) setEditing(false); return; }
    if (e.target.closest('input,textarea,select,[contenteditable]')) return;
    if (document.querySelector('.modal.on, .drawer.on, .menupop.on')) return;
    const k = e.key.toLowerCase();
    if (k === 'f') { e.preventDefault(); setFocusing(!focusing); }
    else if (k === 'e' && innerWidth > 1180) { e.preventDefault(); setEditing(!editing); }
  });
  addEventListener('resize', () => root.querySelectorAll('.dash-seg').forEach(placePill));
}

/** 给命令面板用：外面也能打开专注模式、布局编辑 */
export function command(name) {
  if (name === 'focus') setFocusing(true);
  if (name === 'edit' && innerWidth > 1180) setEditing(true);
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
  if (editing) return;   // 正在拖卡片排版时不重绘，不然手里的卡片会被换掉
  const root = $('#v-home');
  const cached = root.querySelector('.dash-hero') ? null : readCache();
  if (cached) paintDashboard(root, cached);
  else if (!root.querySelector('.dash-hero')) {
    root.innerHTML = skeleton('home', { label: '正在整理今天的工作…' });
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

  // 今天值得推进的事：待审核 → 评审 → 客户跟进。每条可以在首页上勾掉（只记在这台设备的今天，见 doneStore）
  focusRows = [];
  for (const row of pendingReports.slice(0, 2)) focusRows.push({
    kind: 'review', tone: 'amber', eyebrow: '待我审核', title: row.title || '未命名工作提交',
    meta: `${row.authorName || '同事'} 提交${row.needHelp ? ' · 需要协助' : ''}`,
    board: 'reports', entity: 'report', id: row.id,
  });
  for (const row of reviewing.slice(0, 2)) focusRows.push({
    kind: 'idea', tone: 'violet', eyebrow: '评审进行中', title: row.title,
    meta: `${row.voteCount || 0} 人支持 · ${row.commentCount || 0} 条讨论`,
    board: 'pool', entity: 'idea', id: row.id,
  });
  for (const row of serviceClients.slice(0, 3)) focusRows.push({
    kind: 'client', tone: 'green', eyebrow: '客户跟进', title: row.alias || '未命名客户',
    meta: `${stageLabel[row.stage] || '待分阶段'}${row.ownerName ? ` · ${row.ownerName}负责` : ''}`,
    board: 'clients', entity: 'client', id: row.id,
  });
  focusRows = focusRows.slice(0, 6).map(r => ({ ...r, fid: `${r.entity}:${r.id}` }));

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
  const hot = pendingReports[0];

  root.innerHTML = `
    <div class="dash-tools" id="dashTools">
      <div class="dash-editbar" id="dashEditbar" hidden>
        <b>拖动卡片换位置，用卡片右上角的按钮改大小或先藏起来</b>
        <span class="dash-tray" id="dashTray"></span>
        <button type="button" class="dash-tool" data-dash-layout="reset">恢复默认</button>
        <button type="button" class="dash-tool is-primary" data-dash-layout="done">完成</button>
      </div>
    </div>

    <div class="dash-bento" id="dashBento">
    <section class="dash-hero" data-tile="hero">
      <div class="dash-hero-main">
        <div class="page-kicker">${esc(dateText())}<span class="dash-clock" id="dashClock">${clockText()}</span></div>
        <h1>${greeting()}，<em class="dash-name">${esc(me?.name || '伙伴')}</em></h1>
        <p id="dashHeroLine"></p>
      </div>
      <div class="dash-ring" id="dashRing" role="img" aria-label="">
        <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="trk" cx="60" cy="60" r="52"/><circle class="bar" id="dashRingBar" cx="60" cy="60" r="52" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
        <div><b id="dashRingNum">0/0</b><small>今天已推进</small></div>
      </div>
      <div class="dash-quick" aria-label="快捷操作">
        <button class="rip" data-dash-create="pool">${ICON.bulb}<span><b>记一条灵感</b><small>发起讨论</small></span></button>
        <button class="rip" data-dash-create="clients">${ICON.users}<span><b>新增客户</b><small>跟进信息</small></span></button>
        <button class="rip" data-dash-learning="framework">${ICON.layers}<span><b>框架学习</b><small>判断链路</small></span></button>
        <button class="rip" data-dash-learning="detail">${ICON.book}<span><b>详细学习</b><small>专业详解</small></span></button>
      </div>
    </section>

    <section class="dash-hot${hot ? '' : ' is-clear'}" data-tile="hot" aria-labelledby="dashHotHead">
      <header><h2 id="dashHotHead">待我审核</h2><span class="dash-chip">${hot ? '先做这件' : '已全部审完'}</span></header>
      <b class="dash-hot-num" data-num="hot">${pendingReports.length}</b>
      ${hot ? `<div class="dash-hot-card"><small>${esc(hot.authorName || '同事')} 提交${hot.needHelp ? ' · 需要协助' : ''}</small>
        <b>${esc(hot.title || '未命名工作提交')}</b><span>${pendingReports.length > 1 ? `还有 ${pendingReports.length - 1} 条排在后面` : '需要给出反馈'}</span></div>`
        : '<p class="dash-hot-empty">没有等你审核的工作提交，今天可以把精力放在客户和灵感上。</p>'}
      <button class="dash-hot-go rip" data-goto="reports"${hot ? ` data-entity="report" data-ref="${Number(hot.id)}"` : ''}>${hot ? '去审核 →' : '看工作提交'}</button>
    </section>

    <section class="dash-panel dash-today${todayOpen ? ' open' : ''}" data-tile="today" data-day="${esc(day)}"
        data-report-id="${dayReport ? Number(dayReport.id) : ''}">
      <header>
        <div><h2 id="dashTodayHead">${esc(dayLabel(day))}做了什么</h2>
          <p class="dash-today-status" id="dashTodayStatus">${esc(todayStatus(day, dayReport))}</p></div>
        <button data-goto="reports" class="dash-today-history">看历史日报 →</button>
        <button type="button" class="btn btn-primary dash-today-toggle" id="dashTodayToggle"
          aria-expanded="${todayOpen}" aria-controls="dashTodayBody">${esc(todayToggleLabel(dayReport))}</button>
      </header>
      <div class="dash-today-body" id="dashTodayBody">
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

    <section class="dash-action-grid" data-tile="stats">
      <button data-goto="reports"><span class="dash-action-icon amber">${ICON.check}</span><small>待我审核</small><b data-num="review">${pendingReports.length}</b><em>${pendingReports.length ? '需要给出反馈' : '当前已清空'}</em></button>
      <button data-goto="pool"><span class="dash-action-icon violet">${ICON.eye}</span><small>评审中的灵感</small><b data-num="reviewing">${reviewing.length}</b><em>${reviewing.length ? '正在形成共识' : '暂无评审中项目'}</em></button>
      <button data-goto="clients"><span class="dash-action-icon green">${ICON.users}</span><small>服务中客户</small><b data-num="clients">${serviceClients.length}</b><em>${incompleteClients.length} 份档案待补完整</em></button>
      <button data-goto="demands"><span class="dash-action-icon blue">${ICON.search}</span><small>用户需求</small><b data-num="demands">${demandItems.length}</b><em>${demandItems.filter(x => !x.quote).length} 条缺少原话证据</em></button>
    </section>

    <section class="dash-panel dash-focus" data-tile="focus">
      <header><div><h2>今天值得推进的事</h2><small>按待审核、评审、客户跟进排序；勾掉的沉到下面</small></div>
        <div class="dash-seg" id="dashFocusSeg" role="group" aria-label="筛选待办"><i class="dash-seg-pill" aria-hidden="true"></i>${[
          ['all', '全部'], ['review', '审核'], ['idea', '评审'], ['client', '客户'], ['done', '已推进'],
        ].map(([k, t]) => `<button type="button" data-filter="${k}" aria-pressed="${focusFilter === k}">${t}</button>`).join('')}</div>
        <button type="button" class="dash-mini" id="dashFocusBtn" aria-pressed="false" aria-label="专注模式（F）" title="专注模式（F）">${ICON.clock}</button>
      </header>
      <div class="dash-focus-list" id="dashFocusList"></div>
    </section>

    <section class="dash-panel dash-pipeline" data-tile="pipeline">
      <header><div><h2>客户转化</h2></div>
        <div class="dash-seg" id="dashPipeSeg" role="group" aria-label="漏斗显示方式"><i class="dash-seg-pill" aria-hidden="true"></i>${[
          ['count', '人数'], ['rate', '转化率'],
        ].map(([k, t]) => `<button type="button" data-pipe="${k}" aria-pressed="${pipeMode === k}">${t}</button>`).join('')}</div>
        <button data-goto="funnel">看完整漏斗 →</button></header>
      <div class="dash-pipeline-list">${sales.map((step, index) => {
        const w = Math.max(8, Number(step.value || 0) / maxSales * 100);
        const r = index ? Math.max(4, Math.min(100, Number(step.conversion) || 0)) : 100;
        const cur = pipeMode === 'rate' ? r : w;
        return `
          <button data-goto="clients" data-stages="${esc((step.stages || []).join(','))}"
              data-filter-label="销售漏斗 · ${esc(step.name)}"
              title="${index ? `上一步 → ${esc(step.name)}：转化 ${step.conversion ?? '—'}%` : `漏斗起点：${Number(step.value || 0)} 位`}">
            <span><i>${String(index + 1).padStart(2, '0')}</i><b>${esc(step.name)}</b></span>
            <div><i data-w="${w}%" data-r="${r}%" style="width:${cur}%"></i></div>
            <strong>${Number(step.value || 0)}</strong>
            <em>${index ? `${step.conversion ?? '—'}%` : '起点'}</em>
          </button>`;
      }).join('')}</div>
    </section>

    <section class="dash-panel dash-library" data-tile="library">
      <header><div><h2>团队资产</h2></div><button data-goto="stats">查看统计 →</button></header>
      <div>${library.map(item => `<button data-goto="${esc(item.board)}"><small>${esc(item.name)}</small><b>${Number(item.value || 0)}</b><em>${esc(item.note || '')}</em><span>打开 →</span></button>`).join('')}</div>
    </section>

    <section class="dash-panel dash-clients" data-tile="clients">
      <header><div><h2>服务中客户</h2>${incompleteClients.length ? `<small>${incompleteClients.length} 份档案待补完整</small>` : ''}</div><button data-goto="clients">客户档案 →</button></header>
      ${serviceClients.length ? `<div class="dash-client-grid">${serviceClients.slice(0, 6).map(c => `
        <button class="dash-client" data-goto="clients" data-entity="client" data-ref="${Number(c.id)}">
          <i style="background:${avatarColor(c.alias || '?')}">${esc(initial(c.alias || '?'))}</i>
          <b>${esc(c.alias || '未命名客户')}</b>
          <span class="dash-chip">${esc(stageLabel[c.stage] || '待分阶段')}</span>
          <em>${c.ownerName ? `${esc(c.ownerName)}负责` : '还没有负责人'}</em>
        </button>`).join('')}</div>`
        : '<p class="dash-empty">已咨询和陪跑中的客户会出现在这里。</p>'}
    </section>
    </div>`;

  bindToday(root);
  paintFocus(false);
  applyLayout();
  if (editing) enterEdit();
  if (focusing) root.querySelector('#dashBento').classList.add('focusing');
  syncTools();
  animateDashboard(root);
}

/** 鼠标划过卡片时跟着光标走的一圈柔光（样式在 soft.css）。事件挂在 #v-home 上，它不会被重绘，绑一次就够 */
const SPOT = '.dash-panel, .dash-hero, .dash-hot, .dash-quick button, .dash-action-grid>button, .dash-client';
let spotBound = false;

/** 画完之后放动效。第一次进来：模块依次滑入、漏斗条长出来；之后只有数字变了才滚动 */
function animateDashboard(root) {
  const first = !entered;
  entered = true;
  if (first) maybeStartTour();   // 新功能引导：没看过的人第一次打开首页时出现
  if (first && !reduced()) {
    root.classList.add('dash-enter');
    setTimeout(() => root.classList.remove('dash-enter'), 1200);
    const bars = [...root.querySelectorAll('.dash-pipeline-list i[data-w]')];
    bars.forEach(i => { i.style.width = '0%'; });
    requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach(i => { i.style.width = pipeMode === 'rate' ? i.dataset.r : i.dataset.w; })));
  }
  for (const el of root.querySelectorAll('[data-num]')) {
    const to = Number(el.textContent) || 0;
    const from = shownNums.has(el.dataset.num) ? shownNums.get(el.dataset.num) : 0;
    shownNums.set(el.dataset.num, to);
    if (from !== to) countTo(el, to, { from, ms: 700 });
  }
  bindHome(root);
  if (!spotBound) {
    spotBound = true;
    root.addEventListener('pointermove', e => {
      const el = e.target.closest?.(SPOT);
      if (!el || !root.contains(el)) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
  }
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
  const statusEl = box.querySelector('#dashTodayStatus');
  const toggle = box.querySelector('#dashTodayToggle');
  const defaultVis = me?.reportVisibilityDefault === 'public' ? 'public' : 'private';

  const currentReport = () => myByDate.get(box.dataset.day || todayYmd()) || null;
  const syncToggle = () => {
    box.classList.toggle('open', todayOpen);
    toggle.setAttribute('aria-expanded', String(todayOpen));
    toggle.textContent = todayToggleLabel(currentReport());
    statusEl.textContent = todayStatus(box.dataset.day || todayYmd(), currentReport());
  };
  toggle.addEventListener('click', () => {
    todayOpen = !todayOpen;
    syncToggle();
    if (todayOpen) title.focus({ preventScroll: true });
  });

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
    syncToggle();
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
      // 存完就收起来，那一行直接显示「已写：……」
      todayOpen = false;
      syncToggle();
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
