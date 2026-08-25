/**
 * 热更新的连接层。
 *
 * 页面开着的时候自己保持最新，不用手动刷新浏览器。优先用 SSE（后端 /api/events）
 * 秒级收推送；连不上就退回轮询，慢一点但一定能用。
 *
 * 对外只有 start() 和一个 EventTarget，各视图自己订阅 —— 和 drawer.events /
 * modal.events 是同一套习惯，main.js 里接线的地方能排在一起看。
 */
import { state } from './api.js';

export const events = new EventTarget();

const SSE_URL = '/api/events';
const POLL_MS = 20_000;          // 降级轮询间隔
const WATCHDOG_MS = 60_000;      // 超过这么久没动静（含心跳）就判定连接死了
const RETRY_SSE_MS = 120_000;    // 降级之后多久再试一次推送

let es = null;
let pollTimer = null;
let watchdogTimer = null;
let retryTimer = null;
let lastBeat = 0;
let bootId = null;
let started = false;

const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

/** 「去把数据拉一遍」。轮询模式下没有具体事件，就发这个让各视图各自刷新 */
const emitSweep = reason => emit('sweep', { reason });

export function start() {
  if (started) return;
  // 演示模式（后端没连上，界面跑在内置假数据上）没有推送可言，也不该空转轮询
  if (state.mode === 'mock') return;
  started = true;

  document.addEventListener('visibilitychange', onVisibility);
  // 只有真正离开页面才断连接。切标签页不算离开 —— 见 onVisibility 的说明
  window.addEventListener('pagehide', stopAll);
  connect();
}

/* ---------------- SSE ---------------- */

function connect() {
  if (es) return;
  clearTimeout(retryTimer);
  stopPolling();

  try {
    // 同源，cookie 自动带。开发时前端在 5173、后端在 3000 才需要 withCredentials。
    es = location.port === '5173'
      ? new EventSource(`${location.protocol}//${location.hostname}:3000${SSE_URL}`, { withCredentials: true })
      : new EventSource(SSE_URL);
  } catch {
    return degrade();
  }

  beat();
  startWatchdog();

  es.addEventListener('open', beat);

  es.addEventListener('hello', e => {
    beat();
    const d = safeParse(e.data);
    // bootId 变了 = 后端重启过，中间发生的事我们一概不知道，老老实实全量重拉
    if (bootId && d?.bootId && d.bootId !== bootId) emitSweep('restart');
    bootId = d?.bootId ?? bootId;
  });

  // 后端明确告诉我们「续不上了」
  es.addEventListener('reset', () => { beat(); emitSweep('reset'); });
  // 后端正在优雅退出，别急着重连，等它起来
  es.addEventListener('bye', () => { beat(); });

  // 业务事件统一从这里进来，类型在 data 里。
  // 原来是给每种事件 addEventListener 一遍，那份白名单要手工和后端保持一致 ——
  // 后端加了 board:updated / notify:ping / chat:ping 之后忘了同步，
  // 这三种推送静默失效了很久，而且不会报任何错。
  es.onmessage = e => {
    beat();
    const d = safeParse(e.data);
    if (d?.type) emit(d.type, d.data);
  };

  es.addEventListener('error', () => {
    beat.silent = true;    // onerror 期间浏览器已经在自己重连了，先不打断它
  });
}

function beat() { lastBeat = Date.now(); }

/**
 * 看门狗。
 * EventSource 断线后会自己无限重连，光看 onerror 分不清「正在重连」和「彻底连不上」，
 * 所以判据只能是「多久没收到任何字节」—— 后端 25 秒一次心跳，60 秒还没动静就是真断了。
 */
function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (Date.now() - lastBeat > WATCHDOG_MS) degrade();
  }, 10_000);
}

function closeSse() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
  try { es?.close(); } catch { /* 已经没了 */ }
  es = null;
}

/* ---------------- 降级轮询 ---------------- */

function degrade() {
  if (pollTimer) return;
  closeSse();
  console.info('[IdeaHub] 推送连不上，已切换到轮询刷新。');
  emitSweep('degrade');
  // 后台也照常轮询：退回轮询模式后如果后台不拉，提醒就又失效了
  pollTimer = setInterval(() => emitSweep('poll'), POLL_MS);
  // 别就这么认命，过一阵子再试试推送
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, RETRY_SSE_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/* ---------------- 前后台 ---------------- */

/**
 * 切到后台不再断开连接。
 *
 * 原来是「切走就断」，理由是后台标签页不该占着一条长连接。
 * 但那和「收到消息要能提醒」直接冲突 —— 连接断了消息根本进不来，
 * 人在做别的事的时候恰恰是最需要被提醒的时候。一条 SSE 的开销
 * 远小于「同事发了消息你一小时后才看到」的代价。
 *
 * 切回前台仍然补一次全量：合上笔记本一晚上再打开时，
 * 这一次补拉才能保证看到的不是昨天的快照。
 */
function onVisibility() {
  if (!document.hidden) {
    emitSweep('visible');
    connect();
  }
}

function stopAll() {
  closeSse();
  stopPolling();
  clearTimeout(retryTimer);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
