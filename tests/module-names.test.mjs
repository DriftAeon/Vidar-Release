// src/modules/names.ts: the shared validator fixture, the cleaning reader, and the save path
// (chained saves merged into the on-disk map, echo ignored while pending, refusal rollback).
// The ipc stub stands in for read_config / patch_settings; `disk` is vidar.json moduleNames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom } from './helpers/dom-mount.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/module-names.json', import.meta.url), 'utf8'));
const contract = JSON.parse(readFileSync(new URL('../contracts/modules.json', import.meta.url), 'utf8'));

const s = { disk: undefined, writes: [], gate: null, refuse: false };
const { ipc, flush } = setupDom({
  answers: {
    read_config: () => ({ config: s.disk === undefined ? {} : { moduleNames: structuredClone(s.disk) }, error: null, notice: null }),
    patch_settings: async ({ key, value }) => {
      assert.equal(key, 'moduleNames');
      s.writes.push(value);
      if (s.gate) await s.gate.promise;
      if (s.refuse) throw new Error('moduleNames.doc refused');
      s.disk = structuredClone(value);
      ipc.listeners['settings-changed']?.({ payload: { keys: ['moduleNames'], tier: 'live' } });
    },
  },
});
const names = await import('../src/modules/names.ts');
const { NAME_CHARS, moduleIdOk, moduleNameOk, moduleName, setModuleNames, renameModule, onModuleNamesChange } = names;

const gate = () => { let release; const promise = new Promise((r) => { release = r; }); s.gate = { promise, release }; return release; };
const reset = (disk) => { s.disk = disk; s.writes = []; s.gate = null; s.refuse = false; setModuleNames(disk); };
const echo = () => ipc.listeners['settings-changed']({ payload: { keys: ['moduleNames'], tier: 'live' } });
const quiet = (fn) => { const warns = []; const orig = console.warn; console.warn = (m) => warns.push(m); try { fn(); } finally { console.warn = orig; } return warns; };

test('every fixture name case matches the TS validator', () => {
  for (const c of fixture.names) assert.equal(moduleNameOk(c.name), c.ok, `${c.case}: ${JSON.stringify(c.name)}`);
});

test('every fixture key case matches the TS key check', () => {
  for (const c of fixture.keys) assert.equal(moduleIdOk(c.key), c.ok, `key ${JSON.stringify(c.key)}`);
});

test('the limit comes from the contract', () => {
  assert.equal(NAME_CHARS, contract.limits.nameChars);
  assert.equal(moduleNameOk('x'.repeat(NAME_CHARS)), true);
  assert.equal(moduleNameOk('x'.repeat(NAME_CHARS + 1)), false);
});

test('the reader drops bad entries with one warning, ignores relay, keeps unknown ids', () => {
  const warns = quiet(() => setModuleNames({ doc: 'Docs', relay: 'Hub', flow: ' Graph', Bad: 'x', 'pack-z': 'Zed', tray: 7 }));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /flow/);
  assert.doesNotMatch(warns[0], /relay/);
  assert.equal(moduleName('doc', 'Document'), 'Docs');
  assert.equal(moduleName('relay', 'Relay'), 'Relay');
  assert.equal(moduleName('flow', 'Flow'), 'Flow');
  assert.equal(moduleName('tray', 'Tray'), 'Tray');
  assert.equal(moduleName('pack-z', 'Pack Z'), 'Zed');
  assert.equal(quiet(() => setModuleNames(['Docs'])).length, 1);
  assert.equal(moduleName('doc', 'Document'), 'Document');
  assert.equal(quiet(() => setModuleNames(undefined)).length, 0);
});

test('a custom name on the old benchmark id reads as the Lab name; the new id wins when both exist', async () => {
  reset({ benchmark: 'Evals' });
  assert.equal(moduleName('lab', 'Lab'), 'Evals');
  assert.equal(moduleName('benchmark', 'Benchmark'), 'Benchmark');
  reset({ benchmark: 'Old', lab: 'New' });
  assert.equal(moduleName('lab', 'Lab'), 'New');
  reset({ benchmark: 'Evals', doc: 'Docs' });
  assert.equal(await renameModule('flow', 'Graph', 'Flow'), 'saved');
  assert.deepEqual(s.disk, { doc: 'Docs', lab: 'Evals', flow: 'Graph' });
});

