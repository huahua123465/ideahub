/**
 * 进程内事件广播 —— 页面热更新的推送侧。
 *
 * 只有一个 api 容器（compose 里没有 replicas），所以不需要 Redis 或 pg LISTEN/NOTIFY，
 * 一个 Set 装着所有挂在 /api/events 上的响应对象就够了。以后真要横向扩，
 * 把 publish() 换成往 pg NOTIFY 发、再由每个进程订阅回来即可，调用方一行都不用改。
 *
 * 设计约束：事件体里只放「哪条变了」和公共计数，绝不放 voted（那是每个用户各自的）
 * 或作者姓名（有匿名灵感，脱敏逻辑只在 dto.mjs 里维护一份）。前端拿到事件后
 * 走原来的 REST 接口重新拉数据，所以这里不存在第二套序列化，也就没有第二个泄露点。
 */
import { randomBytes } from 'node:crypto';

/** 每次进程启动都换一个。前端靠它识别「后端重启过了，之前的序号作废」 */
export const bootId = randomBytes(6).toString('hex');

const MAX_CLIENTS = 200;      // 内部工具，几十号人，留足余量
const KEEP = 200;             // 断线补发的缓冲条数

let seq = 0;
const recent = [];
const clients = new Set();

export const clientCount = () => clients.size;
export const isFull = () => clients.size >= MAX_CLIENTS;

/**
 * 拼一条 SSE 报文。
 *
 * 业务事件一律不带 event: 名字，把类型塞进 data 里。
 * 因为 EventSource 的具名事件必须在前端逐个 addEventListener ——
 * 那份白名单是手写的，后端加了新事件忘了同步前端就会静默失效，
 * 而且完全没有报错。这个坑真踩过：board:updated / notify:ping / chat:ping
 * 三个事件因为没加进白名单，实时推送一直是不通的，
 * 靠「自己操作后自己重渲染」掩盖了很久。
 *
 * 握手用的 hello / reset / bye 仍然具名 —— 它们是协议层的，不走业务分发。
 */
function frame({ id, type, data, named = false }) {
  return named
    ? `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    : `id: ${id}\ndata: ${JSON.stringify({ type, data })}\n\n`;
}

export function publish(type, data = {}) {
  const ev = { id: `${bootId}.${++seq}`, type, data };
  recent.push(ev);
  if (recent.length > KEEP) recent.shift();

  const chunk = frame(ev);
  for (const res of clients) {
    // 写失败说明对端已经走了。就地摘掉，不要让一个死连接拖垮整轮广播。
    try { res.write(chunk); } catch { clients.delete(res); }
  }
  return ev.id;
}

/**
 * 断线补发。
 * bootId 对不上就返回 null —— 那是重启前的序号，拿它续播会漏掉重启期间的所有变更。
 * 调用方收到 null 应该改发 reset，让前端老老实实做一次全量拉取。
 */
export function replaySince(lastEventId) {
  if (!lastEventId) return [];
  const [boot, n] = String(lastEventId).split('.');
  if (boot !== bootId) return null;
  const from = Number(n);
  if (!Number.isFinite(from)) return null;
  // 缓冲区已经把这一段冲掉了，同样只能全量重来
  if (recent.length && Number(recent[0].id.split('.')[1]) > from + 1) return null;
  return recent.filter(e => Number(e.id.split('.')[1]) > from);
}

export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/** 协议层的握手事件（hello / reset / bye）走具名，前端单独处理 */
export function writeFrame(res, type, data) {
  try { res.write(frame({ id: `${bootId}.${seq}`, type, data, named: true })); } catch { /* 对端没了 */ }
}

/**
 * 退出前把所有长连接主动断掉。
 * server.close() 只是停止接受新连接，不会动已经建立的连接 —— 不做这一步的话
 * 挂着页面的浏览器会让容器一直停不下来，最后被 SIGKILL。
 */
export function closeAll() {
  for (const res of clients) {
    try {
      res.write(`event: bye\ndata: {}\n\n`);
      res.end();
      res.socket?.destroy();
    } catch { /* 已经断了 */ }
  }
  clients.clear();
}
