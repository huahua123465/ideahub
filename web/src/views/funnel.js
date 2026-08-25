/**
 * 数据漏斗看板（PDF 11：全链路数据漏斗，每一步都要可量化）。
 *
 * 刻意不做成「手工填数的周报表」—— 那种表没人愿意填，填了也没人信。
 * 这里每一层都是后端从 works.metrics 和 clients.stage 直接数出来的：
 * 台账录进去漏斗自己就动了，不需要有人每周去维护第二份数字。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { toast } from '../toast.js';
import { countTo } from '../anim.js';

let lastAt = 0;

export async function render() {
  const root = $('#v-funnel');
  let d;
  try {
    d = await api.funnel();
  } catch (e) {
    if (e.message === '请先登录') return;
    toast('info', e.message || '加载失败');
    return;
  }
  lastAt = Date.now();

  const top = d.steps[0]?.value || 1;
  const compact = n => Number(n || 0) >= 10000
    ? `${(Number(n) / 10000).toFixed(1).replace(/\.0$/, '')}万`
    : new Intl.NumberFormat('zh-CN').format(Number(n || 0));
  const weakest = d.steps.slice(1).filter(s => s.conv != null)
    .sort((a, b) => a.conv - b.conv)[0];
  const byName = name => d.steps.find(s => s.name === name)?.value || 0;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-kicker">全链路转化</div>
        <h1>数据漏斗</h1>
        <div class="sub">每一层都是从作品指标和客户档案里直接数出来的，不用手工填。</div>
      </div>
    </div>

    <div class="funnel-hero">
      <div class="funnel-principle"><span>核心原则</span><b>${esc(d.principle)}</b></div>
      <div class="funnel-hero-stat"><span>总曝光</span><b>${compact(top)}</b><small>内容起点</small></div>
      <div class="funnel-hero-stat"><span>有效客资</span><b>${compact(byName('有效客资'))}</b><small>进入私域</small></div>
      <div class="funnel-hero-stat weak"><span>当前最大损耗</span><b>${esc(weakest?.name || '—')} ${weakest?.conv ?? 0}%</b><small>优先检查这一步</small></div>
    </div>

    <div class="panel funnel-conversion-panel">
      <div class="funnel-panel-head">
        <div><h4>逐步转化</h4><div class="hint">每张卡只和上一步比较，直接看出客户在哪一层流失</div></div>
        <span>数量 · 转化率 · 流失</span>
      </div>
      <div class="fnl-conversion-grid">
        ${d.steps.map((s, i) => {
          const prev = d.steps[i - 1];
          const conversion = s.conv == null ? 100 : Math.max(0, Math.min(100, Number(s.conv)));
          const loss = prev ? Math.max(0, Number(prev.value || 0) - Number(s.value || 0)) : 0;
          const isWeak = weakest && s.name === weakest.name;
          return `<article class="fnl-step-card${isWeak ? ' is-weak' : ''}">
            <header><i>${String(i + 1).padStart(2, '0')}</i><span>${esc(s.name)}</span>${isWeak ? '<em>优先关注</em>' : ''}</header>
            <div class="fnl-step-main">
              <strong class="fnl-val" data-v="${s.value}">0</strong>
              <div><b>${s.conv == null ? '起点' : `${s.conv}%`}</b><small>${s.conv == null ? '内容总触达' : '上一步转化'}</small></div>
            </div>
            <div class="fnl-step-meter"><i style="width:${Math.max(6, conversion)}%"></i></div>
            <footer><span>${esc(s.source)}</span><b>${prev ? `流失 ${compact(loss)}` : `全链路基数 ${compact(top)}`}</b></footer>
          </article>`;
        }).join('')}
      </div>
    </div>

    <div class="panel layer-panel">
      <h4>六层经营视图</h4>
      <div class="hint">每一层都明确「看什么」，不只堆数字</div>
      <div class="layer-grid">
        ${d.layers.map((l, i) => `<article class="layer-card">
          <header><i>${String(i + 1).padStart(2, '0')}</i><b>${esc(l.name)}</b></header>
          <div class="layer-watch">${esc(l.watch)}</div>
          <div class="lay-metrics">${Object.entries(l.metrics).map(([k, v]) =>
            `<span class="kv"><i>${esc(k)}</i><b>${v == null ? '—' : esc(v)}</b></span>`
          ).join('')}</div>
        </article>`).join('')}
      </div>
    </div>`;

  // 数字滚上去。漏斗第一眼看的是量级差，滚动能让人注意到每层掉了多少
  for (const el of root.querySelectorAll('.fnl-val')) {
    countTo(el, Number(el.dataset.v), { ms: 620 });
  }
}

/** 静默刷新：只在漏斗页开着时才拉，且 30 秒内不重复 */
export async function refresh(view) {
  if (view !== 'funnel') return;
  if (Date.now() - lastAt < 30_000) return;
  return render();
}
