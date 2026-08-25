/**
 * 重新生成 index.html 里的 modulepreload 清单。
 * 加了新的前端模块之后跑一次：node scripts/gen-preload.mjs
 *
 * 为什么需要它：ES 模块靠逐层解析发现依赖，浏览器下完一层才知道下一层要什么，
 * 网络有延迟时这就是连续好几个来回。把清单摊平写进 HTML，一开始就能全部并发拉。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const list = [];
for (const [dir, prefix] of [[join(web, 'src'), './src/'], [join(web, 'src', 'views'), './src/views/']]) {
  for (const f of await readdir(dir)) {
    // mock.js 只有后端连不上时才会用到，不值得占一个并发额度
    if (f.endsWith('.js') && f !== 'mock.js') list.push(prefix + f);
  }
}
list.sort();

const html = join(web, 'index.html');
let s = await readFile(html, 'utf8');
const links = list.map(m => `<link rel="modulepreload" href="${m}">`).join('\n');
const re = /<link rel="modulepreload"[\s\S]*?<!-- \/modulepreload -->/;
if (!re.test(s)) { console.error('index.html 里找不到 modulepreload 区块'); process.exit(1); }
s = s.replace(re, links + '\n<!-- /modulepreload -->');
await writeFile(html, s);
console.log(`已更新 ${list.length} 个模块的预加载清单`);
