/**
 * 账号相关：头像菜单、退出登录、修改密码、用户管理。
 */
import { api } from '../api.js';
import { $, avatarColor, initial, esc } from '../util.js';
import { toast } from '../toast.js';
import { clearCache as clearDashboardCache } from './dashboard.js';

const ROLE_CN = { admin: '管理员', reviewer: '评审委员', member: '成员' };

let me = null;

export function setMe(u) {
  me = u;
  $('#umName').textContent = u.name;
  $('#umMeta').textContent =
    `${u.username ? '@' + u.username : ''}${u.dept ? ' · ' + u.dept : ''} · ${ROLE_CN[u.role] || u.role}`;
  $('#miUsers').hidden = u.role !== 'admin';
}

/* ---------- 头像菜单 ---------- */
export function bindMenu() {
  const pop = $('#userMenu');
  const avatar = $('#meAvatar');
  const setOpen = open => {
    pop.classList.toggle('on', open);
    avatar.setAttribute('aria-expanded', String(open));
  };

  avatar.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(!pop.classList.contains('on'));
  });
  // 点菜单里面不关，点外面才关
  pop.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !pop.classList.contains('on')) return;
    setOpen(false);
    avatar.focus();
  });

  $('#miLogout').addEventListener('click', logout);
  $('#miPassword').addEventListener('click', () => { setOpen(false); avatar.focus(); openPassword(); });
  $('#miUsers').addEventListener('click', () => { setOpen(false); avatar.focus(); openUsers(); });

  $('#btnPwSave').addEventListener('click', savePassword);
  $('#pwNew2').addEventListener('keydown', e => { if (e.key === 'Enter') savePassword(); });
}

async function logout() {
  try { await api.logout(); } catch { /* 就算请求失败也照样送回登录页 */ }
  clearDashboardCache();
  location.replace('/login.html');
}

/* ---------- 修改密码 ---------- */
function openPassword() {
  for (const id of ['#pwOld', '#pwNew', '#pwNew2']) $(id).value = '';
  $('#pwErr').classList.remove('on');
  $('#pwModal').classList.add('on');
  $('#mask').classList.add('on');
  setTimeout(() => $('#pwOld').focus(), 60);
}

async function savePassword() {
  const err = $('#pwErr');
  const show = m => { err.textContent = m; err.classList.add('on'); };
  err.classList.remove('on');

  const oldPw = $('#pwOld').value, newPw = $('#pwNew').value;
  if (!oldPw || !newPw) return show('都要填');
  if (newPw !== $('#pwNew2').value) return show('两次输入的新密码不一样');
  if (newPw === oldPw) return show('新密码和原密码一样，等于没改');

  const btn = $('#btnPwSave');
  btn.disabled = true;
  try {
    await api.changePw(oldPw, newPw);
    close();
    toast('ok', '密码已修改，其它设备需要重新登录');
  } catch (e) {
    show(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 用户管理 ---------- */
async function openUsers() {
  $('#usersModal').classList.add('on');
  $('#mask').classList.add('on');
  $('#userList').innerHTML = Array.from({ length: 3 }, () => `
    <div class="urow sk">
      <div class="sk-line" style="width:34px;height:34px;border-radius:50%;flex:none"></div>
      <div class="who"><div class="sk-line" style="width:38%;height:14px"></div>
        <div class="sk-line" style="width:62%;height:12px"></div></div>
    </div>`).join('');
  await renderUsers();
}

async function renderUsers() {
  let items;
  try {
    ({ items } = await api.users());
  } catch (e) {
    $('#userList').innerHTML = `<div class="uempty">加载失败：${esc(e.message)}</div>`;
    return;
  }

  if (!items.length) {
    $('#userList').innerHTML = `<div class="uempty">还没有别人注册</div>`;
    return;
  }

  const adminCount = items.filter(u => u.role === 'admin').length;

  $('#userList').innerHTML = items.map(u => {
    const isMe = u.id === me.id;
    // 最后一个管理员不能降级，否则没人能再任命管理员，系统会锁死。
    // 后端也拦着这条，这里禁用按钮只是为了别让人白点一次。
    const lockAdmin = u.role === 'admin' && adminCount <= 1;
    return `
    <div class="urow" data-id="${u.id}">
      <div class="av" style="background:${avatarColor(u.name)}">${esc(initial(u.name))}</div>
      <div class="who">
        <b>${esc(u.name)}${isMe ? '<span class="utag">你自己</span>' : ''}</b>
        <span>@${esc(u.username || '')}${u.dept ? ' · ' + esc(u.dept) : ''} · 提过 ${u.ideaCount} 条灵感${
          u.lastLoginAt ? '' : ' · 从没登录过'}</span>
      </div>
      <div class="roles">
        ${['member', 'reviewer', 'admin'].map(r => `
          <button data-role="${r}" class="${u.role === r ? 'on' : ''}"${
            lockAdmin && r !== 'admin' ? ' disabled title="这是最后一个管理员，不能降级"' : ''}>${ROLE_CN[r]}</button>
        `).join('')}
      </div>
      <button class="more" data-reset="${u.id}" title="重置这个人的密码">重置密码</button>
    </div>`;
  }).join('');

  $('#userList').onclick = async e => {
    const roleBtn = e.target.closest('[data-role]');
    if (roleBtn && !roleBtn.disabled) return changeRole(roleBtn);
    const resetBtn = e.target.closest('[data-reset]');
    if (resetBtn) return resetPassword(Number(resetBtn.dataset.reset), items);
  };
}

async function changeRole(btn) {
  if (btn.classList.contains('on')) return;
  const id = Number(btn.closest('.urow').dataset.id);
  const role = btn.dataset.role;
  try {
    const u = await api.setRole(id, role);
    toast('ok', `${u.name} 现在是${ROLE_CN[u.role]}`);
    // 管理员把自己降级了的话，界面上的权限也得跟着变，最省事且不会出错的做法是重载
    if (id === me.id) return location.reload();
    await renderUsers();
  } catch (e) {
    toast('info', e.message);
  }
}

async function resetPassword(id, items) {
  const u = items.find(x => x.id === id);
  // 没有邮件系统，重置只能是「管理员设一个新的，当面或私聊告诉本人」。
  // 用 prompt 是刻意的：这个操作很少用，为它专门做一个弹窗不划算。
  const pw = prompt(`给「${u.name}」设一个新密码（至少 8 位）。\n设完请私下告诉本人，并让 ta 登录后自己改掉。`);
  if (pw === null) return;
  try {
    await api.resetPw(id, pw);
    toast('ok', `已重置 ${u.name} 的密码，ta 在其它设备上的登录也已断开`);
  } catch (e) {
    toast('info', e.message);
  }
}

export function close() {
  $('#pwModal').classList.remove('on');
  $('#usersModal').classList.remove('on');
}
