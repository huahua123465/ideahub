/**
 * 动效小工具。
 *
 * 只有两个东西，但整站的动画都从这里过一遍：
 * - countTo：数字滚动。原来这段在 stats.js 里，写死从 0 开始、只认元素 id，
 *   投票数字要用的是「6 → 7」这种短距离滚动，所以搬过来泛化成收元素 + from/to。
 * - reduced：系统「减弱动态效果」开关。每个动效入口都要先问它一句 ——
 *   有前庭功能障碍的人会被弹跳和彩纸弄到眩晕，这不是可选项。
 */

export const reduced = () =>
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  // 「配色与外观」里把动效调成「简洁」或「关闭」（09-24），数字滚动、彩纸这类装饰动画一样不放
  || ['lite', 'off'].includes(document.documentElement.dataset.motion);

/**
 * 换外观时的圆形扩散：新配色从点击的位置一圈圈铺满屏幕（09-24）。
 * 用浏览器自带的 View Transitions：先拍下旧画面，fn() 换完颜色后，新画面按圆形裁剪逐渐露出来。
 * 不支持的浏览器、或者动效关了，就直接换，不做过渡。
 */
export function reveal(event, fn) {
  if (reduced() || !document.startViewTransition) { fn(); return; }
  const x = event?.clientX ?? innerWidth / 2;
  const y = event?.clientY ?? innerHeight / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const html = document.documentElement;
  html.classList.add('look-vt');
  const vt = document.startViewTransition(fn);
  vt.ready.then(() => html.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
  )).catch(() => {});
  vt.finished.finally(() => html.classList.remove('look-vt'));
}

/**
 * 数字滚动到 to。
 * 用 rAF 而不是 setInterval：setInterval 在后台标签页会被节流成一团，
 * 回到前台时数字会突然跳完，rAF 直接不跑，回来重新开始。
 */
export function countTo(el, to, { from, suffix = '', ms = 520 } = {}) {
  if (!el) return;
  const start = Number.isFinite(from) ? from : (parseInt(el.textContent, 10) || 0);
  const end = Number(to) || 0;

  cancelAnimationFrame(el._raf);
  if (reduced() || start === end) { el.textContent = end + suffix; return; }

  const t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);       // easeOutCubic，末尾稳稳停住
  const tick = now => {
    const t = Math.min(1, (now - t0) / ms);
    el.textContent = Math.round(start + (end - start) * ease(t)) + suffix;
    if (t < 1) el._raf = requestAnimationFrame(tick);
  };
  el._raf = requestAnimationFrame(tick);
}

/** 加一个动画 class，动画放完自己摘掉。重复触发时先摘再加，否则第二次点没反应 */
export function pulse(el, cls = 'bump', ms = 420) {
  if (!el || reduced()) return;
  el.classList.remove(cls);
  void el.offsetWidth;                            // 强制回流，让浏览器认这是一次新动画
  el.classList.add(cls);
  clearTimeout(el._pulse);
  el._pulse = setTimeout(() => el.classList.remove(cls), ms);
}

