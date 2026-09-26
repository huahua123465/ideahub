import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  WEB_HTML,
  makeDevelopmentHtml,
  makeModulePreloadHtml,
  makeProductionHtml,
  makeQaHtml,
  buildStylesheets,
  minifyStylesheet,
  staticChunkImports,
  rebaseUrls,
} from './lib/web-build.mjs';

test('web HTML transforms round-trip across source, production, and QA modes', async () => {
  const source = await readFile(WEB_HTML, 'utf8');
  assert.match(source, /<script type="module" src="\.\/src\/main\.js"><\/script>/,
    'checked-in web/index.html must remain directly runnable in source mode');
  assert.doesNotMatch(source, /<script type="module" src="\.\/dist\/app\.js/,
    'checked-in web/index.html must not depend on ignored production output');
  const development = makeModulePreloadHtml(
    makeDevelopmentHtml(source),
    ['./src/main.js', './src/views/pool.js'],
  );
  assert.match(development, /src="\.\/src\/main\.js"/);
  assert.match(development, /rel="modulepreload" href="\.\/src\/views\/pool\.js"/);

  const production = makeProductionHtml(development, 'test-build');
  assert.match(production, /src="\.\/dist\/app\.js\?v=test-build"/);
  assert.doesNotMatch(production, /<link rel="modulepreload"/);
  assert.match(production, /modulepreload:start[\s\S]*modulepreload:end/);

  const restored = makeModulePreloadHtml(
    makeDevelopmentHtml(production),
    ['./src/main.js', './src/views/pool.js'],
  );
  assert.equal(restored, development);

  // 首屏要用的公共拆分块和 app.js 一起预加载；切回源码模式时清掉
  const chunks = staticChunkImports('import{a}from"./chunks/chunk-AB12.js";import"./chunks/chunk-CD34.js";x=import("./chunks/samples-EF56.js")');
  assert.deepEqual(chunks, ['./dist/chunks/chunk-AB12.js', './dist/chunks/chunk-CD34.js']);
  const withChunks = makeProductionHtml(development, 'test-build', chunks);
  assert.match(withChunks, /<link rel="modulepreload" href="\.\/dist\/chunks\/chunk-AB12\.js">/);
  assert.equal(makeModulePreloadHtml(makeDevelopmentHtml(withChunks), ['./src/main.js', './src/views/pool.js']), development);

  const qa = makeQaHtml(development);
  assert.match(qa, /src="\/__qa\/app\.js"/);
  assert.doesNotMatch(qa, /<link rel="modulepreload"/);
});

test('production stylesheets are minified into dist/css with content hashes and round-trip back to source', async () => {
  const source = await readFile(WEB_HTML, 'utf8');
  const { html, files } = await buildStylesheets(makeProductionHtml(source, 'test-build'), { write: false });
  const names = [...source.matchAll(/<link rel="stylesheet" href="\.\/([\w.-]+\.css)">/g)].map(m => m[1]);
  assert.ok(names.length >= 4, 'index.html should link the four app stylesheets');
  for (const name of names) {
    assert.match(html, new RegExp(`href="\\./dist/css/${name.replace('.', '\\.')}\\?v=h[0-9a-f]{10}"`));
    const raw = await readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');
    assert.ok(files[name].length < raw.length, `${name} should get smaller`);
    assert.doesNotMatch(files[name], /\/\*(?!!)/, `${name} should have no comments left`);
  }
  // --dev 切回源码模式时链接恢复成 ./styles.css
  for (const name of names) assert.match(makeDevelopmentHtml(html), new RegExp(`href="\\./${name.replace('.', '\\.')}"`));
  // 压缩不改变规则：自定义属性和 light-dark() 取值原样保留
  const soft = await minifyStylesheet('soft.css');
  assert.match(soft, /--blue:light-dark\(#796375,#c3a6bb\)/);
  // 挪到 dist/css/ 后相对地址往上退两级：字体还能找到
  assert.match(files['soft.css'], /url\("?\.\.\/\.\.\/assets\/fonts\/bricolage-grotesque-latin\.woff2"?\)/);
  assert.equal(rebaseUrls('a{b:url(data:x);c:url(/x.png);d:url("./y.png");e:url(z.png)}'),
    'a{b:url(data:x);c:url(/x.png);d:url("../../y.png");e:url(../../z.png)}');
});
