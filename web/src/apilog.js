/**
 * 左下角那个黑色浮层：把每个动作背后真实发生的 API 调用和 SQL 打出来。
 * 不是装饰 —— 演示给非技术同事看时，这一层让「点一下按钮，后端到底做了什么」变得可见。
 *
 * 默认关闭。它是给「讲解系统怎么运作」用的，日常用灵感库的人不该看到一片
 * 滚动的 SQL —— 那只会让人以为出问题了。需要演示时用下面任一方式打开：
 *
 *   1. 网址后面加 ?apilog=1        —— 临时看一次，最省事
 *   2. 控制台执行 IDEAHUB_APILOG(true) —— 记进 localStorage，之后一直开着
 *      关掉是 IDEAHUB_APILOG(false)
 */
import { esc } from './util.js';

const KEY = 'ideahub.apilog';

/** 只在打开时才记录。三个来源任一为真即可，判定只做一次。 */
const ENABLED = (() => {
  try {
    if (new URLSearchParams(location.search).has('apilog')) return true;
    if (localStorage.getItem(KEY) === '1') return true;
  } catch { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
  return window.IDEAHUB_SHOW_APILOG === true;
})();

// 演示时不用改代码，控制台一行就能开关
window.IDEAHUB_APILOG = (on) => {
  try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch {}
  location.reload();
};

const box = () => document.getElementById('apilog');
const lines = () => document.getElementById('apilines');
let hideTimer = null;

/** 每个接口对应的 SQL 说明。前端并不真的执行它们，只是把后端做的事说清楚。 */
const SQL_HINT = [
  [/^GET \/api\/ideas\?status=adopted/,      `SELECT * FROM ideas WHERE status='adopted' ORDER BY adopted_at DESC`],
  [/^GET \/api\/ideas\?.*sort=new/,          `SELECT * FROM ideas WHERE status IN ('pending','reviewing') ORDER BY created_at DESC`],
  [/^GET \/api\/ideas\?/,                    `SELECT * FROM ideas WHERE status IN ('pending','reviewing') ORDER BY hot_score DESC`],
  [/^GET \/api\/ideas\/similar/,             `SELECT title, title_similarity(title,$1) FROM ideas ORDER BY 2 DESC LIMIT 3`],
  [/^GET \/api\/ideas\/\d+$/,                `SELECT i.*, c.*, a.* FROM ideas i LEFT JOIN idea_comments c … LEFT JOIN idea_activities a …`],
  [/^POST \/api\/ideas$/,                    `BEGIN; INSERT INTO ideas(...) RETURNING id;`],
  [/^POST \/api\/ideas\/\d+\/vote/,          `INSERT INTO idea_votes ON CONFLICT DO NOTHING`],
  [/^POST \/api\/ideas\/\d+\/comments/,      `INSERT INTO idea_comments; UPDATE ideas SET comment_count=comment_count+1`],
  [/^PATCH \/api\/ideas\/\d+\/status/,       `BEGIN; SELECT … FOR UPDATE;`],
  [/^GET \/api\/stats\/overview/,            `SELECT status, count(*) FROM ideas GROUP BY status`],
];

function sqlFor(sig) {
  for (const [re, sql] of SQL_HINT) if (re.test(sig)) return sql;
  return null;
}

/** 记一条请求 */
export function logApi(method, path, status) {
  if (!ENABLED) return;
  const sig = `${method} ${path}`;
  const sql = sqlFor(sig);
  push(`<span class="m ${method.toLowerCase()}">${method}</span> ${esc(path)} <span class="ok">${status}</span>` +
       (sql ? `<div class="ln"><span class="sql">   └ pg</span> <span class="dim">${esc(sql)}</span></div>` : ''));
}

/** 记一条附加的 SQL / 消息队列动作 */
export function logSql(text)    { push(`<span class="sql">   └ pg</span> <span class="dim">${esc(text)}</span>`); }
export function logQueue(text)  { push(`<span class="ok">   └ mq</span> <span class="dim">${esc(text)}</span>`); }

function push(html) {
  if (!ENABLED) return;
  const b = box(), l = lines();
  if (!b || !l) return;
  b.classList.add('on');
  l.insertAdjacentHTML('beforeend', `<div class="ln">${html}</div>`);
  while (l.children.length > 7) l.firstElementChild.remove();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => b.classList.remove('on'), 4200);
}
