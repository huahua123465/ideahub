/**
 * 「配色与外观」面板（2026-09-24）。
 *
 * 真正换颜色的引擎在 index.html <head> 里（window.IdeaHubLook）：它必须在首次绘制前跑，
 * 所以不能放进模块。这里只负责面板：选配色、自己调色相、圆角、密度、动效。
 * 设置记在这台设备的 localStorage（ideahub.look），和「跟随系统 / 浅色 / 深色」一样按设备走。
 * 09-25 配色按原型 1:1：分「浅色主题」「深色主题」两组，选哪套明暗就跟着切到那一边。
 * 09-25 晚「自己调」能直接取色（主色 / 点缀色 / 底色），调好的可以存成「我的配色」，
 * 起名、改名、删除，随时切回来；清单也记在这台设备上（ideahub.look.mine.v1）。
 * 09-26 改成自动保存：从哪套配色出发一动手，就自动在「我的配色」里建一套（「我的森屿」这样起名），
 * 之后每一下都直接写回这一套。原来要手动点「存为我的配色」，没点就去点别的色板，改的颜色就丢了。
 *
 * 面板不遮挡页面（没有遮罩）：改外观就是要边改边看后面的页面。
 */
import { esc } from './util.js';
import { toast } from './toast.js';
import { reveal } from './anim.js';
import { current as currentTheme, setTheme } from './theme.js';

const engine = () => window.IdeaHubLook;
let drawer = null;
let returnFocus = null;
let frame = 0;
let draft = null;         // 这一帧里还没交给引擎的最新设置：连着几下取色 / 拖动都在它上面叠
let naming = null;        // 正在起名：{ kind: 'copy' | 'rename', value }
let confirmDel = 0;       // 点过一次「删除」的时间，3 秒内再点才真删
const q = sel => drawer.querySelector(sel);

