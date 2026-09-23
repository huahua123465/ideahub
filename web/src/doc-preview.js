/**
 * Markdown（.md）和 Word（.docx）附件在页面里直接阅读。
 *
 * 服务端把 .md 当纯文本回给浏览器，直接点开只能看到一屏井号和星号；
 * .docx 浏览器根本打不开，点了只会下载。这里做法同 sheet-preview.js：
 * 全局拦截指向 /api/files/<id>、文件名是 .md / .docx 的普通左键点击，弹出阅读浮层，
 * 右上角可以下载（Markdown 还能切「原文」）；
 * Ctrl/⌘/Shift 点、中键点、带 ?download=1 的「下载」链接照旧交给浏览器。
 * 老格式 .doc 是二进制格式，浏览器里没有靠谱的解析办法，不接管，点了照旧下载。
 *
 * 文件是别人上传的、不可信的：
 * - Markdown 用 marked 渲染后过一遍 DOMPurify —— Markdown 里可以直接写 HTML，不消毒就是 XSS；
 * - Word 用 docx-preview 按页排版（字体、表格、图片、页眉页脚都保留），它是逐个节点建 DOM、
 *   不拼 HTML 字符串，但超链接地址来自文档本身，渲染完再把非 http(s)/mailto 的链接去掉。
 * 两套库各打成一个文件放在 /vendor/ 下，只在第一次预览对应格式时按需加载，不进首屏的 app.js。
 *
 * 浮层复用表格预览的外壳样式（.sheet-preview / .sp-*），层级、Esc 只关自己、
 * 叠在聊天面板上不把面板关掉，这些行为和表格预览一致。
 */
import { esc } from './util.js';

const MD_MODULE = '/vendor/markdown/markdown.min.mjs';
const DOCX_MODULE = '/vendor/docx/docx-preview.min.mjs';
const DOC_FILE_RE = /\.(md|markdown|docx)$/i;
const FILE_URL_RE = /^\/api\/files\/\d+$/;
const MAX_CHARS = 1_000_000;   // 超出只排版前面这些，几 MB 的日志导出排版会卡住手机

const loaders = {};
let box = null;
let kind = 'md';             // 'md' | 'docx'
let text = '';               // Markdown 原文，切「原文 / 排版」时用
let mode = 'render';
let seq = 0;                 // 连点两个文件时，只认最后一次打开的结果
let returnFocus = null;

/** 按需加载，失败了清掉缓存，网络抖了一下的话下次点还能重试 */
function load(url, init) {
  if (!loaders[url]) {
    loaders[url] = import(url).then(m => { init?.(m); return m; }).catch(err => {
      delete loaders[url];
      throw err;
    });
  }
  return loaders[url];
}

const mdLib = () => load(MD_MODULE, m => {
  // 文档里的链接一律新窗口打开，别把 IdeaHub 本身导航走
  m.DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
});
const docxLib = () => load(DOCX_MODULE);

/** 这个链接该不该由预览接管。返回 { url, name } 或 null */
function previewTarget(a) {
  if (!a || a.hasAttribute('download')) return null;
  let url;
  try { url = new URL(a.getAttribute('href') || '', location.href); } catch { return null; }
  if (url.origin !== location.origin || !FILE_URL_RE.test(url.pathname)) return null;
  if (url.searchParams.get('download') === '1') return null;
  const name = (a.dataset.fileName || a.querySelector('.fname')?.textContent || a.textContent || '').trim();
  if (!DOC_FILE_RE.test(name)) return null;
  return { url: url.pathname, name };
}

/** 装一次就行，main.js 启动时调用 */
export function bindDocPreview() {
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = previewTarget(e.target.closest?.('a[href]'));
    if (!target) return;
    e.preventDefault();
    openDocPreview(target);
  });
}

