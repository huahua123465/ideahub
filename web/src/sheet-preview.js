/**
 * Excel / CSV 附件在页面里直接预览。
 *
 * 浏览器自己打不开 xlsx，点附件只会下载 —— 同事在群里发一张选题表，
 * 每个人都得下载、再找软件打开，才能看一眼。这里点开就是一张表。
 *
 * 做法是全局拦截：任何指向 /api/files/<id> 的链接，只要文件名是 .xls/.xlsx/.csv，
 * 普通左键点击就弹预览；Ctrl/⌘/Shift 点、中键点、带 ?download=1 的「下载」链接
 * 都照旧交给浏览器。这样聊天、灵感、客户档案、报销、采购各处附件一次就接上，
 * 以后新加的附件列表只要沿用同样的链接写法也自动有预览。
 *
 * 解析库 SheetJS 约 500KB，只在第一次预览时从 /vendor/sheetjs/ 按需加载，
 * 不进首屏的 app.js。文件内容是别人上传的、不可信的：单元格一律按纯文本转义后再上屏，
 * 不用 SheetJS 自带的 HTML 输出。
 *
 * 浮层参照 lightbox.js：自己挂在 body 上、层级高过聊天面板；
 * Esc 在捕获阶段拦下，只关预览，不连带关掉底下的弹窗或抽屉。
 */
import { esc } from './util.js';

const SHEETJS_MODULE = '/vendor/sheetjs/xlsx.min.mjs';
const SHEET_FILE_RE = /\.(xlsx|xlsm|xls|csv)$/i;
const FILE_URL_RE = /^\/api\/files\/\d+$/;
const MAX_ROWS = 2000;       // 超出只显示前面这些，手机上几万行会直接卡死
const MAX_COLS = 100;

let sheetjsPromise = null;
let box = null;
let book = null;             // { names, sheets: { name: { rows, cols, totalRows, totalCols } } }
let current = '';
let seq = 0;                 // 连点两个文件时，只认最后一次打开的结果
let returnFocus = null;

function sheetjs() {
  if (!sheetjsPromise) {
    sheetjsPromise = import(SHEETJS_MODULE).catch(err => {
      sheetjsPromise = null;   // 网络抖了一下的话，下次点还能重试
      throw err;
    });
  }
  return sheetjsPromise;
}

/** 这个链接该不该由预览接管。返回 { url, name } 或 null */
function previewTarget(a) {
  if (!a || a.hasAttribute('download')) return null;
  let url;
  try { url = new URL(a.getAttribute('href') || '', location.href); } catch { return null; }
  if (url.origin !== location.origin || !FILE_URL_RE.test(url.pathname)) return null;
  if (url.searchParams.get('download') === '1') return null;
  const name = (a.dataset.fileName || a.querySelector('.fname')?.textContent || a.textContent || '').trim();
  if (!SHEET_FILE_RE.test(name)) return null;
  return { url: url.pathname, name };
}

/** 装一次就行，main.js 启动时调用 */
export function bindSheetPreview() {
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = previewTarget(e.target.closest?.('a[href]'));
    if (!target) return;
    e.preventDefault();
    openSheetPreview(target);
  });
}

