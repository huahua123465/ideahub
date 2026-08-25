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
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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

export const skeletonRows = (n = 5, cols = 6) => Array.from({ length: n }, () => `
  <tr class="sk-row">${Array.from({ length: cols }, () =>
    '<td><div class="sk-line" style="height:14px"></div></td>').join('')}</tr>`).join('');
