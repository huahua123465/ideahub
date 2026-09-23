/**
 * 看大图。
 *
 * 在用的地方：工作提交的附件缩略图（审核人要看清截图里的字）、对标拆解里图文笔记的整叠图、
 * 聊天里的图片；另外 bindImagePreview() 全局接管指向 /api/files/<id> 的图片附件链接
 * （报销凭证、采购材料、客户档案附件等），点了在这里看，不再新开标签页。抽成独立模块是因为 board.js 和 bench.js
 * 互相 import 会成环 —— board 路由到 bench.open，bench 又要用这个。
 *
 * 缩略图只有一百多像素，要看清图上印的那段话必须能放大。
 * 不复用 modal/drawer：那两个都是「表单」语义，会带上一堆边框和标题栏，
 * 而看图要的是尽量大的一块黑底。
 *
 * **能左右翻**：图文笔记一条就是九张、一页一个论点，
 * 看完一张要退出去再点下一张的话，那条笔记根本读不下来。
 * 所以打开时把同一组图整个交进来，在灯箱里翻，不用回到列表。
 *
 * Esc 和方向键都用捕获阶段拦下来：页面上有个全局 Esc 会把整个编辑弹窗一起关掉，
 * 看完一张图就退出整条记录，那是没人想要的。
 */
let lbox = null;
/** 当前这一组图和看到第几张 */
let items = [];
let at = 0;
let returnFocus = null;

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;   // HEIC 除了 Safari 都显示不了，照旧下载
const FILE_URL_RE = /^\/api\/files\/\d+$/;

/** 这个链接是不是一张能在灯箱里看的附件图。返回 { url, name } 或 null */
function imageTarget(a) {
  if (!a || a.hasAttribute('download')) return null;
  let url;
  try { url = new URL(a.getAttribute('href') || '', location.href); } catch { return null; }
  if (url.origin !== location.origin || !FILE_URL_RE.test(url.pathname)) return null;
  if (url.searchParams.get('download') === '1') return null;
  const name = (a.dataset.fileName || a.querySelector('.fname')?.textContent || a.textContent || '').trim();
  return IMAGE_FILE_RE.test(name) ? { url: url.pathname, name } : null;
}

/**
 * 装一次就行，main.js 启动时调用。做法同 sheet-preview.js / doc-preview.js：
 * 只接管普通左键点击，Ctrl/⌘/中键和 ?download=1 的下载链接照旧交给浏览器。
 * 同一个附件列表里的其他图片一起交进来，能直接左右翻（一张报销单常常是好几张截图）。
 */
export function bindImagePreview() {
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest?.('a[href]');
    const target = imageTarget(link);
    if (!target) return;
    e.preventDefault();
    const list = link.closest('ul, ol, .filelist') || link.parentElement;
    const group = [...list.querySelectorAll('a[href]')].map(imageTarget).filter(Boolean);
    const i = group.findIndex(g => g.url === target.url);
    openLightbox(i >= 0 ? group : [target], Math.max(i, 0));
  });
}

/**
 * @param a  一组图 [{ url, name }]，或者单张的 url（老写法，仍然能用）
 * @param b  a 是数组时表示从第几张开始看；a 是 url 时表示这张图的名字
 */
export function openLightbox(a, b) {
  items = Array.isArray(a)
    ? a.filter(x => x?.url)
    : [{ url: a, name: b }];
  at = Array.isArray(a) ? Math.min(Math.max(Number(b) || 0, 0), items.length - 1) : 0;
  if (!items.length) return;
  build();
  if (!lbox.classList.contains('on')) returnFocus = document.activeElement;
  paint();
  lbox.classList.add('on');
  lbox.querySelector('.lb-close').focus({ preventScroll: true });
}

export function closeLightbox() {
  if (!lbox) return;
  lbox.classList.remove('on');
  lbox.querySelector('.lb-img').removeAttribute('src');   // 别让大图一直占着内存
  items = [];
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

/** 翻页。到头就停住，不绕回去 —— 图文笔记是有顺序的，
    从最后一张跳回第一张会让人以为自己看漏了中间几张。 */
function step(d) {
  const next = at + d;
  if (next < 0 || next >= items.length) return;
  at = next;
  paint();
}

function paint() {
  const it = items[at];
  lbox.classList.remove('broken');
  lbox.querySelector('.lb-img').src = it.url;
  // 附件图才有「下载」：对标拆解里那些是转存的外站图，没有下载原文件这回事
  const dl = lbox.querySelector('.lb-download');
  let path = '';
  try { path = new URL(it.url, location.href).pathname; } catch { /* 不是合法地址 */ }
  dl.hidden = !FILE_URL_RE.test(path);
  if (!dl.hidden) dl.href = `${path}?download=1`;
  lbox.querySelector('.lb-name').textContent = it.name || '';
  // 只有一张时不显示翻页件，否则界面上多两个永远点不动的箭头
  lbox.classList.toggle('single', items.length < 2);
  lbox.querySelector('.lb-count').textContent = `${at + 1} / ${items.length}`;
  lbox.querySelector('.lb-prev').disabled = at === 0;
  lbox.querySelector('.lb-next').disabled = at === items.length - 1;
  preload(at + 1); preload(at - 1);
}

/** 提前把相邻那张拉进浏览器缓存。
    服务器在洛杉矶，一次往返 200ms 起 —— 不预取的话每翻一张都要等一下。 */
function preload(i) {
  const it = items[i];
  if (it?.url) new Image().src = it.url;
}

function build() {
  if (lbox) return;
  lbox = document.createElement('div');
  lbox.className = 'lightbox';
  lbox.innerHTML = `
    <button class="lb-nav lb-prev" type="button" aria-label="上一张">‹</button>
    <button class="lb-nav lb-next" type="button" aria-label="下一张">›</button>
    <img class="lb-img" alt="">
    <div class="lb-error" role="status">图片打不开：可能没有权限，或者已经被删除了</div>
    <div class="lb-foot"><span class="lb-count"></span><span class="lb-name"></span></div>
    <a class="lb-download" href="#" hidden>下载</a>
    <button class="lb-close" type="button" aria-label="关闭">×</button>`;
  lbox.setAttribute('role', 'dialog');
  lbox.setAttribute('aria-modal', 'true');
  lbox.setAttribute('aria-label', '看图');
  lbox.querySelector('.lb-img').addEventListener('error', () => {
    if (lbox.querySelector('.lb-img').getAttribute('src')) lbox.classList.add('broken');
  });

  // 手机上左右滑翻页；两根手指是在放大，不算
  let sx = 0, sy = 0, swiping = false;
  lbox.addEventListener('touchstart', e => {
    swiping = e.touches.length === 1;
    if (swiping) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true });
  lbox.addEventListener('touchmove', e => { if (e.touches.length > 1) swiping = false; }, { passive: true });
  lbox.addEventListener('touchend', e => {
    if (!swiping) return;
    swiping = false;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });

  lbox.addEventListener('click', e => {
    if (e.target.closest('.lb-prev')) return step(-1);
    if (e.target.closest('.lb-next')) return step(1);
    // 点图片本身不关，点周围的黑底才关 —— 想放大细看的人不会希望一碰就没
    if (e.target === lbox || e.target.closest('.lb-close')) closeLightbox();
  });

  document.addEventListener('keydown', e => {
    if (!lbox?.classList.contains('on')) return;
    if (e.key === 'Escape')     { e.stopPropagation(); return closeLightbox(); }
    if (e.key === 'ArrowLeft')  { e.stopPropagation(); e.preventDefault(); return step(-1); }
    if (e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); return step(1); }
  }, true);

  document.body.append(lbox);
}
