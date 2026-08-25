/**
 * 对标作品的完整拆解（抽屉）。
 *
 * 技术1 把一份采集分析原样推进来（POST /api/ingest/analysis），
 * 这里负责把它摊开给人看：对标账号、公开互动数、AI 的视频七问和评论五问、
 * 高赞评论原文、带时间码的逐字稿。
 *
 * 为什么另开一个抽屉、不复用编辑弹窗：那份数据有九个区、逐字稿本身三千多字，
 * 塞进一个 560px 的表单弹窗谁也看不清。而且它是**只读**的 ——
 * 技术1 推过来的原文不该在界面上被改，改了就和技术1 那边对不上了。
 *
 * DOM 是第一次打开时才建的：绝大多数人一天都不会点开一条对标，
 * 没有理由让每次刷新首页都为它多解析一段 HTML。
 */
import { api } from '../api.js';
import { esc, fromNow } from '../util.js';
import { openLightbox } from '../lightbox.js';

let box = null, mask = null;
let curId = null;
/** 已经拉过的分析，按 work id 缓存。同一条来回点开不用重复拉 30KB */
const cache = new Map();

const n = v => (v == null || v === '' ? null : v);
const num = v => (Number.isFinite(Number(v)) ? new Intl.NumberFormat('zh-CN').format(Number(v)) : null);
/** 粉丝、赞藏这种六七位数写成「12.3万」—— 122814 这串数字要数一遍才知道量级 */
const compact = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 1 : 2).replace(/\.?0+$/, '')}万`;
  return num(n);
};

function build() {
  if (box) return;
  mask = document.createElement('div');
  mask.className = 'mask bench-mask';
  mask.addEventListener('click', close);

  box = document.createElement('aside');
  box.className = 'drawer bench-drawer';
  box.setAttribute('aria-label', '对标作品拆解');
  box.innerHTML = `
    <div class="dhead bench-head">
      <div class="bench-head-top">
        <span class="bench-pill"></span>
        <div class="spacer"></div>
        <button class="btn btn-ghost bench-close" type="button">收起</button>
      </div>
      <h2></h2>
      <div class="dmeta bench-sub"></div>
    </div>
    <div class="dbody bench-body"></div>`;
  box.querySelector('.bench-close').addEventListener('click', close);

  document.body.append(mask, box);
}

export const isOpen = () => !!box && box.classList.contains('on');

export function close() {
  if (!box) return;
  box.classList.remove('on');
  mask.classList.remove('on');
  curId = null;
}

/**
 * 打开一条对标作品的拆解。
 *
 * seed 是列表卡片上已经有的那份摘要（digest）。有它就先把抽屉开出来、
 * 标题和账号先填上，再去拉完整分析 —— 点完等一个来回才有反应的话，
 * 网络慢一点就会被当成没点上。
 */
export async function open(workId, seed) {
  build();
  curId = workId;
  const d = seed?.analysis || {};

  box.querySelector('.bench-pill').textContent =
    `${d.platformLabel || '对标作品'} · 采集分析`;
  box.querySelector('h2').textContent = seed?.title || '正在打开…';
  box.querySelector('.bench-sub').innerHTML = d.account?.name
    ? `<span>${esc(d.account.name)}</span>${d.duration ? `<span>${esc(d.duration)}</span>` : ''}`
    : '';
  box.querySelector('.bench-body').innerHTML = '<div class="bench-loading">正在取完整拆解…</div>';
  mask.classList.add('on');
  box.classList.add('on');

  let a = cache.get(workId);
  if (!a) {
    try {
      a = await api.workAnalysis(workId);
      cache.set(workId, a);
    } catch (e) {
      if (e.message === '请先登录') return;
      box.querySelector('.bench-body').innerHTML =
        `<div class="bench-loading">${esc(e.message || '取不到这条的分析结果')}</div>`;
      return;
    }
  }
  // 拉的过程中人已经点开了另一条 / 把抽屉关了 —— 别把旧内容画上去
  if (curId !== workId) return;
  paint(a);
}

/** 打开时顺手把缓存清掉。技术1 重推过同一条之后，第二次点开该看到新的 */
export const forget = (workId) => cache.delete(workId);

function paint(a) {
  box.querySelector('.bench-pill').textContent =
    `${a.platformLabel || '对标作品'} · ${a.collectionMode || '采集分析'}`;
  box.querySelector('h2').textContent = a.title || a.workTitle || '（无标题）';

  const sub = [];
  if (a.account?.name) sub.push(esc(a.account.name));
  if (a.media?.duration) sub.push(esc(a.media.duration));
  // 「技术1 1 分钟前推送」读起来别扭，拆成两段，中间的 · 由 CSS 加
  if (a.receivedAt) sub.push('技术1 推送', esc(fromNow(a.receivedAt)));
  box.querySelector('.bench-sub').innerHTML = sub.map(s => `<span>${s}</span>`).join('');

  box.querySelector('.bench-body').innerHTML = [
    coverBlock(a),
    accountBlock(a),
    engagementBlock(a),
    topicsBlock(a),
    imagesBlock(a),
    // 图文笔记没有视频，标题跟着改 —— 技术1 那边字段名叫 video 是历史原因，
    // 界面上照抄会变成「AI 视频拆解」配一叠图片，看的人会以为数据串了
    aiBlock(a.mediaType === 'image_post' ? 'AI 图文拆解' : 'AI 视频拆解', a.ai?.video, a.ai),
    aiBlock('AI 评论洞察', a.ai?.comments, a.ai, a.commentStats),
    commentsBlock(a),
    transcriptBlock(a),
    footBlock(a),
  ].filter(Boolean).join('');

  // 图文笔记那叠图，点开看大的 —— 缩略图上印的字太小，读不出来等于没显示。
  // 整组一起交给灯箱，在里面左右翻：一条笔记九张、一页一个论点，
  // 每看一张都要退出去再点下一张的话，那条笔记根本读不下来。
  // 过期没存下来的那些不在这一组里（它们本来就没有图可看），
  // 翻页时会被跳过，而不是翻到一个空框。
  const shots = [...box.querySelectorAll('.bench-img img')];
  shots.forEach((im, i) => {
    im.addEventListener('click', () =>
      openLightbox(shots.map(x => ({ url: x.dataset.full, name: x.alt })), i));
  });
}

/* ---------------- 各区 ---------------- */

function coverBlock(a) {
  const c = a.cover || {}, m = a.media || {};
  // 封面优先走本地那张：平台地址带时间签名（路径里就是个日期），几天后 404，
  // 而且它是 http:// 的，HTTPS 页面上会被当混合内容拦掉。
  // 本地没有才退回原地址，再挂就把整块图收起来，而不是在抽屉正中间留一个碎图标。
  const src = a.coverLocal ? `/api/works/${a.workId}/cover` : c.url;
  const img = src ? `<img src="${esc(src)}" alt="封面" loading="lazy"
      referrerpolicy="no-referrer"
      onerror="this.closest('.bench-cover').classList.add('no-img')">` : '';
  const facts = [
    m.duration && ['时长', m.duration],
    m.size && ['尺寸', m.size],
    m.format && ['清晰度', m.format],
    a.mediaType && ['类型', a.mediaType === 'video' ? '视频' : a.mediaType],
  ].filter(Boolean);
  if (!img && !facts.length && !c.title) return '';

  // 封面标题是 OCR 认出来的，会有误差（样本里「无聊」被认成了「无趣」）。
  // 置信度必须摆在旁边，不然它看上去和帖子原标题一样权威。
  const ocr = c.title ? `<div class="bench-ocr">
      <span>封面标题（图像识别）</span>
      <b>${esc(c.title)}</b>
      ${c.confidence ? `<i>置信度 ${Math.round(c.confidence * 100)}%，可能与原文有出入</i>` : ''}
    </div>` : '';

  return `<section class="bench-cover ${img ? '' : 'no-img'}">
    <div class="bench-cover-img">${img}</div>
    <div class="bench-cover-side">
      ${ocr}
      ${facts.length ? `<div class="bench-facts">${facts.map(([k, v]) =>
        `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
      ${a.sourceUrl ? `<a class="link" href="${esc(a.sourceUrl)}" target="_blank" rel="noopener">打开原作品 ↗</a>` : ''}
    </div>
  </section>`;
}

function accountBlock(a) {
  const ac = a.account || {};
  if (!ac.name) return '';
  const stats = [
    ac.followers && ['粉丝', compact(ac.followers) || ac.followers],
    ac.following && ['关注', compact(ac.following) || ac.following],
    ac.likesCollections && ['赞与收藏', compact(ac.likesCollections) || ac.likesCollections],
  ].filter(Boolean);
  return `<div class="sec-title">对标账号</div>
    <section class="bench-acct">
      <div class="bench-acct-top">
        <b>${esc(ac.name)}</b>
        ${ac.url ? `<a class="link" href="${esc(ac.url)}" target="_blank" rel="noopener">主页 ↗</a>` : ''}
      </div>
      ${stats.length ? `<div class="bench-facts">${stats.map(([k, v]) =>
        `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
      ${ac.bio ? `<p class="bench-bio">${esc(ac.bio)}</p>` : ''}
    </section>`;
}

function engagementBlock(a) {
  const e = a.engagement || {};
  const cells = [['点赞', e.likes], ['收藏', e.collects], ['评论', e.comments]]
    .filter(([, v]) => n(v));
  if (!cells.length) return '';
  return `<div class="sec-title">公开互动数据</div>
    <div class="metric-grid bench-eng">${cells.map(([k, v]) =>
      `<div class="metric-cell"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
}

function topicsBlock(a) {
  const t = a.topics || [];
  if (!t.length) return '';
  return `<div class="sec-title">话题 / 标签（${t.length}）</div>
    <div class="bench-topics">${t.map(x => `<span class="chip">#${esc(x)}</span>`).join('')}</div>`;
}

/**
 * AI 结论的一组条目。
 *
 * 每条都可能带「证据评论」—— 原话必须跟结论摆在一起。
 * 只给结论不给原话的话，业务人员没法判断这句总结是不是 AI 编的，
 * 而这份数据是要拿来定选题的。
 */
function aiBlock(title, items, ai, stats) {
  if (!items || !items.length) return '';
  const body = items.map(it => {
    // key_comments 那一条是「哪些评论值得重点看」，结构是评论 + 推荐理由
    if (it.entries?.length) {
      return `<div class="bench-ai-item">
        <div class="bench-ai-label">${esc(it.label)}</div>
        ${it.entries.map(e => `<div class="bench-quote">
          ${cmtLine(e.comment)}
          ${e.reason ? `<div class="bench-why">值得看：${esc(e.reason)}</div>` : ''}
        </div>`).join('')}
      </div>`;
    }
    return `<div class="bench-ai-item">
      <div class="bench-ai-label">${esc(it.label)}</div>
      <p>${esc(it.summary || '—')}</p>
      ${it.evidence?.length ? `<div class="bench-evi">
        <span>依据的原话</span>
        ${it.evidence.map(c => `<div class="bench-quote">${cmtLine(c)}</div>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');

  const foot = [];
  if (ai?.model) foot.push(`模型 ${ai.model}`);
  if (stats?.scanned) foot.push(`扫了 ${stats.scanned} 条评论${stats.repliesScanned ? ` + ${stats.repliesScanned} 条回复` : ''}`);
  if (ai?.videoLabels?.length && title.includes('视频')) foot.push('依据：' + ai.videoLabels.join(' / '));

  return `<div class="sec-title">${esc(title)}</div>
    <section class="bench-ai">${body}
      ${foot.length ? `<div class="bench-ai-foot">${esc(foot.join(' · '))}</div>` : ''}
    </section>`;
}

const cmtLine = (c) => `
  <div class="bench-cmt">
    <div class="bench-cmt-top"><b>${esc(c.author || '匿名')}</b>
      ${c.likes ? `<span>${num(c.likes)} 赞</span>` : ''}
      ${c.replies ? `<span>${num(c.replies)} 回复</span>` : ''}
    </div>
    <p>${esc(c.text || '')}</p>
  </div>`;

function commentsBlock(a) {
  const list = a.comments || [];
  if (!list.length) return '';
  const s = a.commentStats || {};
  const note = [
    s.scanned ? `从 ${num(s.scanned)} 条评论里取的高赞前 ${list.length} 条` : `${list.length} 条`,
    s.truncated ? '评论区没翻到底' : null,
    // 平台把赞数糊掉的时候，「高赞」这个排序本身就不可信，必须说出来
    s.likesObscured ? '平台隐去了部分赞数，排序仅供参考' : null,
  ].filter(Boolean).join(' · ');
  return `<div class="sec-title">高赞评论</div>
    <section class="bench-cmts">
      <div class="bench-note">${esc(note)}</div>
      ${list.map(c => `<div class="bench-quote">${cmtLine(c)}</div>`).join('')}
    </section>`;
}

function transcriptBlock(a) {
  const t = a.transcript || {};
  if (!t.text) return '';
  const meta = [
    t.chars ? `${num(t.chars)} 字` : null,
    t.model ? `${t.model} 识别` : null,
    t.chunks ? `分 ${t.chunks} 段` : null,
    // 有段没识别成功就必须说 —— 让人拿一份缺了一段的原文下判断，比不给更糟
    t.partial ? `⚠ 有 ${t.chunks - t.chunksOk} 段没识别出来，内容不完整` : null,
  ].filter(Boolean).join(' · ');
  return `<div class="sec-title">逐字稿</div>
    <details class="bench-trans">
      <summary>展开完整逐字稿<i>${esc(meta)}</i></summary>
      <pre>${esc(t.text)}</pre>
    </details>`;
}

/**
 * 图文笔记的整叠图。
 *
 * 对图文笔记来说这一区就是正文 —— 等价于视频那边的逐字稿。
 * 每张图上印着一段话（技术1 OCR 出来放在 text 里），顺序即论述顺序，
 * 所以按序号排、把文字贴在图下面，而不是做成一个只能左右翻的轮播。
 *
 * local=false 的那些是本地镜像没下下来（多半是推送时平台签名已过期）。
 * 不硬塞平台原地址去试：那是 http:// 的，HTTPS 页面上会被当混合内容拦掉，
 * 结果是一排碎图标 + 一堆控制台报错，看的人只会以为系统坏了。
 * 直接说清楚「这张图没存下来」，并留一个去原作品看的入口。
 */
function imagesBlock(a) {
  const imgs = Array.isArray(a.images) ? a.images : [];
  if (!imgs.length) return '';
  const missing = imgs.filter(im => !im.local).length;

  return `<div class="sec-title">图文内容（${imgs.length} 张）</div>
    ${missing ? `<div class="bench-notice">有 ${missing} 张没能存下来 ——
      平台图片地址是有时效的（路径里那串数字就是失效时间），
      采集完隔太久才推送就会过期。让技术1 重推一次，或者
      ${a.sourceUrl ? `<a class="link" href="${esc(a.sourceUrl)}" target="_blank" rel="noopener">打开原作品 ↗</a>` : '去原作品'}看。</div>` : ''}
    <div class="bench-imgs">
      ${imgs.map(im => `
        <figure class="bench-img${im.local ? '' : ' gone'}">
          ${im.local
            ? `<img src="/api/works/${a.workId}/image/${im.i}" alt="第 ${im.index} 张"
                 loading="lazy" data-full="/api/works/${a.workId}/image/${im.i}">`
            : `<div class="bench-img-gone">第 ${im.index} 张<span>图片已过期</span></div>`}
          <figcaption>
            <b>${im.index}</b>
            ${im.text ? `<span>${esc(im.text)}</span>` : '<span class="dim">这张图上没识别出文字</span>'}
          </figcaption>
        </figure>`).join('')}
    </div>`;
}

function footBlock(a) {
  const rows = [
    a.taskId && ['技术1 任务号', a.taskId],
    a.schemaVer && ['数据格式版本', 'v' + a.schemaVer],
    a.ai?.generatedAt && ['AI 生成时间', a.ai.generatedAt.slice(0, 19).replace('T', ' ')],
    a.receivedAt && ['IdeaHub 收到', new Date(a.receivedAt).toLocaleString('zh-CN')],
  ].filter(Boolean);
  return `<div class="sec-title">这份数据的出处</div>
    <section class="bench-foot">
      ${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      ${a.ai?.notice ? `<p class="bench-notice">${esc(a.ai.notice)}</p>` : ''}
    </section>`;
}
