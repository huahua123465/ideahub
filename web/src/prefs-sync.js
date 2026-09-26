/**
 * 界面偏好跟着账号走（2026-09-26）。
 *
 * 配色与外观（ideahub.look）、我的配色（ideahub.look.mine.v1）、明暗（ideahub.theme）原来只存在这台浏览器里，
 * 换电脑、换浏览器就没了。现在登录后和服务器上的那份对一下（/api/auth/me/ui-prefs）：
 *   · 这台浏览器上次同步之后没改过、服务器那份变了（在别处改的）→ 用服务器的
 *   · 这台浏览器改过还没推上去、服务器那份没变 → 推上去
 *   · 这台浏览器第一次给这个账号用（或者换了人登录）→ 服务器有就用服务器的，没有就把本地的推上去
 *   · 两边都改了（很少见：断网时改了，别处也改了）→ 以这台浏览器为准，因为这是用户最近一次的操作
 * 不比较两边的时钟：只记「上次同步时服务器那份的版本号（updatedAt）」和「之后本地改没改过」。
 * 之后本地一改（配色引擎、配色面板、明暗切换都会发 ideahub:prefs 事件），停 1.5 秒推一次。
 *
 * 演示模式默认不同步，不然各个 UI 测试之间会通过假服务器互相串；
 * 要验同步的测试设 sessionStorage ideahub.qa.prefsync = 1。
 */
import { api, state } from './api.js';
import { current as currentTheme, setTheme } from './theme.js';

const LOOK_KEY = 'ideahub.look';
const MINE_KEY = 'ideahub.look.mine.v1';
const META_KEY = 'ideahub.uiPrefs.meta';   // { user, synced: 服务器那份的 updatedAt, dirty: 之后本地改过没推 }
const PUSH_DELAY = 1500;

let userId = null;
let timer = 0;
let applying = false;
let enabled = false;

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
};
const meta = () => readJson(META_KEY, {});
const saveMeta = m => { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* 存不下就下次再比 */ } };

/** 这台浏览器现在的那一份 */
function localPrefs() {
  const out = {};
  const look = readJson(LOOK_KEY, null);
  if (look && typeof look === 'object' && !Array.isArray(look)) out.look = look;
  const mine = readJson(MINE_KEY, null);
  if (Array.isArray(mine) && mine.length) out.mine = mine;
  out.theme = currentTheme();
  return out;
}
const isEmpty = p => !p.look && !p.mine?.length && (!p.theme || p.theme === 'auto');

/** 把服务器那份套到这台浏览器上。套的过程中引擎、明暗也会发改动事件，这时不当成「本地改了」 */
function applyServer(prefs) {
  applying = true;
  try {
    try {
      if (Array.isArray(prefs.mine) && prefs.mine.length) localStorage.setItem(MINE_KEY, JSON.stringify(prefs.mine));
      else localStorage.removeItem(MINE_KEY);
    } catch { /* 存不下：这次照样生效，只是刷新后又会从服务器拿 */ }
    const engine = window.IdeaHubLook;
    if (engine) {
      engine.reset();
      if (prefs.look) engine.set(prefs.look);
    }
    setTheme(prefs.theme || 'auto');
  } finally {
    applying = false;
  }
  window.dispatchEvent(new Event('ideahub:prefs-applied'));   // 配色面板开着的话重画一遍
}

async function push() {
  clearTimeout(timer);
  if (!enabled) return;
  try {
    const r = await api.uiPrefsSave(localPrefs());
    const m = meta();
    // 推的过程中又改了（dirty 被重新置上且时间更晚）就留着 dirty，等下一次推
    saveMeta({ user: userId, synced: r.updatedAt, dirty: m.changedAt > m.pushingAt });
    if (m.changedAt > m.pushingAt) schedule();
  } catch {
    /* 网络断了之类：dirty 留着，下次改动或下次打开页面再推 */
  }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    saveMeta({ ...meta(), pushingAt: Date.now() });
    push();
  }, PUSH_DELAY);
}

function onLocalChange() {
  if (applying || !enabled) return;
  saveMeta({ ...meta(), user: userId, dirty: true, changedAt: Date.now() });
  schedule();
}

/** 登录后调一次。拿不到服务器那份（比如迁移还没执行）就当没有这个功能，本地照常用 */
export async function initPrefsSync(me) {
  userId = Number(me?.id) || null;
  enabled = !!userId && (state.mode === 'live' || sessionStorage.getItem('ideahub.qa.prefsync') === '1');
  if (!enabled) return;
  window.addEventListener('ideahub:prefs', onLocalChange);
  let server;
  try { server = await api.uiPrefs(); } catch { enabled = false; return; }
  const m = meta();
  const hasServer = !!server?.updatedAt;
  const local = localPrefs();
  if (m.user !== userId) {
    // 这台浏览器第一次给这个账号用
    if (hasServer) { applyServer(server.prefs || {}); saveMeta({ user: userId, synced: server.updatedAt, dirty: false }); }
    else if (!isEmpty(local)) { saveMeta({ user: userId, synced: null, dirty: true, changedAt: Date.now() }); schedule(); }
    else saveMeta({ user: userId, synced: null, dirty: false });
    return;
  }
  if (m.dirty) { schedule(); return; }   // 本地有没推上去的改动：以本地为准
  if (hasServer && server.updatedAt !== m.synced) {
    applyServer(server.prefs || {});
    saveMeta({ user: userId, synced: server.updatedAt, dirty: false });
  }
}
