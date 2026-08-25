/**
 * 资料关联（任务 8）。
 *
 * 挂在编辑弹窗底部：看到一条需求时，能直接看到它相关的视频、灵感、案例、客户，
 * 并且点得开。第一版不做关系图 —— 图好看，但业务人员真正要的是「点过去」。
 */
import { api } from '../api.js';
import { esc } from '../util.js';
import { toast } from '../toast.js';

/** 可关联的资料类型。和后端 lib/entity.mjs 的 ENTITIES 对齐 */
const KINDS = [
  { key: 'demand', label: '用户需求' },
  { key: 'idea', label: '灵感 / 正式内容' },
  { key: 'work', label: '作品 / 直播' },
  { key: 'client', label: '客户' },
  { key: 'case', label: '案例' },
];

let cur = null;   // { box, entity, id }

export async function mount(box, entity, id) {
  cur = { box, entity, id };
  box.innerHTML = `<div class="sec-title">关联资料</div><div class="dim">加载中…</div>`;
  await paint();
}

async function paint() {
  if (!cur) return;
  const { box, entity, id } = cur;
  let items = [];
  try {
    ({ items } = await api.links(entity, id));
  } catch (e) {
    box.innerHTML = `<div class="sec-title">关联资料</div><div class="dim">读取失败：${esc(e.message)}</div>`;
    return;
  }
  // 弹窗可能已经换了一条记录，别把结果画到错的地方
  if (!cur || cur.id !== id || cur.entity !== entity) return;

  box.innerHTML = `
    <div class="sec-title">关联资料 <span class="dim">${items.length ? items.length + ' 条' : ''}</span></div>
    <div class="linklist">
      ${items.length ? items.map(l => `
        <div class="linkitem" data-lid="${l.id}">
          <span class="tag">${esc(l.entityLabel)}</span>
          ${l.missing
            ? `<span class="dim">${esc(l.title)}</span>`
            : `<a class="link" href="#" data-goto="${esc(l.board)}" data-ref="${l.refId}">${esc(l.title)}</a>`}
          ${l.note ? `<span class="dim">· ${esc(l.note)}</span>` : ''}
          <div class="spacer"></div>
          <button class="btn btn-ghost lk-del" data-lid="${l.id}">取消关联</button>
        </div>`).join('')
        : '<div class="dim">还没有关联。比如：这条需求是从哪个视频看出来的、对应哪个案例。</div>'}
    </div>
    <div class="linkadd">
      <select class="inp lk-kind">
        ${KINDS.filter(k => k.key !== null).map(k =>
          `<option value="${k.key}">${esc(k.label)}</option>`).join('')}
      </select>
      <input class="inp lk-q" placeholder="输入关键词找要关联的资料…" autocomplete="off">
      <div class="lk-results" hidden></div>
    </div>`;

  box.querySelectorAll('.lk-del').forEach(b => b.addEventListener('click', async () => {
    try {
      await api.linkDelete(Number(b.dataset.lid));
      toast('ok', '已取消关联');
      await paint();
    } catch (e) { toast('info', e.message || '取消失败'); }
  }));

  // 搜要关联的资料。走的是全局搜索接口，限定在选中的那类资料里 ——
  // 不必为「挑一条资料」再造一套搜索
  const q = box.querySelector('.lk-q');
  const kind = box.querySelector('.lk-kind');
  const results = box.querySelector('.lk-results');
  let timer;
  const doSearch = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const kw = q.value.trim();
      if (kw.length < 1) { results.hidden = true; return; }
      let found = [];
      try {
        ({ items: found } = await api.search(kw, { entity: kind.value, limit: 8 }));
      } catch { return; }
      // 已经关联过的、还有自己，都不该再出现在候选里
      const has = new Set(items.map(l => `${l.entity}:${l.refId}`));
      found = found.filter(f => !has.has(`${f.entity}:${f.id}`)
                             && !(f.entity === cur.entity && f.id === cur.id));
      results.hidden = false;
      results.innerHTML = found.length
        ? found.map(f => `<button type="button" class="lk-hit" data-e="${esc(f.entity)}" data-i="${f.id}">
             ${esc(f.title)} <span class="dim">${esc(f.module)}</span></button>`).join('')
        : '<div class="dim" style="padding:6px 8px">没找到</div>';
      results.querySelectorAll('.lk-hit').forEach(btn => btn.addEventListener('click', async () => {
        try {
          await api.linkCreate({
            fromEntity: cur.entity, fromId: cur.id,
            toEntity: btn.dataset.e, toId: Number(btn.dataset.i),
          });
          q.value = '';
          results.hidden = true;
          toast('ok', '已关联');
          await paint();
        } catch (e) { toast('info', e.message || '关联失败'); }
      }));
    }, 260);
  };
  q.addEventListener('input', doSearch);
  kind.addEventListener('change', doSearch);
}

export function unmount() { cur = null; }
