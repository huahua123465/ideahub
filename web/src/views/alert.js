/**
 * 新消息提醒。
 *
 * 真正的系统级桌面通知（切到别的软件也能弹出来的那种）需要 HTTPS ——
 * 浏览器把 Notification 归为「安全上下文专属」的能力，明文 HTTP 下
 * requestPermission() 直接不可用。
 *
 * 这个项目有多个入口，能不能发通知取决于走哪个（详见 CLAUDE.md 的地址表）：
 *  · https://xm.xingxingqule.com:9443  ✅ 安全上下文，「开启桌面通知」按钮会出现
 *  · http://xm.xingxingqule.com        ❌ 明文，只有下面那套兜底
 *  · http://67.230.168.104:18080       ❌ 明文，直连，绕过了前置 Caddy
 *
 * 所以这里分两层：
 *  · 任何情况下都有的兜底：标签页标题挂未读数 + 提示音 + favicon 红点。
 *    浏览器开着（哪怕在别的标签页）就能注意到；最小化或切到别的软件则看不到。
 *  · HTTPS 下：用户点一下「开启桌面通知」就能发真正的系统通知。
 *
 * 权限申请必须由用户点击触发，不能在页面加载时自动调。
 * Edge 从 84 起默认开着「静默通知请求」：自动发起的申请**不弹授权框**，
 * 只在地址栏放一个铃铛图标，Notification.permission 一直停在 'default'。
 * 结果就是 Chrome 上好好的，Edge 上什么都不发生、也不报错。
 * 见 status() / enable()，以及消息面板里那条提示条（views/notify.js）。
 */

const TITLE = document.title;
let unread = 0;
let sysOk = false;              // 系统通知能不能用
let lastSound = 0;

/** 状态变了就发一下，让消息面板把提示条重画 */
export const events = new EventTarget();
const emitChange = () => events.dispatchEvent(new Event('change'));

/* ---------------- 系统通知 ---------------- */

/**
 * 页面启动时调一次：只**读**当前权限，绝不主动申请。
 * 之前这里会自动 requestPermission()，那正是 Edge 静默拦截的那条路。
 */
export function initSystem() {
  sysOk = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  return sysOk;
}

/**
 * 现在到底能不能发系统通知，以及为什么不能。
 *
 * 顺序有讲究，三条都踩过坑：
 *  1. granted 必须排在最前。明文 HTTP 下用户仍然可以在浏览器的站点设置里
 *     手动把这个源加进「允许」，加了之后通知是真能发的 ——
 *     先判 secure 会把这种已经能用的情况误报成不可用。
 *  2. insecure 要排在 denied 前面。Chromium 在非安全源上会直接把 permission
 *     报成 'denied'，先判 denied 就会告诉用户「你拒绝过，去锁图标里改」——
 *     而真正的原因是 HTTP，照那句话去点是找不到那个开关的。
 *  3. 剩下的 default 才是「可以问一问」。
 *
 * @returns {{state:string, why:string, canAsk:boolean}}
 */
export function status() {
  if (typeof Notification === 'undefined')
    return { state: 'unsupported', why: '这个浏览器不支持桌面通知。', canAsk: false };

  if (Notification.permission === 'granted')
    return { state: 'granted', why: '', canAsk: false };

  if (!window.isSecureContext)
    return {
      state: 'insecure',
      why: '当前是 HTTP 访问，浏览器只在 HTTPS 下开放桌面通知。'
         + '临时办法：在浏览器的通知设置里把本站地址手动加进「允许」列表。',
      canAsk: false,
    };

  if (Notification.permission === 'denied')
    return {
      state: 'denied',
      why: '桌面通知被拒绝过。要改回来：点地址栏左边的锁/信息图标 → 通知 → 允许，然后刷新页面。',
      canAsk: false,
    };

  return { state: 'default', why: '', canAsk: true };
}

/**
 * 申请权限。**必须在用户点击的事件处理里调**，否则 Edge 会静默吞掉。
 * @returns 和 status() 同构的结果，外加 dismissed 这个只有申请过才会出现的状态
 */
