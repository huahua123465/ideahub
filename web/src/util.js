/** 小工具：头像色、相对时间、转义 */

/* 头像色：上面是白字，所以每个颜色和白字的对比度都要 ≥ 4.5（09-24 起，原来橙、绿、黄、粉只有 2.8~3.5）。
   在 OKLCH 里保持色相压暗到 4.6 左右；原来的黄色压暗后和橙色、红色都成了棕色，分不出人，换成了青绿。
   深色模式下也用这一组（白字照样清楚），不用 light-dark。 */
const COLORS = ['#2563eb','#bb5815','#008744','#0f7b83','#c14c74','#7857fa','#d14236'];
/** 群聊头像的底色：原来用 var(--ink2)，深色下它是浅灰，压白字就看不清了 */
export const GROUP_AVATAR = '#625d63';

/** 按名字算头像底色，同一个人在任何位置颜色都一致 */
export function avatarColor(name = '?') {
  let h = 0;
  for (const c of String(name)) h += c.codePointAt(0);
  return COLORS[h % COLORS.length];
}

export const initial = (name = '?') => [...String(name)][0] || '?';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 周前 / 日期 */
export function fromNow(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const d = Math.floor(diff / 86400);
  if (d < 14) return `${d} 天前`;      // 两周以内说「天」比说「周」清楚
  if (d < 30) return `${Math.floor(d / 7)} 周前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return new Date(iso).toISOString().slice(0, 10);
}

export const ymd = iso => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

/** 插入 HTML 前一律走这里。用户提交的标题里可能有 < > & */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $  = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

/** 状态徽章的 class 和文案。
    图标不再用 emoji —— 它出现在每一张卡片上，是全站最显眼的地方，
    而 emoji 恰恰是各系统画风差异最大的东西（Windows / mac / 安卓三套样子）。
    现在文案是纯文字，图标由 STATUS_ICON 单独拼在前面。 */
export const PILL = {
  pending:   ['pill-pending',   '待评审'],
  reviewing: ['pill-reviewing', '评审中'],
  adopted:   ['pill-adopted',   '已采纳'],
  rejected:  ['pill-rejected',  '已否决'],
  archived:  ['pill-rejected',  '已归档'],
  draft:     ['pill-pending',   '草稿'],
};
