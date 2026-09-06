/**
 * 重新生成 index.html 里的 modulepreload 清单。
 * 加了新的前端模块之后跑一次：node scripts/gen-preload.mjs
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WEB_HTML, WEB_ROOT, makeModulePreloadHtml } from './lib/web-build.mjs';

const list = [];
for (const [dir, prefix] of [[join(WEB_ROOT, 'src'), './src/'], [join(WEB_ROOT, 'src', 'views'), './src/views/']]) {
  for (const file of await readdir(dir)) {
    // mock.js 只有后端连不上时才会用到，不值得占一个并发额度。
    if (file.endsWith('.js') && file !== 'mock.js') list.push(prefix + file);
  }
}

const source = await readFile(WEB_HTML, 'utf8');
await writeFile(WEB_HTML, makeModulePreloadHtml(source, list));
console.log(`已更新 ${list.length} 个模块的预加载清单`);
