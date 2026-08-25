/**
 * 客户档案详情页（任务 9）。
 *
 * 任务表点名的九个区：基础信息、对象信息、当前需求、客户资料入口、
 * AI情况分析、AI用户分析、消费/成交信息、交付记录、案例状态。
 *
 * 验收标准是「查看一个客户时，不需要在多个模块来回找资料」——
 * 所以这一页把散在 clients / attachments / client_deliveries / cases / links
 * 五个地方的东西拼到一屏里，而不是给几个跳转链接了事。
 * 技术2 还没接上的区显示成空，不隐藏 —— 隐藏的话没人知道这里将来会有东西。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { toast } from '../toast.js';
import { STAGE } from '../boards.js';
import { SOURCE_LABEL } from '../tagstore.js';
import * as links from './links.js';

const events = new EventTarget();
export { events };

let cur = null;   // 当前打开的客户 id

export function current() { return cur; }

export async function open(id) {
  cur = Number(id);
  const root = $('#v-clientDetail');
  root.innerHTML = '<div class="page-head"><div><h1>客户档案</h1><div class="sub">加载中…</div></div></div>';
  events.dispatchEvent(new CustomEvent('show'));
  await paint();
}

const ymd = v => (v ? String(v).slice(0, 10) : '');
const val = v => (v == null || v === '' ? '<span class="dim">—</span>' : esc(v));

/** 一组「字段名：值」。JSONB 里没有的键不显示，但整个区块一定显示 */
function kvBlock(obj, keys) {
  const rows = keys.filter(k => obj?.[k]).map(k =>
    `<div class="kv"><span>${esc(k)}</span><b>${esc(obj[k])}</b></div>`);
  return rows.length ? rows.join('') : '<div class="dim">还没填</div>';
}

