/**
 * 「配色与外观」面板（2026-09-24）。
 *
 * 真正换颜色的引擎在 index.html <head> 里（window.IdeaHubLook）：它必须在首次绘制前跑，
 * 所以不能放进模块。这里只负责面板：选配色家族、自己调色相、圆角、密度、动效。
 * 设置记在这台设备的 localStorage（ideahub.look），和「跟随系统 / 浅色 / 深色」一样按设备走。
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
const q = sel => drawer.querySelector(sel);

const isDark = () => {
  const t = currentTheme();
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
};

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

function markup() {
  const s = engine().get();
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
        <div class="look-families" id="lookFamilies"></div>
      </section>
      <section class="look-sec" aria-labelledby="lookTuneH">
        <h3 id="lookTuneH">自己调</h3>
        ${range('lookA', '主色', 0, 359, 1, s.A)}
        ${range('lookB', '点缀色', 0, 359, 1, s.B)}
        ${range('lookChroma', '鲜艳度', 0.1, 3, 0.05, s.chroma)}
        ${range('lookTint', '底色染色', 0, 3, 0.05, s.tint, '越往右，页面底色和边框越带主色的色调')}
      </section>
      <section class="look-sec" aria-labelledby="lookShapeH">
        <h3 id="lookShapeH">形状与密度</h3>
        ${range('lookRadius', '圆角', 0.5, 1.6, 0.05, s.radius)}
        ${seg('density', [['compact', '紧凑'], ['cozy', '标准'], ['roomy', '宽松']], s.density, '密度')}
      </section>
      <section class="look-sec" aria-labelledby="lookMotionH">
        <h3 id="lookMotionH">动效</h3>
        ${seg('motion', [['full', '完整'], ['lite', '简洁'], ['off', '关闭']], s.motion, '动效')}
        <small class="look-note" id="lookMotionNote"></small>
      </section>
    </div>
    <div class="dfoot look-foot">
      <button type="button" class="btn btn-ghost" data-look-reset>恢复默认</button>
      <button type="button" class="btn btn-primary" data-look-close>完成</button>
    </div>`;
}

const MOTION_NOTE = {
  full: '切换、数字滚动、庆祝动画都开着',
  lite: '保留必要的过渡，去掉数字滚动和庆祝动画',
  off: '所有动画都关掉，适合容易晕动的人',
};

/** 把面板上的每个控件对齐到当前设置。拖滑块时跳过正在拖的那个，不然会和手指打架 */
function paint() {
  if (!drawer) return;
  const s = engine().get();
  const dark = isDark();
  const fams = engine().FAMILIES;
  const active = s.family;
  q('#lookFamilies').innerHTML = [...fams, { id: 'custom', name: '自定义' }].map(f => {
    const [bg, a, b] = f.id === 'custom'
      ? engine().swatch({ A: s.A, B: s.B, H: s.H, chroma: s.chroma, tint: s.tint }, dark)
      : engine().swatch(f, dark);
    return `<button type="button" class="look-fam" data-look-family="${f.id}" aria-pressed="${active === f.id}"
        ${f.id === 'custom' && active !== 'custom' ? 'hidden' : ''}>
      <span class="look-dot" style="background:${bg}"><i style="background:${a}"></i><i style="background:${b}"></i></span>
      <span>${esc(f.name)}</span></button>`;
  }).join('');
  // 滑块显示的是眼前这套配色的真实数值：选了「晨雾」，主色滑块就停在晨雾的蓝上
  const fam = fams.find(f => f.id === active);
  const v = active === 'custom' ? s : fam?.A != null ? fam : { A: 332, B: 20, chroma: 1, tint: 1 };
  const out = {
    lookA: [v.A, `${Math.round(v.A)}°`], lookB: [v.B, `${Math.round(v.B)}°`],
    lookChroma: [v.chroma, `${Math.round(v.chroma * 100)}%`], lookTint: [v.tint, `${Math.round(v.tint * 100)}%`],
    lookRadius: [s.radius, s.radius < 0.85 ? '偏方' : s.radius > 1.15 ? '偏圆' : '标准'],
  };
  for (const [id, [value, text]] of Object.entries(out)) {
    const input = q(`#${id}`);
    if (document.activeElement !== input) input.value = value;
    q(`#${id}Out`).textContent = text;
  }
  q('#lookA').style.setProperty('--look-track', hueTrack(dark));
  q('#lookB').style.setProperty('--look-track', hueTrack(dark));
  drawer.querySelectorAll('[data-look-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lookMode === currentTheme())));
  drawer.querySelectorAll('[data-look-density]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lookDensity === s.density)));
  drawer.querySelectorAll('[data-look-motion]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lookMotion === s.motion)));
  q('#lookMotionNote').textContent = MOTION_NOTE[s.motion];
}

/** 拖色相时从当前家族「接手」成自定义：起点就是眼前这套颜色，不会一拖就跳 */
function tune(patch) {
  const s = engine().get();
  const fam = engine().FAMILIES.find(f => f.id === s.family);
  const base = s.family === 'custom' ? s : fam?.A != null ? fam : { A: 332, B: 20, H: 332, chroma: 1, tint: 1 };
  const next = { family: 'custom', A: base.A, B: base.B, H: base.H, chroma: base.chroma, tint: base.tint, ...patch };
  if ('A' in patch) next.H = patch.A;   // 底色跟着主色走，拖一个滑块整页一起变
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => { engine().set(next); paint(); });
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
    if (e.target.closest('[data-look-close]')) return closeLook();
    if (e.target.closest('[data-look-reset]')) {
      reveal(e, () => { engine().reset(); setTheme('auto'); paint(); });
      toast('ok', '外观已恢复默认');
      return;
    }
    const fam = e.target.closest('[data-look-family]');
    if (fam) {
      const id = fam.dataset.lookFamily;
      if (id !== 'custom') reveal(e, () => { engine().set({ family: id }); paint(); });
      return;
    }
    const mode = e.target.closest('[data-look-mode]');
    if (mode) { reveal(e, () => { setTheme(mode.dataset.lookMode); paint(); }); return; }
    const density = e.target.closest('[data-look-density]');
    if (density) { engine().set({ density: density.dataset.lookDensity }); paint(); return; }
    const motion = e.target.closest('[data-look-motion]');
    if (motion) { engine().set({ motion: motion.dataset.lookMotion }); paint(); }
  });
  drawer.addEventListener('input', e => {
    const v = Number(e.target.value);
    if (e.target.id === 'lookA') tune({ A: v });
    else if (e.target.id === 'lookB') tune({ B: v });
    else if (e.target.id === 'lookChroma') tune({ chroma: v });
    else if (e.target.id === 'lookTint') tune({ tint: v });
    else if (e.target.id === 'lookRadius') { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { engine().set({ radius: v }); paint(); }); }
  });
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeLook(); } });
  // 系统明暗变了，色板预览跟着换
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
}

export function openLook() {
  if (!engine()) { toast('info', '外观设置暂时不可用，刷新页面再试'); return; }
  if (!drawer) build();
  returnFocus = document.activeElement;
  paint();
  drawer.classList.add('on');
  requestAnimationFrame(() => drawer.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }));
}

export function closeLook() {
  if (!drawer?.classList.contains('on')) return;
  drawer.classList.remove('on');
  returnFocus?.focus?.({ preventScroll: true });
}
