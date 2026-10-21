import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayAgents, agentKey } from '../src/config-agents.ts';
import { rulesPlan } from '../src/rules/inject.ts';

// Generic overlay fixtures use neutral agents; only the rules cases at the bottom use real ids.
const BUILTINS = [
  { id: 'alpha', label: 'Alpha', args: ['alpha'] },
  { id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'C:\\Work' },
  { id: 'alpha', label: 'Rendered', under: 'alpha', body: 'rendered', permissionMode: 'auto' },
  { id: 'beta', label: 'Beta' },
  { id: 'shell', label: 'Terminal' },
];
const labels = (list) => list.map((a) => a.label);

test('no overlay -> the built-ins, unchanged and copied', () => {
  const out = overlayAgents(BUILTINS, undefined);
  assert.deepEqual(out, BUILTINS);
  assert.notEqual(out[0], BUILTINS[0]);
  assert.deepEqual(overlayAgents(BUILTINS, []), BUILTINS);
});

test('new key -> addition after the built-ins, in overlay order', () => {
  const out = overlayAgents(BUILTINS, [
    { id: 'beta', label: 'Beta Two', under: 'beta', cwd: 'C:\\x' },
    { id: 'zed', label: 'Zed' },
  ]);
  assert.deepEqual(labels(out), ['Alpha', 'Pinned', 'Rendered', 'Beta', 'Terminal', 'Beta Two', 'Zed']);
});

test('same key -> given fields override in place, the rest kept', () => {
  const out = overlayAgents(BUILTINS, [{ id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'D:\\y' }]);
  assert.deepEqual(labels(out), labels(BUILTINS));
  assert.deepEqual(out[1], { id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'D:\\y' });
  assert.equal(BUILTINS[1].cwd, 'C:\\Work'); // input not mutated
});

test('null fields (Rust None) are not given: they do not blank the built-in', () => {
  const out = overlayAgents(BUILTINS, [
    { id: 'alpha', label: 'Rendered', under: 'alpha', body: 'rendered', permissionMode: null, model: 'm', disabled: null },
  ]);
  assert.equal(out[2].permissionMode, 'auto');
  assert.equal(out[2].model, 'm');
  assert.equal('disabled' in out[2], false);
});

test('key is id + under + label: same id, different label is a different row', () => {
  assert.notEqual(agentKey(BUILTINS[0]), agentKey(BUILTINS[1]));
  assert.equal(agentKey({ id: 'beta' }), agentKey({ id: 'beta', label: 'beta' }));
  const out = overlayAgents(BUILTINS, [{ id: 'alpha', label: 'Alpha', args: ['x'] }]);
  assert.deepEqual(out[0].args, ['x']);
  assert.deepEqual(out[1], BUILTINS[1]);
});

test('disabled: true -> the matching row is removed', () => {
  const out = overlayAgents(BUILTINS, [{ id: 'beta', label: 'Beta', disabled: true }]);
  assert.deepEqual(labels(out), ['Alpha', 'Pinned', 'Rendered', 'Terminal']);
});

test('disabled on an unknown key is ignored, not added', () => {
  const out = overlayAgents(BUILTINS, [{ id: 'nope', label: 'Nope', disabled: true }]);
  assert.deepEqual(out, BUILTINS);
});

test('disabled: false is an ordinary override and the flag is stripped', () => {
  const out = overlayAgents(BUILTINS, [{ id: 'shell', label: 'Terminal', disabled: false, shell: 'cmd' }]);
  assert.deepEqual(out[4], { id: 'shell', label: 'Terminal', shell: 'cmd' });
});

test('disabled on no match -> a warning carrying the entry', () => {
  const warnings = [];
  overlayAgents(BUILTINS, [{ id: 'nope', label: 'Nope', disabled: true }, { key: 'gone', id: '', disabled: true }], warnings);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /"label":"Nope"/);
  assert.match(warnings[1], /"key":"gone"/);
  assert.deepEqual(overlayAgents(BUILTINS, [{ id: 'beta', label: 'Beta', disabled: true }], []), overlayAgents(BUILTINS, [{ id: 'beta', label: 'Beta', disabled: true }]));
});

test('disabling a root takes its variants along, wherever the disable sits', () => {
  const out = overlayAgents(BUILTINS, [
    { id: 'alpha', label: 'Extra', under: 'alpha', cwd: 'C:\\z' },
    { id: 'alpha', label: 'Alpha', disabled: true },
  ]);
  assert.deepEqual(labels(out), ['Beta', 'Terminal']);
});

test('disabling a root keeps its variants when another root with that id remains', () => {
  const out = overlayAgents(BUILTINS, [
    { id: 'alpha', label: 'Alpha 2' },
    { id: 'alpha', label: 'Alpha', disabled: true },
  ]);
  assert.deepEqual(labels(out), ['Pinned', 'Rendered', 'Beta', 'Terminal', 'Alpha 2']);
});