export async function enable() {
  const st = status();
  if (st.state === 'granted') { sysOk = true; return st; }
  if (!st.canAsk) return st;

  let p;
  try {
    p = await Notification.requestPermission();
  } catch {
    return { state: 'error', why: '浏览器拒绝了这次权限申请。', canAsk: false };
  }

  sysOk = p === 'granted';
  emitChange();

  if (p === 'granted') {
    // 立刻发一条确认。这一步不只是「好看」：权限给了但系统层被拦住
    // （Windows 通知设置里关了 Edge、或者开着专注助手）时，
    // 这条也弹不出来 —— 人当场就能发现问题出在浏览器外面。
    try {
      new Notification('桌面通知已开启', {
        body: '有新消息时会像这样提醒你。如果你没看到这条，问题在系统的通知设置里。',
        tag: 'ideahub',
      });
    } catch { /* 发不出去也不影响权限本身 */ }
    return { state: 'granted', why: '', canAsk: false };
  }

  if (p === 'denied')
    return {
      state: 'denied',
      why: '你拒绝了。要改回来：点地址栏左边的锁/信息图标 → 通知 → 允许，然后刷新页面。',
      canAsk: false,
    };

  // 既没同意也没拒绝 —— 授权框压根没出现。Edge 的「静默通知请求」就是这个表现。
  return {
    state: 'dismissed',
    why: '授权框没有出现。Edge 默认开着「静默通知请求」，'
       + '请点地址栏里的铃铛图标手动允许，或到 edge://settings/content/notifications 关掉这个设置后再试。',
    canAsk: true,
  };
}

/* ---------------- 提示音 ---------------- */

/** 用 Web Audio 现场合成一声「叮」，不引外部音频文件 —— 少一个要加载的资源 */
function ding() {
  // 一秒内最多响一次：几条消息连着到不该变成连环 beep
  if (Date.now() - lastSound < 1000) return;
  lastSound = Date.now();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(1180, ctx.currentTime + 0.09);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.3);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch { /* 浏览器不让自动播就算了，标题上的未读数还在 */ }
}

/* ---------------- favicon 红点 ---------------- */

let baseFavicon = null;

function paintFavicon(n) {
  const link = document.querySelector('link[rel~="icon"]');
  if (!link) return;
  if (baseFavicon === null) baseFavicon = link.href;
  if (!n) { link.href = baseFavicon; return; }
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    // 底色用品牌蓝，中间一个白点，右上角红角标 —— 32px 的图标里画不下更多东西
    x.fillStyle = '#2563eb';
    x.beginPath(); x.roundRect(2, 2, 60, 60, 14); x.fill();
    x.fillStyle = '#fff';
    x.font = 'bold 34px system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('i', 30, 32);
    x.fillStyle = '#dc4c3f';
    x.beginPath(); x.arc(48, 16, 14, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#fff';
    x.font = 'bold 20px system-ui, sans-serif';
    x.fillText(n > 9 ? '9+' : String(n), 48, 17);
    link.href = c.toDataURL('image/png');
  } catch { /* 画不出来就保持原样 */ }
}

/* ---------------- 标签页标题 ---------------- */

/**
 * 在标题前挂一个 (N)，而不是让它闪。
 *
 * 一开始做的是 setInterval 定时交替，实测在后台标签页里根本不闪 ——
 * 浏览器会把后台页面的定时器限流到一分钟级别。而这里本来也不需要动画：
 * 设一次就够，Gmail、Slack 都是这么做的，扫一眼标签栏就看见数字。
 */
function setTitle(n) {
  document.title = n > 0 ? `(${n}) ${TITLE}` : TITLE;
}

/* ---------------- 对外 ---------------- */

/**
 * 未读数变了就调一次。
 * @param n     当前未读总数
 * @param info  新到的那条（有就弹系统通知/响一声），{ title, body, onClick }
 */
export function update(n, info) {
  const grew = n > unread;
  unread = n;

  paintFavicon(n);

  // 人就在页面上看着，不用打扰他 —— 未读数在铃铛和聊天按钮上已经显示了
  if (document.visibilityState === 'visible') { setTitle(0); return; }

  setTitle(n);

  if (grew && info) {
    ding();
    if (sysOk) {
      try {
        const nf = new Notification(info.title || '新消息', {
          body: info.body || '', tag: 'ideahub', renotify: true,
        });
        nf.onclick = () => { window.focus(); nf.close(); info.onClick?.(); };
      } catch { /* 发不出去就算了 */ }
    }
  }
}

/** 回到页面就把提醒收掉 */
export function bind() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTitle(0);
  });
}
