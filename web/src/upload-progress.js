/**
 * 附件上传进度条。
 *
 * 手机上传一张照片要好几秒，这期间界面一动不动，用户会以为是自己手机卡了 ——
 * 于是反复点提交，或者干脆关掉页面，附件就真的没传上去（2026-09-16 用户反馈）。
 * 这里把「传到第几个、传了百分之多少」画出来；进度到 100% 只表示字节发完了，
 * 后端还要写盘落库，所以那一刻文案换成「正在保存…」，而不是直接说完成。
 *
 * 用法：
 *   const p = uploadProgress($('#expUploadProgress'));
 *   p.start(files);
 *   await api.expenseUpload(id, f, r => p.tick(i, r));
 *   p.stop();                       // 放在 finally 里，失败也要收起来
 */
import { esc } from './util.js';

const pct = r => Math.max(0, Math.min(100, Math.round(r * 100)));

export function uploadProgress(box) {
  let files = [];
  const paint = (i, ratio) => {
    const done = ratio >= 1;
    const name = files[i]?.name || '';
    box.innerHTML = `<div class="up-bar"><i style="width:${done ? 100 : pct(ratio)}%"></i></div>
      <div class="up-text">${files.length > 1 ? `<span>第 ${i + 1}/${files.length} 个</span>` : ''}
        <em>${esc(name)}</em><b>${done ? '已传完，正在保存…' : `${pct(ratio)}%`}</b></div>
      <div class="up-note">正在上传，别关页面，也不用重复点提交。</div>`;
  };
  return {
    /** 开始传这一批文件；空数组不画 */
    start(list) {
      files = [...list];
      if (!files.length) return;
      box.hidden = false;
      paint(0, 0);
      // 弹窗内容是滚动的，进度条可能正好在视野外 —— 那就等于没有进度条
      box.scrollIntoView({ block: 'nearest' });
    },
    /** 第 i 个文件传了 ratio（0~1） */
    tick(i, ratio) {
      if (files.length) paint(i, ratio);
    },
    stop() {
      box.hidden = true;
      box.innerHTML = '';
      files = [];
    },
  };
}
