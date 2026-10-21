import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayAgents, attributeOverlay } from '../src/config-agents.ts';
import { setEnabled, setModel, setEffort, removeCustom, toWire } from '../src/settings/agents-edit.ts';

// src/launcher/roster.ts builtinAgents() with the plain rows off (roster.ts imports the DOM, so copied).
// OVERLAY below is a vidar.json written before the Bare rows led: config-agents.ts migrates it onto them.
const BUILTINS = [
  { key: 'claude-bare', id: 'claude', label: 'Claude', profile: 'bare', requires: ['claude'] },
  { key: 'claude-rendered-bare', id: 'claude', label: 'Rendered', under: 'claude', body: 'rendered', profile: 'bare', permissionMode: 'auto', requires: ['claude', 'node', 'falcon'] },
  { key: 'codex-bare', id: 'codex', label: 'Codex', profile: 'bare', requires: ['codex', 'node'] },
  { key: 'codex-rendered-bare', id: 'codex', label: 'Rendered', under: 'codex', body: 'rendered', profile: 'bare', requires: ['codex', 'node'] },
  { key: 'astra', id: 'codex', label: 'Astra', under: 'codex', role: 'astra', requires: ['codex'], cwd: '{vidar}\\bridge\\display', args: ['-NoExit', '-Command', 'codex -a never -s workspace-write'] },
  { key: 'gemini', id: 'gemini', label: 'Gemini', requires: ['gemini'], args: ['-NoExit', '-Command', 'gemini'] },
  { key: 'pi', id: 'pi', label: 'Pi', requires: ['pi'], args: ['-NoExit', '-Command', 'pi'] },
  { key: 'terminal', id: 'shell', label: 'Terminal' },
];

// vidar.json:8-67 as read_config returns it: every AgentCfg field present, absent ones null, no keys;
// the guard carries one unknown field (a flattened extra).
const NULLS = { id: '', label: null, shell: null, args: null, model: null, role: null, cwd: null, under: null, body: null, permissionMode: null, key: null, disabled: null };
const read = (e) => ({ ...NULLS, ...e });
const OVERLAY = [
  read({ id: 'claude', label: 'Claude', args: ['-NoExit', '-Command', 'claude'] }),
  read({ id: 'claude', label: 'Rendered', under: 'claude', body: 'rendered', permissionMode: 'auto', model: 'claude-sonnet-5', cwd: 'C:\\Work', x: { why: 'fable guard' } }),
  read({ id: 'codex', label: 'Codex', model: 'gpt-5.6-terra', args: ['-NoExit', '-Command', 'codex'] }),
  read({ id: 'codex', label: 'Rendered', under: 'codex', body: 'rendered', permissionMode: 'default', cwd: 'C:\\Work' }),
  read({ id: 'codex', label: 'Astra', under: 'codex', role: 'astra', cwd: 'C:\\Apps\\Vidar\\bridge\\display', args: ['-NoExit', '-Command', 'codex -a never -s workspace-write'] }),
  read({ id: 'codex', label: 'Astra Code', under: 'codex', role: 'astra', cwd: 'C:\\Apps\\Vidar', args: ['-NoExit', '-Command', 'codex -a never -s workspace-write'] }),
];
const G = 'claude-rendered-bare';
const row = (rows, label, under) => rows.find((a) => a.label === label && a.under === under);

test('guard regression: off then on keeps the entry (plus key), the menu, and a blank model clears', () => {
  const off = setEnabled(OVERLAY, attributeOverlay(BUILTINS, OVERLAY), BUILTINS, G, false);
  assert.equal(row(overlayAgents(BUILTINS, off), 'Rendered', 'claude'), undefined);
  const on = setEnabled(off, attributeOverlay(BUILTINS, off), BUILTINS, G, true);

  const before = toWire(OVERLAY);
  const after = toWire(on);
  assert.deepEqual(after[1], { ...before[1], key: G });
  assert.deepEqual(after[1].x, { why: 'fable guard' });
  assert.deepEqual(after.filter((_, i) => i !== 1), before.filter((_, i) => i !== 1));
  // the saved entry is now keyed (no longer migrated), so its unknown field rides onto the row too
  assert.deepEqual(overlayAgents(BUILTINS, on), overlayAgents(BUILTINS, OVERLAY).map((r) => (r.key === G ? { ...r, x: { why: 'fable guard' } } : r)));

  assert.equal(row(overlayAgents(BUILTINS, OVERLAY), 'Rendered', 'claude').model, 'claude-sonnet-5');
  const cleared = setModel(OVERLAY, attributeOverlay(BUILTINS, OVERLAY), BUILTINS, G, '');
  assert.equal(row(overlayAgents(BUILTINS, cleared), 'Rendered', 'claude').model, undefined);
});

test('setEffort round-trips: set a level, clear it, no effort null on the wire', () => {
  const set = setEffort(OVERLAY, attributeOverlay(BUILTINS, OVERLAY), BUILTINS, G, 'xhigh');
  assert.equal(row(overlayAgents(BUILTINS, set), 'Rendered', 'claude').effort, 'xhigh');
  assert.equal(toWire(set)[1].effort, 'xhigh');
  const cleared = setEffort(set, attributeOverlay(BUILTINS, set), BUILTINS, G, '');
  assert.equal(row(overlayAgents(BUILTINS, cleared), 'Rendered', 'claude').effort, undefined);
  assert.ok(!JSON.stringify(toWire(cleared)).includes('"effort"'));
});

test('toWire strips a null effort and keeps a set one', () => {
  assert.deepEqual(toWire([{ key: 'k', effort: null }]), [{ key: 'k' }]);
  assert.deepEqual(toWire([{ key: 'k', effort: 'high' }]), [{ key: 'k', effort: 'high' }]);
});

test('ordering: off with two entries hitting one built-in removes the row and appends nothing', () => {
  const overlay = [...OVERLAY, read({ id: 'gemini', label: 'Gemini' }), read({ key: 'gemini', cwd: 'C:\\Work' })];
  const hits = attributeOverlay(BUILTINS, overlay);
  assert.deepEqual(hits.slice(-2), ['gemini', 'gemini']);
  const customs = hits.filter((h) => h?.startsWith('#')).length; // Astra Code
  const rows = overlayAgents(BUILTINS, setEnabled(overlay, hits, BUILTINS, 'gemini', false));
  assert.equal(rows.length, BUILTINS.length - 1 + customs);
  assert.equal(rows.some((a) => a.id === 'gemini'), false);
});

test('removeCustom takes every entry of a keyed custom row, and spares variants another custom root hosts', () => {
  const j = OVERLAY.length;
  const overlay = [...OVERLAY, read({ key: 'user-x', id: 'shell', label: 'X' }), read({ key: 'user-x', cwd: 'C:\\Work' })];
  const hits = attributeOverlay(BUILTINS, overlay);
  assert.deepEqual(hits.slice(-2), [`#${j}`, `#${j}`]);
  assert.deepEqual(toWire(removeCustom(overlay, hits, BUILTINS, j)), toWire(OVERLAY));

  const two = [read({ id: 'local', label: 'L1' }), read({ id: 'local', label: 'L2' }), read({ id: 'local', under: 'local', label: 'Q', cwd: 'C:\\Work' })];
  const left = removeCustom(two, attributeOverlay(BUILTINS, two), BUILTINS, 0);
  assert.deepEqual(left.map((e) => e.label), ['L2', 'Q']);
});
