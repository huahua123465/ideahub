/**
 * 采纳庆祝。
 *
 * 采纳是全系统最有仪式感的动作 —— 一条灵感从「有人随口一说」变成「立项，有编号，有负责人」。
 * 原来这件事只有一句 toast，太轻了。同事采纳彼此的灵感时，这一下反馈直接影响
 * 他们愿不愿意再点第二次。
 *
 * 彩纸是纯 DOM 的，不引第三方库 —— 这个项目全部依赖只有一个 pg，值得保持。
 */
import { reduced } from '../anim.js';
import { ICON } from '../icons.js';

const CONFETTI_COLORS = ['#2563eb', '#7c5cff', '#0f9d58', '#d68910', '#e07a3f', '#dc4c3f'];

/**
 * @param {{code:string, owner:string}} detail
 * @returns {Promise<void>} 动画播完才 resolve，调用方可以接着弹 toast
 */
export function celebrateAdopt({ code, owner }) {
  const layer = document.createElement('div');
  layer.className = 'fx-celebrate';
  layer.innerHTML = `
    <div class="fx-card">
      <div class="fx-tick">${ICON.check}</div>
      <div class="fx-lab">已采纳并立项</div>
      <div class="fx-code"></div>
      <div class="fx-owner">负责人 ${escapeText(owner || '未指派')}</div>
    </div>`;
  document.body.appendChild(layer);

  const codeEl = layer.querySelector('.fx-code');
  const text = String(code || '');

  if (reduced()) {
    codeEl.textContent = text;
    return hold(layer, 1200);
  }

  requestAnimationFrame(() => layer.classList.add('on'));
  confetti(layer);

  // 编号逐位打出：这串编号是这条灵感的「身份证」，值得一个字一个字地看着它生成
  let i = 0;
  const typer = setInterval(() => {
    codeEl.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typer);
  }, 45);

  return hold(layer, 900 + text.length * 45);
}

function hold(layer, ms) {
  return new Promise(resolve => {
    setTimeout(() => {
      layer.classList.add('out');
      setTimeout(() => { layer.remove(); resolve(); }, 320);
    }, ms);
  });
}

function confetti(layer) {
  const frag = document.createDocumentFragment();
  for (let n = 0; n < 42; n++) {
    const bit = document.createElement('i');
    bit.className = 'fx-bit';
    // 从中心偏上撒出去，左右随机、落点随机，避免看起来像一排整齐的方块往下掉
    bit.style.cssText = `
      --x:${(Math.random() - 0.5) * 620}px;
      --y:${180 + Math.random() * 320}px;
      --rot:${(Math.random() - 0.5) * 900}deg;
      --delay:${Math.random() * 260}ms;
      --dur:${1100 + Math.random() * 700}ms;
      background:${CONFETTI_COLORS[n % CONFETTI_COLORS.length]};
      width:${6 + Math.random() * 5}px;height:${9 + Math.random() * 6}px`;
    frag.appendChild(bit);
  }
  layer.appendChild(frag);
}

/** 负责人名字来自数据库，插进 DOM 前转义 */
function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
