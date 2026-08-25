/** 正式库：表格 */
import { api } from '../api.js';
import { avatarColor, initial, ymd, esc, $ } from '../util.js';
import { skeletonRows } from '../anim.js';
import { openDrawer } from './drawer.js';

let flashCode = null;
/** 留一份列表数据：点开详情时先拿它把抽屉填上，不用干等详情接口 */
let rows = [];
export const markFlash = code => { flashCode = code; };

let bound = false;
/** 正式库的行也能点开详情 —— 采纳之后的讨论和流转记录同样需要能翻出来看 */
function bindOnce() {
  if (bound) return;
  bound = true;
  $('#formalBody').addEventListener('click', e => {
    if (e.target.closest('a')) return;          // 点「查看 ↗」是去开文档，不是开抽屉
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDrawer(Number(tr.dataset.id), rows.find(r => r.id === Number(tr.dataset.id)));
  });
}

/**
 * 静默刷新。
 * 正式库的表格没有任何行内交互状态，又是按立项日期倒序、新条目本来就在最上面，
 * 所以直接整块重渲染就行，不需要像灵感池那样做增量。
 * 唯一要躲开的是抽屉开着的时候 —— 别让表格在遮罩后面抖。
 *
 * 但「跳过」不等于「算了」：跳过的这次要记下来，等抽屉一关立刻补上。
 * 不记的话，在抽屉里改完进度关掉，表格还是旧数字 —— 看起来就像没保存成功。
 */
let pending = false;

export async function refresh() {
  if (document.querySelector('#drawer.on')) { pending = true; return; }
  return render();
}

/** 抽屉关掉时调用：把刚才跳过的那次刷新补上 */
export async function flush() {
  if (!pending) return;
  pending = false;
  return render();
}

export async function render() {
  const body = $('#formalBody');
  if (!body.children.length) body.innerHTML = skeletonRows(5, 6);

  const data = await api.ideas({ status: 'adopted', sort: 'adopted', pageSize: 100 });
  rows = data.items;
  $('#formalN').textContent = data.total;

  $('#formalBody').innerHTML = data.items.map(f => `
    <tr data-code="${esc(f.code || '')}" data-id="${f.id}" style="cursor:pointer">
      <td data-label="编号"><span class="code">${esc(f.code || '—')}</span></td>
      <td data-label="灵感" style="font-weight:550">${esc(f.title)}</td>
      <td data-label="负责人"><span class="who"><span class="av" style="background:${avatarColor(f.owner?.name)}">${esc(initial(f.owner?.name))}</span>${esc(f.owner?.name || '未指派')}</span></td>
      <td data-label="立项日期" style="color:var(--ink2);font-variant-numeric:tabular-nums">${ymd(f.adoptedAt)}</td>
      <td data-label="进度" class="prog"><span class="progress"><i style="width:${f.progress}%"></i></span>
          <span style="font-size:12px;color:var(--muted);margin-left:7px">${f.progress}%</span></td>
      <td data-label="方案文档">${f.docUrl ? `<a class="link" href="${esc(f.docUrl)}" target="_blank" rel="noopener">查看 ↗</a>`
                     : `<span style="color:var(--muted);font-size:12px">待补</span>`}</td>
    </tr>`).join('')
    || `<tr><td colspan="6"><div class="empty sm">
           <svg viewBox="0 0 120 96" aria-hidden="true">
             <path d="M26 30h68v46H26zM26 30l8-12h52l8 12"/>
             <path d="M52 52h16" class="ray"/>
           </svg>
           <span>还没有灵感被采纳。去灵感池里挑一条吧。</span>
         </div></td></tr>`;

  bindOnce();

  if (flashCode) {
    const r = $(`tr[data-code="${flashCode}"]`);
    if (r) { r.classList.remove('flash-row'); void r.offsetWidth; r.classList.add('flash-row'); }
    flashCode = null;
  }
}
