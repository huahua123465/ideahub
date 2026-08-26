/**
 * 移动端可连续滚动的 PDF.js 阅读器。
 * 原生 iframe 在 iOS/Safari 常只画第一页；这里把每页渲染成普通 Canvas，
 * 页面容器使用标准触摸滚动，不依赖浏览器内置 PDF 插件。
 */
let pdfjsPromise = null;
let session = 0;
let loadingTask = null;
let documentTask = null;
let observer = null;
let renderTasks = new Set();
const PDFJS_MODULE = '/vendor/pdfjs/pdf.min.mjs';
const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';

async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_MODULE).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

export function closePdf() {
  session++;
  observer?.disconnect(); observer = null;
  for (const task of renderTasks) task.cancel?.();
  renderTasks = new Set();
  loadingTask?.destroy?.(); loadingTask = null;
  documentTask?.destroy?.(); documentTask = null;
}

/**
 * @param {HTMLElement} container 可滚动的分页容器
 * @param {string} url 受登录保护的同源 PDF 地址
 */
export async function openPdf(container, url, { onProgress, onReady, onPageChange } = {}) {
  closePdf();
  const own = session;
  container.innerHTML = '';
  container.scrollTop = 0;

  const lib = await pdfjs();
  if (own !== session) return;
  loadingTask = lib.getDocument({ url, withCredentials: true, rangeChunkSize: 256 * 1024 });
  loadingTask.onProgress = ({ loaded, total }) => {
    if (own === session && total) onProgress?.(Math.min(100, Math.round(loaded / total * 100)));
  };
  const pdf = await loadingTask.promise;
  if (own !== session) { pdf.destroy(); return; }
  documentTask = pdf;

  const first = await pdf.getPage(1);
  if (own !== session) return;
  const base = first.getViewport({ scale: 1 });
  const ratio = `${base.width} / ${base.height}`;
  const shells = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const shell = document.createElement('section');
    shell.className = 'learning-pdf-page';
    shell.dataset.page = String(n);
    shell.style.aspectRatio = ratio;
    shell.setAttribute('aria-label', `第 ${n} 页，共 ${pdf.numPages} 页`);
    shell.innerHTML = `<span>${n}</span><div class="learning-page-wait">第 ${n} 页</div>`;
    container.appendChild(shell);
    shells.push(shell);
  }

  const rendered = new Set();
  const rendering = new Set();
  async function renderPage(n) {
    if (own !== session || rendered.has(n) || rendering.has(n)) return;
    rendering.add(n);
    let task = null;
    try {
      const page = n === 1 ? first : await pdf.getPage(n);
      if (own !== session) return;
      const natural = page.getViewport({ scale: 1 });
      const cssWidth = Math.max(280, Math.min(container.clientWidth - 24, 1080));
      const cssScale = cssWidth / natural.width;
      const pixelRatio = Math.min(Number(devicePixelRatio) || 1, 1.75);
      const viewport = page.getViewport({ scale: cssScale * pixelRatio });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.round(viewport.width / pixelRatio)}px`;
      canvas.style.height = `${Math.round(viewport.height / pixelRatio)}px`;
      task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
      renderTasks.add(task);
      await task.promise;
      if (own !== session) return;
      const shell = shells[n - 1];
      shell.querySelector('.learning-page-wait')?.remove();
      shell.appendChild(canvas);
      shell.style.aspectRatio = 'auto';
      shell.classList.add('ready');
      rendered.add(n);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException' && own === session) {
        const wait = shells[n - 1]?.querySelector('.learning-page-wait');
        if (wait) wait.textContent = `第 ${n} 页加载失败`;
      }
    } finally {
      if (task) renderTasks.delete(task);
      rendering.delete(n);
    }
  }

  observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) renderPage(Number(entry.target.dataset.page));
  }, { root: container, rootMargin: '900px 0px', threshold: .01 });
  shells.forEach(shell => observer.observe(shell));

  let scrollFrame = 0;
  container.onscroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const top = container.getBoundingClientRect().top + 24;
      let current = 1, distance = Infinity;
      for (const shell of shells) {
        const d = Math.abs(shell.getBoundingClientRect().top - top);
        if (d < distance) { distance = d; current = Number(shell.dataset.page); }
      }
      onPageChange?.(current, pdf.numPages);
    });
  };

  onReady?.(pdf.numPages);
  onPageChange?.(1, pdf.numPages);
  await Promise.all([renderPage(1), pdf.numPages > 1 ? renderPage(2) : null]);
}
