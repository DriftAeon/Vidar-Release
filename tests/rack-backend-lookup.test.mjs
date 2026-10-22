// The Vidar Drive server reaches the rack as vidar_drive (Codex home) or a Claude plugin form;
// icon lookup folds all of them to vidar-drive and leaves plain names alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backendLookupName, railIcon, railServers } from '../src/panels/rack-modules.ts';

test('drive server forms map to vidar-drive', () => {
  for (const n of ['vidar_drive', 'plugin_vidar_drive', 'plugin:vidar:drive', 'Plugin_Vidar_Drive']) {
    assert.equal(backendLookupName(n), 'vidar-drive', n);
  }
});

test('plain names are unchanged', () => {
  for (const n of ['proxy', 'notion', 'my_server', 'Atlassian', 'vidar-drive']) {
    assert.equal(backendLookupName(n), n);
  }
});

test('railIcon gives the drive server the steering wheel', () => {
  assert.equal(railIcon('vidar_drive'), 'steer');
  assert.equal(railIcon('plugin_vidar_drive'), 'steer');
  assert.equal(railIcon('mystery'), 'link');
});

test('rail entry keeps the raw name and id', () => {
  const s = { name: 'vidar_drive', scope: 'codex', transport: 'stdio', target: 'node', args: [], project: null };
  const { others } = railServers([s], []);
  assert.equal(others[0].icon, 'steer');
  assert.equal(others[0].name, 'vidar_drive');
  assert.equal(others[0].id, 'rack:server:codex:vidar_drive');
});
