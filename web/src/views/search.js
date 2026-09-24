/**
 * 全局搜索（任务 5 + 任务 16）。
 * 输入时仍走快速关键词搜索；点「智能」才按相近意思搜索，避免无意消耗模型额度。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';

const events = new EventTarget();
export { events };

let timer = null;
let lastQ = '';
let lastMode = 'keyword';
let requestSeq = 0;

/**
 * 页面切换时清空全局搜索。它不是草稿字段，不应把上一个页面的关键词带到
 * 新页面；同时让已发出的旧请求失效，避免稍后返回又把搜索面板打开。
 */
/**
 * 命令（09-24）：Ctrl K 聚焦搜索框后，框里还没字时列出能直接做的事（跳到某页、新建、专注模式、换配色……），
 * 输入时把名字对得上的命令放在搜索结果上面。↑↓ 选，Enter 执行。
 * 命令清单由 main.js 通过 setCommands 提供 —— 跳页面、新建这些动作都在那边。
 */
let commandSource = () => [];
let shownCommands = [];
let activeIndex = -1;
export function setCommands(fn) { commandSource = fn; }

function matchCommands(keyword) {
  const all = commandSource();
  if (!keyword) return all.filter(c => c.featured);
  const k = keyword.toLowerCase();
  return all.filter(c => c.label.toLowerCase().includes(k) || (c.keywords || '').toLowerCase().includes(k)).slice(0, 6);
}

function commandHtml(keyword) {
  shownCommands = matchCommands(keyword);
  if (!shownCommands.length) return '';
  const hit = label => {
    if (!keyword) return esc(label);
    const i = label.toLowerCase().indexOf(keyword.toLowerCase());
    return i < 0 ? esc(label) : `${esc(label.slice(0, i))}<mark>${esc(label.slice(i, i + keyword.length))}</mark>${esc(label.slice(i + keyword.length))}`;
  };
  let group = '';
  return `<div class="searchcmds">${keyword ? '<div class="searchgrp-t">命令</div>' : ''}${shownCommands.map((c, i) => {
    const head = !keyword && c.group !== group ? `<div class="searchgrp-t">${esc(group = c.group)}</div>` : '';
    return `${head}<button type="button" class="searchcmd" data-cmd="${i}">${c.icon || ''}<span>${hit(c.label)}</span>${c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ''}</button>`;
  }).join('')}</div>`;
}

/** 框里没字时的命令列表 */
function showCommands() {
  const pop = $('#searchPop');
  const html = commandHtml('');
  activeIndex = -1;
  if (!html) { close(); return; }
  pop.innerHTML = `${html}<div class="searchcmd-foot">输入关键词搜索全站资料 · ↑↓ 选择 · Enter 执行</div>`;
  pop.hidden = false;
  pop.dataset.mode = 'commands';
}

function runCommand(i) {
  const c = shownCommands[i];
  if (!c) return;
  reset();
  $('#q')?.blur();
  c.run();
}

/** ↑↓ 在命令和搜索结果之间移动，被选中的那一行滚到看得见的地方 */
function moveActive(step) {
  const items = [...$('#searchPop').querySelectorAll('.searchcmd, .searchhit')];
  if (!items.length) return;
  activeIndex = (activeIndex + step + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
  items[activeIndex].scrollIntoView({ block: 'nearest' });
}

export function reset() {
  clearTimeout(timer);
  timer = null;
  requestSeq++;
  lastQ = '';
  lastMode = 'keyword';
  activeIndex = -1;
  const input = $('#q');
  if (input) input.value = '';
  if ($('#smartSearchBtn')) smartLoading(false);
  close();
}

export function bind() {
  const input = $('#q');
  const pop = $('#searchPop');

  // Chrome / Edge 即使看到 autocomplete="off"，刷新或从前进后退缓存恢复时仍可能
  // 把上一次输入重新塞回来。全局搜索不是草稿，不应该跨刷新保留；初始化、pageshow
  // 以及浏览器可能稍晚执行的表单恢复之后各清一次。用户已经主动聚焦输入时不打断。
  const clearIfIdle = () => { if (document.activeElement !== input) reset(); };
  reset();
  setTimeout(clearIfIdle, 160);
  window.addEventListener('pageshow', () => {
    reset();
    setTimeout(clearIfIdle, 160);
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    requestSeq++; // 正在返回的旧请求作废，不能覆盖用户刚输入的新词
    smartLoading(false);
    const keyword = input.value.trim();
    activeIndex = -1;
    if (!keyword) { showCommands(); return; }
    const cmds = commandHtml(keyword);
    if (cmds) {
      pop.hidden = false;
      pop.dataset.mode = 'search';
      pop.innerHTML = `${cmds}<div class="dim" style="padding:12px">搜索中…</div>`;
    }
    timer = setTimeout(() => run(keyword, 'keyword'), 320);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { input.blur(); close(); }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !pop.hidden) {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      const active = pop.querySelector('.is-active');
      if (active) { event.preventDefault(); active.click(); return; }
    }
    if (event.key === 'Enter') {
      clearTimeout(timer);
      run(input.value.trim(), 'keyword');
    }
  });

  $('#smartSearchBtn').addEventListener('click', event => {
    event.stopPropagation();
    clearTimeout(timer);
    const keyword = input.value.trim();
    if (!keyword) {
      input.focus();
      input.placeholder = '先输入想找的内容，再点智能';
      return;
    }
    run(keyword, 'smart');
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.search')) close();
  });

  input.addEventListener('focus', () => {
    if (!input.value.trim()) { showCommands(); return; }
    if (lastQ === input.value.trim()) pop.hidden = false;
  });
  let pressingPop = false;
  pop.addEventListener('pointerdown', () => { pressingPop = true; });
  input.addEventListener('blur', () => setTimeout(() => {
    if (!pressingPop && pop.dataset.mode === 'commands' && !input.value.trim()) close();
    pressingPop = false;
  }, 120));

  pop.addEventListener('click', event => {
    const cmd = event.target.closest('[data-cmd]');
    if (cmd) { event.preventDefault(); runCommand(Number(cmd.dataset.cmd)); return; }
    const retry = event.target.closest('.search-smart-retry');
    if (retry) {
      event.preventDefault();
      run(input.value.trim(), 'smart');
      return;
    }
    const hit = event.target.closest('[data-goto]');
    if (!hit) return;
    event.preventDefault();
    close();
    events.dispatchEvent(new CustomEvent('goto', { detail: {
      board: hit.dataset.goto, entity: hit.dataset.entity, refId: Number(hit.dataset.ref),
    } }));
  });
}

