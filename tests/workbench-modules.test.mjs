import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { defineModuleRegistry } from '../src/modules/types.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../modules/types' && context.parentURL?.endsWith('/src/panels/workbench-modules.ts')) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});

const { WORKBENCH_MODULES } = await import('../src/panels/workbench-modules.ts');

test('bench descriptors come from ordered core workbench surfaces', () => {
  const { core } = JSON.parse(readFileSync(new URL('../contracts/modules.json', import.meta.url), 'utf8'));
  const declared = core.filter(({ kind, surface }) => kind === 'surface' && surface?.placement === 'workbench')
    .sort((a, b) => a.surface.order - b.surface.order)
    .map(({ id, label, level }) => ({ id, label, level }));
  assert.deepEqual(WORKBENCH_MODULES, declared);
});

test('built-in bench modules keep their ten stable IDs in button order', () => {
  assert.deepEqual(
    WORKBENCH_MODULES.map(({ id }) => id),
    ['relay', 'tray', 'doc', 'flow', 'runelib', 'lab', 'changes', 'unreal', 'jira', 'notion', 'slack'],
  );
});

test('built-in bench module levels match their lifecycle contracts', () => {
  assert.deepEqual(
    WORKBENCH_MODULES.map(({ level }) => level),
    ['core', 'required-hideable', 'required-hideable', 'required-hideable',
      'optional', 'optional', 'optional', 'optional', 'optional', 'optional', 'optional'],
  );
});

test('module registry rejects duplicate IDs', () => {
  assert.throws(() => defineModuleRegistry([
    { id: 'relay', label: 'Relay', level: 'core' },
    { id: 'relay', label: 'Second Relay', level: 'optional' },
  ]), /duplicate|relay/i);
});

test('registry accepts an open string ID without loading third-party modules', () => {
  const future = { id: 'future-module', label: 'Future Module', level: 'optional' };
  assert.deepEqual(defineModuleRegistry([future]), [future]);
  assert.equal(WORKBENCH_MODULES.length, 11);
  for (const module of WORKBENCH_MODULES) {
    assert.equal(Object.hasOwn(module, 'loader'), false);
    assert.equal(Object.hasOwn(module, 'load'), false);
  }
});
