/**
 * 定时任务：node scripts/cron.mjs
 * 两件事 —— 每 15 分钟重算热度；每天归档一次 90 天没人处理的灵感。
 *
 * 多数情况下你不需要这个脚本：后端进程里已经内置了同样的调度
 * （见 server/src/index.mjs 的 startScheduler）。
 * 这个脚本是留给「用系统 crontab 跑、不想让后端常驻定时器」的部署方式的，
 * 用之前记得给后端设 ENABLE_SCHEDULER=false，否则两边会重复跑。
 *
 * 原来这里是往 /api/maintenance/* 发 HTTP 请求。加了登录之后那两个接口
 * 也要求登录了，脚本会稳定拿到 401 —— 而且它 catch 住了错误只打一行日志，
 * 属于会静默失效的那类问题。所以改成直接连数据库，绕开 HTTP 这一层：
 * 定时任务本来也不需要「以某个人的身份」去做事。
 */
import '../server/src/lib/env.mjs';
import { query, close } from '../server/src/db/index.mjs';
import { archiveStaleIdeas } from '../server/src/routes/status.mjs';

async function hot() {
  try { await query('SELECT recalc_hot_scores()'); }
  catch (e) { console.error('[cron] 热度重算失败:', e.message); }
}

async function stale() {
  try {
    const r = await archiveStaleIdeas();
    if (r.archived) console.log(`[cron] 归档了 ${r.archived} 条超期灵感:`, r.items.join('、'));
  } catch (e) { console.error('[cron] 归档失败:', e.message); }
}

// --once：跑一遍就退出，给系统 crontab 用。不带参数则常驻。
if (process.argv.includes('--once')) {
  await hot();
  await stale();
  await close();
  console.log('[cron] 单次执行完成');
} else {
  await hot();
  setInterval(hot, 15 * 60 * 1000);
  setInterval(stale, 24 * 60 * 60 * 1000);
  console.log('[cron] 已启动：热度每 15 分钟重算，超期归档每天一次');
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => { await close().catch(() => {}); process.exit(0); });
  }
}