function build() {
  if (box) return;
  box = document.createElement('div');
  box.className = 'sheet-preview doc-preview';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'docPreviewTitle');
  box.innerHTML = `
    <div class="sp-panel">
      <header class="sp-head">
        <div class="sp-title"><small class="doc-kind">文档预览</small><b id="docPreviewTitle"></b></div>
        <button class="btn btn-ghost md-mode" type="button" aria-pressed="false" disabled>原文</button>
        <a class="btn btn-ghost sp-download" href="#">下载</a>
        <button class="sp-close" type="button" aria-label="关闭预览">×</button>
      </header>
      <div class="sp-note" role="status" aria-live="polite" hidden></div>
      <div class="sp-body doc-scroll" tabindex="0"></div>
    </div>`;
  document.body.appendChild(box);

  box.querySelector('.sp-close').addEventListener('click', closeDocPreview);
  box.addEventListener('click', e => { if (e.target === box) closeDocPreview(); });
  box.querySelector('.md-mode').addEventListener('click', () => {
    mode = mode === 'render' ? 'source' : 'render';
    paintMd();
  });
  document.addEventListener('keydown', e => {
    if (!box.classList.contains('on')) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeDocPreview(); return; }
    if (e.key === 'Tab') trapFocus(e);
  }, true);
  // Word 页面是固定的 A4 宽，窗口变窄（手机横竖屏切换）时重新缩放
  window.addEventListener('resize', () => { if (box.classList.contains('on') && kind === 'docx') fitDocx(); });
}

function trapFocus(e) {
  const items = [...box.querySelectorAll('a[href],button:not([disabled]),[tabindex="0"]')]
    .filter(el => el.getClientRects().length && !el.closest('.docx-host'));
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

function setNote(msg) {
  const note = box.querySelector('.sp-note');
  note.textContent = msg;
  note.className = `sp-note${msg ? ' warn' : ''}`;
  note.hidden = !msg;
}

export async function openDocPreview({ url, name }) {
  build();
  const my = ++seq;
  kind = /\.docx$/i.test(name) ? 'docx' : 'md';
  text = '';
  mode = 'render';
  returnFocus = document.activeElement;
  box.classList.toggle('is-docx', kind === 'docx');
  box.querySelector('.doc-kind').textContent = kind === 'docx' ? 'Word 预览' : '文档预览';
  box.querySelector('#docPreviewTitle').textContent = name || '文档';
  box.querySelector('.sp-download').href = `${url}?download=1`;
  const modeBtn = box.querySelector('.md-mode');
  modeBtn.hidden = kind === 'docx';
  modeBtn.disabled = true;
  modeBtn.textContent = '原文';
  modeBtn.setAttribute('aria-pressed', 'false');
  box.querySelector('.sp-body').innerHTML = '<div class="sp-loading">正在读取文档…</div>';
  setNote('');
  box.classList.add('on');
  document.body.classList.add('sheet-preview-open');
  box.querySelector('.sp-close').focus();

  try {
    if (kind === 'docx') {
      const [lib, buffer] = await Promise.all([docxLib(), fetchFile(url)]);
      if (my !== seq) return;
      await paintDocx(lib, buffer, my);
    } else {
      const [, buffer] = await Promise.all([mdLib(), fetchFile(url)]);
      if (my !== seq) return;
      text = decodeText(buffer).replace(/^﻿/, '');
      if (text.length > MAX_CHARS) {
        setNote(`文档有 ${text.length.toLocaleString()} 个字符，只显示前 ${MAX_CHARS.toLocaleString()} 个。完整内容请下载后查看。`);
        text = text.slice(0, MAX_CHARS);
      }
      modeBtn.disabled = false;
      await paintMd();
    }
  } catch (err) {
    if (my !== seq) return;
    box.querySelector('.sp-body').innerHTML = `
      <div class="sp-error">
        <b>预览不了这个文件</b>
        <span>${esc(err?.message || '读取失败')}</span>
        <span class="dim">可以点右上角「下载」后用${kind === 'docx' ? ' Word 或 WPS ' : '文本编辑器'}打开。</span>
      </div>`;
  }
}

export function closeDocPreview() {
  if (!box?.classList.contains('on')) return;
  seq++;                       // 还在读的那次作废
  box.classList.remove('on');
  // 表格预览也可能开着（理论上不会同时开），只在它没开时才恢复页面滚动
  if (!document.querySelector('.sheet-preview.on')) document.body.classList.remove('sheet-preview-open');
  box.querySelector('.sp-body').innerHTML = '';   // Word 里的图片是 base64，别一直占着内存
  text = '';
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

async function fetchFile(url) {
  let r;
  try { r = await fetch(url, { credentials: 'include' }); }
  catch { throw new Error('网络连接失败，请稍后再试'); }
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json())?.error || ''; } catch { /* 不是 JSON */ }
    if (r.status === 401) throw new Error('登录已过期，请刷新页面重新登录');
    throw new Error(msg || `读取失败（${r.status}）`);
  }
  return r.arrayBuffer();
}