function build() {
  if (box) return;
  box = document.createElement('div');
  box.className = 'sheet-preview';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'sheetPreviewTitle');
  box.innerHTML = `
    <div class="sp-panel">
      <header class="sp-head">
        <div class="sp-title"><small>表格预览</small><b id="sheetPreviewTitle"></b></div>
        <a class="btn btn-ghost sp-download" href="#">下载</a>
        <button class="sp-close" type="button" aria-label="关闭预览">×</button>
      </header>
      <div class="sp-tabs" role="tablist" aria-label="工作表" hidden></div>
      <div class="sp-note" role="status" aria-live="polite"></div>
      <div class="sp-body" tabindex="0"></div>
    </div>`;
  document.body.appendChild(box);

  box.querySelector('.sp-close').addEventListener('click', closeSheetPreview);
  // 点表格外的暗处关闭；点面板内部不算
  box.addEventListener('click', e => { if (e.target === box) closeSheetPreview(); });
  box.querySelector('.sp-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-sheet]');
    if (tab) showSheet(tab.dataset.sheet);
  });
  box.querySelector('.sp-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || !book) return;
    const i = book.names.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1);
    if (i < 0 || i >= book.names.length) return;
    e.preventDefault();
    showSheet(book.names[i]);
    box.querySelector(`[data-sheet="${CSS.escape(book.names[i])}"]`)?.focus();
  });
  document.addEventListener('keydown', e => {
    if (!box.classList.contains('on')) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeSheetPreview(); return; }
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

function setNote(text, kind = '') {
  const note = box.querySelector('.sp-note');
  note.textContent = text;
  note.className = `sp-note${kind ? ` ${kind}` : ''}`;
  note.hidden = !text;
}

export async function openSheetPreview({ url, name }) {
  build();
  const my = ++seq;
  book = null;
  current = '';
  returnFocus = document.activeElement;
  box.querySelector('#sheetPreviewTitle').textContent = name || '表格';
  const dl = box.querySelector('.sp-download');
  dl.href = `${url}?download=1`;
  box.querySelector('.sp-tabs').hidden = true;
  box.querySelector('.sp-body').innerHTML = '<div class="sp-loading">正在读取表格…</div>';
  setNote('');
  box.classList.add('on');
  document.body.classList.add('sheet-preview-open');
  box.querySelector('.sp-close').focus();

  try {
    const [XLSX, buffer] = await Promise.all([sheetjs(), fetchFile(url)]);
    if (my !== seq) return;
    book = parseBook(XLSX, buffer, name);
    if (my !== seq) return;
    paintTabs();
    showSheet(book.names[0]);
  } catch (err) {
    if (my !== seq) return;
    box.querySelector('.sp-body').innerHTML = `
      <div class="sp-error">
        <b>预览不了这个文件</b>
        <span>${esc(err?.message || '读取失败')}</span>
        <span class="dim">可以点右上角「下载」用 Excel 或 WPS 打开。</span>
      </div>`;
  }
}

export function closeSheetPreview() {
  if (!box?.classList.contains('on')) return;
  seq++;                       // 还在读的那次作废
  box.classList.remove('on');
  document.body.classList.remove('sheet-preview-open');
  box.querySelector('.sp-body').innerHTML = '';   // 大表格别一直占着内存
  book = null;
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

/**
 * CSV 没有编码标记：WPS / 老版 Excel 在中文系统上导出的是 GBK，新的一般是 UTF-8。
 * 先按 UTF-8 严格解，解不通再按 GBK —— 顺序反过来的话 UTF-8 文件会被解成乱码而不报错。
 */
function decodeCsv(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('gbk').decode(buffer); }
}

function parseBook(XLSX, buffer, name) {
  const options = {
    dense: true,
    cellDates: true,
    // Excel 的默认日期格式（内置 14 号）跟随系统区域，中文 Excel 里显示 2026/9/30；
    // SheetJS 按美式 m/d/yy 显示成 9/30/26，同事会看不懂。统一换成年月日。
    dateNF: 'yyyy-mm-dd',
    sheetRows: MAX_ROWS + 1,        // 只解析需要显示的行，大文件也不会把页面卡住
  };
  let wb;
  try {
    wb = /\.csv$/i.test(name)
      ? XLSX.read(decodeCsv(buffer).replace(/^\uFEFF/, ''), { ...options, type: 'string', raw: true })
      : XLSX.read(buffer, { ...options, type: 'array' });
  } catch {
    throw new Error('文件已损坏，或者不是 Excel 表格');
  }
  if (!wb?.SheetNames?.length) throw new Error('这个文件里没有工作表');

  const sheets = {};
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) { sheets[sheetName] = { rows: [], cols: 0, totalRows: 0, totalCols: 0 }; continue; }
    // !fullref 是截断前的真实范围；没截断时只有 !ref
    const full = XLSX.utils.decode_range(ws['!fullref'] || ws['!ref']);
    const totalRows = full.e.r - full.s.r + 1;
    const totalCols = full.e.c - full.s.c + 1;
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1, raw: false, defval: '', blankrows: true, dateNF: 'yyyy-mm-dd',
    }).slice(0, MAX_ROWS).map(row => row.slice(0, MAX_COLS).map(v => String(v ?? '')));
    // 末尾整片空白的行列不画，表格里常有被格式刷过的空行把范围撑得很大
    while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    const cols = rows.reduce((n, row) => {
      let end = row.length;
      while (end && row[end - 1] === '') end--;
      return Math.max(n, end);
    }, 0);
    sheets[sheetName] = { rows, cols, totalRows, totalCols, startCol: full.s.c, startRow: full.s.r };
  }
  return { names: wb.SheetNames, sheets };
}

function paintTabs() {
  const tabs = box.querySelector('.sp-tabs');
  tabs.hidden = book.names.length < 2;
  tabs.innerHTML = book.names.map(n => `
    <button type="button" role="tab" data-sheet="${esc(n)}" aria-selected="false" tabindex="-1">${esc(n)}</button>`).join('');
}

/** 0 → A，25 → Z，26 → AA */
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function showSheet(name) {
  if (!book?.sheets[name]) return;
  current = name;
  for (const tab of box.querySelectorAll('[data-sheet]')) {
    const on = tab.dataset.sheet === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    tab.classList.toggle('on', on);
  }
  const s = book.sheets[name];
  const body = box.querySelector('.sp-body');
  body.scrollTop = 0;
  body.scrollLeft = 0;
  if (!s.rows.length || !s.cols) {
    body.innerHTML = '<div class="sp-empty">这个工作表是空的。</div>';
    setNote('');
    return;
  }

  const head = Array.from({ length: s.cols }, (_, c) => `<th scope="col">${colName(s.startCol + c)}</th>`).join('');
  const rows = s.rows.map((row, r) => {
    let cells = '';
    for (let c = 0; c < s.cols; c++) cells += `<td>${esc(row[c] ?? '')}</td>`;
    return `<tr><th scope="row">${s.startRow + r + 1}</th>${cells}</tr>`;
  }).join('');
  body.innerHTML = `<table class="sp-table"><thead><tr><th class="sp-corner" aria-label="行号"></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;

  const cut = [];
  if (s.totalRows > MAX_ROWS) cut.push(`共 ${s.totalRows} 行，只显示前 ${MAX_ROWS} 行`);
  if (s.totalCols > MAX_COLS) cut.push(`共 ${s.totalCols} 列，只显示前 ${MAX_COLS} 列`);
  setNote(cut.length ? `${cut.join('；')}。完整内容请下载后查看。` : '', cut.length ? 'warn' : '');
}
