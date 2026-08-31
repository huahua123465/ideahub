import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const collector = await readFile(new URL('../web/src/views/collector.js', import.meta.url), 'utf8');
const samples = await readFile(new URL('../web/src/views/samples.js', import.meta.url), 'utf8');
const research = await readFile(new URL('../web/src/views/sample-research.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../web/src/main.js', import.meta.url), 'utf8');

test('采集结果可归档并进入对应样本拆解页', () => {
  assert.match(collector, /data-result-archive/);
  assert.match(collector, /api\.collectorArchive\(task\.id\)/);
  assert.match(collector, /CustomEvent\('open-sample'/);
  assert.match(samples, /export function openSample\(id\)/);
  assert.match(samples, /selectSample\(sampleId, 'elements'\)/);
  assert.match(research, /options\.initialTab/);
  assert.match(main, /collector\.events\.addEventListener\('open-sample'/);
  assert.match(main, /samples\.openSample\(event\.detail\.sampleId\)/);
});
