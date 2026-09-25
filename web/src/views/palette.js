/**
 * 命令面板（09-25，Ctrl K / ⌘K）：屏幕中间弹出来，既能执行命令（跳页面、新建、专注模式、换配色……），也能搜全站资料。
 *
 * - 命令清单和顶栏搜索框下拉里的是同一份（search.js 的 setCommands，由 main.js 提供）。
 * - 搜资料走 api.search，和顶栏搜索同一个接口；输入停 250ms 再搜，旧请求回来不覆盖新结果。
 * - 键盘：↑↓ 选、Enter 执行、Esc 关；焦点一直在输入框里，选中项用 aria-activedescendant 告诉读屏软件。
 * - 关掉后焦点回到打开前的位置。
 */
import { api } from '../api.js';
import { esc } from '../util.js';
import { ICON } from '../icons.js';
import { commands } from './search.js';

let root = null;
let input = null;
let list = null;
let items = [];
let active = 0;
let timer = null;
let seq = 0;
let found = null;
let returnFocus = null;
let onGoto = null;

/** main.js 传进来「打开某一条资料」的办法（和搜索结果、关联资料同一条路） */
export function bindPalette(gotoFn) { onGoto = gotoFn; }
export const isPaletteOpen = () => !!root;
export function togglePalette() { if (root) closePalette(); else openPalette(); }

export function openPalette() {
  if (root) return;
  returnFocus = document.activeElement;
  root = document.createElement('div');
  root.className = 'cmdk-layer';
  root.innerHTML = `<div class="cmdk-scrim" data-cmdk-close></div>
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
      <div class="cmdk-in">${ICON.search}
        <input id="cmdkInput" type="text" placeholder="搜资料，或输入要做的事…"
          role="combobox" aria-expanded="true" aria-controls="cmdkList" aria-autocomplete="list" autocomplete="off" spellcheck="false">
        <kbd>Esc</kbd></div>
      <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="命令和搜索结果"></div>
      <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
    </div>`;
  document.body.appendChild(root);
  input = root.querySelector('#cmdkInput');
  list = root.querySelector('#cmdkList');
  input.addEventListener('input', () => { active = 0; paint(); schedule(); });
  input.addEventListener('keydown', onKey);
  root.addEventListener('click', e => {
    if (e.target.closest('[data-cmdk-close]')) { closePalette(); return; }
    const it = e.target.closest('[data-i]');
    if (it) run(Number(it.dataset.i));
  });
  list.addEventListener('mousemove', e => {
    const it = e.target.closest('[data-i]');
    if (it && Number(it.dataset.i) !== active) { active = Number(it.dataset.i); mark(false); }
  });
  paint();
  input.focus();
}

export function closePalette(restore = true) {
  if (!root) return;
  root.remove();
  root = null;
  found = null;
  clearTimeout(timer);
  seq++;
  if (restore) returnFocus?.focus?.({ preventScroll: true });
}

/** 名字里对上的那几个字加下划线 */
function hl(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}
const row = (i, icon, label, tail) => `<div class="cmdk-item" role="option" id="cmdk-${i}" data-i="${i}" aria-selected="false">
  ${icon || ''}<span>${label}</span>${tail ? `<small>${esc(tail)}</small>` : ''}</div>`;

function paint() {
  if (!root) return;
  const q = input.value.trim();
  const all = commands();
  const cmds = q
    ? all.filter(c => `${c.label} ${c.keywords || ''} ${c.group}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
    : all;
  items = cmds.map(c => ({ type: 'cmd', c }));
  let html = '';
  let group = '';
  cmds.forEach((c, i) => {
    const g = q ? '命令' : c.group;
    if (g !== group) { html += `<div class="cmdk-grp">${esc(g)}</div>`; group = g; }
    html += row(i, c.icon, hl(c.label, q), c.hint);
  });
  if (q) {
    html += '<div class="cmdk-grp">资料</div>';
    if (found?.q !== q) html += `<div class="cmdk-note">正在搜「${esc(q)}」…</div>`;
    else if (found.error) html += `<div class="cmdk-note">没搜到：${esc(found.error)}</div>`;
    else if (!found.items.length) html += `<div class="cmdk-note">没有找到「${esc(q)}」相关的资料，换个说法试试</div>`;
    else for (const item of found.items.slice(0, 12)) {
      items.push({ type: 'hit', item });
      html += row(items.length - 1, ICON.file, hl(item.title || '未命名', q), item.module);
    }
  }
  list.innerHTML = html || '<div class="cmdk-note">没有对得上的命令</div>';
  active = Math.min(active, Math.max(0, items.length - 1));
  mark(true);
}

function mark(scroll) {
  list.querySelectorAll('.cmdk-item').forEach(el => {
    const on = Number(el.dataset.i) === active;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-selected', String(on));
    if (on && scroll) el.scrollIntoView({ block: 'nearest' });
  });
  if (items.length) input.setAttribute('aria-activedescendant', `cmdk-${active}`);
  else input.removeAttribute('aria-activedescendant');
}

function schedule() {
  clearTimeout(timer);
  const q = input.value.trim();
  if (!q) return;
  timer = setTimeout(async () => {
    const my = ++seq;
    try {
      const d = await api.search(q);
      if (my !== seq || !root) return;
      found = { q, items: d.items || [] };
    } catch (e) {
      if (my !== seq || !root) return;
      found = { q, items: [], error: e.message || '请稍后再试' };
    }
    paint();
  }, 250);
}

function run(i) {
  const it = items[i];
  if (!it) return;
  closePalette(false);
  if (it.type === 'cmd') it.c.run();
  else onGoto?.({ board: it.item.board, entity: it.item.entity, refId: Number(it.item.id) });
}

function onKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    mark(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    run(active);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
  } else if (e.key === 'Tab') {
    e.preventDefault();   // 面板里只有这一个输入框，Tab 不跑到后面被遮住的页面上
  }
}