async function paint() {
  const root = $('#v-clientDetail');
  let c;
  try {
    c = await api.client(cur);
  } catch (e) {
    root.innerHTML = `<div class="page-head"><div><h1>客户档案</h1>
      <div class="sub">打不开：${esc(e.message)}</div></div></div>`;
    return;
  }

  const deal = {
    '成交产品': c.deal?.['成交产品'] || c.deal?.['产品'],
    '成交金额': c.deal?.['成交金额'] || c.deal?.['金额'],
    '成交时间': c.deal?.['成交时间'],
    '续费': c.deal?.['续费'] || (String(c.deal?.['状态'] || '').includes('续费') ? '已续费' : ''),
    '退款': c.deal?.['退款'],
    '备注': c.deal?.['备注'] || c.deal?.['状态'],
  };
  const initial = [...String(c.alias || '?')][0];

  root.innerHTML = `
    <div class="client-detail-head">
      <div class="client-detail-avatar">${esc(initial)}</div>
      <div class="client-detail-main">
        <div class="page-kicker">360° 客户视图</div>
        <div class="client-detail-title"><h1>${esc(c.alias)}</h1>
          ${c.tier ? `<span class="tier-badge">${esc(c.tier)} 级</span>` : ''}
          <span class="stagepill s-${esc(c.stage)}">${esc(STAGE[c.stage] || c.stage)}</span>
        </div>
        <div class="sub">
          ${esc(c.source || SOURCE_LABEL[c.sourceType] || '来源未填')}
          ${c.ownerName ? ' · 跟进人 ' + esc(c.ownerName) : ''}
          ${c.externalId ? ' · 技术2 客户号 ' + esc(c.externalId) : ''}
        </div>
        <div class="cdtags">
          ${(c.tags || []).length
            ? c.tags.map(t => `<span class="tag tag-${esc(t.kind)}">${esc(t.name)}</span>`).join('')
            : '<span class="dim">还没打标签</span>'}
        </div>
      </div>
      <div class="client-detail-actions">
        <button class="btn btn-ghost" id="cdBack">← 返回列表</button>
        <button class="btn btn-ghost" id="cdEdit">编辑资料</button>
        <button class="btn btn-primary" id="cdToCase">转成案例</button>
      </div>
    </div>

    <div class="cdgrid">
      <section class="cdcard">
        <div class="sec-title">① 基础信息（女方）</div>
        ${kvBlock(c.female, ['年龄', '城市', '职业', '收入区间', '婚恋史', '当前诉求'])}
      </section>

      <section class="cdcard">
        <div class="sec-title">② 对象信息（男方）</div>
        ${kvBlock(c.male, ['年龄', '职业', '经济状况', '家庭', '婚恋史', '社会关系'])}
      </section>

      <section class="cdcard">
        <div class="sec-title">③ 当前需求与关系</div>
        ${kvBlock(c.relation, ['认识时间', '方式', '见面次数', '关系阶段', '公开度', '当前状态'])}
        <div class="cdsub">时间线</div>
        <div class="cdtext">${val(c.timeline)}</div>
        <div class="cdsub">判断 / 备注</div>
        <div class="cdtext">${val(c.note)}</div>
      </section>

      <section class="cdcard">
        <div class="sec-title">④ 客户资料入口 <span class="dim">${c.files.length} 份</span></div>
        ${c.files.length ? c.files.map(f => `
          <div class="kv"><a class="link" href="/api/files/${f.id}" target="_blank" rel="noopener">${esc(f.name)}</a>
          <span class="dim">${ymd(f.createdAt)}</span></div>`).join('')
          : '<div class="dim">还没有上传聊天记录分析报告等材料</div>'}
        <div class="cdsub">证据材料清单</div>
        <div class="cdtext">${val(c.evidence)}</div>
      </section>

      <section class="cdcard cdai">
        <div class="sec-title">⑤ AI 情况分析
          ${c.aiUpdatedAt ? `<span class="dim">更新于 ${ymd(c.aiUpdatedAt)}</span>` : ''}</div>
        <div class="cdtext">${c.aiSituation ? esc(c.aiSituation)
          : '<span class="dim">等技术2 接入后自动出现；也可以在「编辑资料」里先手工填。</span>'}</div>
      </section>

      <section class="cdcard cdai">
        <div class="sec-title">⑥ AI 用户分析</div>
        <div class="cdtext">${c.aiUser ? esc(c.aiUser)
          : '<span class="dim">等技术2 接入后自动出现；也可以在「编辑资料」里先手工填。</span>'}</div>
      </section>

      <section class="cdcard">
        <div class="sec-title">⑦ 消费 / 成交</div>
        ${kvBlock(deal, ['成交产品', '成交金额', '成交时间', '续费', '退款', '备注'])}
      </section>

      <section class="cdcard">
        <div class="sec-title">⑧ 交付记录 <span class="dim">${c.deliveries.length} 条</span></div>
        <div class="cddel">
          ${c.deliveries.length ? c.deliveries.map(d => `
            <div class="kv">
              <span>${ymd(d.happenedAt)}${d.kind ? ' · ' + esc(d.kind) : ''}</span>
              <b>${esc(d.summary)}</b>
              <button class="btn btn-ghost cd-del-delivery" data-did="${d.id}">删除</button>
            </div>`).join('')
            : '<div class="dim">还没有交付记录</div>'}
        </div>
        <div class="cdadd">
          <input class="inp" id="cdDelKind" placeholder="类型：咨询 / 陪跑 / 复盘" style="max-width:170px">
          <input class="inp" id="cdDelSummary" placeholder="这次做了什么">
          <button class="btn btn-ghost" id="cdDelAdd">添加</button>
        </div>
      </section>

      <section class="cdcard">
        <div class="sec-title">⑨ 案例状态 <span class="dim">${c.cases.length} 条</span></div>
        ${c.cases.length ? c.cases.map(k => `
          <div class="kv">
            <a class="link" href="#" data-goto="cases" data-ref="${k.id}">${esc(k.title)}</a>
            <span class="tag">${esc(k.outcome || '进行中')}</span>
            ${k.reusable ? '<span class="tag">可复用</span>' : ''}
          </div>`).join('')
          : '<div class="dim">还没转成案例。有结果之后点右上角「转成案例」，客户信息会自动带过去。</div>'}
      </section>
    </div>

    <div class="cdcard" id="cdLinks"></div>`;

  links.mount($('#cdLinks'), 'client', cur);

  $('#cdBack').addEventListener('click', () =>
    events.dispatchEvent(new CustomEvent('back')));
  $('#cdEdit').addEventListener('click', () =>
    events.dispatchEvent(new CustomEvent('edit', { detail: { id: cur } })));
  $('#cdToCase').addEventListener('click', toCase);

  $('#cdDelAdd').addEventListener('click', async () => {
    const summary = $('#cdDelSummary').value.trim();
    if (!summary) return toast('info', '写一句这次做了什么');
    try {
      await api.deliveryCreate(cur, { kind: $('#cdDelKind').value.trim(), summary });
      toast('ok', '已添加');
      await paint();
    } catch (e) { toast('info', e.message || '添加失败'); }
  });

  root.querySelectorAll('.cd-del-delivery').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这条交付记录？')) return;
    try {
      await api.deliveryDelete(cur, Number(b.dataset.did));
      await paint();
    } catch (e) { toast('info', e.message || '删除失败'); }
  }));
}

/** 转案例（任务 12）：客户信息自动带过去，不重复录入 */
async function toCase() {
  try {
    const r = await api.clientToCase(cur);
    if (r.existed) {
      toast('info', '这个客户已经有案例了，帮你打开它');
    } else {
      toast('ok', '已生成案例草稿，客户标签和时间线都带过去了');
    }
    events.dispatchEvent(new CustomEvent('goto-case', { detail: { id: r.id } }));
  } catch (e) {
    toast('info', e.message || '转案例失败');
  }
}

/** 别处改了这个客户之后回来刷新 */
export async function refresh() {
  if (cur) await paint();
}
