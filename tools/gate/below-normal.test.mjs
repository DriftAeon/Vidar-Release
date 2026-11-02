// below-normal.mjs: the child and a grandchild of the wrapper report BelowNormal (10). Windows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./below-normal.mjs', import.meta.url));
const opts = { skip: process.platform !== 'win32' && 'Windows-only priority classes' };
const BELOW = 10;

test('wrapped child runs at below-normal', opts, () => {
  const r = spawnSync(process.execPath, [script, process.execPath, '-e', 'console.log(require("os").getPriority())'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Number(r.stdout.trim()), BELOW);
});

test('grandchild inherits below-normal', opts, () => {
  const inner = 'console.log(require("os").getPriority())';
  const outer = `const r=require("child_process").spawnSync(process.execPath,["-e",${JSON.stringify(inner)}],{encoding:"utf8"});process.stdout.write(r.stdout)`;
  const r = spawnSync(process.execPath, [script, process.execPath, '-e', outer], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Number(r.stdout.trim()), BELOW);
});