/** 从某个元素中心扩散一圈 ring */
export function ring(el, color = 'var(--blue)') {
  if (!el || reduced()) return;
  const r = el.getBoundingClientRect();
  const i = document.createElement('i');
  i.className = 'fx-ring';
  i.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;border-color:${color}`;
  document.body.appendChild(i);
  setTimeout(() => i.remove(), 620);
}

/** 骨架屏：n 个占位块的 HTML */
export const skeletonCards = (n = 6) => Array.from({ length: n }, () => `
  <article class="card sk">
    <div class="sk-line" style="width:38%;height:18px"></div>
    <div class="sk-line" style="width:82%;height:15px"></div>
    <div class="sk-line" style="width:64%;height:13px"></div>
    <div class="sk-foot"><div class="sk-line" style="width:44%;height:12px"></div></div>
  </article>`).join('');

/**
 * 页面 / 列表第一次加载时的骨架（09-24 起全站统一用这一套）。
 * 形状贴着真实内容画：数据回来时版面不跳，也不会一片空白让人以为页面坏了。
 * 外层是 display:contents，占位块直接参与父容器的网格 / 弹性布局；
 * 读屏软件读到的是 label，所以原来的「正在读取…」那句话仍然会被读出来。
 * 骨架一律不用真实组件的类名（.dash-hero / .sample-card / .exp-card / .msg …）：页面代码和测试会拿这些类名
 * 判断「内容到了没有」、数有几条，骨架混进去就会数错（首页靠 .dash-hero 判断有没有缓存内容）。
 */
const L = (w, h, more = '') => `<span class="sk-line" style="width:${w};height:${h}px${more}"></span>`;
const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const SKELETON = {
  home: () => `
    <div class="sk-box sk-home-hero"><div class="sk-stack">${L('120px', 12)}${L('min(280px,70%)', 34)}${L('min(360px,90%)', 14)}</div>
      <div class="sk-home-quick">${repeat(4, () => L('100%', 58, ';border-radius:var(--rd-lg)'))}</div></div>
    <div class="sk-box sk-row">${L('min(220px,50%)', 18)}${L('84px', 38, ';margin-left:auto;border-radius:var(--rd-base)')}</div>
    <div class="sk-box sk-home-stats">${repeat(4, () => `<div class="sk-stack">${L('60%', 12)}${L('32px', 26)}${L('80%', 12)}</div>`)}</div>
    <div class="sk-home-cols">${repeat(2, () => `<div class="sk-box sk-stack">${L('40%', 18)}${repeat(3, () => L('100%', 44, ';margin-top:var(--sp-sm)'))}</div>`)}</div>`,
  exp: n => `<div class="sk-cards">${repeat(n, () => `<div class="sk-surface sk-stack">
    ${L('45%', 12)}${L('80%', 20)}${L('38%', 26)}${L('100%', 8, ';margin-top:var(--sp-sm)')}${L('62%', 12)}</div>`)}</div>`,
  sample: n => repeat(n, () => `<div class="sk-surface sk-sample">${L('100%', 0, ';height:auto;border-radius:0')}
    <div class="sk-stack">${L('35%', 12)}${L('85%', 18)}${L('60%', 13)}${L('45%', 12, ';margin-top:auto')}</div></div>`),
  task: n => repeat(n, () => `<div class="sk-surface sk-stack sk-task">${L('30%', 11)}${L('88%', 15)}${L('52%', 11)}</div>`),
  tag: n => repeat(n, () => `<div class="sk-surface sk-stack">${L('36%', 14)}
    <div class="sk-row">${repeat(4, i => L(`${56 + (i % 3) * 14}px`, 26, ';border-radius:var(--rd-pill)'))}</div>${L('100%', 40, ';border-radius:var(--rd-base)')}</div>`),
  client: () => `
    <div class="sk-head sk-stack">${L('80px', 12)}${L('220px', 30)}${L('320px', 13)}</div>
    <div class="sk-cards">${repeat(3, () => `<div class="sk-surface sk-stack">${L('30%', 14)}${repeat(3, () => L('100%', 14))}${L('70%', 14)}</div>`)}</div>`,
  chat: n => repeat(n, i => `<div class="sk-msg${i % 2 ? ' mine' : ''}"><div class="sk-bubble">${L(`${120 + (i * 53) % 110}px`, 14)}</div></div>`),
};
export const skeleton = (kind, { n = 3, label = '正在读取…' } = {}) =>
  `<div class="sk-group" role="status" aria-busy="true"><span class="sr-only">${label}</span>${SKELETON[kind](n)}</div>`;

export const skeletonRows = (n = 5, cols = 6) => Array.from({ length: n }, () => `
  <tr class="sk-row">${Array.from({ length: cols }, () =>
    '<td><div class="sk-line" style="height:14px"></div></td>').join('')}</tr>`).join('');
