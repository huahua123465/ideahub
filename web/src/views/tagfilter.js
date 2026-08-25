/**
 * 统一标签筛选条（任务 6）。
 *
 * 灵感池和各个业务板块共用这一个组件 —— 任务表要的是「按关系阶段、用户需求、
 * 内容类型、来源筛选」，如果每个页面自己画一套筛选条，很快就会变成
 * 「客户档案能按关系阶段筛、案例库不能」这种参差不齐的状态。
 */
import { esc } from '../util.js';
import { tagDict, KIND_ORDER, KIND_LABEL, SOURCE_OPTIONS } from '../tagstore.js';

/**
 * 把一个筛选条挂到容器上。
 * onChange({ tagIds, sourceType }) 在用户点了任何一颗 chip 后触发。
 */
export async function mount(box, { onChange, withSource = true } = {}) {
  if (!box) return;
  let dict;
  try { dict = await tagDict(); }
  catch { box.innerHTML = ''; return; }

  const kinds = KIND_ORDER.filter(k => (dict.byKind?.[k] || []).length);
  if (!kinds.length && !withSource) { box.innerHTML = ''; return; }

  box.innerHTML = `
    ${kinds.map(kind => `
      <span class="tagkind">${esc(KIND_LABEL[kind])}</span>
      ${dict.byKind[kind].map(t =>
        `<button class="chip tagchip" data-tag="${t.id}">${esc(t.name)}</button>`).join('')}
      <div class="divider-v"></div>`).join('')}
    ${withSource ? `<span class="tagkind">来源</span>
      ${SOURCE_OPTIONS.map(o =>
        `<button class="chip" data-src="${esc(o.value)}">${esc(o.label)}</button>`).join('')}` : ''}
    <div class="spacer"></div>
    <button class="chip tf-clear" hidden>清除筛选</button>`;

  const clear = box.querySelector('.tf-clear');

  const emit = () => {
    const tagIds = [...box.querySelectorAll('.tagchip.on')].map(c => Number(c.dataset.tag));
    const srcBtn = box.querySelector('[data-src].on');
    clear.hidden = !tagIds.length && !srcBtn;
    onChange?.({ tagIds, sourceType: srcBtn?.dataset.src || '' });
  };

  box.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.classList.contains('tf-clear')) {
      box.querySelectorAll('.chip.on').forEach(c => c.classList.remove('on'));
      return emit();
    }
    // 来源是单选（一条资料只有一个来源），标签是多选（或的关系）
    if (chip.dataset.src !== undefined) {
      const was = chip.classList.contains('on');
      box.querySelectorAll('[data-src]').forEach(c => c.classList.remove('on'));
      chip.classList.toggle('on', !was);
    } else if (chip.dataset.tag !== undefined) {
      chip.classList.toggle('on');
    } else {
      return;
    }
    emit();
  });
}
