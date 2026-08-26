/**
 * 站内学习中心。
 * PDF 是部署时跟代码一起进镜像的静态资料；这里只维护目录、搜索和阅读状态，
 * 不把 Office 原文件暴露给浏览器，也不提供“点击即下载”的文件链接。
 */
import { $, esc } from '../util.js';
import { ICON } from '../icons.js';

export const events = new EventTarget();

const CATALOG = {
  framework: {
    label: '框架学习内容', short: '框架学习', kicker: '先建立判断骨架',
    intro: '用结构化课件快速掌握识别维度、判断顺序和关键分叉。',
    items: [
      ['security-foundation', '底层安全感识别', 38, '识别一个人面对不确定、距离和失控时的底层反应。'],
      ['relationship-posture', '关系姿态', 20, '观察关系中的位置、靠近方式与进退节奏。'],
      ['attachment-chain', '依附性识别判断链路', 20, '沿行为证据判断依附程度、触发点与关系代价。'],
      ['control-needs', '控制需求识别判断链路', 20, '区分秩序需要、焦虑补偿与控制型互动。'],
      ['aggression-chain', '攻击性识别判断链路', 20, '识别攻击性的表达方式、强度与关系功能。'],
      ['coquetry', '媚态', 19, '理解媚态的外在表现、关系位置和心理来源。'],
      ['coquetry-chain', '媚态识别判断链路', 10, '用判断链路把印象还原为可核对的行为线索。'],
    ],
  },
  detail: {
    label: '详细学习内容', short: '详细学习', kicker: '再进入专业详解',
    intro: '逐章阅读定义、证据、边界情况与完整判断逻辑。',
    items: [
      ['security-foundation-detail', '底层安全感识别判断链路', 40, '从具体语言、行为和关系情境深入判断安全感结构。'],
      ['self-worth-detail', '自我价值稳定性识别判断链路', 22, '识别自我价值的来源、波动方式和外部确认依赖。'],
      ['relationship-posture-detail', '关系姿态识别判断链路', 18, '详细拆解关系姿态的形成、表现与判断边界。'],
      ['attachment-detail', '依附性识别判断链路 · 专业详解', 19, '从依赖、连接和分离反应还原依附性。'],
      ['control-needs-detail', '控制需求识别判断链路 · 专业详解', 19, '判断控制需要背后的焦虑、权力与秩序机制。'],
      ['aggression-detail', '攻击性识别判断链路 · 专业详解', 19, '区分直接、间接、防御性和工具性攻击。'],
      ['coquetry-detail', '媚态识别判断链路 · 专业详解', 25, '结合完整案例理解媚态、迎合与关系策略。'],
    ],
  },
};

const PATHS = {
  'security-foundation': '/learning/files/framework/security-foundation.pdf',
  'relationship-posture': '/learning/files/framework/relationship-posture.pdf',
  'attachment-chain': '/learning/files/framework/attachment-chain.pdf',
  'control-needs': '/learning/files/framework/control-needs.pdf',
  'aggression-chain': '/learning/files/framework/aggression-chain.pdf',
  'coquetry': '/learning/files/framework/coquetry.pdf',
  'coquetry-chain': '/learning/files/framework/coquetry-chain.pdf',
  'security-foundation-detail': '/learning/files/detail/security-foundation-detail.pdf',
  'self-worth-detail': '/learning/files/detail/self-worth-detail.pdf',
  'relationship-posture-detail': '/learning/files/detail/relationship-posture-detail.pdf',
  'attachment-detail': '/learning/files/detail/attachment-detail.pdf',
  'control-needs-detail': '/learning/files/detail/control-needs-detail.pdf',
  'aggression-detail': '/learning/files/detail/aggression-detail.pdf',
  'coquetry-detail': '/learning/files/detail/coquetry-detail.pdf',
};

let section = 'framework';
let currentId = null;
let query = '';

export function setSection(next) {
  if (CATALOG[next]) section = next;
}

const currentItems = () => CATALOG[section].items;
const findItem = id => currentItems().find(x => x[0] === id) || currentItems()[0];

function remembered() {
  try {
    const state = JSON.parse(localStorage.getItem('ideahub-learning-last') || '{}');
    return state.section === section && findItem(state.id)?.[0] === state.id ? state.id : null;
  } catch { return null; }
}

function remember(id) {
  try { localStorage.setItem('ideahub-learning-last', JSON.stringify({ section, id })); }
  catch { /* 隐私模式禁用存储时不影响阅读 */ }
}

