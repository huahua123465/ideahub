/**
 * 登录 / 注册页。
 * 独立入口，不走 api.js —— api.js 在 401 时会跳转到登录页，
 * 登录页自己再用它就会绕成一个圈。这里直接 fetch，逻辑也就几十行。
 */
const $ = s => document.querySelector(s);

const BASE = location.port === '5173'
  ? `${location.protocol}//${location.hostname}:3000`
  : '';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空响应 */ }
  if (!r.ok) throw new Error(data?.error || `请求失败（${r.status}）`);
  return data;
}

/** 登录成功后回到原来想去的地方。 */
function go() {
  const next = new URLSearchParams(location.search).get('next') || '/';
  // 只允许站内相对路径。不校验的话，别人发一个
  // /login.html?next=https://钓鱼站 的链接，登录完就把人送出去了。
  location.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.add('on');
}
function clearErr(el) { el.classList.remove('on'); }

/** 提交期间禁用按钮，避免手快点两下建出两个账号 */
async function submitting(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------- 切换登录 / 注册 ---------- */
function showTab(which) {
  const isLogin = which === 'login';
  $('#tabLogin').classList.toggle('on', isLogin);
  $('#tabReg').classList.toggle('on', !isLogin);
  $('#formLogin').hidden = !isLogin;
  $('#formReg').hidden = isLogin;
  clearErr($('#lgErr')); clearErr($('#rgErr'));
  setTimeout(() => (isLogin ? $('#lgUser') : $('#rgName')).focus(), 30);
}
$('#tabLogin').onclick = () => showTab('login');
$('#tabReg').onclick   = () => showTab('reg');

/* ---------- 登录 ---------- */
$('#formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  clearErr($('#lgErr'));
  const username = $('#lgUser').value.trim();
  const password = $('#lgPw').value;
  if (!username || !password) return showErr($('#lgErr'), '姓名和密码都要填');

  await submitting($('#lgBtn'), '登录中…', async () => {
    try {
      await post('/api/auth/login', { username, password });
      go();
    } catch (err) {
      showErr($('#lgErr'), err.message);
      $('#lgPw').value = '';
      $('#lgPw').focus();
    }
  });
});

/* ---------- 注册 ---------- */
$('#formReg').addEventListener('submit', async e => {
  e.preventDefault();
  clearErr($('#rgErr'));

  const payload = {
    name: $('#rgName').value.trim(),
    dept: $('#rgDept').value.trim(),
    password: $('#rgPw').value,
    inviteCode: $('#rgInvite').value.trim(),
  };

  // 两次密码不一致在前端就拦掉：这个错不需要跑一趟服务器才知道
  if (payload.password !== $('#rgPw2').value) {
    $('#rgPw2').focus();
    return showErr($('#rgErr'), '两次输入的密码不一样');
  }

  await submitting($('#rgBtn'), '注册中…', async () => {
    try {
      await post('/api/auth/register', payload);
      go();
    } catch (err) {
      showErr($('#rgErr'), err.message);
    }
  });
});

/* ---------- 启动 ---------- */
(async () => {
  try {
    const r = await fetch(BASE + '/api/auth/config', { credentials: 'include' });
    const cfg = await r.json();

    if (cfg.loggedIn) return go();          // 已经登录了就别停在登录页

    if (cfg.needInviteCode) $('#inviteWrap').hidden = false;

    // 一个账号都没有 → 默认落在注册页，并说清楚第一个注册的人会是管理员。
    // 否则第一次部署完打开是个登录框，而系统里根本没有账号可登。
    if (cfg.isEmpty) {
      $('#firstNote').hidden = false;
      showTab('reg');
      return;
    }
  } catch {
    showErr($('#lgErr'), '连不上服务器，确认后端已经启动。');
  }
  showTab('login');
})();
