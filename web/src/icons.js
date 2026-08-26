/**
 * 线性图标。
 *
 * 原来用的是 emoji（💬 📎 👥 🗑 🔔），问题有三个：
 *  - 每个系统一套画风，Windows / mac / 安卓渲染出来完全不是一个东西；
 *  - 彩色实心，跟这套界面的细线条格格不入，显得很生硬；
 *  - 大小和基线各家不同，垂直居中永远差一点。
 * 换成同一套 stroke 图标，跟界面里已有的空态插画是同一个语言。
 *
 * 都是 20×20、`currentColor` 描边，所以颜色跟着上下文走，不用为每个位置改一遍。
 */
const svg = (d, extra = '') => `<svg class="ic" viewBox="0 0 20 20" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">${d}${extra}</svg>`;

export const ICON = {
  chat:    svg('<path d="M3.2 15.2V5.6a2 2 0 0 1 2-2h9.6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6.6z"/>'),
  bell:    svg('<path d="M10 3a4.2 4.2 0 0 0-4.2 4.2c0 3.6-1.3 4.7-1.3 4.7h11c0 0-1.3-1.1-1.3-4.7A4.2 4.2 0 0 0 10 3Z"/><path d="M8.6 15a1.6 1.6 0 0 0 2.8 0"/>'),
  clip:    svg('<path d="M14.7 9.1 9.9 14a2.8 2.8 0 0 1-4-4l5.4-5.4a1.9 1.9 0 0 1 2.7 2.7l-5.4 5.4a.9.9 0 0 1-1.3-1.3l4.8-4.8"/>'),
  users:   svg('<circle cx="7.6" cy="7.4" r="2.4"/><path d="M3.2 15.4a4.4 4.4 0 0 1 8.8 0"/><path d="M13.4 5.4a2.4 2.4 0 0 1 0 4.5"/><path d="M14.4 11.6a4 4 0 0 1 2.5 3.8"/>'),
  trash:   svg('<path d="M4.6 5.8h10.8"/><path d="M8.2 5.8V4.4h3.6v1.4"/><path d="M6 5.8l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-9"/>'),
  close:   svg('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>'),
  back:    svg('<path d="M12 4.5 6.5 10l5.5 5.5"/>'),
  more:    svg('<circle cx="4.6" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="10" r="1.1" fill="currentColor" stroke="none"/>'),
  plus:    svg('<path d="M10 4.6v10.8M4.6 10h10.8"/>'),
  send:    svg('<path d="M16.5 3.5 8.8 11.2"/><path d="M16.5 3.5 11.7 16.5l-2.9-5.3-5.3-2.9z"/>'),
  file:    svg('<path d="M11.4 3.4H6.4a1.4 1.4 0 0 0-1.4 1.4v10.4a1.4 1.4 0 0 0 1.4 1.4h7.2a1.4 1.4 0 0 0 1.4-1.4V6.9z"/><path d="M11.4 3.4v3.5h3.6"/>'),
  book:    svg('<path d="M3.6 4.3h4.8A1.6 1.6 0 0 1 10 5.9v10.2a2.2 2.2 0 0 0-2-1.2H3.6z"/><path d="M16.4 4.3h-4.8A1.6 1.6 0 0 0 10 5.9v10.2a2.2 2.2 0 0 1 2-1.2h4.4z"/>'),
  layers:  svg('<path d="m10 3.2 7 3.7-7 3.7-7-3.7z"/><path d="m4.2 10 5.8 3.1 5.8-3.1"/><path d="m4.2 13.3 5.8 3.1 5.8-3.1"/>'),
  download: svg('<path d="M10 3.6v8.2"/><path d="M6.8 8.9 10 12.1l3.2-3.2"/><path d="M4.4 15.2h11.2"/>'),

  /* ---- 状态徽章。原来用的是 ⏳👀✓✕📦✎ 这几个 emoji，
         它们出现在每一张卡片上，是全站最显眼的地方，
         而 emoji 恰恰是各系统画风差异最大的东西。 ---- */
  clock:   svg('<circle cx="10" cy="10" r="6.6"/><path d="M10 6.4V10l2.4 1.6"/>'),
  eye:     svg('<path d="M2.6 10S5.4 5.4 10 5.4 17.4 10 17.4 10 14.6 14.6 10 14.6 2.6 10 2.6 10Z"/><circle cx="10" cy="10" r="2.1"/>'),
  check:   svg('<path d="M4.8 10.4 8.2 13.8l7-7.6"/>'),
  x:       svg('<path d="M6 6l8 8M14 6l-8 8"/>'),
  archive: svg('<path d="M3.4 6.2h13.2v9.2a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1z"/><path d="M2.8 3.6h14.4v2.6H2.8z"/><path d="M8.2 9.6h3.6"/>'),
  pencil:  svg('<path d="M13.2 3.9 16.1 6.8 7 15.9l-3.6.7.7-3.6z"/>'),

  /* ---- 卡片上的三个小图标 ---- */
  /* 火焰用实心。描边版在 13px 那个尺寸下只剩几根细线，看着像个卷曲的符号，
     根本认不出是火 —— 小尺寸图标该用实心，细节靠轮廓而不是线条。 */
  flame:   `<svg class="ic" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M11.3 2.2c.4 2-.3 3.4-1.4 4.6-1.2 1.3-2.7 2.4-2.7 4.4a2.9 2.9 0 0 0 1.5 2.6c-.3-.9-.2-1.9.5-2.7.5-.6 1.2-1 1.5-1.8.5 1 1.1 1.5 1.6 2.2.6.8.8 1.7.5 2.7a3.5 3.5 0 0 0 1.8-3.1c0-3-2-4.8-3.3-8.9Z"/>
    <path d="M8.6 17.3a4.9 4.9 0 0 1-3.4-4.7c0-1.6.6-2.8 1.4-3.8-.1.5-.2 1-.2 1.5 0 2.2 1 3.8 2.2 7Z" opacity=".55"/>
  </svg>`,
  comment: svg('<path d="M3.6 4.6h12.8v8.2H8.4L4.9 15.7v-2.9H3.6z"/>'),
  up:      svg('<path d="M10 4.6 4.9 11h10.2z" fill="currentColor" stroke="none"/>'),
  search:  svg('<circle cx="9" cy="9" r="5.1"/><path d="M12.8 12.8 16.4 16.4"/>'),
  warn:    svg('<path d="M10 3.6 17.4 16.4H2.6z"/><path d="M10 8.4v3.2"/><circle cx="10" cy="13.8" r=".85" fill="currentColor" stroke="none"/>'),
  bulb:    svg('<path d="M10 3.2a4.7 4.7 0 0 0-2.9 8.4c.5.4.8 1 .8 1.6h4.2c0-.6.3-1.2.8-1.6A4.7 4.7 0 0 0 10 3.2Z"/><path d="M8.4 15.4h3.2M8.9 17.2h2.2"/>'),
  sparkle: svg('<path d="M10 2.8c.5 3.2 2.1 4.8 5.3 5.3-3.2.5-4.8 2.1-5.3 5.3-.5-3.2-2.1-4.8-5.3-5.3C7.9 7.6 9.5 6 10 2.8Z"/><path d="M15.4 12.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3Z"/>'),
};

/** 状态 → 图标。util.js 的 PILL 用它，卡片和抽屉共用一套 */
export const STATUS_ICON = {
  pending: ICON.clock, reviewing: ICON.eye, adopted: ICON.check,
  rejected: ICON.x, archived: ICON.archive, draft: ICON.pencil,
};
