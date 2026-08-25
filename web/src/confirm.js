/**
 * 项目级确认弹窗。
 *
 * 原生 confirm() 的位置和样式由浏览器决定，在大屏上常贴着顶部，
 * 也没法把“可恢复 / 不可恢复”这类后果分出层级。这个组件只负责确认，
 * 具体删除动作仍留在各业务模块里。
 */
import { ICON } from './icons.js';

let layer = null;
let pending = null;
let previousFocus = null;

function build() {
  if (layer) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="confirm-layer" id="confirmLayer" aria-hidden="true">
      <div class="confirm-backdrop" data-confirm-cancel></div>
      <section class="confirm-dialog" role="alertdialog" aria-modal="true"
               aria-labelledby="confirmTitle" aria-describedby="confirmMessage confirmNote">
        <div class="confirm-head">
          <span class="confirm-mark" aria-hidden="true">${ICON.trash}</span>
          <div class="confirm-copy">
            <span class="confirm-eyebrow" id="confirmEyebrow"></span>
            <h2 id="confirmTitle"></h2>
          </div>
        </div>
        <p class="confirm-message" id="confirmMessage"></p>
        <p class="confirm-note" id="confirmNote"></p>
        <footer class="confirm-actions">
          <button class="btn btn-ghost" type="button" data-confirm-cancel>取消</button>
          <button class="btn confirm-submit" type="button" id="confirmSubmit">确认</button>
        </footer>
      </section>
    </div>`);
  layer = document.getElementById('confirmLayer');

  layer.addEventListener('click', e => {
    if (e.target.closest('[data-confirm-cancel]')) settle(false);
    if (e.target.closest('#confirmSubmit')) settle(true);
  });
  layer.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      settle(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const buttons = [...layer.querySelectorAll('button')];
    const at = buttons.indexOf(document.activeElement);
    const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1)
                            : (at >= buttons.length - 1 ? 0 : at + 1);
    e.preventDefault();
    buttons[next].focus();
  });
}

function settle(value) {
  if (!pending) return;
  const done = pending;
  pending = null;
  layer.classList.remove('on');
  layer.setAttribute('aria-hidden', 'true');
  previousFocus?.focus?.();
  done(value);
}

/**
 * @returns {Promise<boolean>} true = 用户确认，false = 取消
 */
export function confirmAction({
  eyebrow = '请确认操作', title = '确定继续？', message = '', note = '',
  confirmLabel = '确认',
} = {}) {
  build();
  // 理论上不会并发打开；真发生时先取消上一项，不能让旧 Promise 永远悬着。
  if (pending) settle(false);
  previousFocus = document.activeElement;
  layer.querySelector('#confirmEyebrow').textContent = eyebrow;
  layer.querySelector('#confirmTitle').textContent = title;
  layer.querySelector('#confirmMessage').textContent = message;
  layer.querySelector('#confirmNote').textContent = note;
  layer.querySelector('#confirmSubmit').textContent = confirmLabel;
  layer.setAttribute('aria-hidden', 'false');
  layer.classList.add('on');
  requestAnimationFrame(() => layer.querySelector('#confirmSubmit').focus());
  return new Promise(resolve => { pending = resolve; });
}
