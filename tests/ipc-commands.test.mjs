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

test('Falcon-shell commands in ipc-hosts.ts equal src-falcon/src/main.rs generate_handler!', () => {
  assert.deepEqual(mapNames(['falcon', 'both']), handlerNames('src-falcon/src/main.rs'));
});
