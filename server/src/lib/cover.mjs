/**
 * 把对标作品的封面图落到本地。
 *
 * 为什么非落不可：平台给的封面地址是带时间签名的，
 * 小红书那份样本里路径中间明晃晃写着 `/202608251136/` —— 过几天就 404。
 * 直接把那个 URL 存下来的结果是：今天推进来的对标卡片，明天全变成空白色块，
 * 而且没人会意识到是链接过期了，只会觉得「这系统怎么图老是加载不出来」。
 *
 * 收到推送时下一次，之后一律走 GET /api/works/:id/cover。
 * 下载失败不影响入库 —— 封面是锦上添花，分析内容才是正事。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_DIR } from '../routes/files.mjs';

/**
 * 两个来源，优先级从高到低：
 *   1. 技术1 在 JSON 里直接带的整张图（base64）—— 最可靠，不受签名和过期影响
 *   2. 平台 CDN 的图片地址 —— 退路，多数是被重压过的缩略图
 * 之所以要第 1 条：小红书给的 thumbnail_url 是 `!nd_prv_` 预览变体，
 * 1080×1441 只有 27KB（每像素 0.017 字节），糊得看不清人脸；
 * 而那个签名只对这一个变体有效，换任何清晰度后缀都是 403 —— 从我们这头救不了。
 */

/** 封面单独一个子目录，和用户上传的附件分开 —— 清理策略不一样 */
export const COVER_DIR = join(UPLOAD_DIR, 'bench-covers');

/**
 * 单张封面的上限。一张 1080×1920 的清晰竖图大约 200~500KB，
 * 3MB 足够宽松；比这还大的多半不是封面（整段视频、一叠长图），不要。
 */
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 8000;

const EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif',
};

/** 文件名只由 sourceRef 决定：同一条对标重推，覆盖同一个文件，不会越攒越多 */
export const coverName = (sourceRef, ext) =>
  createHash('sha1').update(String(sourceRef)).digest('hex') + ext;

/**
 * 下载一张封面。
 * @returns 落地后的文件名，失败返回 null（调用方照常入库）
 */
export async function mirrorCover(url, sourceRef) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // 页面走的是 HTTPS，http:// 的图会被浏览器当混合内容拦掉。
  // 反正是要下到本地再由自己发出去，这里先试 https。
  const tryUrls = url.startsWith('http://')
    ? [url.replace(/^http:/i, 'https:'), url]
    : [url];

  for (const u of tryUrls) {
    try {
      const r = await fetch(u, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // 不带 referer：多数图床的防盗链就是看这个头
        referrerPolicy: 'no-referrer',
        headers: { 'user-agent': 'IdeaHub/1.0 (+benchmark cover mirror)' },
      });
      if (!r.ok) continue;

      const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = EXT[type];
      // 拿到的不是图片（多半是被跳到了一个登录页或错误页）就当没拿到，
      // 不能把一份 HTML 存成 .jpg 摆在卡片上
      if (!ext) continue;

      const len = Number(r.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_BYTES) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      // content-length 可能没有或撒谎，实际字节数再挡一道
      if (!buf.length || buf.length > MAX_BYTES) continue;

      await mkdir(COVER_DIR, { recursive: true });
      const name = coverName(sourceRef, ext);
      await writeFile(join(COVER_DIR, name), buf);
      return name;
    } catch {
      // 超时、DNS、连不上 —— 换下一个地址，都不行就算了
    }
  }
  return null;
}

/** 作品被删时顺手清掉封面文件。删不掉不算错（可能本来就没有） */
export const dropCover = (name) =>
  (name ? rm(join(COVER_DIR, name), { force: true }).catch(() => {}) : Promise.resolve());


/**
 * 认图片的真实类型 —— 看头几个字节，不信对方声明的 mime。
 * 声明成 image/jpeg 实际是一段 HTML 或者 base64 截断了半张，
 * 存下来就是卡片上一个碎图标，而且要查很久才知道是推送方给错了。
 */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
   && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return '.gif';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp'
   && buf.subarray(8, 12).toString('latin1').startsWith('avif')) return '.avif';
  return null;
}

/**
 * 技术1 直接放在 JSON 里的整张封面（base64）落地。
 *
 * 接受 `data:image/jpeg;base64,xxx` 和光秃秃的 base64 两种写法 ——
 * 对接方两种都可能给，为这个来回一趟不值得。
 *
 * @returns 文件名，认不出来是图片就返回 null（调用方退回去下 URL）
 */
export async function saveInlineCover(data, sourceRef) {
  const s = typeof data === 'string' ? data.trim() : '';
  if (s.length < 64) return null;                       // 太短，不可能是一张图
  const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch { return null; }
  if (!buf.length || buf.length > MAX_BYTES) return null;

  const ext = sniff(buf);
  if (!ext) return null;

  await mkdir(COVER_DIR, { recursive: true });
  const name = coverName(sourceRef, ext);
  await writeFile(join(COVER_DIR, name), buf);
  return name;
}

/**
 * 落一张封面：先用 JSON 里带的整张图，没有再去下 URL。
 *
 * 合成一个入口而不是让路由自己 if/else，是因为「优先级」这件事以后还会变
 * （技术1 哪天给了原图地址，顺序要调），调用方不该跟着改。
 *
 * @param {{ inline?: string|null, urls?: (string|null)[] }} src
 * @returns { file, from } from = 'inline' | 'url' | null，写进 digest 好排查
 */
export async function storeCover(src, sourceRef) {
  const file = await saveInlineCover(src?.inline, sourceRef);
  if (file) return { file, from: 'inline' };
  for (const u of (src?.urls || [])) {
    const f = await mirrorCover(u, sourceRef);
    if (f) return { file: f, from: 'url' };
  }
  return { file: null, from: null };
}


/**
 * 图文笔记的整组图落地。
 *
 * 小红书的图文笔记（media_type=image_post）没有视频，正文就是那一叠图 ——
 * 每张图上印着一段话，OCR 出来的文字就在 payload 的 images[].text 里。
 * 对做对标的人来说，这些图**就是内容本身**，等价于视频的逐字稿。
 *
 * 和封面同样的道理必须下到本地：平台地址路径里的 `202608241623` 是**失效时间**，
 * 过了就一律 403。实测技术1 昨天采集、今天才推的那两条，图已经全挂了。
 *
 * 顺序发起、不并发：一条笔记九张图，并发下载对那个 CDN 像一次小爆发，
 * 而这是后台入库、没人在等，慢一点无所谓。
 *
 * @param sources  按显示顺序排好的图片来源；每项可带 inline 和/或 url
 * @param max   最多下几张。定 20 是因为小红书单条上限 18 张，留一点余量
 * @returns [{ i, file, from }]，存不下来的那张不出现在结果里
 */
export async function mirrorImages(sources, sourceRef, max = 20) {
  const out = [];
  const list = (sources || []).slice(0, max);
  for (let i = 0; i < list.length; i++) {
    // 文件名里带序号：同一条笔记的九张图各自独立，重推时逐张覆盖
    const src = typeof list[i] === 'string' ? { url: list[i] } : (list[i] || {});
    const { file, from } = await storeCover(
      { inline: src.inline, urls: [src.url] }, `${sourceRef}#${i}`);
    if (file) out.push({ i, file, from });
  }
  return out;
}
