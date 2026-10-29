// The backend strings Flow sends (src/flow/runner.ts) must be arms of flow.rs's `flow_run_node`
// match, and the Codex default model id must be the one flow/codex.rs sends no `model` for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backendOfModel, backendOfRunner, setBackendLookup, CODEX_DEFAULT_MODEL } from '../src/flow/runner.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('every backend string maps to a flow.rs match arm', () => {
  // Dispatch is `agent_of` in flow/bare.rs: the `"sdk"` arm is the Claude sidecar, and any other
  // backend must parse to the agent a Flow adapter (`agent()` in flow/{claude,codex}.rs) speaks for.
  const bare = read('../src-tauri/src/flow/bare.rs');
  const sdk = [...bare.matchAll(/^\s*"([a-z-]+)"\s*=>\s*Some\(super::claude::agent\(\)\)/gm)].map((m) => m[1]);
  const adapter = (f, fn) => {
    const rs = read(`../src-tauri/src/flow/${f}.rs`);
    const m = rs.match(/const [A-Z_]+_MODULE: &str = "([a-z-]+)";/);
    assert.ok(m && new RegExp(`fn agent\\(\\)[^{]*\\{\\s*crate::agent_spec::parse\\([A-Z_]+_MODULE\\)`).test(rs), `${f}.rs agent()`);
    return m[1];
  };
  assert.match(bare, /agent_spec::parse\(other\)\.filter\(/, 'a non-sdk backend must be an adapted agent id');
  const arms = [...sdk, adapter('codex')];
  assert.equal(adapter('claude'), 'claude');
  assert.deepEqual(arms.sort(), ['codex', 'sdk']);
  setBackendLookup((id) => ({ 'claude-sonnet-5': 'sdk', [CODEX_DEFAULT_MODEL]: 'codex' })[id]);
  for (const model of ['claude-sonnet-5', CODEX_DEFAULT_MODEL, 'unknown-model', undefined]) {
    assert.ok(arms.includes(backendOfModel(model)), `${model} -> ${backendOfModel(model)}`);
  }
  for (const runner of ['claude', 'codex']) assert.ok(arms.includes(backendOfRunner(runner)));
});

test('the model picks the backend; an unknown model runs on the sidecar', () => {
  setBackendLookup((id) => (id === CODEX_DEFAULT_MODEL ? 'codex' : id === 'gpt-x' ? 'codex' : 'sdk'));
  assert.equal(backendOfModel(CODEX_DEFAULT_MODEL), 'codex');
  assert.equal(backendOfModel('gpt-x'), 'codex');
  assert.equal(backendOfModel('claude-opus-5-5'), 'sdk');
  setBackendLookup(() => undefined);
  assert.equal(backendOfModel('anything'), 'sdk');
  assert.equal(backendOfModel(undefined), 'sdk');
});

test('the Codex default id and the retired backend', () => {
  assert.equal(CODEX_DEFAULT_MODEL, 'codex-default');
  assert.match(read('../src-tauri/src/flow/codex.rs'), /DEFAULT_MODEL: &str = "codex-default"/);
  assert.equal(backendOfRunner('codex-sdk'), null);
  assert.equal(backendOfRunner('claude-p'), null);
});

test('validation follows the live model source', async () => {
  const { setLiveModelIds, validateGraph } = await import('../src/flow/validate.ts');
  const agent = (model) => ({ id: 'a', kind: 'agent', title: 'A', x: 0, y: 0, model,
    fields: [{ k: 'task', v: 't' }], fieldSpecs: [{ k: 'task', required: true, kind: 'text' }], inputs: ['in'], outputs: ['out'] });
  const msgs = (model) => validateGraph({ id: 'g', name: 'g', nodes: [agent(model)], edges: [], updatedAt: 'x' })
    .issues?.filter((i) => i.nodeId === 'a').map((i) => i.message) ?? [];
  try {
    assert.equal(msgs(CODEX_DEFAULT_MODEL).filter((m) => /not available/.test(m)).length, 0);
    setLiveModelIds(() => [CODEX_DEFAULT_MODEL]);
    assert.equal(msgs(CODEX_DEFAULT_MODEL).filter((m) => /not available/.test(m)).length, 0);
    assert.equal(msgs('claude-sonnet-5').filter((m) => /not available/.test(m)).length, 1);
  } finally {
    setLiveModelIds(null);
  }
});
