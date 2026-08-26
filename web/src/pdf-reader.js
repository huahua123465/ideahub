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
let activeContainer = null;
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
  if (activeContainer) {
    activeContainer.onscroll = null;
    activeContainer.ontouchstart = null;
    activeContainer.ontouchmove = null;
    activeContainer.ontouchend = null;
    activeContainer.ondblclick = null;
    activeContainer = null;
  }
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
export async function openPdf(container, url, { onProgress, onReady, onPageChange, onZoomChange } = {}) {
  closePdf();
  const own = session;
  activeContainer = container;
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
  const fitWidth = Math.max(280, Math.min(container.clientWidth - 24, 1080));
  let zoom = 1;
  let qualityTimer = 0;
  const shells = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const shell = document.createElement('section');
    shell.className = 'learning-pdf-page';
    shell.dataset.page = String(n);
    shell.style.aspectRatio = ratio;
    shell.style.width = `${fitWidth}px`;
    shell.setAttribute('aria-label', `第 ${n} 页，共 ${pdf.numPages} 页`);
    shell.innerHTML = `<span>${n}</span><div class="learning-page-wait">第 ${n} 页</div>`;
    container.appendChild(shell);
    shells.push(shell);
  }

  const rendered = new Set();
  const rendering = new Set();
  async function renderPage(n, force = false) {
    if (own !== session || (!force && rendered.has(n)) || rendering.has(n)) return;
    rendering.add(n);
    let task = null;
    const renderZoom = zoom;
    try {
      const page = n === 1 ? first : await pdf.getPage(n);
      if (own !== session) return;
      const natural = page.getViewport({ scale: 1 });
      const cssWidth = fitWidth * renderZoom;
      const cssScale = cssWidth / natural.width;
      const pixelRatio = Math.min(Number(devicePixelRatio) || 1, 2);
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
      shell.querySelector('canvas')?.replaceWith(canvas) || shell.appendChild(canvas);
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
      if (own === session && renderZoom !== zoom) setTimeout(() => renderPage(n, true), 0);
    }
  }

  function refreshVisibleQuality() {
    clearTimeout(qualityTimer);
    qualityTimer = setTimeout(() => {
      if (own !== session) return;
      for (const shell of shells) {
        const box = shell.getBoundingClientRect();
        const root = container.getBoundingClientRect();
        if (box.bottom >= root.top - 500 && box.top <= root.bottom + 500) {
          renderPage(Number(shell.dataset.page), true);
        }
      }
    }, 180);
  }

  function setZoom(next, anchorX = container.clientWidth / 2, anchorY = container.clientHeight / 2) {
    const value = Math.max(1, Math.min(2.5, Math.round(next * 20) / 20));
    if (value === zoom) return;
    const factor = value / zoom;
    const oldLeft = container.scrollLeft;
    const oldTop = container.scrollTop;
    zoom = value;
    const displayWidth = Math.round(fitWidth * zoom);
    for (const shell of shells) {
      shell.style.width = `${displayWidth}px`;
      const canvas = shell.querySelector('canvas');
      if (canvas) {
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${Math.round(displayWidth * canvas.height / canvas.width)}px`;
      }
    }
    requestAnimationFrame(() => {
      container.scrollLeft = (oldLeft + anchorX) * factor - anchorX;
      container.scrollTop = (oldTop + anchorY) * factor - anchorY;
    });
    onZoomChange?.(zoom);
    refreshVisibleQuality();
  }

  let pinchDistance = 0;
  let pinchZoom = 1;
  const distance = touches => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
  container.ontouchstart = e => {
    if (e.touches.length !== 2) return;
    pinchDistance = distance(e.touches);
    pinchZoom = zoom;
  };
  container.ontouchmove = e => {
    if (e.touches.length !== 2 || !pinchDistance) return;
    e.preventDefault();
    const root = container.getBoundingClientRect();
    const x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - root.left;
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - root.top;
    setZoom(pinchZoom * distance(e.touches) / pinchDistance, x, y);
  };
  container.ontouchend = e => { if (e.touches.length < 2) pinchDistance = 0; };
  container.ondblclick = e => {
    const root = container.getBoundingClientRect();
    setZoom(zoom > 1.05 ? 1 : 1.8, e.clientX - root.left, e.clientY - root.top);
  };

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
  onZoomChange?.(zoom);
  await Promise.all([renderPage(1), pdf.numPages > 1 ? renderPage(2) : null]);
  return {
    get zoom() { return zoom; },
    setZoom,
    zoomIn: () => setZoom(zoom + .25),
    zoomOut: () => setZoom(zoom - .25),
    fit: () => setZoom(1),
  };
}
