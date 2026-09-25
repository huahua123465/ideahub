/**
 * 新功能引导（09-24）：第一次打开首页时，一步步指给人看这次新加的东西 ——
 * 首页改版、勾待办、专注模式、布局编辑、Ctrl K 命令、配色与外观、收起侧栏。
 *
 * - 只自动出现一次（按设备记在 localStorage ideahub.tour.v1）；头像菜单「新功能介绍」、搜索框命令里可以再看。
 * - 不挡页面：点引导卡片以外的地方，就当「知道了」关掉，那一下点击照常生效。
 * - 当前屏幕上看不到的步骤自动跳过（比如手机上没有专注模式按钮、没有侧栏收起按钮）。
 * - 自动化浏览器（UI 测试、录演示视频）不自动弹：navigator.webdriver 为真时跳过；
 *   引导自己的测试在 sessionStorage 放 ideahub.qa.tour=1 强制打开。
 */
import { esc } from './util.js';

const KEY = 'ideahub.tour.v1';
const STEPS = [
  { sel: '#dashBento .dash-hero', title: '首页改版了', text: '今天要推进的事、待审核、客户和数据都在一屏里。右边的进度环会跟着你勾掉的待办走。' },
  { sel: '#dashFocusList .dash-check', title: '勾掉推进过的事', text: '点左边的圆圈，这一条就划线沉到下面。只记在这台设备的今天，不改后台的状态。' },
  { sel: '#dashFocusBtn', title: '专注模式', key: 'F', text: '点这个时钟或按 F：只留「今天值得推进的事」，其余的退到后面，顶部给你一个 25 分钟计时。按 Esc 退出。' },
  { sel: '#dashEditBtn', title: '自己排首页', key: 'E', text: '点顶栏这个按钮或按 E：拖动卡片换位置、改宽度，把用不上的先藏起来。只改你这台设备上的首页。' },
  { sel: '#lookBtn', title: '配色与外观', text: '12 套配色，也能自己调颜色、圆角、密度和动效。换配色时新颜色会从你点的位置扩散开。' },
  { sel: '.topbar .search', title: '命令面板', key: 'Ctrl K', text: '按 Ctrl K 在屏幕中间打开命令面板：跳页面、新建、专注模式、换配色，也能直接搜全站资料。↑↓ 选、Enter 执行。' },
  { sel: '#meAvatar', title: '头像菜单', text: '明暗切换、配色与外观、再看一次这份介绍，都在头像菜单里。' },
  { sel: '#navRailBtn', title: '收起侧栏', text: '侧栏可以收成只剩图标的窄栏，给内容腾出地方。再点一次展开。' },
];

let box = null;
let steps = [];
let idx = 0;
let returnFocus = null;

const shown = el => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const seen = () => { try { return localStorage.getItem(KEY) === 'done'; } catch { return true; } };
const forced = () => { try { return sessionStorage.getItem('ideahub.qa.tour') === '1'; } catch { return false; } };

/** 首页第一次画出来时调用：没看过、不是自动化浏览器、首页还在前台、没开着弹窗，才开始 */
export function maybeStartTour() {
  if (seen() || box) return;
  if (navigator.webdriver && !forced()) return;
  setTimeout(() => {
    if (!document.querySelector('#v-home.on') || document.querySelector('.modal.on, .drawer.on, .menupop.on')) return;
    startTour();
  }, forced() ? 50 : 1200);
}

