import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `answer` approves tool-permission cards, so without VIDAR_DRIVE_CARDS=1 it must refuse before any
// CDP connection, exactly like `card` (an agent must not approve its own permission request).
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'drive', 'vidar-drive.mjs');

function run(args) {
  const env = { ...process.env, VIDAR_CDP_PORT: '1' };
  delete env.VIDAR_DRIVE_CARDS;
  delete env.VIDAR_DRIVE_BUDGET;
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

test('answer is refused without VIDAR_DRIVE_CARDS', () => {
  const r = run(['answer', 'tab-1', '{"decision":"allow"}']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /card answers are the user's/);
});

test('card is refused without VIDAR_DRIVE_CARDS', () => {
  const r = run(['card', 'c-1', 'approve']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /card answers are the user's/);
});

test('answer with VIDAR_DRIVE_CARDS=0 is still refused', () => {
  const env = { ...process.env, VIDAR_CDP_PORT: '1', VIDAR_DRIVE_CARDS: '0' };
  delete env.VIDAR_DRIVE_BUDGET;
  const r = spawnSync(process.execPath, [SCRIPT, 'answer', 'tab-1', '{"decision":"allow"}'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /card answers are the user's/);
});
