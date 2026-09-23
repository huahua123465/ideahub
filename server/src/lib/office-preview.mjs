/**
 * PPT / 老格式 Word 转 PDF，给前端的附件预览用。
 *
 * .pptx 在浏览器里没有靠得住的开源渲染库（能找到的要么闭源、要么带着有 XSS 公告的图表库），
 * .ppt / .doc 是二进制老格式，浏览器里更是无从下手。所以在服务端用 LibreOffice 转成 PDF，
 * 前端拿现成的 PDF.js 阅读器（web/src/pdf-reader.js）来显示，版式和 PowerPoint 里基本一致。
 *
 * 几个刻意的做法：
 *  - 转换结果缓存在容器的 /tmp 下（PREVIEW_DIR），按磁盘文件名命名。不放进 data/uploads：
 *    那个目录每天会被 git 备份推到 GitHub，缓存进去只会让仓库白白变大。
 *    容器重建后缓存就没了，下次有人点开时再转一次，没关系。
 *  - 同一时间只跑一个 LibreOffice（排队），同一个文件被几个人同时点开只转一次。
 *    这台 VPS 只有 4G 内存，还跑着别的服务，并发转换会把内存吃光。
 *  - 先看文件头：.pptx 必须是 zip、.ppt/.doc 必须是 OLE 复合文档。LibreOffice 什么都肯打开，
 *    一个改了后缀的文本 / HTML 也会被它「转」成一页 PDF，没必要让它碰那些东西。
 *  - 文件是别人上传的、不可信的：LibreOffice 以 nobody 身份、清空环境变量运行
 *    （拿不到数据库密码之类的配置），每次用一次性的配置目录，超时直接杀掉。
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm, stat, chown, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';

export const PREVIEW_DIR = process.env.PREVIEW_DIR || join(tmpdir(), 'ideahub-previews');
export const CONVERTIBLE_EXT = new Set(['.ppt', '.pptx', '.doc']);
const SOFFICE = process.env.SOFFICE_BIN || 'soffice';
const TIMEOUT_MS = 120_000;
const NOBODY = 65534;

let queue = Promise.resolve();
const inflight = new Map();   // stored_name → Promise<pdfPath>

/** 预览 PDF 在磁盘上的路径（不管存不存在） */
export function previewPath(storedName) {
  return join(PREVIEW_DIR, `${basename(storedName)}.pdf`);
}

/** 确保这个附件的预览 PDF 已经生成，返回它的路径。转换失败抛出带中文说明的错误 */
export async function ensurePreview(srcPath, storedName) {
  const out = previewPath(storedName);
  try { if ((await stat(out)).size > 0) return out; } catch { /* 还没转过 */ }
  if (!inflight.has(storedName)) {
    const job = queue.then(() => convert(srcPath, storedName, out));
    queue = job.catch(() => {});
    inflight.set(storedName, job);
    job.finally(() => inflight.delete(storedName)).catch(() => {});
  }
  return inflight.get(storedName);
}

/** 附件被删掉时顺手清掉它的预览 */
export async function dropPreview(storedName) {
  await rm(previewPath(storedName), { force: true }).catch(() => {});
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]);                       // .pptx / .docx
const OLE_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);   // .ppt / .doc

async function checkMagic(srcPath, ext) {
  const want = ext.endsWith('x') ? ZIP_MAGIC : OLE_MAGIC;
  const fh = await open(srcPath, 'r');
  try {
    const buf = Buffer.alloc(want.length);
    const { bytesRead } = await fh.read(buf, 0, want.length, 0);
    if (bytesRead < want.length || !buf.equals(want)) throw new Error('文件已损坏，或者后缀和实际格式对不上');
  } finally { await fh.close(); }
}

async function convert(srcPath, storedName, out) {
  await checkMagic(srcPath, extname(storedName).toLowerCase());
  await mkdir(PREVIEW_DIR, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'ideahub-soffice-'));
  try {
    const ext = extname(storedName).toLowerCase();
    const input = join(work, `input${ext}`);
    const profile = join(work, 'profile');
    await copyFile(srcPath, input);
    await mkdir(profile);
    const asNobody = process.getuid?.() === 0;
    if (asNobody) for (const p of [work, input, profile]) await chown(p, NOBODY, NOBODY);

    await run([
      `-env:UserInstallation=file://${profile}`,
      '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--nofirststartwizard',
      '--convert-to', 'pdf', '--outdir', work, input,
    ], { cwd: work, asNobody, home: work });

    const pdf = join(work, 'input.pdf');
    let size = 0;
    try { size = (await stat(pdf)).size; } catch { /* 没生成 */ }
    if (!size) throw new Error('这个文件转换失败了，可能已损坏');
    // 先写到同目录的临时名再改名：别人读到的要么是完整的 PDF，要么没有
    const tmp = `${out}.${process.pid}.tmp`;
    await copyFile(pdf, tmp);
    await rename(tmp, out);
    return out;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function run(args, { cwd, asNobody, home }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(SOFFICE, args, {
        cwd,
        // 不继承服务端的环境变量：里面有数据库密码和各种接口密钥
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: home, LANG: 'zh_CN.UTF-8' },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,   // 自成一个进程组，超时时连它拉起的子进程一起杀
        ...(asNobody ? { uid: NOBODY, gid: NOBODY } : {}),
      });
    } catch {
      reject(new Error('服务器上没有装文档转换组件'));
      return;
    }
    let stderr = '';
    child.stderr.on('data', d => { if (stderr.length < 2000) stderr += d; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已经退出 */ }
      reject(new Error('文件太复杂，转换超时了'));
    }, TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? '服务器上没有装文档转换组件' : '文档转换启动失败'));
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        console.error(`[office-preview] soffice 退出码 ${code}: ${stderr.slice(0, 500)}`);
        reject(new Error('这个文件转换失败了，可能已损坏'));
      }
    });
  });
}