export function close() {
  const pop = $('#searchPop');
  if (pop) { pop.hidden = true; pop.dataset.mode = ''; }
}

function smartLoading(loading) {
  const button = $('#smartSearchBtn');
  button.classList.toggle('loading', loading);
  button.disabled = loading;
  const label = button.querySelector('span:last-child');
  if (label) label.textContent = loading ? '理解中' : '智能';
}

async function run(keyword, mode = 'keyword') {
  if (!keyword) return close();
  const pop = $('#searchPop');
  const runId = ++requestSeq;
  pop.hidden = false;
  pop.innerHTML = mode === 'smart'
    ? '<div class="searchmode"><b>正在理解你想找的意思…</b></div>'
    : '<div class="dim" style="padding:12px">搜索中…</div>';
  pop.dataset.mode = 'search';
  const cmds = commandHtml(keyword);
  if (cmds && mode !== 'smart') pop.innerHTML = `${cmds}<div class="dim" style="padding:12px">搜索中…</div>`;
  lastQ = keyword;
  lastMode = mode;
  if (mode === 'smart') smartLoading(true);

  let data;
  try {
    data = await api.search(keyword, mode === 'smart' ? { mode: 'smart' } : {});
  } catch (error) {
    if (runId !== requestSeq) return;
    pop.innerHTML = `<div class="dim" style="padding:12px">搜索失败：${esc(error.message)}</div>`;
    return;
  } finally {
    if (mode === 'smart' && runId === requestSeq) smartLoading(false);
  }
  if (runId !== requestSeq || lastQ !== keyword || lastMode !== mode) return;

  activeIndex = -1;
  if (!data.items.length) {
    const smartTried = data.requestedMode === 'smart';
    pop.innerHTML = `${mode === 'smart' ? '' : commandHtml(keyword)}<div class="searchempty">
      没有找到「${esc(keyword)}」
      <div class="dim" style="margin-top:5px">${smartTried
        ? '已经搜索了相近表达，可以换一个更具体的说法'
        : '关键词没有命中，可以让 AI 按相近意思继续找'}</div>
      ${smartTried ? '' : '<button class="search-smart-retry" type="button">按意思智能搜索</button>'}
    </div>`;
    return;
  }

  const byEntity = new Map();
  for (const item of data.items) {
    if (!byEntity.has(item.entity)) byEntity.set(item.entity, []);
    byEntity.get(item.entity).push(item);
  }

  const modeHead = data.mode === 'smart'
    ? `<div class="searchmode"><b>智能搜索</b><span class="search-terms">理解为：${esc((data.terms || []).slice(0, 6).join('、'))}</span></div>`
    : '';
  const warning = data.warning ? `<div class="searchwarn">${esc(data.warning)}</div>` : '';

  pop.innerHTML = `
    ${mode === 'smart' ? '' : commandHtml(keyword)}${modeHead}${warning}
    <div class="searchhead">找到 <b>${data.items.length}</b> 条 · 跨 ${byEntity.size} 个模块</div>
    ${data.groups.map(group => {
      const list = byEntity.get(group.entity) || [];
      return `<div class="searchgrp">
        <div class="searchgrp-t">${esc(group.label)} <span class="dim">${list.length}</span></div>
        ${list.map(item => `
          <a class="searchhit" href="#" data-goto="${esc(item.board)}"
             data-entity="${esc(item.entity)}" data-ref="${item.id}">
            <div class="searchhit-t">${esc(item.title)}
              <span class="tag">${esc(item.module)}</span>
              ${item.matchType === 'semantic'
                ? `<span class="tag semantic-tag">语义相关${item.matchedTerm ? ` · ${esc(item.matchedTerm)}` : ''}</span>` : ''}
              ${(item.tags || []).slice(0, 3).map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}
            </div>
            ${item.snippet ? `<div class="searchhit-s">${esc(item.snippet)}</div>` : ''}
          </a>`).join('')}
      </div>`;
    }).join('')}`;
}
