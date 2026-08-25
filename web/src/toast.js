import { esc } from './util.js';
import { ICON } from './icons.js';

export function toast(kind, msg) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<span class="ic">${kind === 'ok' ? ICON.check : 'i'}</span>${esc(msg)}`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 3400);
}
