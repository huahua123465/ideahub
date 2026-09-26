/**
 * 浏览器报错上报（2026-09-26）：POST /api/client-errors
 *
 * 用户浏览器里出的错，原来我们完全看不见（「刷新后配色恢复默认」就一直查不到原因）。
 * 前端 errlog.js 把 window 的 error / unhandledrejection 收集起来发到这里，写进服务器日志：
 *   docker compose logs api | grep client-error
 *
 * - 只记日志，不进数据库；只收已登录用户的（登录闸门挡在前面），日志里带用户 id 方便回访。
 * - 每人每 10 分钟最多 30 条，某个页面死循环报错也刷不爆日志。
 * - 消息、堆栈、地址都截断并去掉换行；地址去掉查询串和 # 之后的部分（可能带分享 token）。
 *   不记请求头里的 Cookie，也不回显请求体。
 */
import { readJson, sendJson, HttpError } from '../lib/http.mjs';
import { currentUser } from '../lib/auth.mjs';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const MAX_BODY = 16 * 1024;
const recent = new Map();   // userId → { start, count }

const clip = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/"/g, "'").slice(0, n);
const place = v => clip(v, 400).replace(/[?#].*$/, '');
const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);

/** 这一批里还能收几条（超出的直接丢掉，不算错误） */
function allowance(userId, want) {
  const now = Date.now();
  let r = recent.get(userId);
  if (!r || now - r.start > WINDOW_MS) { r = { start: now, count: 0 }; recent.set(userId, r); }
  const n = Math.max(0, Math.min(want, MAX_PER_WINDOW - r.count));
  r.count += n;
  if (recent.size > 5000) for (const [k, v] of recent) if (now - v.start > WINDOW_MS) recent.delete(k);
  return n;
}

export function mount(router) {
  router.post('/api/client-errors', async (req, res) => {
    const me = await currentUser(req);
    const body = await readJson(req, MAX_BODY);
    const items = (Array.isArray(body?.items) ? body.items : [body])
      .filter(it => it && typeof it === 'object' && typeof it.message === 'string' && it.message.trim())
      .slice(0, 10);
    const n = allowance(Number(me.id), items.length);
    if (items.length && !n) throw new HttpError(429, '报错上报太频繁了，稍后再试');
    for (const it of items.slice(0, n)) {
      console.warn(`[client-error] user=${me.id} kind=${clip(it.kind, 20)} view=${clip(it.view, 40)} v=${clip(it.version, 24)}`
        + ` at=${place(it.source)}:${num(it.line)}:${num(it.col)} msg="${clip(it.message, 400)}"`
        + ` page=${place(it.page)} ua="${clip(req.headers['user-agent'], 180)}"`);
      if (it.stack) console.warn(`[client-error]   stack: ${clip(it.stack, 1500)}`);
    }
    sendJson(res, 202, { ok: true, accepted: n });
  });
}
