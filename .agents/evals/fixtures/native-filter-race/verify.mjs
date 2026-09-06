import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceIndex = process.argv.indexOf('--workspace');
if (workspaceIndex < 0 || !process.argv[workspaceIndex + 1]) {
  console.error('Usage: node verify.mjs --workspace <copied-workspace>');
  process.exit(2);
}

const workspace = resolve(process.argv[workspaceIndex + 1]);
const modulePath = resolve(workspace, 'filter-controller.mjs');
const checks = [];

await check('native-esm-source', async () => {
  const source = await readFile(modulePath, 'utf8');
  assert.match(source, /export\s+function\s+createFilterController/);
  assert.doesNotMatch(source, /\b(?:require|React|axios)\b/);
});

await check('latest-request-wins', async () => {
  const { createFilterController } = await import(`${pathToFileURL(modulePath).href}?race=${Date.now()}`);
  const pending = new Map();
  const states = [];
  const controller = createFilterController({
    load: filter => new Promise((resolvePromise, rejectPromise) => pending.set(filter, { resolvePromise, rejectPromise })),
    onChange: state => states.push(state),
  });
  const slow = controller.select('slow');
  const fast = controller.select('fast');
  pending.get('fast').resolvePromise(['fast-item']);
  await fast;
  pending.get('slow').resolvePromise(['slow-item']);
  await slow;
  assert.deepEqual(controller.getState(), {
    status: 'ready', filter: 'fast', items: ['fast-item'], error: '',
  });
  assert.equal(states.at(-1).filter, 'fast');
});

await check('loading-clears-stale-items', async () => {
  const { createFilterController } = await import(`${pathToFileURL(modulePath).href}?loading=${Date.now()}`);
  let release;
  const states = [];
  const controller = createFilterController({
    load: async filter => {
      if (filter === 'seed') return ['old-item'];
      return await new Promise(resolvePromise => { release = resolvePromise; });
    },
    onChange: state => states.push(state),
  });
  await controller.select('seed');
  const next = controller.select('next');
  assert.deepEqual(controller.getState(), {
    status: 'loading', filter: 'next', items: [], error: '',
  });
  release(['next-item']);
  await next;
});

await check('current-error-is-actionable', async () => {
  const { createFilterController } = await import(`${pathToFileURL(modulePath).href}?error=${Date.now()}`);
  const controller = createFilterController({
    load: async () => { throw new Error('网络暂时不可用'); },
    onChange: () => {},
  });
  await controller.select('failed-filter');
  const state = controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.filter, 'failed-filter');
  assert.deepEqual(state.items, []);
  assert.match(state.error, /网络暂时不可用/);
});

const ok = checks.every(item => item.passed);
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  fixture: 'native-filter-race',
  ok,
  checks,
}, null, 2)}\n`);
process.exitCode = ok ? 0 : 1;

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, passed: true, evidence: 'deterministic assertion passed' });
  } catch (error) {
    checks.push({ name, passed: false, evidence: error.message });
  }
}