function listHTML() {
  const q = query.trim().toLowerCase();
  const list = currentItems().filter(x => !q || `${x[1]} ${x[3]}`.toLowerCase().includes(q));
  if (!list.length) return '<div class="learning-empty">没有匹配的学习资料</div>';
  return list.map(([id, title, pages, desc], i) => `
    <button class="learning-item${id === currentId ? ' on' : ''}" data-learning-id="${id}">
      <span class="learning-no">${String(i + 1).padStart(2, '0')}</span>
      <span><b>${esc(title)}</b><small>${esc(desc)}</small><em>${pages} 页</em></span>
    </button>`).join('');
}

function paintList() {
  $('#learningList').innerHTML = listHTML();
}

function openDocument(id) {
  const item = findItem(id);
  currentId = item[0];
  remember(currentId);
  paintList();

  const [_, title, pages, desc] = item;
  $('#learningDocTitle').textContent = title;
  $('#learningDocMeta').textContent = `${CATALOG[section].short} · ${pages} 页`;
  $('#learningDocDesc').textContent = desc;
  const frame = $('#learningPdf');
  const loading = $('#learningLoading');
  const main = $('#main');
  const keepScroll = main.scrollTop;
  loading.hidden = false;
  frame.title = `${title} · 站内阅读`;
  frame.onload = () => {
    loading.hidden = true;
    // Chromium 的内置 PDF 查看器加载时会尝试把 iframe 滚进视口。
    // 保留打开前的位置，首次进入就仍从学习中心标题开始，切资料也不会整页跳动。
    requestAnimationFrame(() => { main.scrollTop = keepScroll; });
  };
  frame.src = `${PATHS[currentId]}#toolbar=0&navpanes=0&view=FitH`;

  const index = currentItems().findIndex(x => x[0] === currentId);
  $('#learningPrev').disabled = index <= 0;
  $('#learningNext').disabled = index >= currentItems().length - 1;
}

function switchSection(next) {
  if (!CATALOG[next] || next === section) return;
  section = next; query = ''; currentId = null;
  render();
}

export function render() {
  const root = $('#v-learning');
  const group = CATALOG[section];
  currentId = currentId && findItem(currentId)?.[0] === currentId
    ? currentId : (remembered() || group.items[0][0]);

  root.innerHTML = `
    <section class="learning-hero">
      <button class="learning-back" data-learning-back>${ICON.back}<span>返回工作台</span></button>
      <div>
        <div class="page-kicker">${esc(group.kicker)}</div>
        <h1>${esc(group.label)}</h1>
        <p>${esc(group.intro)}</p>
      </div>
      <div class="learning-summary"><b>${group.items.length}</b><span>份资料</span><em>${group.items.reduce((n, x) => n + x[2], 0)} 页</em></div>
    </section>
    <div class="learning-tabs" role="tablist" aria-label="学习内容分类">
      ${Object.entries(CATALOG).map(([key, v]) => `<button role="tab" aria-selected="${key === section}"
        class="${key === section ? 'on' : ''}" data-learning-section="${key}">${key === 'framework' ? ICON.layers : ICON.book}${esc(v.label)}</button>`).join('')}
    </div>
    <div class="learning-layout">
      <aside class="learning-catalog">
        <label class="learning-search">${ICON.search}<input id="learningSearch" placeholder="搜索当前板块" value="${esc(query)}"></label>
        <div class="learning-list" id="learningList"></div>
      </aside>
      <article class="learning-reader">
        <header class="learning-reader-head">
          <div><span id="learningDocMeta"></span><h2 id="learningDocTitle"></h2><p id="learningDocDesc"></p></div>
          <div class="learning-nav"><button class="btn btn-ghost" id="learningPrev">上一份</button><button class="btn btn-ghost" id="learningNext">下一份</button></div>
        </header>
        <div class="learning-pdf-shell">
          <div class="learning-loading" id="learningLoading"><i></i><span>正在打开学习资料…</span></div>
          <iframe class="learning-pdf" id="learningPdf" loading="eager"></iframe>
        </div>
      </article>
    </div>`;

  root.querySelector('[data-learning-back]').onclick = () => events.dispatchEvent(new Event('back'));
  root.querySelectorAll('[data-learning-section]').forEach(btn => {
    btn.onclick = () => switchSection(btn.dataset.learningSection);
  });
  $('#learningList').addEventListener('click', e => {
    const btn = e.target.closest('[data-learning-id]');
    if (btn) openDocument(btn.dataset.learningId);
  });
  $('#learningSearch').addEventListener('input', e => { query = e.target.value; paintList(); });
  $('#learningPrev').onclick = () => {
    const i = currentItems().findIndex(x => x[0] === currentId);
    if (i > 0) openDocument(currentItems()[i - 1][0]);
  };
  $('#learningNext').onclick = () => {
    const i = currentItems().findIndex(x => x[0] === currentId);
    if (i < currentItems().length - 1) openDocument(currentItems()[i + 1][0]);
  };
  openDocument(currentId);
}
