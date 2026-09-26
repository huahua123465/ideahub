import { build, transform } from 'esbuild';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const WEB_ROOT = join(PROJECT_ROOT, 'web');
export const WEB_ENTRY = join(WEB_ROOT, 'src', 'main.js');
export const WEB_HTML = join(WEB_ROOT, 'index.html');
export const WEB_DIST = join(WEB_ROOT, 'dist');
export const WEB_BUNDLE = join(WEB_DIST, 'app.js');
export const PDF_JS_INPUTS = Object.freeze([
  join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs'),
  join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'LICENSE'),
]);

const ENTRY_SCRIPT = /<script type="module" src="\.\/(?:src\/main\.js|dist\/app\.js[^"]*)"><\/script>/;
const MODULE_PRELOADS = /<!-- modulepreload:start -->[\s\S]*?<!-- modulepreload:end -->/;
// 源码里是 ./styles.css；生产构建换成压缩版 ./dist/css/styles.css?v=h…（见 buildStylesheets），两种都要认得
const STYLESHEET = /<link rel="stylesheet" href="\.\/(?:dist\/css\/)?([\w.-]+\.css)(?:\?v=h[0-9a-f]{10})?">/g;

const SHARED_BUILD_OPTIONS = Object.freeze({
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022'],
  logLevel: 'warning',
  // 按需加载的模块（比如只在演示模式用的 mock.js）拆成单独的文件，不进首屏的 app.js。
  // 拆出来的文件名带内容哈希，放在 dist/chunks/ 下，服务端对它们给长缓存。
  splitting: true,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
});

/**
 * Build the browser application with the production compiler contract.
 * Tests may keep the result in memory, but entry point, format, minification,
 * target and output identity stay shared with the deploy build.
 */
export function buildWebBundle({
  write = true,
  sourcemap = write,
  outdir = WEB_DIST,
} = {}) {
  return build({
    ...SHARED_BUILD_OPTIONS,
    entryPoints: { app: WEB_ENTRY },
    outdir,
    sourcemap,
    write,
  });
}

/** 拆出来的按需模块：{ 'chunks/mock-XXXX.js': Buffer }，测试服务器要能按路径回给浏览器 */
export function readChunkOutputs(buildResult, outdir = WEB_DIST) {
  const root = outdir.replaceAll('\\', '/').replace(/\/?$/, '/');
  const chunks = {};
  for (const file of buildResult.outputFiles || []) {
    const path = file.path.replaceAll('\\', '/');
    if (path.startsWith(`${root}chunks/`) && path.endsWith('.js')) {
      chunks[path.slice(root.length)] = Buffer.from(file.contents);
    }
  }
  return chunks;
}

export function readBundleOutput(buildResult, outfile = WEB_BUNDLE) {
  const normalized = outfile.replaceAll('\\', '/');
  const output = buildResult.outputFiles?.find(file =>
    file.path.replaceAll('\\', '/') === normalized,
  ) || buildResult.outputFiles?.find(file => file.path.replaceAll('\\', '/').endsWith('/app.js'));

  if (!output) throw new Error('esbuild did not produce app.js');
  return Buffer.from(output.contents);
}

export function makeProductionHtml(source, stamp, preloads = []) {
  // app.js 静态引用的公共拆分块（按需加载的页面和首屏共用的代码）：和 app.js 一起提前下载，
  // 不然要等 app.js 下完、解析了才知道还要它们，白白多一个来回（09-26）
  const links = preloads.map(path => `<link rel="modulepreload" href="${path}">`).join('\n');
  return replaceModulePreloads(
    replaceEntry(source, `./dist/app.js?v=${stamp}`),
    links ? `<!-- 已打包成 dist/app.js；下面是它首屏就要用的公共拆分块 -->\n${links}` : '<!-- 已打包成 dist/app.js，不需要逐个模块预加载 -->',
  );
}

/** app.js 开头静态 import 的拆分块（./chunks/…），换成相对 index.html 的地址 ./dist/chunks/… */
export function staticChunkImports(appCode) {
  const code = Buffer.isBuffer(appCode) ? appCode.toString('utf8') : String(appCode);
  return [...new Set([...code.matchAll(/(?:from|import)\s*"\.\/(chunks\/[\w.-]+\.js)"/g)].map(m => `./dist/${m[1]}`))];
}

