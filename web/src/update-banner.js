/**
 * 「有新版本」提示条。
 *
 * IdeaHub 是单页应用，同事的页面常常一开一整天、手机上切到后台再回来也还是那一份，
 * 上线之后不刷新就一直用着旧版 —— 2026-09-23 上线 .md 预览后，用户那边看到的就还是旧页面。
 *
 * live.js 收到后端 hello 时带着服务器当前的前端版本号，和页面自己加载的版本（dist/app.js?v=…）
 * 一比，不一样就在顶栏下方弹这条。不自动刷新：人可能正在填报销单、写灵感，刷掉就白写了。
 * 点「稍后」只是收起，下次版本再变（或重新连上）还会出现。
 */
let bar = null;
let dismissedFor = '';

/** 页面自己加载的版本号；源码模式（开发时）没有，返回空串 */
export function loadedVersion() {
  const src = document.querySelector('script[src*="dist/app.js"]')?.getAttribute('src') || '';
  try { return new URL(src, location.href).searchParams.get('v') || ''; } catch { return ''; }
}

/** 服务器说当前版本是 serverVersion：和页面的不一样就提示 */
export function checkVersion(serverVersion) {
  const mine = loadedVersion();
  if (!serverVersion || !mine || serverVersion === mine) return false;
  if (dismissedFor === serverVersion) return false;
  show(serverVersion);
  return true;
}

function show(version) {
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `
      <span class="ub-text">IdeaHub 有新版本了<span class="ub-more">，刷新一下就能用上</span></span>
      <button type="button" class="ub-reload">刷新</button>
      <button type="button" class="ub-later" aria-label="稍后再说">稍后</button>`;
    bar.querySelector('.ub-reload').addEventListener('click', () => location.reload());
    bar.querySelector('.ub-later').addEventListener('click', () => {
      dismissedFor = bar.dataset.version;
      bar.classList.remove('on');
    });
    document.body.appendChild(bar);
  }
  bar.dataset.version = version;
  bar.classList.add('on');
}
