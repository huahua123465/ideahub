import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  WEB_HTML,
  makeDevelopmentHtml,
  makeModulePreloadHtml,
  makeProductionHtml,
  makeQaHtml,
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

  const qa = makeQaHtml(development);
  assert.match(qa, /src="\/__qa\/app\.js"/);
  assert.doesNotMatch(qa, /<link rel="modulepreload"/);
});
