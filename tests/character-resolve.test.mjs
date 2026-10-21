// Character packs: the tab -> character resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findClashes, resolveCharacter } from '../src/character/resolve.ts';

const pack = (id, answersTo, status = 'ok') => ({
  id, target: id, folder: id, dir: `C:\\x\\characters\\${id}`, status,
  pack: { id, name: id, model: { path: `C:\\m\\${id}.glb`, bytes: 1, sha256: 'a'.repeat(64) }, material: 'auto', answersTo },
});

test('resolution runs model, then role, then agent, then default; the earlier pack wins a clash', () => {
  const list = {
    default: 'fallback',
    packs: [
      pack('first', [{ kind: 'model', key: 'Opus' }, { kind: 'agent', key: 'codex' }]),
      pack('second', [{ kind: 'model', key: ' opus ' }, { kind: 'role', key: 'astra' }]),
      pack('broken', [{ kind: 'agent', key: 'gemini' }], 'changed'),
      pack('fallback', []),
    ],
  };
  const id = (tab) => resolveCharacter(list, tab).id;
  assert.equal(id({ model: 'OPUS', role: 'astra', agent: 'codex' }), 'first', 'model beats role; first in order wins');
  assert.equal(id({ model: 'unknown', role: 'astra', agent: 'codex' }), 'second', 'role beats agent');
  assert.equal(id({ agent: 'codex' }), 'first');
  assert.equal(id({ agent: 'claude' }), 'fallback');
  // a matched pack that changed is not skipped for the next claimant or the default
  assert.deepEqual(resolveCharacter(list, { agent: 'gemini' }), { id: 'broken', entry: list.packs[2], usable: false });
  assert.deepEqual(resolveCharacter({ packs: [], default: null }, { agent: 'claude' }), { id: null, entry: null, usable: false });
  assert.deepEqual(findClashes(list), [{ kind: 'model', key: 'opus', winner: 'first', losers: ['second'] }]);
});

test('an invalid pack whose id and claims parse keeps its claims: placeholder, no fall-through', () => {
  // Rust sends a render-invalid pack (e.g. lighting out of range) with id + answersTo, no pack;
  // an unreadable folder comes with id null and claims nothing.
  const dim = { id: 'dim', target: 'folder:dim', folder: 'dim', dir: '', status: 'invalid', reason: 'lighting.ambient must be 0 to 2',
    answersTo: [{ kind: 'agent', key: 'Gemini' }] };
  const junk = { id: null, target: 'folder:junk', folder: 'junk', dir: '', status: 'invalid', answersTo: [{ kind: 'agent', key: 'codex' }] };
  const list = { default: 'later', packs: [dim, junk, pack('later', [{ kind: 'agent', key: 'gemini' }])] };
  assert.deepEqual(resolveCharacter(list, { agent: 'gemini' }), { id: 'dim', entry: dim, usable: false });
  assert.equal(resolveCharacter(list, { agent: 'codex' }).id, 'later', 'a row with no id claims nothing');
  assert.deepEqual(findClashes(list), [{ kind: 'agent', key: 'gemini', winner: 'dim', losers: ['later'] }]);
});