/** 同 CSV：先按 UTF-8 严格解，解不通再按 GBK（Windows 记事本老版本存的是 GBK） */
function decodeText(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('gbk').decode(buffer); }
}

async function paintMd() {
  const body = box.querySelector('.sp-body');
  const modeBtn = box.querySelector('.md-mode');
  modeBtn.textContent = mode === 'render' ? '原文' : '排版';
  modeBtn.setAttribute('aria-pressed', String(mode === 'source'));
  body.scrollTop = 0;
  if (!text.trim()) {
    body.innerHTML = '<div class="sp-empty">这个文档是空的。</div>';
    return;
  }
  if (mode === 'source') {
    body.innerHTML = `<pre class="md-source">${esc(text)}</pre>`;
    return;
  }
  const { marked, DOMPurify } = await mdLib();
  const html = marked.parse(text, { gfm: true, breaks: true, async: false });
  body.innerHTML = `<article class="md-body">${DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'] })}</article>`;
}

async function paintDocx(lib, buffer, my) {
  const body = box.querySelector('.sp-body');
  const host = document.createElement('div');
  host.className = 'docx-host';
  try {
    // 样式也写进 host，关闭时跟着内容一起清掉，不在 <head> 里越积越多
    await lib.renderAsync(buffer, host, host, {
      className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true,
      useBase64URL: true, renderHeaders: true, renderFooters: true,
      renderFootnotes: true, renderEndnotes: true, renderComments: false, experimental: false,
    });
  } catch {
    throw new Error('文件已损坏，或者不是 Word 文档（老格式 .doc 请另存为 .docx）');
  }
  if (my !== seq) return;
  sanitizeDocx(host);
  body.innerHTML = '';
  body.scrollTop = 0;
  body.appendChild(host);
  if (!host.querySelector('section.docx')) {
    body.innerHTML = '<div class="sp-empty">这个文档是空的。</div>';
    return;
  }
  fitDocx();
}

/** 超链接地址来自文档本身：只留 http(s) / mailto / 文内锚点，外链新窗口打开 */
function sanitizeDocx(host) {
  for (const el of host.querySelectorAll('script,iframe,object,embed,form')) el.remove();
  for (const el of host.querySelectorAll('*')) {
    for (const { name } of [...el.attributes]) if (/^on/i.test(name)) el.removeAttribute(name);
  }
  for (const a of host.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href').trim();
    if (href.startsWith('#')) continue;
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  }
}

/**
 * Word 页面是按纸张宽度排的（A4 约 794px），窗口比它窄一点时整体缩小，免得左右拖。
 * 手机（≤760px）不缩放：缩到一半字就看不清了，那边由样式改成随屏幕重排。
 */
function fitDocx() {
  const body = box.querySelector('.sp-body');
  const wrapper = body.querySelector('.docx-wrapper');
  if (!wrapper) return;
  wrapper.style.zoom = '';
  if (window.innerWidth <= 760) return;
  const pageWidth = Math.max(0, ...[...wrapper.querySelectorAll(':scope > section.docx')].map(s => s.offsetWidth));
  if (!pageWidth) return;
  const scale = Math.min(1, (body.clientWidth - 48) / pageWidth);   // 两侧各留 24px 灰边
  if (scale < 1) wrapper.style.zoom = String(Math.max(scale, 0.3));
}
