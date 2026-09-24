/**
 * 站内消息：顶栏的铃铛 + 未读红点 + 下拉列表。
 *
 * 点一条消息会跳到对应板块并打开那条记录 —— 「点击打开」这件事是这个功能的重点，
 * 只告诉人「你有新反馈」却要他自己去翻，等于没通知。
 */
import { api, state } from '../api.js';
import { esc, $, fromNow } from '../util.js';
import { toast } from '../toast.js';
import * as alertBox from './alert.js';

export const events = new EventTarget();

let items = [];
let unread = 0;
let open = false;
let hint = null;      // 上一次点「开启桌面通知」的结果，见 paintPerm

/**
 * 左右滑动清掉一条消息（09-24）。后台没有「删除消息」，所以滑掉 = 标成已读 + 在这台设备上记住不再显示。
 * 只存 id，最多留最近 500 个，旧的自然淘汰。
 */
const HIDDEN_KEY = 'ideahub.notif.hidden.v1';
const hiddenIds = () => { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { return new Set(); } };
function hideId(id) {
  const ids = [...hiddenIds(), id].slice(-500);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids)); } catch { /* 记不住只影响这一次 */ }
}
let swiped = false;   // 刚滑完的那次 pointerup 后面会跟一个 click，不能当成「点开这条」

export async function refresh() {
  if (state.mode === 'mock') return;
  try {
    const d = await api.notifications();
    items = d.items;
    unread = d.unread;
  } catch (e) {
    if (e.message === '请先登录') return;
    return;   // 消息拉不到不该打断别的事，静默算了
  }
  paintBadge();
  if (open) paintList();
}

function paintBadge() {
  const dot = $('#notifDot');
  if (!dot) return;
  dot.hidden = unread === 0;
  dot.textContent = unread > 99 ? '99+' : unread;
}

/**
 * 面板顶部那条「开启桌面通知」。
 *
 * 为什么是按钮而不是页面加载时自动申请：Edge 从 84 起默认开着「静默通知请求」，
 * 非用户手势发起的申请**不弹授权框**，权限一直停在 'default'，
 * 页面这边什么错都收不到 —— 表现就是 Chrome 能弹、Edge 悄无声息。
 * 由点击触发就绕开了这条路。
 *
 * 开好之后整条消失：常驻的设置项会一直占着面板顶部，而这件事一辈子只点一次。
 */
function paintPerm() {
  const box = $('#notifPerm');
  if (!box) return;

  const live = alertBox.status();
  // hint 比 status() 多知道一件事：申请发出去了、但授权框根本没出现。
  // 那种情况权限仍然是 'default'，单看 status() 分辨不出来。
  const st = live.state === 'granted' ? live : (hint || live);

  if (st.state === 'granted') {
    hint = null;
    box.hidden = true;
    box.innerHTML = '';
    return;
  }

  box.hidden = false;
  box.innerHTML = `
    <div class="permtext">
      <b>桌面通知没有开启</b>
      <span>开启后，切到别的软件、或者浏览器最小化时也能收到提醒。</span>
      ${st.why ? `<span class="permwhy">${esc(st.why)}</span>` : ''}
    </div>
    ${st.canAsk ? '<button class="btn btn-primary permbtn" id="notifPermBtn">开启桌面通知</button>' : ''}`;
}

function paintList() {
  const hidden = hiddenIds();
  const shown = items.filter(n => !hidden.has(n.id));
  $('#notifList').innerHTML = shown.length ? `<div class="notif-tip">左右滑一下，可以把消息清掉</div>` + shown.map(n => `
    <button class="notifitem${n.read ? '' : ' unread'}" data-nid="${n.id}"
            data-board="${esc(n.board || '')}" data-ref="${n.refId ?? ''}">
      <b>${esc(n.title)}</b>
      ${n.body ? `<span class="nbody">${esc(n.body)}</span>` : ''}
      <span class="ntime">${esc(fromNow(n.createdAt))}</span>
    </button>`).join('')
    : '<div class="dim" style="padding:14px">还没有消息。</div>';
}