export function makeQaHtml(source) {
  return replaceModulePreloads(
    replaceEntry(source, '/__qa/app.js'),
    '<!-- UI QA uses one in-memory production bundle -->',
  );
}

export function makeDevelopmentHtml(source) {
  return stripStylesheetVersions(replaceEntry(source, './src/main.js'));
}

/**
 * 给 index.html 里的本地样式表加内容指纹：./styles.css → ./styles.css?v=h1a2b3c4d5e。
 * 服务端对带 ?v= 的静态文件给一年的强缓存（server/src/index.mjs serveStatic），
 * 所以地址必须跟着内容变：内容不变指纹不变，照样吃缓存；改了一个字指纹就变，浏览器重新下载。
 */
export async function versionStylesheets(source, webRoot = WEB_ROOT) {
  const links = [...source.matchAll(STYLESHEET)];
  let out = source;
  for (const [tag, name] of links) {
    const hash = createHash('sha1').update(await readFile(join(webRoot, name))).digest('hex').slice(0, 10);
    out = out.replace(tag, `<link rel="stylesheet" href="./${name}?v=h${hash}">`);
  }
  return out;
}

/**
 * 压缩一份样式表（2026-09-26）：去掉注释和空白，规则顺序、选择器和取值都不变。
 * 样式表里中文注释很多，gzip 之后四份一共从约 122KB 降到约 82KB。
 * 生产构建和 UI 验收都用这一份结果，保证测的就是线上发出去的样式。
 */
export async function minifyStylesheet(name, webRoot = WEB_ROOT) {
  const source = await readFile(join(webRoot, name), 'utf8');
  const { code } = await transform(source, { loader: 'css', minify: true, sourcefile: name, logLevel: 'error' });
  return code;
}

/**
 * 生产：把 index.html 引用的样式表压缩到 web/dist/css/，链接换成压缩版并带内容指纹。
 * web/ 下的源文件不动（本地直接改、直接刷新）；--dev 模式会把链接换回 ./styles.css。
 */
export async function buildStylesheets(source, { webRoot = WEB_ROOT, outdir = join(WEB_DIST, 'css'), write = true } = {}) {
  let html = source;
  const files = {};
  for (const [tag, name] of [...source.matchAll(STYLESHEET)]) {
    const code = rebaseUrls(await minifyStylesheet(name, webRoot));
    const hash = createHash('sha1').update(code).digest('hex').slice(0, 10);
    files[name] = code;
    html = html.replace(tag, `<link rel="stylesheet" href="./dist/css/${name}?v=h${hash}">`);
  }
  if (write) {
    await mkdir(outdir, { recursive: true });
    await Promise.all(Object.entries(files).map(([name, code]) => writeFile(join(outdir, name), code)));
  }
  return { html, files };
}

/**
 * 样式表从 web/ 挪到 web/dist/css/ 之后，里面的相对地址（字体 ./assets/fonts/…）要往上退两级，
 * 不然会去找 dist/css/assets/…（09-26 生产构建冒烟时发现字体 404）。data:、http(s):、/ 开头和 # 开头的不动。
 */
export function rebaseUrls(code) {
  return code.replace(/url\((['"]?)(?![a-z][\w+.-]*:|\/|#)(?:\.\/)?([^'")]+)\1\)/gi, (_, q, path) => `url(${q}../../${path}${q})`);
}

function stripStylesheetVersions(source) {
  return source.replace(STYLESHEET, (_, name) => `<link rel="stylesheet" href="./${name}">`);
}

export function makeModulePreloadHtml(source, modules) {
  const links = [...modules].sort().map(module => `<link rel="modulepreload" href="${module}">`).join('\n');
  return replaceModulePreloads(source, links);
}

export async function validateWebBuildInputs() {
  await Promise.all([WEB_ENTRY, WEB_HTML, ...PDF_JS_INPUTS].map(path => access(path)));
}

function replaceEntry(source, src) {
  const next = source.replace(ENTRY_SCRIPT, `<script type="module" src="${src}"></script>`);
  if (next === source && !source.includes(`src="${src}"`)) {
    throw new Error('web/index.html entry script was not recognized');
  }
  return next;
}

function replaceModulePreloads(source, content) {
  const block = `<!-- modulepreload:start -->\n${content}\n<!-- modulepreload:end -->`;
  const next = source.replace(MODULE_PRELOADS, block);
  if (next === source && !source.includes(block)) {
    throw new Error('web/index.html modulepreload markers were not recognized');
  }
  return next;
}
