/**
 * 看大图。
 *
 * 两处在用：工作提交的附件缩略图（审核人要看清截图里的字），
 * 以及对标拆解里图文笔记的整叠图。抽成独立模块是因为 board.js 和 bench.js
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
  paint();
  lbox.classList.add('on');
}

export function closeLightbox() {
  if (!lbox) return;
  lbox.classList.remove('on');
  lbox.querySelector('.lb-img').src = '';   // 别让大图一直占着内存
  items = [];
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
  lbox.querySelector('.lb-img').src = it.url;
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
    <div class="lb-foot"><span class="lb-count"></span><span class="lb-name"></span></div>
    <button class="lb-close" type="button" aria-label="关闭">×</button>`;

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
