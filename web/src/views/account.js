/**
 * 账号相关：头像菜单、退出登录、修改密码、用户管理。
 */
import { api } from '../api.js';
import { $, avatarColor, initial, esc } from '../util.js';
import { toast } from '../toast.js';
import { clearCache as clearDashboardCache } from './dashboard.js';
import { DEFAULT_DEPTS } from './expenses.js';
import { confirmAction } from '../confirm.js';

const ROLE_CN = { admin: '管理员', reviewer: '评审委员', member: '成员' };
const EXPENSE_ROLE_CN = { gm: '总经理', finance: '财务', cashier: '出纳' };

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
  $('#miReportPrefs').addEventListener('click', () => { setOpen(false); avatar.focus(); openReportPrefs(); });

  $('#btnVisSave').addEventListener('click', saveVisibilityDefault);
  $('#btnVisAllPublic').addEventListener('click', () => applyVisibilityToAll('public'));
  $('#btnVisAllPrivate').addEventListener('click', () => applyVisibilityToAll('private'));

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

/* ---------- 日报可见性 ----------
   两件事，界面上必须分清楚，不然一定有人以为改了默认值历史记录也跟着变：
     · 默认值 —— 只影响以后新写的
     · 两个批量按钮 —— 只影响已经写过的
   都只作用于自己写的日报，后端那两个接口也没有管理员分支。 */
function openReportPrefs() {
  $('#visErr').classList.remove('on');
  $('#visDefault').value = me?.reportVisibilityDefault === 'public' ? 'public' : 'private';
  $('#visModal').classList.add('on');
  $('#mask').classList.add('on');
  setTimeout(() => $('#visDefault').focus(), 60);
}

const visError = m => { const e = $('#visErr'); e.textContent = m; e.classList.add('on'); };

