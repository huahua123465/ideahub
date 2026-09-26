/**
 * 浏览器报错上报（2026-09-26）。
 *
 * 用户浏览器里出的错，原来我们完全看不见。这里接住 window 的 error / unhandledrejection，
 * 攒 1.5 秒一起发给 /api/client-errors，服务器写进日志（docker compose logs api | grep client-error）。
 *
 * - 同一个错误（消息 + 位置）一页只报一次，一页最多报 20 条，不会刷屏。
 * - 不报与我们无关的噪声：浏览器插件的脚本、跨域脚本的「Script error.」、ResizeObserver 的提示、主动取消的请求。
 * - 演示模式不报（没有后端可收）；上报本身失败就算了，不再报错，免得循环。
 * - 只带定位问题需要的东西：消息、堆栈、脚本位置、当前页面、前端版本。不带表单内容或接口返回。
 */
import { sendClientErrors, state } from './api.js';

const MAX_PER_PAGE = 20;
const seen = new Set();
let queue = [];
let timer = 0;
let count = 0;

const VERSION = document.querySelector('script[type="module"][src*="app.js"]')?.getAttribute('src')?.match(/[?&]v=([\w-]+)/)?.[1] || 'dev';

function isNoise(message, source, name) {
  if (!message || message === 'Script error.' || /ResizeObserver loop/.test(message)) return true;
  if (name === 'AbortError') return true;
  if (source && !source.startsWith(location.origin) && !source.startsWith('/')) return true;   // 插件、跨域脚本
  return false;
}

function report(kind, message, source = '', line = 0, col = 0, stack = '', name = '') {
  message = String(message || '').slice(0, 500);
  if (isNoise(message, source, name) || count >= MAX_PER_PAGE) return;
  const key = `${kind}|${message}|${source}|${line}`;
  if (seen.has(key)) return;
  seen.add(key);
  count++;
  queue.push({
    kind, message, source: String(source || '').replace(location.origin, ''), line, col,
    stack: String(stack || '').slice(0, 2000),
    view: document.documentElement.dataset.view || '',
    page: location.pathname,
    version: VERSION,
  });
  clearTimeout(timer);
  timer = setTimeout(flush, 1500);
}

function flush() {
  if (state.mode === 'mock') { queue = []; return; }
  const items = queue.splice(0, 10);
  if (items.length) sendClientErrors(items);
  if (queue.length) timer = setTimeout(flush, 1500);
}

export function initErrorReporting() {
  addEventListener('error', e => {
    // 图片、脚本加载失败也会冒出 error 事件，但没有 message；那种由各自的 onerror 处理，这里不管
    if (!e.message) return;
    report('error', e.message, e.filename, e.lineno, e.colno, e.error?.stack, e.error?.name);
  });
  addEventListener('unhandledrejection', e => {
    const r = e.reason;
    report('promise', r?.message || String(r), '', 0, 0, r?.stack, r?.name);
  });
  // 页面关掉前把攒着的发出去
  addEventListener('pagehide', () => { if (queue.length) flush(); });
}
