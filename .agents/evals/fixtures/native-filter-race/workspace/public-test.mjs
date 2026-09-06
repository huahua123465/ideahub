import assert from 'node:assert/strict';
import test from 'node:test';

assert.ok(process.permission, 'Run with Node --permission.');
assert.equal(process.permission.has('fs.read', process.cwd()), true, 'Current fixture must be readable.');
assert.equal(process.permission.has('fs.write', process.cwd()), false, 'Fixture writes are not needed while testing.');
assert.equal(process.permission.has('child'), false, 'Child processes must remain denied.');
assert.equal(process.permission.has('worker'), false, 'Workers must remain denied.');
assert.equal(process.permission.has('addons'), false, 'Native addons must remain denied.');

const { createFilterController } = await import('./filter-controller.mjs');

test('loads one selected filter', async () => {
  const states = [];
  const controller = createFilterController({
    load: async filter => [`${filter}-item`],
    onChange: state => states.push(state),
  });

  await controller.select('new');
  assert.equal(states[0].status, 'loading');
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    filter: 'new',
    items: ['new-item'],
    error: '',
  });
});