async function saveVisibilityDefault() {
  const btn = $('#btnVisSave');
  const v = $('#visDefault').value;
  $('#visErr').classList.remove('on');
  btn.disabled = true;
  try {
    const fresh = await api.prefsPatch({ reportVisibilityDefault: v });
    // me 是这个模块里的一份缓存，不同步的话弹窗再打开会显示改之前的值
    if (me) me.reportVisibilityDefault = fresh.reportVisibilityDefault;
    close();
    toast('ok', v === 'public' ? '以后新写的日报默认全员可见' : '以后新写的日报默认只有你自己看得到');
  } catch (e) {
    visError(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function applyVisibilityToAll(v) {
  const btns = [$('#btnVisAllPublic'), $('#btnVisAllPrivate')];
  $('#visErr').classList.remove('on');
  for (const b of btns) b.disabled = true;
  try {
    const r = await api.reportsVisibilityAll(v);
    close();
    toast('ok', r.changed
      ? `${r.changed} 条日报已改为${v === 'public' ? '全员可见' : '仅自己可见'}`
      : '没有需要改的日报，本来就都是这个设置');
  } catch (e) {
    visError(e.message);
  } finally {
    for (const b of btns) b.disabled = false;
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

/** 部门下拉：报销审批里配过的部门 + 公司默认部门 + 这个人当前填的（哪怕不在列表里也要显示出来） */
function deptOptions(current, cfg) {
  const configured = new Set((cfg?.depts || []).map(d => d.dept));
  const names = [...new Set([...configured, ...DEFAULT_DEPTS, ...(current ? [current] : [])])];
  return `<option value="">未分配部门</option>${names.map(d => `<option value="${esc(d)}"${d === current ? ' selected' : ''}>${
    esc(d)}${configured.has(d) ? '' : '（未设负责人）'}</option>`).join('')}`;
}

async function renderUsers() {
  let items, cfg;
  try {
    // 读不到报销配置不影响管理账号，部门下拉退回到默认部门
    [{ items }, cfg] = await Promise.all([api.users(), api.expenseConfig().catch(() => null)]);
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
    // 报销审批里的身份：负责哪些部门、是不是总经理 / 财务 / 出纳。都来自同一份审批配置
    const leads = (cfg?.depts || []).filter(d => d.leader?.id === u.id).map(d => d.dept);
    const isLeader = !!u.dept && leads.includes(u.dept);
    const duties = [
      ...leads.map(d => `${d}负责人`),
      ...Object.entries(EXPENSE_ROLE_CN).filter(([k]) => cfg?.roles?.[k]?.id === u.id).map(([, v]) => v),
    ];
    return `
    <div class="urow" data-id="${u.id}">
      <div class="av" style="background:${avatarColor(u.name)}">${esc(initial(u.name))}</div>
      <div class="who">
        <b>${esc(u.name)}${isMe ? '<span class="utag">你自己</span>' : ''}</b>
        <span>@${esc(u.username || '')}${u.dept ? ' · ' + esc(u.dept) : ''} · 提过 ${u.ideaCount} 条灵感${
          u.lastLoginAt ? '' : ' · 从没登录过'}</span>
        ${duties.length ? `<div class="uduties">${duties.map(t => `<span class="utag duty">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
      <select class="inp udept" data-dept-user="${u.id}" aria-label="${esc(u.name)}的部门"
        title="报销单按这个部门找负责人审批">${deptOptions(u.dept, cfg)}</select>
      <button type="button" class="ulead${isLeader ? ' on' : ''}" data-lead-user="${u.id}" aria-pressed="${isLeader}"${
        u.dept ? ` title="${isLeader ? `点击取消${esc(u.name)}的${esc(u.dept)}负责人` : `设为${esc(u.dept)}的负责人`}"`
          : ' disabled title="先给这个人选部门"'}>部门负责人</button>
      <div class="roles">
        ${['member', 'reviewer', 'admin'].map(r => `
          <button data-role="${r}" class="${u.role === r ? 'on' : ''}"${
            lockAdmin && r !== 'admin' ? ' disabled title="这是最后一个管理员，不能降级"' : ''}>${ROLE_CN[r]}</button>
        `).join('')}
      </div>
      <button class="more" data-reset="${u.id}" title="重置这个人的密码">重置密码</button>
    </div>`;
  }).join('');

  $('#userList').onchange = e => {
    const sel = e.target.closest('[data-dept-user]');
    if (sel) changeDept(sel);
  };
  $('#userList').onclick = async e => {
    const leadBtn = e.target.closest('[data-lead-user]');
    if (leadBtn && !leadBtn.disabled) return changeLeader(leadBtn, items, cfg);
    const roleBtn = e.target.closest('[data-role]');
    if (roleBtn && !roleBtn.disabled) return changeRole(roleBtn);
    const resetBtn = e.target.closest('[data-reset]');
    if (resetBtn) return resetPassword(Number(resetBtn.dataset.reset), items);
  };
}

/** 用户管理里的「部门负责人」开关：设为 / 取消这个人所在部门的负责人 */
async function changeLeader(btn, items, cfg) {
  const id = Number(btn.dataset.leadUser);
  const u = items.find(x => x.id === id);
  if (!u?.dept) return;
  const current = (cfg?.depts || []).find(d => d.dept === u.dept)?.leader || null;
  const on = btn.getAttribute('aria-pressed') === 'true';
  const ok = on
    ? await confirmAction({
      eyebrow: '取消部门负责人', title: `取消${u.name}的「${u.dept}」负责人？`,
      message: '取消后这个部门暂不启用：部门里的人提交报销会被拦下，直到指定新的负责人。',
      confirmLabel: '取消负责人',
    })
    : !current || current.id === id || await confirmAction({
      eyebrow: '更换部门负责人', title: `把「${u.dept}」的负责人从${current.name}换成${u.name}？`,
      message: '正在等部门负责人审批的报销单会转给新负责人。', confirmLabel: '更换',
    });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api.expenseDeptLeader(u.dept, on ? null : id);
    toast('ok', on ? `已取消 ${u.name} 的${u.dept}负责人` : `${u.name} 现在是${u.dept}负责人`);
  } catch (e) {
    toast('info', e.message || '保存失败');
  }
  await renderUsers();
  $(`#userList [data-lead-user="${id}"]`)?.focus();
}

async function changeDept(sel) {
  const id = Number(sel.dataset.deptUser);
  sel.disabled = true;
  try {
    const saved = await api.setDept(id, sel.value);
    toast('ok', saved.dept ? `${saved.name} 已分到${saved.dept}` : `已取消 ${saved.name} 的部门`);
    // me 是全站共用的那份当前用户对象：改的是自己时同步过去，发起报销马上按新部门走
    if (id === me.id) { me.dept = saved.dept; setMe(me); }
  } catch (e) {
    toast('info', e.message || '保存失败');
  }
  await renderUsers();
  // 重绘后焦点回到这个人的下拉框，键盘连续分配时不用重新找
  $(`#userList [data-dept-user="${id}"]`)?.focus();
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
  $('#visModal').classList.remove('on');
}