export function toggle(force) {
  open = force ?? !open;
  $('#notifPop').classList.toggle('on', open);
  if (open) { paintPerm(); paintList(); refresh(); }
}

export function close() { toggle(false); }

export function bind() {
  $('#notifBtn').addEventListener('click', e => { e.stopPropagation(); toggle(); });

  // 权限申请必须在这个点击的调用栈里发出去，中间不能插 await ——
  // 浏览器判定「用户手势」是有时效的，先 await 再 requestPermission 会被当成自动申请。
  $('#notifPerm').addEventListener('click', async e => {
    if (!e.target.closest('#notifPermBtn')) return;
    const r = await alertBox.enable();
    hint = r.state === 'granted' ? null : r;
    paintPerm();
    if (r.state === 'granted') toast('ok', '桌面通知已开启');
    else if (r.why) toast('info', r.why);
  });

  // 权限可能在别处变（比如用户直接改了浏览器设置），变了就把提示条重画
  alertBox.events.addEventListener('change', () => paintPerm());

  // 左右滑：跟手移动、越远越淡，超过 90px 松手就飞出去并收起那一行
  $('#notifList').addEventListener('pointerdown', e => {
    const btn = e.target.closest('.notifitem');
    if (!btn || e.button !== 0) return;
    const x0 = e.clientX;
    let dx = 0;
    const move = ev => {
      dx = ev.clientX - x0;
      if (Math.abs(dx) < 6) return;
      btn.classList.add('swiping');
      btn.style.transform = `translateX(${dx}px)`;
      btn.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 260));
    };
    const up = async () => {
      btn.removeEventListener('pointermove', move);
      btn.classList.remove('swiping');
      if (Math.abs(dx) < 90) { btn.style.transform = ''; btn.style.opacity = ''; if (Math.abs(dx) >= 6) swiped = true; return; }
      swiped = true;
      const id = Number(btn.dataset.nid);
      const h = btn.offsetHeight;
      const out = btn.animate([
        { transform: `translateX(${dx}px)`, opacity: btn.style.opacity, height: `${h}px` },
        { transform: `translateX(${Math.sign(dx) * 420}px)`, opacity: 0, height: `${h}px`, offset: 0.6 },
        { transform: `translateX(${Math.sign(dx) * 420}px)`, opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px' },
      ], { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
      hideId(id);
      const it = items.find(x => x.id === id);
      if (it && !it.read) {
        try { const d = await api.notifRead(id); unread = d.unread; } catch { /* 标不上就算了，本机照样不显示 */ }
        it.read = true;
        paintBadge();
      }
      out.onfinish = () => paintList();
    };
    btn.addEventListener('pointermove', move);
    btn.addEventListener('pointerup', up, { once: true });
    btn.addEventListener('pointercancel', up, { once: true });
  });

  $('#notifList').addEventListener('click', async e => {
    if (swiped) { swiped = false; e.preventDefault(); return; }
    const btn = e.target.closest('.notifitem');
    if (!btn) return;
    const id = Number(btn.dataset.nid);
    const board = btn.dataset.board;
    const ref = btn.dataset.ref ? Number(btn.dataset.ref) : null;

    // 先标已读再跳。反过来的话跳转会把这次点击的上下文冲掉，红点留在那儿不消。
    try { const d = await api.notifRead(id); unread = d.unread; } catch { /* 标不上就算了 */ }
    const it = items.find(x => x.id === id);
    if (it) it.read = true;
    paintBadge();
    close();
    if (board) events.dispatchEvent(new CustomEvent('goto', { detail: { board, refId: ref } }));
  });

  $('#notifReadAll').addEventListener('click', async () => {
    try {
      const d = await api.notifRead();
      unread = d.unread;
      items = items.map(n => ({ ...n, read: true }));
      paintBadge(); paintList();
    } catch { /* 忽略 */ }
  });

  // 点别处收起
  document.addEventListener('click', e => {
    if (open && !e.target.closest('#notifPop') && !e.target.closest('#notifBtn')) close();
  });
}