test('a change notifies subscribers; an identical seed does not', () => {
  reset({});
  let n = 0;
  const off = onModuleNamesChange(() => n++);
  setModuleNames({ doc: 'Docs' });
  setModuleNames({ doc: 'Docs' });
  off();
  setModuleNames({});
  assert.equal(n, 1);
});

test('two quick renames: the written map holds both', async () => {
  reset({});
  const release = gate();
  const a = renameModule('doc', 'Docs', 'Document');
  const b = renameModule('flow', '  Graph ', 'Flow');
  assert.equal(moduleName('doc', 'Document'), 'Docs');
  assert.equal(moduleName('flow', 'Flow'), 'Graph');
  release();
  assert.deepEqual(await Promise.all([a, b]), ['saved', 'saved']);
  assert.deepEqual(s.writes.at(-1), { doc: 'Docs', flow: 'Graph' });
  assert.deepEqual(s.disk, { doc: 'Docs', flow: 'Graph' });
});

test('a save merges into the on-disk map, keeping a hand edit', async () => {
  reset({ doc: 'Docs' });
  s.disk = { doc: 'Docs', tray: 'Box', relay: 'Hub', Bad: 1 };
  assert.equal(await renameModule('flow', 'Graph', 'Flow'), 'saved');
  assert.deepEqual(s.disk, { doc: 'Docs', tray: 'Box', flow: 'Graph' });
  assert.equal(moduleName('tray', 'Tray'), 'Box');
});

test('empty or the built-in name removes the entry', async () => {
  reset({ doc: 'Docs', flow: 'Graph' });
  assert.equal(await renameModule('doc', '   ', 'Document'), 'saved');
  assert.equal(await renameModule('flow', 'Flow', 'Flow'), 'saved');
  assert.deepEqual(s.disk, {});
  assert.equal(moduleName('doc', 'Document'), 'Document');
});

test('an echo during a pending write does not wipe the cache', async () => {
  reset({});
  const release = gate();
  const p = renameModule('doc', 'Docs', 'Document');
  echo();
  await flush();
  assert.equal(moduleName('doc', 'Document'), 'Docs');
  release();
  assert.equal(await p, 'saved');
  await flush();
  assert.equal(moduleName('doc', 'Document'), 'Docs');
});

test('a later hand edit echo is adopted once nothing is pending', async () => {
  reset({ doc: 'Docs' });
  s.disk = { doc: 'Paper' };
  echo();
  await flush();
  assert.equal(moduleName('doc', 'Document'), 'Paper');
});

test('a refused write resets the cache to the confirmed map', async () => {
  reset({ doc: 'Docs' });
  s.refuse = true;
  const release = gate();
  const p = renameModule('doc', 'Paper', 'Document');
  assert.equal(moduleName('doc', 'Document'), 'Paper');
  release();
  let outcome;
  const orig = console.warn; console.warn = () => {};
  try { outcome = await p; } finally { console.warn = orig; }
  assert.equal(outcome, 'failed');
  assert.equal(moduleName('doc', 'Document'), 'Docs');
  assert.deepEqual(s.disk, { doc: 'Docs' });
});

test('the TS rules refuse before any write', async () => {
  reset({ doc: 'Docs' });
  assert.equal(await renameModule('doc', 'Do‮cs', 'Document'), 'refused');
  assert.equal(await renameModule('doc', 'x'.repeat(NAME_CHARS + 1), 'Document'), 'refused');
  assert.equal(await renameModule('relay', 'Hub', 'Relay'), 'refused');
  assert.equal(await renameModule('Doc', 'Docs', 'Document'), 'refused');
  assert.equal(s.writes.length, 0);
  assert.equal(moduleName('doc', 'Document'), 'Docs');
});