/** 打开引导。首页可能还在加载，最多等 3 秒等它画出来 */
export async function startTour() {
  if (box) return;
  for (let t = 0; t < 30 && !document.querySelector('#dashBento .dash-hero'); t++) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (box) return;
  steps = STEPS.filter(s => shown(document.querySelector(s.sel)));
  if (!steps.length) return;
  idx = 0;
  returnFocus = document.activeElement;
  box = document.createElement('div');
  box.className = 'tour';
  box.innerHTML = `<div class="tour-spot" aria-hidden="true"></div>
    <div class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tourTitle" aria-describedby="tourText">
      <div class="tour-step"><span id="tourStep"></span><kbd id="tourKey" hidden></kbd></div>
      <h2 id="tourTitle"></h2>
      <p id="tourText"></p>
      <div class="tour-dots" aria-hidden="true">${steps.map(() => '<i></i>').join('')}</div>
      <div class="tour-foot">
        <button type="button" class="tour-skip" data-tour="skip">跳过</button>
        <span class="tour-grow"></span>
        <button type="button" class="btn btn-ghost" data-tour="prev">上一步</button>
        <button type="button" class="btn btn-primary" data-tour="next">下一步</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-tour]');
    if (!b) return;
    if (b.dataset.tour === 'skip') end(true);
    else if (b.dataset.tour === 'prev') show(Math.max(0, idx - 1));
    else if (idx < steps.length - 1) show(idx + 1);
    else end(true);
  });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  show(0);
}

function show(i) {
  idx = i;
  const s = steps[i];
  document.querySelector(s.sel)?.scrollIntoView({ block: 'nearest' });
  box.querySelector('#tourStep').textContent = `新功能 ${i + 1} / ${steps.length}`;
  const key = box.querySelector('#tourKey');
  key.hidden = !s.key;
  key.textContent = s.key || '';
  box.querySelector('#tourTitle').textContent = s.title;
  box.querySelector('#tourText').innerHTML = esc(s.text);
  box.querySelectorAll('.tour-dots i').forEach((dot, n) => dot.classList.toggle('on', n === i));
  box.querySelector('[data-tour="prev"]').hidden = i === 0;
  box.querySelector('[data-tour="next"]').textContent = i === steps.length - 1 ? '开始使用' : '下一步';
  place();
  box.querySelector('[data-tour="next"]').focus({ preventScroll: true });
}

/** 聚光框贴着目标，说明卡放在目标下面；下面放不下就放上面；侧栏这种又窄又靠左的，放右边 */
function place() {
  if (!box) return;
  const el = document.querySelector(steps[idx].sel);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pad = 6;
  const spot = box.querySelector('.tour-spot');
  const round = getComputedStyle(el).borderRadius;
  Object.assign(spot.style, {
    left: `${r.left - pad}px`, top: `${r.top - pad}px`,
    width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    borderRadius: round && round !== '0px' ? `calc(${round} + ${pad}px)` : 'var(--rd-lg)',
  });
  const card = box.querySelector('.tour-card');
  const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, margin = 12;
  let left, top;
  if (r.left < 300 && r.width < 280 && r.right + gap + cw < innerWidth - margin) {
    left = r.right + gap;
    top = r.top + r.height / 2 - ch / 2;
  } else {
    left = r.left + r.width / 2 - cw / 2;
    top = r.bottom + gap + ch < innerHeight - margin ? r.bottom + gap : r.top - gap - ch;
  }
  card.style.left = `${Math.max(margin, Math.min(left, innerWidth - cw - margin))}px`;
  card.style.top = `${Math.max(margin, Math.min(top, innerHeight - ch - margin))}px`;
}

function outside(e) {
  if (box && !e.target.closest('.tour-card')) end(false);
}

function onKey(e) {
  if (!box) return;
  if (e.key === 'Escape') { e.stopPropagation(); end(true); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); if (idx < steps.length - 1) show(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); if (idx > 0) show(idx - 1); }
}

/** 关掉并记住看过了。restore = 用键盘或按钮关的，焦点回到打开前的位置；点页面别处关的，焦点留给那一下点击 */
function end(restore) {
  if (!box) return;
  box.remove();
  box = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onKey, true);
  removeEventListener('resize', place);
  removeEventListener('scroll', place, true);
  try { localStorage.setItem(KEY, 'done'); } catch { /* 记不住下次会再出现一次，不影响使用 */ }
  if (restore) returnFocus?.focus?.({ preventScroll: true });
}
