// contracts/modules.json flowCoreModelIds is the one list of core Flow model ids: Rust breaks a
// pack that declares one, and src/flow/roster.ts CORE_ROSTER must show the same ids in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('CORE_ROSTER ids equal contract flowCoreModelIds in order', () => {
  const contract = JSON.parse(read('../contracts/modules.json'));
  const src = read('../src/flow/roster.ts');
  const block = /const CORE_ROSTER[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'CORE_ROSTER literal found');
  const ids = [...block[1].matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, contract.flowCoreModelIds);
});

test('primary codex puts the Codex rows first; claude or unset keeps the roster order', async () => {
  const { leadRunner } = await import('../src/flow/roster-order.ts');
  const { resolvePrimary } = await import('../src/agents/primary.ts');
  const rows = [
    { id: 'claude-sonnet-5', runner: 'sdk' },
    { id: 'claude-opus-5-5', runner: 'sdk' },
    { id: 'codex-default', runner: 'codex' },
    { id: 'codex-saved', runner: 'codex' },
  ];
  const mods = [{ id: 'claude', kind: 'agent' }, { id: 'codex', kind: 'agent' }];
  const order = (saved) => (resolvePrimary(saved, mods) === 'codex' ? leadRunner(rows, 'codex') : rows).map((r) => r.id);
  assert.deepEqual(order('codex'), ['codex-default', 'codex-saved', 'claude-sonnet-5', 'claude-opus-5-5']);
  assert.equal(order('codex')[0], 'codex-default');
  assert.deepEqual(order('claude'), rows.map((r) => r.id));
  assert.deepEqual(order(undefined), rows.map((r) => r.id));
  // roster.ts must route its core+saved rows through leadRunner on the effective primary.
  const src = read('../src/flow/roster.ts');
  assert.match(src, /effectivePrimary\(\) === "codex"\) out = leadRunner\(out, "codex"\)/);
});

test('CORE_ROSTER runners: claude models sdk, Codex Default codex', () => {
  const src = read('../src/flow/roster.ts');
  const block = /const CORE_ROSTER[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src)[1];
  const rows = [...block.matchAll(/id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*wired:\s*(true|false),\s*runner:\s*"([^"]+)"/g)];
  assert.equal(rows.length, 5);
  for (const [, id, , , runner] of rows) assert.equal(runner, id === 'codex-default' ? 'codex' : 'sdk', id);
  assert.ok(rows.some((r) => r[1] === 'codex-default' && r[2] === 'Codex Default'));
});
