/**
 * 简单统计（任务 15）。
 *
 * 这里只回答两个业务问题：库里真正沉淀了多少资料、客户走到了销售漏斗哪一步。
 * 所有数字都能回到来源页面；更细的经营指标仍保留在独立「数据漏斗」页。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { countTo } from '../anim.js';

let lastAt = 0;

export async function refresh() {
  if (!document.querySelector('#v-stats.on')) return;
  if (Date.now() - lastAt < 30_000) return;
  return render();
}

export async function render() {
  const d = await api.stats();
  lastAt = Date.now();

  $('#statsRange').textContent = '五类关键资料与基础销售漏斗 · 删除记录不参与统计';

  $('#statKeyGrid').innerHTML = (d.library || []).map((item, index) => `
    <a class="stat-key-card tone-${index + 1}" href="#" data-goto="${esc(item.board)}">
      <div class="stat-key-top"><span>${esc(item.name)}</span><i>查看记录 →</i></div>
      <strong class="stat-key-value" data-value="${Number(item.value) || 0}">0</strong>
      <small>${esc(item.note)}</small>
    </a>`).join('');

  for (const el of document.querySelectorAll('#statKeyGrid .stat-key-value')) {
    countTo(el, Number(el.dataset.value), { ms: 520 });
  }

  const funnel = d.salesFunnel || [];
  $('#salesFlow').innerHTML = funnel.map((step, index) => {
    const conversion = index === 0 ? '漏斗起点'
      : step.conversion == null ? '暂无上一步数据' : `上一步转化 ${step.conversion}%`;
    return `<a class="sales-step" href="#" data-goto="clients"
        data-stages="${esc((step.stages || []).join(','))}"
        data-filter-label="销售漏斗 · ${esc(step.name)}">
      <span class="sales-index">${String(index + 1).padStart(2, '0')}</span>
      <strong class="sales-value" data-value="${Number(step.value) || 0}">0</strong>
      <b>${esc(step.name)}</b>
      <small>${esc(conversion)}</small>
      <em>${esc(step.source || '客户档案')}</em>
    </a>`;
  }).join('');

  for (const el of document.querySelectorAll('#salesFlow .sales-value')) {
    countTo(el, Number(el.dataset.value), { ms: 620 });
  }
}

export function reset() {
  lastAt = 0;
}
