/**
 * 外观：跟随系统 / 浅色 / 深色（2026-09-24）。
 *
 * 选择记在这台设备的 localStorage（ideahub.theme），不同设备可以不一样。
 * index.html / login.html 的 <head> 里有一小段内联脚本，在样式生效前就把 data-theme 设好，
 * 打开页面时不会先闪一下浅色；这里只管头像菜单里的三个按钮。
 * 颜色本身全在样式表里：每个颜色都写成 light-dark(浅色值, 深色值)，
 * styles.css 按 data-theme 切换 color-scheme，浏览器自己选用哪一个。
 */
import { $ } from './util.js';

const KEY = 'ideahub.theme';
const THEMES = ['auto', 'light', 'dark'];

export const current = () => {
  const t = document.documentElement.dataset.theme;
  return THEMES.includes(t) ? t : 'auto';
};

function paint() {
  for (const b of document.querySelectorAll('[data-theme-set]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === current()));
  }
}

export function setTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'auto';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* 隐私模式下只是记不住，这一次仍然生效 */ }
  paint();
  window.dispatchEvent(new Event('ideahub:prefs'));   // 界面偏好跟着账号走（prefs-sync.js）
}

export function bindThemeMenu() {
  $('#themeSeg')?.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-set]');
    if (b) setTheme(b.dataset.themeSet);
  });
  paint();
}
