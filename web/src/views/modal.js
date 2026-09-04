/** 提交弹窗：表单 + 实时查重 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { toast } from '../toast.js';
import { tagDict, KIND_ORDER, KIND_LABEL, SOURCE_OPTIONS } from '../tagstore.js';

export const events = new EventTarget();
let dupeTimer = null;
let picksReady = false;
let returnFocus = null;

/**
 * 把统一标签和来源两个选择器画出来。
 * 只画一次 —— 标签字典全站共用，弹窗每次打开都重画纯属浪费。
 */
async function buildPickers() {
  if (picksReady) return;
  $('#fSourceType').innerHTML = SOURCE_OPTIONS.map(o =>
    `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  let dict;
  try { dict = await tagDict(); } catch { return; }
  const box = $('#fTagPick');
  box.innerHTML = KIND_ORDER.map(kind => {
    const list = dict.byKind?.[kind] || [];
    if (!list.length) return '';
    return `<div class="tagrow">
      <span class="tagkind">${esc(KIND_LABEL[kind])}</span>
      ${list.map(t => `<button type="button" class="chip tagchip" data-tag="${t.id}">${esc(t.name)}</button>`).join('')}
    </div>`;
  }).join('');
  box.addEventListener('click', e => {
    const chip = e.target.closest('.tagchip');
    if (chip) chip.classList.toggle('on');
  });
  picksReady = true;
}

export function open() {
  returnFocus = document.activeElement;
  buildPickers();
  $('#mask').classList.add('on');
  $('#modal').classList.add('on');
  setTimeout(() => $('#fTitle').focus(), 240);
}

export function close() {
  const wasOpen = $('#modal').classList.contains('on');
  $('#modal').classList.remove('on');
  $('#mask').classList.remove('on');
  $('#dupe').classList.remove('on');
  if (wasOpen && returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}

function reset() {
  for (const id of ['fTitle', 'fBody', 'fTags', 'fSourceUrl']) $('#' + id).value = '';
  $('#fTagPick').querySelectorAll('.tagchip.on').forEach(c => c.classList.remove('on'));
  $('#fCat').selectedIndex = 0;
  $('#anon').classList.remove('on');
  $('#anon').setAttribute('aria-checked', 'false');
  $('#dupe').classList.remove('on');
}

/**
 * 标题打字时查重。
 * 提示但不阻断 —— 阻断会直接劝退提交欲望，而重复提交的成本远低于不提交。
 */
export function onTitleInput() {
  clearTimeout(dupeTimer);
  dupeTimer = setTimeout(async () => {
    const q = $('#fTitle').value.trim();
    const box = $('#dupe');
    if (q.length < 4) { box.classList.remove('on'); return; }
    try {
      const { items } = await api.similar(q);
      if (!items.length) { box.classList.remove('on'); return; }
      box.innerHTML =
        `<b>发现 ${items.length} 条相似灵感，确认不是重复？</b>` +
        items.map(i => `<a data-open="${i.id}">· ${esc(i.title)}（相似度 ${i.score}%）</a>`).join('');
      box.classList.add('on');
    } catch { box.classList.remove('on'); }
  }, 380);
}

export async function submit() {
  const title = $('#fTitle').value.trim();
  const content = $('#fBody').value.trim();
  const category = $('#fCat').value;
  const tags = $('#fTags').value.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);
  const tagIds = [...$('#fTagPick').querySelectorAll('.tagchip.on')].map(c => Number(c.dataset.tag));
  const sourceType = $('#fSourceType').value || 'manual';
  const sourceUrl = $('#fSourceUrl').value.trim();
  const isAnonymous = $('#anon').classList.contains('on');

  if (!title)             { toast('info', '标题不能为空'); $('#fTitle').focus(); return; }
  if (!content)           { toast('info', '详细说明不能为空'); $('#fBody').focus(); return; }

  const btn = $('#btnSubmit');
  btn.disabled = true;
  try {
    const idea = await api.create({
      title, content, category, tags, isAnonymous, tagIds, sourceType, sourceUrl });
    close();
    reset();
    toast('ok', '灵感已提交');
    events.dispatchEvent(new CustomEvent('created', { detail: idea }));
  } catch (e) {
    toast('info', e.message);
  } finally {
    btn.disabled = false;
  }
}
