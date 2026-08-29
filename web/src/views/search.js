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
export function reset() {
  clearTimeout(timer);
  timer = null;
  requestSeq++;
  lastQ = '';
  lastMode = 'keyword';
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
    if (!keyword) { close(); return; }
    timer = setTimeout(() => run(keyword, 'keyword'), 320);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { input.blur(); close(); }
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
    if (input.value.trim() && lastQ === input.value.trim()) pop.hidden = false;
  });

  pop.addEventListener('click', event => {
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
  if (pop) pop.hidden = true;
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

  if (!data.items.length) {
    const smartTried = data.requestedMode === 'smart';
    pop.innerHTML = `<div class="searchempty">
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
    ${modeHead}${warning}
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
