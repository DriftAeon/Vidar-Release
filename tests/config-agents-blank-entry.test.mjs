// Regression: a vidar.json agents entry with no key and id:""
// (read_config's serialisation of a missing id) was appended as a launcher row with an empty id, and
// patch_settings refused every later Agents save with no pointer to the entry. It is now skipped
// with a warning that names the entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeOverlay, overlayAgents } from '../src/config-agents.ts';

const BUILTINS = [{ key: 'claude', id: 'claude', label: 'Claude' }];

test('overlayAgents: a key-less entry with a blank id is skipped with a warning', () => {
  const overlay = [{ id: '', label: 'Orphan', key: null }, { id: 'shell', label: 'Box' }];
  const warnings = [];
  const rows = overlayAgents(BUILTINS, overlay, warnings);
  assert.deepEqual(rows.map((r) => r.label), ['Claude', 'Box']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^vidar\.json agents entry: has no id and no key.*"label":"Orphan"/);
  assert.doesNotMatch(warnings[0], /agents\[\d/);
  assert.deepEqual(attributeOverlay(BUILTINS, overlay), [null, '#1']);
});
