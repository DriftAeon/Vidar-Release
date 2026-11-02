import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_IDS } from '../src/agents/id.ts';
import { AGENTS } from '../src/agents/descriptor.ts';
import { agentOfBackend, backendOfRunner, sdkAgent } from '../src/flow/runner.ts';

test('Flow backend words match Rust and exactly one descriptor row owns the SDK', () => {
  const bare = readFileSync(new URL('../src-tauri/src/flow/bare.rs', import.meta.url), 'utf8');
  const arms = [...bare.matchAll(/Agent::(Claude|Codex) => ("sdk"|agent\.as_str\(\))/g)];
  assert.equal(arms.length, AGENT_IDS.length);
  assert.deepEqual(AGENT_IDS.filter((id) => AGENTS[id].flowSdk), ['claude']);
  for (const id of AGENT_IDS) {
    const rust = arms.find((arm) => arm[1].toLowerCase() === id);
    assert.ok(rust, id);
    assert.equal(AGENTS[id].flowBackend, rust[2] === 'agent.as_str()' ? id : 'sdk');
    assert.equal(backendOfRunner(id), AGENTS[id].flowBackend);
    assert.equal(agentOfBackend(AGENTS[id].flowBackend), id);
  }
});

test('reordering AGENT_IDS keeps the SDK agent Claude', () => {
  AGENT_IDS.reverse();
  try {
    assert.equal(sdkAgent(), 'claude');
    assert.equal(agentOfBackend('sdk'), 'claude');
    assert.equal(agentOfBackend('codex'), 'codex');
    assert.equal(backendOfRunner('unknown'), null);
    assert.throws(() => agentOfBackend('unknown'), /Unknown Flow backend/);
  } finally {
    AGENT_IDS.reverse();
  }
});
