/**
 * GET /api/events —— 服务端推送（SSE）。
 *
 * 页面挂着这条长连接，别人提灵感 / 投票 / 评论 / 采纳时秒级收到通知，
 * 不用再手动刷新浏览器。连不上或被中间层掐断时前端会自己退回轮询，
 * 所以这条接口挂了不会让页面变成死的，只是慢一点。
 *
 * 鉴权靠 index.mjs 的全局登录闸门（/api/events 不在 PUBLIC_API 里），
 * 这里再取一次 currentUser 只是为了日志里能看出是谁连的。
 */
import { currentUser } from '../lib/auth.mjs';
import { sendJson } from '../lib/http.mjs';
import { addClient, replaySince, writeFrame, bootId, isFull, clientCount } from '../lib/bus.mjs';

const PING_EVERY = 25_000;   // 要短于常见反代/网关的 60s 空闲超时

export function mount(router) {
  router.get('/api/events', async (req, res) => {
    const me = await currentUser(req);

    // 连接数封顶。挤爆了就明确拒绝，前端会退到轮询 —— 比把所有人都拖慢好。
    if (isFull()) return sendJson(res, 503, { error: '推送连接已满，请稍后重试' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform 是给中间层看的：别压缩、别缓冲
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    // 长连接不能被 Node 的空闲超时掐掉；setNoDelay 让每条事件立刻上路而不是等攒够一个包
    req.socket?.setTimeout?.(0);
    res.socket?.setNoDelay?.(true);

    res.write(`retry: 3000\n\n`);

    // 断线补发：EventSource 重连时浏览器会自动带上 Last-Event-ID。
    // 拿不到可续的位置（后端重启过 / 缓冲区已冲掉）就发 reset，让前端全量重拉。
    const missed = replaySince(req.headers['last-event-id']);
    writeFrame(res, 'hello', { bootId, resumed: Array.isArray(missed) && missed.length > 0 });
    if (missed === null) {
      writeFrame(res, 'reset', {});
    } else {
      for (const ev of missed) {
        // 和 publish 用同一种格式（类型在 data 里），否则补发的事件前端认不出来
        res.write(`id: ${ev.id}\ndata: ${JSON.stringify({ type: ev.type, data: ev.data })}\n\n`);
      }
    }

    const remove = addClient(res);

    // 心跳。注释行（: 开头）不会触发前端的 message 事件，纯粹用来保活，
    // 同时也是前端看门狗判断「连接还活着」的依据。
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, PING_EVERY);
    ping.unref?.();

    let done = false;
    function cleanup() {
      if (done) return;
      done = true;
      clearInterval(ping);      // 漏了这行，每断一次连接就泄漏一个定时器
      remove();
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);

    console.log(`SSE   连接  ${me.name}（当前 ${clientCount()} 个）`);
  });
}