const MINE_KEY = 'ideahub.look.mine.v1';
const MINE_MAX = 12;
/* 主色在浅色下的深浅范围：再浅，按钮上的白字、链接文字的对比度就不到 4.5:1 了 */
const AL_MIN = 0.25;
const AL_MAX = 0.56;
const VALS = ['A', 'B', 'H', 'C', 'tint', 'AL', 'BL', 'BC'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const valsOf = o => Object.fromEntries(VALS.map(k => [k, o[k] ?? null]));

const isDark = () => {
  const t = currentTheme();
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
};

/* ---------- 我的配色 ---------- */
export function savedLooks() {
  try {
    const v = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
    return Array.isArray(v) ? v.filter(m => m && typeof m.id === 'string' && typeof m.name === 'string') : [];
  } catch { return []; }
}
function storeMine(list) {
  try { localStorage.setItem(MINE_KEY, JSON.stringify(list)); return true; } catch {
    toast('info', '这台设备存不下了（可能是隐私模式），这次的配色只在当前页面生效');
    return false;
  }
}
/** 切到「我的配色」里的某一套（面板和命令面板都走这里） */
export function useSaved(id) {
  const m = savedLooks().find(x => x.id === id);
  if (!m) return;
  engine().set({ family: 'custom', ...valsOf(m), mine: id });
  setTheme(m.mode === 'dark' ? 'dark' : 'light');
}
/** 当前用的是「我的配色」里的哪一套（没有就是 null） */
function mineState() {
  const s = draft || engine().get();
  const cur = s.family === 'custom' && s.mine ? savedLooks().find(m => m.id === s.mine) || null : null;
  return { s, cur };
}
const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** 自动起名：从「森屿」改出来的叫「我的森屿」，重名了往后加数字 */
function autoName(from) {
  const names = new Set(savedLooks().map(m => m.name));
  const base = from ? `我的${from}` : '我的配色';
  if (from && !names.has(base)) return base;
  let n = from ? 2 : 1;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
/** 眼前这套配色的数值：自定义就是自己，预设就是预设的参数，默认用引擎的默认值 */
function effective(s = engine().get()) {
  if (s.family === 'custom') return valsOf(s);
  const fam = engine().FAMILIES.find(f => f.id === s.family);
  return valsOf(fam?.A != null ? fam : engine().DEFAULTS);
}

/** 色相滑块的轨道：把一整圈色相按当前明暗画出来，拖到哪就是哪种颜色 */
const hueTrack = dark => `linear-gradient(90deg,${Array.from({ length: 13 },
  (_, i) => `oklch(${dark ? 72 : 60}% .15 ${i * 30})`).join(',')})`;

const seg = (key, options, value, label) => `
  <div class="look-seg" role="group" aria-label="${esc(label)}">${options.map(([v, text]) =>
    `<button type="button" data-look-${key}="${v}" aria-pressed="${value === v}">${esc(text)}</button>`).join('')}</div>`;

const range = (id, label, min, max, step, value, hint) => `
  <div class="look-range">
    <label for="${id}"><span>${esc(label)}</span><output id="${id}Out" for="${id}"></output></label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"${hint ? ` aria-describedby="${id}Hint"` : ''}>
    ${hint ? `<small id="${id}Hint">${esc(hint)}</small>` : ''}
  </div>`;

const picker = (key, label) => `
  <label class="look-pick" for="lookPick${key}">
    <input type="color" id="lookPick${key}" data-look-pick="${key}">
    <span><b>${esc(label)}</b><small id="lookPick${key}Hex"></small></span>
  </label>`;

function markup() {
  const s = engine().get();
  const v = effective(s);
  return `
    <div class="dhead">
      <div class="look-head">
        <h2 id="lookTitle">配色与外观</h2>
        <button type="button" class="look-x" data-look-close aria-label="关闭配色与外观">×</button>
      </div>
      <p class="look-sub">改完立刻生效，只保存在这台设备上</p>
    </div>
    <div class="dbody look-body">
      <section class="look-sec" aria-labelledby="lookModeH">
        <h3 id="lookModeH">明暗</h3>
        ${seg('mode', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']], currentTheme(), '明暗')}
      </section>
      <section class="look-sec" aria-labelledby="lookFamH">
        <h3 id="lookFamH">配色</h3>
        <div id="lookFamilies"></div>
      </section>
      <section class="look-sec" aria-labelledby="lookTuneH">
        <h3 id="lookTuneH">自己调</h3>
        <p class="look-note">从任何一套配色出发，取色或拖滑块就变成你自己的配色，调好了存进「我的配色」</p>
        <div class="look-picks">${picker('A', '主色')}${picker('B', '点缀色')}${picker('H', '底色')}</div>
        <small class="look-note" id="lookPickNote" hidden></small>
        ${range('lookA', '主色色相', 0, 359, 1, v.A)}
        ${range('lookChroma', '鲜艳度', 0, 0.25, 0.005, v.C)}
        ${range('lookAL', '主色深浅', AL_MIN, AL_MAX, 0.01, v.AL ?? engine().BASE.L, '只影响浅色；深色下主色会自动提亮。最浅到按钮白字还看得清为止')}
        ${range('lookB', '点缀色色相', 0, 359, 1, v.B)}
        ${range('lookTint', '底色染色', 0, 1, 0.05, v.tint, '越往右，页面底色和边框越带颜色')}
        <div class="look-mine-bar" id="lookMineBar"></div>
      </section>
      <section class="look-sec" aria-labelledby="lookShapeH">
        <h3 id="lookShapeH">形状与密度</h3>
        ${range('lookRadius', '圆角', 0.5, 1.6, 0.05, s.radius)}
        ${seg('density', [['compact', '紧凑'], ['cozy', '标准'], ['roomy', '宽松']], s.density, '密度')}
      </section>
      <section class="look-sec" aria-labelledby="lookMotionH">
        <h3 id="lookMotionH">动效</h3>
        ${seg('motion', [['auto', '跟随系统'], ['always', '完整'], ['lite', '简洁'], ['off', '关闭']], s.motion, '动效')}
        <small class="look-note" id="lookMotionNote"></small>
      </section>
    </div>
    <div class="dfoot look-foot">
      <button type="button" class="btn btn-ghost" data-look-reset>恢复默认</button>
      <button type="button" class="btn btn-primary" data-look-close>完成</button>
    </div>`;
}

const MOTION_NOTE = {
  auto: '按系统设置来：系统开了「减弱动态效果」（Windows 关了「显示动画」）就自动收起动画',
  always: '切换、数字滚动、倾斜、庆祝动画都开着，系统关了动画也照样播放',
  lite: '保留必要的过渡，去掉数字滚动和庆祝动画',
  off: '所有动画都关掉，适合容易晕动的人',
};

const dot = ([bg, a, b]) =>
  `<span class="look-dot" style="background:${bg}"><i style="background:${a}"></i><i style="background:${b}"></i></span>`;

function paintFamilies(s, dark) {
  const fams = engine().FAMILIES;
  const { cur } = mineState();
  const card = (attr, id, pressed, colors, name, extra = '') =>
    `<button type="button" class="look-fam" ${attr}="${id}" aria-pressed="${pressed}">${colors}<span>${esc(name)}</span>${extra}</button>`;
  // 「跟随系统」的色板和原型一样：一半浅底一半深底
  const [light] = engine().swatch(fams[0], false);
  const [darkBg] = engine().swatch(fams[0], true);
  const auto = card('data-look-family', 'default', s.family === 'default',
    `<span class="look-dot" style="background:linear-gradient(135deg,${light} 50%,${darkBg} 50%)"></span>`, fams[0].name);
  const group = mode => fams.filter(f => f.mode === mode)
    .map(f => card('data-look-family', f.id, s.family === f.id, dot(engine().swatch(f)), f.name)).join('');
  const mine = savedLooks().map(m => card('data-look-mine', esc(m.id), cur?.id === m.id,
    dot(engine().swatch({ ...valsOf(m), mode: m.mode })), m.name)).join('');
  // 没存上的那一套（「我的配色」存满了，或者刚把正在用的那套删了）
  const loose = s.family === 'custom' && !cur
    ? card('data-look-family', 'custom', true, dot(engine().swatch(valsOf(s), dark)), '自定义', '<small class="look-dirty">未保存</small>') : '';
  q('#lookFamilies').innerHTML = `
    <h4 class="look-grp">浅色主题</h4><div class="look-families">${auto}${group('light')}</div>
    <h4 class="look-grp">深色主题</h4><div class="look-families">${group('dark')}</div>
    <h4 class="look-grp">我的配色</h4>
    ${mine || loose ? `<div class="look-families" id="lookMine">${mine}${loose}</div>`
      : '<p class="look-note">还没有。在下面「自己调」里取色、拖滑块，会自动存到这里</p>'}`;
}

function paintMineBar() {
  const { s, cur } = mineState();
  const bar = q('#lookMineBar');
  if (naming) {
    bar.innerHTML = `<form class="look-name" data-look-name-form>
        <input id="lookMineName" maxlength="12" value="${esc(naming.value)}" aria-label="配色名字" placeholder="给这套配色起个名字" autocomplete="off">
        <button type="submit" class="btn btn-primary">${naming.kind === 'rename' ? '改名' : '保存'}</button>
        <button type="button" class="btn btn-ghost" data-look-name-cancel>取消</button>
      </form>`;
    return;
  }
  const full = savedLooks().length >= MINE_MAX;
  const del = Date.now() - confirmDel < 3000;
  if (cur) {
    bar.innerHTML = `<small class="look-note look-saved">已自动保存到「${esc(cur.name)}」，改动马上生效，刷新也还在</small>
      <button type="button" class="btn btn-ghost" data-look-mine-rename>重命名</button>
      <button type="button" class="btn btn-ghost" data-look-mine-copy ${full ? 'disabled' : ''}>另存一份</button>
      <button type="button" class="btn btn-ghost look-del" data-look-mine-del>${del ? '确认删除？' : '删除'}</button>`;
    if (full) bar.insertAdjacentHTML('beforeend', `<small class="look-note">我的配色最多存 ${MINE_MAX} 套，删掉一套才能再另存</small>`);
  } else if (s.family === 'custom') {
    bar.innerHTML = full
      ? `<small class="look-note">我的配色已经存满 ${MINE_MAX} 套，这套没能自动保存：删掉一套后点下面的按钮</small>
         <button type="button" class="btn btn-primary" data-look-mine-copy disabled>存为我的配色</button>`
      : '<button type="button" class="btn btn-primary" data-look-mine-copy>存为我的配色</button>';
  } else {
    bar.innerHTML = `<small class="look-note">在上面取色或拖滑块，会在当前配色的基础上自动存一套到「我的配色」${full ? `（已存满 ${MINE_MAX} 套，先删掉一套）` : ''}</small>`;
  }
}

/** 把面板上的每个控件对齐到当前设置。拖滑块、取色时跳过正在用的那个，不然会和手指打架 */
function paint() {
  if (!drawer) return;
  const s = engine().get();
  const dark = isDark();
  paintFamilies(s, dark);
  paintMineBar();
  // 滑块显示的是眼前这套配色的真实数值：选了「晨雾」，主色滑块就停在晨雾的蓝上
  const v = effective(s);
  const al = v.AL ?? engine().BASE.L;
  const out = {
    lookA: [v.A, `${Math.round(v.A)}°`], lookB: [v.B, `${Math.round(v.B)}°`],
    lookChroma: [v.C, `${Math.round(v.C / 0.25 * 100)}%`], lookTint: [v.tint, `${Math.round(v.tint * 100)}%`],
    lookAL: [clamp(al, AL_MIN, AL_MAX), `${Math.round(al * 100)}%`],
    lookRadius: [s.radius, s.radius < 0.85 ? '偏方' : s.radius > 1.15 ? '偏圆' : '标准'],
  };
  for (const [id, [value, text]] of Object.entries(out)) {
    const input = q(`#${id}`);
    if (document.activeElement !== input) input.value = value;
    q(`#${id}Out`).textContent = text;
  }
  // 取色器显示的是页面上真正用到的颜色（当前明暗下的底色 / 主色 / 点缀色）
  const fam = engine().FAMILIES.find(f => f.id === s.family);
  const [bg, acc, hot] = engine().swatch(s.family === 'custom' ? valsOf(s) : fam || null, dark);
  for (const [key, hex] of [['H', bg], ['A', acc], ['B', hot]]) {
    const input = q(`#lookPick${key}`);
    if (document.activeElement !== input) input.value = hex;
    q(`#lookPick${key}Hex`).textContent = hex.toUpperCase();
  }
  q('#lookA').style.setProperty('--look-track', hueTrack(dark));
  q('#lookB').style.setProperty('--look-track', hueTrack(dark));
  drawer.querySelectorAll('[data-look-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lookMode === currentTheme())));
  drawer.querySelectorAll('[data-look-density]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lookDensity === s.density)));
  drawer.querySelectorAll('[data-look-motion]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lookMotion === s.motion)));
  const sysReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  q('#lookMotionNote').textContent = s.motion === 'auto' && sysReduced
    ? '你的系统现在关着动画（Windows「显示动画」没开），所以页面动效是收起的。想看完整效果，选「完整」'
    : MOTION_NOTE[s.motion];
}

/** 取色、拖滑块时从当前配色「接手」成自定义：起点就是眼前这套颜色，不会一拖就跳。
 *  自动保存（09-26）：从预设 / 默认出发的第一下，自动在「我的配色」里建一套；之后每一下都写回这一套 */
function tune(patch) {
  const s = draft || engine().get();
  const base = effective(s);
  const next = { ...s, family: 'custom', ...base, ...patch };
  // 拖主色色相时，底色色相跟着转同样的角度（底色和主色的搭配关系不变）；直接取了底色的就按取的来
  if ('A' in patch && !('H' in patch)) next.H = ((base.H ?? base.A) + (patch.A - base.A) + 360) % 360;
  const list = savedLooks();
  const mode = isDark() ? 'dark' : 'light';
  let created = '';
  if (s.family === 'custom' && s.mine && list.some(m => m.id === s.mine)) {
    next.mine = s.mine;
    storeMine(list.map(m => m.id === s.mine ? { ...m, ...valsOf(next), mode } : m));
  } else if (s.family !== 'custom' && list.length < MINE_MAX) {
    const from = engine().FAMILIES.find(f => f.id === s.family && f.id !== 'default')?.name || '';
    const item = { id: newId(), name: autoName(from), ...valsOf(next), mode };
    if (storeMine([...list, item])) { next.mine = item.id; created = item.name; }
  } else next.mine = '';   // 存满了，或者正在用的那套刚被删：先改着，下面有「存为我的配色」
  draft = next;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const n = draft;
    draft = null;
    if (n) engine().set(n);
    paint();
  });
  if (created) toast('ok', `已自动存到「我的配色」：${created}`);
}

/** 取色器取到的颜色 → 配色参数。浅色下主色的深浅照取的来（限制在白字看得清的范围内） */
function fromPick(key, hex) {
  const [L, C, H] = engine().toLch(hex);
  const dark = isDark();
  const note = q('#lookPickNote');
  note.hidden = true;
  const hue = Math.round(H) % 360;
  if (key === 'A') {
    const patch = { C: clamp(dark ? C / 0.85 : C, 0, 0.25) };
    if (C >= 0.01) patch.A = hue;   // 取的是灰色就不改色相，只把鲜艳度降下来
    if (!dark) {
      patch.AL = clamp(L, AL_MIN, AL_MAX);
      if (L > AL_MAX) { note.hidden = false; note.textContent = '这个颜色太浅了：按钮上的白字会看不清，主色最浅只能到这里'; }
      if (L < AL_MIN) { note.hidden = false; note.textContent = '这个颜色太深了，和正文黑字分不开，主色最深只能到这里'; }
    }
    return patch;
  }
  // 点缀色：色相、深浅、鲜艳度都照取的来；深浅最低到「待我审核」色块上的深色字还看得清
  if (key === 'B') {
    if (L < 0.62) { note.hidden = false; note.textContent = '这个点缀色太深了，色块上的字会看不清，最深只能到这里'; }
    // 色块用的底色本身带 4° 左右的色相偏移（原来的珊瑚色 33°、点缀基准 20°），减掉它，取的颜色才正好落在色块上
    return { ...(C >= 0.01 ? { B: (hue - 4 + 360) % 360 } : {}), BL: clamp(L, 0.62, 0.92), BC: clamp(C, 0, 0.25) };
  }
  // 底色：取色相和染色浓淡；亮度跟着明暗走（浅色下底色不会变暗，文字对比度才有保证）
  const k = dark ? 0.035 * 0.9 : 0.035 * 0.725;
  return C >= 0.004 ? { H: hue, tint: clamp(Math.round(C / k * 20) / 20, 0, 1) } : { tint: 0 };
}

function startNaming(kind, value) {
  naming = { kind, value };
  paintMineBar();
  const input = q('#lookMineName');
  input.focus();
  input.select();
}

const focusMine = id => q(`[data-look-mine="${CSS.escape(id)}"]`)?.focus();

function submitName() {
  const name = q('#lookMineName').value.trim().slice(0, 12);
  if (!name) { q('#lookMineName').focus(); toast('info', '给这套配色起个名字'); return; }
  const list = savedLooks();
  const { s, cur } = mineState();
  if (naming.kind === 'rename' && cur) {
    if (!storeMine(list.map(m => m.id === cur.id ? { ...m, name } : m))) return;
    naming = null;
    paint();
    toast('ok', `已改名为「${name}」`);
    focusMine(cur.id);
    return;
  }
  if (list.length >= MINE_MAX) { toast('info', `我的配色最多存 ${MINE_MAX} 套，删掉一套再存`); return; }
  const item = { id: newId(), name, ...effective(s), mode: isDark() ? 'dark' : 'light' };
  if (!storeMine([...list, item])) return;
  engine().set({ family: 'custom', ...valsOf(item), mine: item.id });
  naming = null;
  paint();
  toast('ok', `已存为「${name}」，以后在「我的配色」里一点就切回来`);
  focusMine(item.id);
}

function onMineAction(e) {
  if (e.target.closest('[data-look-mine-copy]')) {
    const { cur } = mineState();
    startNaming('copy', autoName(cur ? cur.name.replace(/^我的/, '').replace(/ \d+$/, '') : ''));
    return true;
  }
  if (e.target.closest('[data-look-name-cancel]')) {
    naming = null;
    paintMineBar();
    q('[data-look-mine-copy], [data-look-mine-rename]')?.focus();
    return true;
  }
  const { cur } = mineState();
  if (!cur) return false;
  if (e.target.closest('[data-look-mine-rename]')) { startNaming('rename', cur.name); return true; }
  if (e.target.closest('[data-look-mine-del]')) {
    if (Date.now() - confirmDel >= 3000) {   // 第一次点：按钮变成「确认删除？」，3 秒内再点才删
      confirmDel = Date.now();
      paintMineBar();
      q('[data-look-mine-del]').focus();
      setTimeout(() => { if (drawer && !naming && Date.now() - confirmDel >= 3000) paintMineBar(); }, 3100);
      return true;
    }
    confirmDel = 0;
    if (storeMine(savedLooks().filter(m => m.id !== cur.id))) {
      engine().set({ mine: '' });   // 颜色先留着，想要可以再点「存为我的配色」
      paint();
      toast('ok', `已删除「${cur.name}」`);
      q('[data-look-mine-copy]')?.focus();
    }
    return true;
  }
  return false;
}

function build() {
  drawer = document.createElement('aside');
  drawer.className = 'drawer look-drawer';
  drawer.id = 'lookDrawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'false');
  drawer.setAttribute('aria-labelledby', 'lookTitle');
  drawer.innerHTML = markup();
  document.body.appendChild(drawer);

  drawer.addEventListener('click', e => {
    // 还有一帧没交给引擎的取色 / 拖动：先落地，再处理这次点击，免得这一帧晚到把刚选的色板盖掉
    if (draft) { cancelAnimationFrame(frame); engine().set(draft); draft = null; }
    if (e.target.closest('[data-look-close]')) return closeLook();
    if (e.target.closest('[data-look-reset]')) {
      naming = null;
      reveal(e, () => { engine().reset(); setTheme('auto'); paint(); });
      toast('ok', '外观已恢复默认（我的配色还在）');
      return;
    }
    if (onMineAction(e)) return;
    const mine = e.target.closest('[data-look-mine]');
    if (mine) { naming = null; reveal(e, () => { useSaved(mine.dataset.lookMine); paint(); }); return; }
    const fam = e.target.closest('[data-look-family]');
    if (fam) {
      // 选哪套，明暗就切到那套本来的一边（「跟随系统」回到跟随系统），和原型一样
      const f = engine().FAMILIES.find(x => x.id === fam.dataset.lookFamily);
      if (f) { naming = null; reveal(e, () => { engine().set({ family: f.id, mine: '' }); setTheme(f.mode || 'auto'); paint(); }); }
      return;
    }
    const mode = e.target.closest('[data-look-mode]');
    if (mode) {
      reveal(e, () => {
        setTheme(mode.dataset.lookMode);
        // 正在用「我的配色」：它记住的明暗跟着改，下次切回来还是这一边
        const { cur } = mineState();
        if (cur) storeMine(savedLooks().map(m => m.id === cur.id ? { ...m, mode: isDark() ? 'dark' : 'light' } : m));
        paint();
      });
      return;
    }
    const density = e.target.closest('[data-look-density]');
    if (density) { engine().set({ density: density.dataset.lookDensity }); paint(); return; }
    const motion = e.target.closest('[data-look-motion]');
    if (motion) { engine().set({ motion: motion.dataset.lookMotion }); paint(); }
  });
  drawer.addEventListener('submit', e => { e.preventDefault(); if (e.target.closest('[data-look-name-form]')) submitName(); });
  drawer.addEventListener('input', e => {
    const id = e.target.id;
    if (id === 'lookMineName') { naming.value = e.target.value; return; }
    if (e.target.dataset.lookPick) { tune(fromPick(e.target.dataset.lookPick, e.target.value)); return; }
    const v = Number(e.target.value);
    if (id === 'lookA') tune({ A: v });
    else if (id === 'lookB') tune({ B: v });
    else if (id === 'lookChroma') tune({ C: v });
    else if (id === 'lookTint') tune({ tint: v });
    else if (id === 'lookAL') tune({ AL: v });
    else if (id === 'lookRadius') { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { engine().set({ radius: v }); paint(); }); }
  });
  drawer.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (naming) { naming = null; paintMineBar(); q('[data-look-mine-copy], [data-look-mine-rename]')?.focus(); return; }
    closeLook();
  });
  // 系统明暗变了，色板预览跟着换
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
}

export function openLook() {
  if (!engine()) { toast('info', '外观设置暂时不可用，刷新页面再试'); return; }
  if (!drawer) build();
  returnFocus = document.activeElement;
  naming = null;
  paint();
  drawer.classList.add('on');
  requestAnimationFrame(() => drawer.querySelector('#lookFamilies [aria-pressed="true"]')?.focus({ preventScroll: true }));
}

export function closeLook() {
  if (!drawer?.classList.contains('on')) return;
  drawer.classList.remove('on');
  naming = null;
  returnFocus?.focus?.({ preventScroll: true });
}