test('disabling a variant does not cascade', () => {
  const out = overlayAgents(BUILTINS, [{ id: 'alpha', label: 'Pinned', under: 'alpha', disabled: true }]);
  assert.deepEqual(labels(out), ['Alpha', 'Rendered', 'Beta', 'Terminal']);
});

// Keyed built-ins.
const KEYED = [
  { key: 'alpha', id: 'alpha', label: 'Alpha', args: ['alpha'] },
  { key: 'pinned', id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'C:\\Work' },
  { key: 'beta', id: 'beta', label: 'Beta' },
  { key: 'gamma', id: 'beta', label: 'Gamma', under: 'beta', cwd: 'C:\\d' },
  { key: 'terminal', id: 'shell', label: 'Terminal' },
];

test('key match -> override in place, whatever the entry says about id/under/label', () => {
  // Rust serializes a missing id as "" and absent fields as null: neither is "given".
  const out = overlayAgents(KEYED, [{ key: 'pinned', id: '', label: null, cwd: 'D:\\y' }]);
  assert.deepEqual(out[1], { key: 'pinned', id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'D:\\y' });
  assert.equal(out.length, KEYED.length);
});

test('key rename/move -> relabels and re-parents the keyed row, no duplicate', () => {
  const out = overlayAgents(KEYED, [{ key: 'gamma', id: 'beta', label: 'Reviewer', under: 'alpha' }]);
  assert.deepEqual(labels(out), ['Alpha', 'Pinned', 'Beta', 'Reviewer', 'Terminal']);
  assert.deepEqual(out[3], { key: 'gamma', id: 'beta', label: 'Reviewer', under: 'alpha', cwd: 'C:\\d' });
});

test('key disable -> removes the keyed row; a root key cascades to its variants', () => {
  assert.deepEqual(labels(overlayAgents(KEYED, [{ key: 'gamma', id: '', disabled: true }])), ['Alpha', 'Pinned', 'Beta', 'Terminal']);
  assert.deepEqual(labels(overlayAgents(KEYED, [{ key: 'beta', id: '', disabled: true }])), ['Alpha', 'Pinned', 'Terminal']);
});

test('unknown key -> appended with its key', () => {
  const out = overlayAgents(KEYED, [{ key: 'zed', id: 'zed', label: 'Zed' }]);
  assert.deepEqual(out.at(-1), { key: 'zed', id: 'zed', label: 'Zed' });
});

// Rules contract: depends on a real Claude row identity. The plain `claude` row is retired (its
// shadow migrates onto the Bare row, which ignores rules), so this uses a keyed row of the same shape.
const CLAUDE_KEYED = [{ key: 'claude-desk', id: 'claude', label: 'Desk', args: ['claude'] }];

test('rules on a keyed overlay lands on the built-in row and plans a prepare', () => {
  const out = overlayAgents(CLAUDE_KEYED, [{ key: 'claude-desk', id: '', rules: ['core', 'vidar-project'] }]);
  assert.deepEqual(out[0].rules, ['core', 'vidar-project']);
  assert.equal(out[0].args[0], 'claude');
  assert.deepEqual(rulesPlan(out[0]), { key: 'claude-desk', ids: ['core', 'vidar-project'], client: 'claude' });
});

test('rules on a row without a key is refused with a warning (S5); vendor and non-agent rows too', () => {
  const plan = rulesPlan({ id: 'claude', label: 'Desk', rules: ['core'] });
  assert.match(plan.warning, /^Rules not applied: .*no key/);
  assert.match(rulesPlan({ key: 'acme', id: 'acme', label: 'Acme', rules: ['core'] }).warning, /not a Claude or Codex row/);
  assert.match(rulesPlan({ key: 'terminal', id: 'shell', label: 'Terminal', rules: ['core'] }).warning, /not a Claude or Codex row/);
  assert.equal(rulesPlan({ key: 'claude', id: 'claude', rules: [] }), null);
});

test('legacy fallback: a key-less entry still matches a keyed built-in by id/under/label', () => {
  const out = overlayAgents(KEYED, [{ id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'D:\\y', key: null }]);
  assert.deepEqual(out[1], { key: 'pinned', id: 'alpha', label: 'Pinned', under: 'alpha', cwd: 'D:\\y' });
  assert.equal(out.length, KEYED.length);
  // ...and a key-less entry whose label differs is an addition, not a rename.
  assert.equal(overlayAgents(KEYED, [{ id: 'alpha', label: 'Desk', under: 'alpha', cwd: 'x' }]).length, KEYED.length + 1);
});
