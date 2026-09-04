import { build } from 'esbuild';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const WEB_ROOT = join(PROJECT_ROOT, 'web');
export const WEB_ENTRY = join(WEB_ROOT, 'src', 'main.js');
export const WEB_HTML = join(WEB_ROOT, 'index.html');
export const WEB_BUNDLE = join(WEB_ROOT, 'dist', 'app.js');
export const PDF_JS_INPUTS = Object.freeze([
  join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs'),
  join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'LICENSE'),
]);

const ENTRY_SCRIPT = /<script type="module" src="\.\/(?:src\/main\.js|dist\/app\.js[^"]*)"><\/script>/;
const MODULE_PRELOADS = /<!-- modulepreload:start -->[\s\S]*?<!-- modulepreload:end -->/;

const SHARED_BUILD_OPTIONS = Object.freeze({
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022'],
  logLevel: 'warning',
});

/**
 * Build the browser application with the production compiler contract.
 * Tests may keep the result in memory, but entry point, format, minification,
 * target and output identity stay shared with the deploy build.
 */
export function buildWebBundle({
  write = true,
  sourcemap = write,
  outfile = WEB_BUNDLE,
} = {}) {
  return build({
    ...SHARED_BUILD_OPTIONS,
    entryPoints: [WEB_ENTRY],
    outfile,
    sourcemap,
    write,
  });
}

export function readBundleOutput(buildResult, outfile = WEB_BUNDLE) {
  const normalized = outfile.replaceAll('\\', '/');
  const output = buildResult.outputFiles?.find(file =>
    file.path.replaceAll('\\', '/') === normalized,
  ) || buildResult.outputFiles?.find(file => file.path.replaceAll('\\', '/').endsWith('/app.js'));

  if (!output) throw new Error('esbuild did not produce app.js');
  return Buffer.from(output.contents);
}

export function makeProductionHtml(source, stamp) {
  return replaceModulePreloads(
    replaceEntry(source, `./dist/app.js?v=${stamp}`),
    '<!-- 已打包成 dist/app.js，不需要逐个模块预加载 -->',
  );
}

export function makeQaHtml(source) {
  return replaceModulePreloads(
    replaceEntry(source, '/__qa/app.js'),
    '<!-- UI QA uses one in-memory production bundle -->',
  );
}

export function makeDevelopmentHtml(source) {
  return replaceEntry(source, './src/main.js');
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
