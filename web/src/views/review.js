/**
 * 评审决定：采纳 / 否决两个弹窗。
 *
 * 之前用的是浏览器原生 prompt()，能跑但很难看，而且在部分浏览器里会被拦。
 * 更重要的是：否决理由是要给人看的东西，值得一个像样的输入框。
 */
import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { toast } from '../toast.js';

export const events = new EventTarget();

let target = null;      // 当前正在处理的灵感
/**
 * 负责人候选。
 *
 * 原来是「第一次打开拉一次，之后整个页面会话都不再更新」——
 * 于是新同事注册、或者管理员刚改完谁的角色，不刷新页面就永远看不到变化。
 * 这个列表只有几个人、一次请求几毫秒，缓存省下的那点开销远不值这个坑。
 * 现在每次打开采纳弹窗都重新拉，拉失败才退回上一次的结果。
 */
let users = null;

function show(id) {
  $('#mask').classList.add('on');
  $(id).classList.add('on');
}
export function close() {
  $('#adoptModal').classList.remove('on');
  $('#rejectModal').classList.remove('on');
  $('#mask').classList.remove('on');
}

/* ---------- 采纳 ---------- */
export async function openAdopt(idea) {
  target = idea;
  $('#adoptTitle').textContent = idea.title;

  try {
    const r = await fetch((location.port === '5173'
      ? `${location.protocol}//${location.hostname}:3000` : '') + '/api/users',
      { credentials: 'include' });
    if (r.ok) users = (await r.json()).items;
  } catch { /* 网络不好就沿用上次的结果，总比下拉框空着强 */ }
  users = users || [];
  // 匿名灵感拿不到提交人是谁（后端就没吐 author.id），也不该猜
  const anon = !!idea.isAnonymous || idea.author?.id == null;

  // 接口拿不到人（比如 mock 模式）就退回成「提交人自己负责」；匿名时没有这个退路
  const list = users.length ? users
    : (anon ? [] : [{ id: idea.author.id, name: idea.author.name || '提交人' }]);

  // 匿名灵感必须有「未指派」这一项并且默认选中。
  // 没有它的话下拉框会默默停在名单第一个人身上，采纳时就把一个毫不相干的人
  // 设成了负责人 —— 而且看起来还像是系统认定的。
  const opts = list
    .map(u => `<option value="${u.id}">${esc(u.name)}${u.dept ? ' · ' + esc(u.dept) : ''}</option>`);
  $('#adoptOwner').innerHTML = (anon ? ['<option value="">未指派</option>'] : []).concat(opts).join('');

  if (anon) {
    $('#adoptOwner').value = '';
  } else {
    // 默认挂在提交人名下 —— 提出想法的人通常最清楚要怎么做
    const self = list.find(u => Number(u.id) === Number(idea.author.id));
    if (self) $('#adoptOwner').value = String(self.id);
  }
  $('#adoptProgress').value = '0';

  show('#adoptModal');
}

export async function confirmAdopt() {
  const btn = $('#btnAdoptConfirm');
  btn.disabled = true;
  try {
    const ownerId = Number($('#adoptOwner').value) || undefined;
    const progress = Number($('#adoptProgress').value) || 0;
    const r = await api.setStatus(target.id, 'adopted', { ownerId });
    if (progress) await api.patch(target.id, { progress });
    close();
    events.dispatchEvent(new CustomEvent('adopted', {
      detail: { id: target.id, code: r.code, owner: r.owner?.name || '未指派' },
    }));
  } catch (e) {
    toast('info', e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 否决 ---------- */
export function openReject(idea) {
  target = idea;
  $('#rejectTitle').textContent = idea.title;
  $('#rejectReason').value = '';
  show('#rejectModal');
  setTimeout(() => $('#rejectReason').focus(), 240);
}

export async function confirmReject() {
  const reason = $('#rejectReason').value.trim();
  if (reason.length < 2) {
    toast('info', '否决必须填写理由');
    $('#rejectReason').focus();
    return;
  }
  const btn = $('#btnRejectConfirm');
  btn.disabled = true;
  try {
    await api.setStatus(target.id, 'rejected', { reason });
    close();
    toast('ok', '已否决，理由已记入流转记录');
    events.dispatchEvent(new CustomEvent('rejected', { detail: { id: target.id } }));
  } catch (e) {
    toast('info', e.message);
  } finally {
    btn.disabled = false;
  }
}
