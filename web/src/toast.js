import { esc } from './util.js';
import { ICON } from './icons.js';

export function toast(kind, msg) {
  const el = document.createElement('div');
  el.className = 'toast t-toast ' + kind;
  el.innerHTML = `<span class="ic">${kind === 'ok' ? ICON.check : 'i'}</span>${esc(msg)}`;
  document.getElementById('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-open'));
  setTimeout(() => {
    el.classList.remove('is-open');
    setTimeout(() => el.remove(), 250);
  }, 3400);
}
