/**
 * 快捷键一览（2026-09-26）：按「?」、头像菜单「快捷键」或命令面板里的「快捷键一览」打开。
 *
 * 站里已经有 Ctrl K、/、F、E、Esc 这些快捷键，但没有地方能看到，只有碰巧知道的人会用。
 * 这里只列真实存在的快捷键（实现分别在 main.js 的全局 keydown、dashboard.js、palette.js），加新快捷键时记得补一行。
 * 弹窗：焦点进来落在「知道了」上，Esc / 点遮罩 / 点按钮关掉，焦点回到打开前的位置。
 */
import { esc } from '../util.js';

let root = null;
let returnFocus = null;

const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');

function groups() {
  const mod = isMac() ? '⌘' : 'Ctrl';
  return [
    ['全站', [
      [[mod, 'K'], '打开命令面板：跳页面、新建、换配色、搜资料'],
      [['/'], '直接聚焦顶栏搜索框'],
      [['?'], '打开这张快捷键表'],
      [['Esc'], '关掉弹窗、抽屉和面板'],
    ]],
    ['首页', [
      [['F'], '专注模式（25 分钟计时，只看待办）'],
      [['E'], '编辑首页布局（宽屏上可用）'],
    ]],
    ['命令面板和搜索框里', [
      [['↑', '↓'], '上下选择'],
      [['Enter'], '执行命令 / 打开资料'],
    ]],
  ];
}

export const isShortcutsOpen = () => !!root;

export function openShortcuts() {
  if (root) return;
  returnFocus = document.activeElement;
  root = document.createElement('div');
  root.className = 'kbd-layer';
  root.innerHTML = `<div class="kbd-scrim" data-kbd-close></div>
    <div class="kbd-dialog" role="dialog" aria-modal="true" aria-labelledby="kbdTitle">
      <header><h2 id="kbdTitle">快捷键</h2><small>在输入框里打字时不会触发</small></header>
      ${groups().map(([title, rows]) => `<section>
        <h3>${esc(title)}</h3>
        <dl>${rows.map(([keys, text]) => `<div><dt>${keys.map(k => `<kbd>${esc(k)}</kbd>`).join('<span>+</span>')}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>
      </section>`).join('')}
      <footer><button type="button" class="btn btn-primary" data-kbd-close>知道了</button></footer>
    </div>`;
  document.body.appendChild(root);
  // 「↑ ↓」这一行的两个键之间不是「同时按」，不画加号
  root.querySelectorAll('dt').forEach(dt => { if (dt.textContent.includes('↑')) dt.querySelector('span')?.remove(); });
  root.addEventListener('click', e => { if (e.target.closest('[data-kbd-close]')) closeShortcuts(); });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeShortcuts(); }
    if (e.key === 'Tab') e.preventDefault();   // 弹窗里只有一个按钮，焦点不跑到后面被遮住的页面上
  });
  root.querySelector('footer .btn').focus();
}

export function closeShortcuts() {
  if (!root) return;
  root.remove();
  root = null;
  returnFocus?.focus?.({ preventScroll: true });
}
