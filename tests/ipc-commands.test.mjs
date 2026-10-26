// ipc-hosts.ts's COMMAND_HOSTS names must
// equal the `generate_handler!` lists in both Rust crates, so a command added, renamed or
// removed on one side fails here instead of at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_HOSTS } from '../src/ipc-hosts.ts';

function handlerNames(relPath) {
  const text = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
  const m = text.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(m, `no generate_handler! in ${relPath}`);
  return m[1]
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim())
    .filter(Boolean)
    .map((path) => path.split('::').pop())
    .sort();
}

function mapNames(hosts) {
  return Object.entries(COMMAND_HOSTS)
    .filter(([, h]) => hosts.includes(h))
    .map(([name]) => name)
    .sort();
}

test('Vidar commands in ipc-hosts.ts equal src-tauri/src/main.rs generate_handler!', () => {
  assert.deepEqual(mapNames(['vidar', 'both']), handlerNames('src-tauri/src/main.rs'));
});

test('the retired row-override commands are gone on both sides', () => {
  const vidar = handlerNames('src-tauri/src/main.rs');
  for (const cmd of ['rules_generate_toggle', 'bare_layer_set', 'bare_set_extend',
    'bare_actives', 'rune_set_toggle', 'bare_set_layer_write']) {
    assert.equal(cmd in COMMAND_HOSTS, false, `${cmd} still in ipc-hosts.ts`);
    assert.equal(vidar.includes(cmd), false, `${cmd} still registered`);
  }
});

test('Falcon-shell commands in ipc-hosts.ts equal src-falcon/src/main.rs generate_handler!', () => {
  assert.deepEqual(mapNames(['falcon', 'both']), handlerNames('src-falcon/src/main.rs'));
});
