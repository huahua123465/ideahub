/**
 * Markdown（.md）附件在页面里直接阅读。
 *
 * 服务端把 .md 当纯文本回给浏览器，直接点开只能看到一屏井号和星号。
 * 这里做法同 sheet-preview.js：全局拦截指向 /api/files/<id>、文件名是 .md 的普通左键点击，
 * 弹出排版好的阅读浮层，右上角可以切「原文」、可以下载；
 * Ctrl/⌘/Shift 点、中键点、带 ?download=1 的「下载」链接照旧交给浏览器。
 *
 * 渲染用 marked，输出再过一遍 DOMPurify —— 文件是别人上传的、不可信的，
 * Markdown 里可以直接写 HTML，不消毒就是 XSS。两个库打成一个文件放在 /vendor/markdown/，
 * 只在第一次预览时按需加载，不进首屏的 app.js。
 *
 * 浮层复用表格预览的外壳样式（.sheet-preview / .sp-*），层级、Esc 只关自己、
 * 叠在聊天面板上不把面板关掉，这些行为和表格预览一致。
 */
import { esc } from './util.js';

const MD_MODULE = '/vendor/markdown/markdown.min.mjs';
const MD_FILE_RE = /\.(md|markdown)$/i;
const FILE_URL_RE = /^\/api\/files\/\d+$/;
const MAX_CHARS = 1_000_000;   // 超出只排版前面这些，几 MB 的日志导出排版会卡住手机

let libPromise = null;
let box = null;
let text = '';               // 当前文件的原文，切「原文 / 排版」时用
let mode = 'render';
let seq = 0;                 // 连点两个文件时，只认最后一次打开的结果
let returnFocus = null;

function lib() {
  if (!libPromise) {
    libPromise = import(MD_MODULE).then(m => {
      // 文档里的链接一律新窗口打开，别把 IdeaHub 本身导航走
      m.DOMPurify.addHook('afterSanitizeAttributes', node => {
        if (node.tagName === 'A' && node.getAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
      return m;
    }).catch(err => {
      libPromise = null;       // 网络抖了一下的话，下次点还能重试
      throw err;
    });
  }
  return libPromise;
}

/** 这个链接该不该由预览接管。返回 { url, name } 或 null */
function previewTarget(a) {
  if (!a || a.hasAttribute('download')) return null;
  let url;
  try { url = new URL(a.getAttribute('href') || '', location.href); } catch { return null; }
  if (url.origin !== location.origin || !FILE_URL_RE.test(url.pathname)) return null;
  if (url.searchParams.get('download') === '1') return null;
  const name = (a.dataset.fileName || a.querySelector('.fname')?.textContent || a.textContent || '').trim();
  if (!MD_FILE_RE.test(name)) return null;
  return { url: url.pathname, name };
}

/** 装一次就行，main.js 启动时调用 */
export function bindMdPreview() {
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = previewTarget(e.target.closest?.('a[href]'));
    if (!target) return;
    e.preventDefault();
    openMdPreview(target);
  });
}

function build() {
  if (box) return;
  box = document.createElement('div');
  box.className = 'sheet-preview md-preview';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'mdPreviewTitle');
  box.innerHTML = `
    <div class="sp-panel">
      <header class="sp-head">
        <div class="sp-title"><small>文档预览</small><b id="mdPreviewTitle"></b></div>
        <button class="btn btn-ghost md-mode" type="button" aria-pressed="false" disabled>原文</button>
        <a class="btn btn-ghost sp-download" href="#">下载</a>
        <button class="sp-close" type="button" aria-label="关闭预览">×</button>
      </header>
      <div class="sp-note" role="status" aria-live="polite" hidden></div>
      <div class="sp-body md-scroll" tabindex="0"></div>
    </div>`;
  document.body.appendChild(box);

  box.querySelector('.sp-close').addEventListener('click', closeMdPreview);
  box.addEventListener('click', e => { if (e.target === box) closeMdPreview(); });
  box.querySelector('.md-mode').addEventListener('click', () => {
    mode = mode === 'render' ? 'source' : 'render';
    paint();
  });
  document.addEventListener('keydown', e => {
    if (!box.classList.contains('on')) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMdPreview(); return; }
    if (e.key === 'Tab') trapFocus(e);
  }, true);
}

function trapFocus(e) {
  const items = [...box.querySelectorAll('a[href],button:not([disabled]),[tabindex="0"]')]
    .filter(el => el.getClientRects().length);
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

export async function openMdPreview({ url, name }) {
  build();
  const my = ++seq;
  text = '';
  mode = 'render';
  returnFocus = document.activeElement;
  box.querySelector('#mdPreviewTitle').textContent = name || '文档';
  box.querySelector('.sp-download').href = `${url}?download=1`;
  const modeBtn = box.querySelector('.md-mode');
  modeBtn.disabled = true;
  modeBtn.textContent = '原文';
  modeBtn.setAttribute('aria-pressed', 'false');
  box.querySelector('.sp-body').innerHTML = '<div class="sp-loading">正在读取文档…</div>';
  setNote('');
  box.classList.add('on');
  document.body.classList.add('sheet-preview-open');
  box.querySelector('.sp-close').focus();

  try {
    const [, buffer] = await Promise.all([lib(), fetchFile(url)]);
    if (my !== seq) return;
    text = decodeText(buffer).replace(/^﻿/, '');
    if (text.length > MAX_CHARS) {
      setNote(`文档有 ${text.length.toLocaleString()} 个字符，只显示前 ${MAX_CHARS.toLocaleString()} 个。完整内容请下载后查看。`);
      text = text.slice(0, MAX_CHARS);
    }
    modeBtn.disabled = false;
    await paint();
  } catch (err) {
    if (my !== seq) return;
    box.querySelector('.sp-body').innerHTML = `
      <div class="sp-error">
        <b>预览不了这个文件</b>
        <span>${esc(err?.message || '读取失败')}</span>
        <span class="dim">可以点右上角「下载」后用文本编辑器打开。</span>
      </div>`;
  }
}

export function closeMdPreview() {
  if (!box?.classList.contains('on')) return;
  seq++;                       // 还在读的那次作废
  box.classList.remove('on');
  // 表格预览也可能开着（理论上不会同时开），只在它没开时才恢复页面滚动
  if (!document.querySelector('.sheet-preview.on')) document.body.classList.remove('sheet-preview-open');
  box.querySelector('.sp-body').innerHTML = '';
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

async function paint() {
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
  const { marked, DOMPurify } = await lib();
  const html = marked.parse(text, { gfm: true, breaks: true, async: false });
  body.innerHTML = `<article class="md-body">${DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'] })}</article>`;
}
