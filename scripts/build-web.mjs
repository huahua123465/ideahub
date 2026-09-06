/**
 * 把前端模块打包成一个文件。
 *
 * 为什么需要：源码由多个 ES 模块组成，浏览器在源码模式下要逐个获取。
 * 实测在 120ms 延迟的网络上，首屏 1.2 秒里绝大部分是这些请求的往返 ——
 * 加了 ETag 之后传输量从 107KB 降到 11KB，但时间几乎没变，
 * 说明卡的不是带宽是**往返次数**。打成一个文件，往返次数从 31 降到个位数。
 *
 * 源码保持不打包（改起来直接刷新就行），只有构建镜像时才打包。
 * index.html 会自动在两者之间切换，见下面写入的那段脚本标签。
 *
 *   node scripts/build-web.mjs          # 生成 web/dist/app.js 并切到打包版
 *   node scripts/build-web.mjs --dev    # 切回未打包的源码模式
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROJECT_ROOT as root,
  WEB_BUNDLE,
  WEB_HTML as html,
  PDF_JS_INPUTS,
  buildWebBundle,
  makeDevelopmentHtml,
  makeProductionHtml,
} from './lib/web-build.mjs';
const dev = process.argv.includes('--dev');

let s = await readFile(html, 'utf8');

if (dev) {
  await writeFile(html, makeDevelopmentHtml(s));
  // 源码模式才需要 modulepreload：把清单重新生成回去
  await import('./gen-preload.mjs');
  await rm(join(root, 'web', 'dist'), { recursive: true, force: true });
  console.log('已切回源码模式（未打包）');
  process.exit(0);
}

await buildWebBundle();

const { size } = await import('node:fs').then(m => m.promises.stat(WEB_BUNDLE));
const stamp = Date.now().toString(36);

// HTML 入口切换与测试使用同一组解析规则，避免测试能识别而生产脚本识别失败。
await writeFile(html, makeProductionHtml(s, stamp));

// 顺手把对接方要用的推送脚本复制进 web/，让它有一个可下载的地址。
// 源文件只有 scripts/ 下那一份 —— 在这里复制而不是手工放两份，
// 是因为手工放两份必然会有一天不一致，而对接方拿到的正好是旧的那份。
// 脚本里不含任何密钥（密钥从环境变量读），可以公开下载。
// 复制失败不能让整个构建挂掉。
// 镜像里只 COPY 了 server / web / scripts，没有 docs —— 也就是说在容器内跑这一步时
// 源文件根本不存在。而那时候 web/ 里已经带着宿主机同步好的副本了，跳过正是对的。
const fsp = (await import('node:fs')).promises;
// PDF.js 只在浏览器里使用。复制最小运行文件到 web/vendor，避免把 35MB 的完整 npm 包
// 当静态资源发布；Worker 必须同源，否则手机浏览器容易因跨域而退化失败。
const pdfVendor = join(root, 'web', 'vendor', 'pdfjs');
await fsp.mkdir(pdfVendor, { recursive: true });
await Promise.all([
  fsp.copyFile(PDF_JS_INPUTS[0], join(pdfVendor, 'pdf.min.mjs')),
  fsp.copyFile(PDF_JS_INPUTS[1], join(pdfVendor, 'pdf.worker.min.mjs')),
  fsp.copyFile(PDF_JS_INPUTS[2], join(pdfVendor, 'LICENSE.txt')),
]);
const 同步 = async (从, 到, 说明) => {
  try {
    await fsp.copyFile(join(root, ...从), join(root, 'web', 到));
    return 到;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log(`  跳过 ${说明}：源文件不在（容器内构建时是正常的）`);
    return null;
  }
};
const 已同步 = (await Promise.all([
  同步(['scripts', '推送到ideahub.py'], '推送到ideahub.py', '推送脚本'),
  同步(['docs', '接入说明.md'], '接入说明.md', '接入文档'),
])).filter(Boolean);

console.log(`打包完成：web/dist/app.js  ${Math.round(size / 1024)} KB  版本 ${stamp}`);
console.log('PDF.js 浏览器运行文件已同步到 web/vendor/pdfjs/');
if (已同步.length) console.log('对接方资料已同步到 web/：' + 已同步.join('、'));
