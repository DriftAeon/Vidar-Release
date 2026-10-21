import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModuleState } from '../src/modules/state.ts';

const benchId = (descriptor) => `bench:${descriptor.id}`;
const WORKBENCH_MODULES = [
  { id: 'relay', level: 'core' },
  { id: 'tray', level: 'required-hideable' },
  { id: 'display', level: 'required-hideable' },
  { id: 'doc', level: 'required-hideable' },
  { id: 'flow', level: 'required-hideable' },
  { id: 'runelib', level: 'optional' },
  { id: 'lab', level: 'optional' },
];
const builtIds = WORKBENCH_MODULES.map(({ id }) => id);

test('absent state shows every bench module in built order', () => {
  const state = resolveModuleState(WORKBENCH_MODULES, {}, benchId);
  assert.deepEqual(state.modules.map(({ descriptor }) => descriptor.id), builtIds);
  assert.ok(state.modules.every(({ visible }) => visible));
  assert.deepEqual(state.hidden, []);
  assert.deepEqual(state.order, []);
});

test('core Relay cannot be hidden, while other bench modules can', () => {
  const state = resolveModuleState(WORKBENCH_MODULES, {
    hidden: ['bench:relay', 'bench:tray'],
  }, benchId);
  assert.deepEqual(state.hidden, ['bench:tray']);
  assert.equal(state.modules.find(({ descriptor }) => descriptor.id === 'relay').visible, true);
  assert.equal(state.modules.find(({ descriptor }) => descriptor.id === 'tray').visible, false);
});

test('unknown visibility and order IDs remain dormant', () => {
  const saved = { hidden: ['bench:future', 'bench:flow'], order: ['future', 'flow', 'relay'] };
  const state = resolveModuleState(WORKBENCH_MODULES, saved, benchId);
  assert.deepEqual(state.hidden, saved.hidden);
  assert.deepEqual(state.order, saved.order);
  assert.equal(state.modules.find(({ descriptor }) => descriptor.id === 'flow').visible, false);
  assert.deepEqual(saved, { hidden: ['bench:future', 'bench:flow'], order: ['future', 'flow', 'relay'] });
});

test('first duplicate wins in hidden and order lists', () => {
  const state = resolveModuleState(WORKBENCH_MODULES, {
    hidden: ['bench:tray', 'bench:future', 'bench:tray', 'bench:future'],
    order: ['flow', 'relay', 'flow', 'future', 'relay'],
  }, benchId);
  assert.deepEqual(state.hidden, ['bench:tray', 'bench:future']);
  assert.deepEqual(state.order, ['flow', 'relay', 'future']);
  assert.deepEqual(
    state.modules.map(({ descriptor }) => descriptor.id).filter((id) => ['flow', 'relay'].includes(id)),
    ['flow', 'relay'],
  );
});
