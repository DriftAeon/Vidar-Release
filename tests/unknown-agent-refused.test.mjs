// An unknown agent (a `grok` Falcon summary) is refused, never opened as Claude; Claude and Codex
// (gate on and off) behave as before. readopt.ts is pure; the falcon-shell window imports Tauri,
// so its path is pinned on the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as readopt from "../src/launcher/readopt.ts";

const sum = (agent) => ({
  session: "s-1", generation: 1, agent, cwd: "C:\\x", conversation: null, pid: 1,
  model: null, permission_mode: "default", attached: 0, exited: null,
  queued_prompts: [], pending_permissions: [], last_holder: "vidar",
});

test("a grok summary is refused and never readopted, gate on or off", () => {
  for (const gate of [false, true]) {
    readopt.setHostedCodexGate(gate);
    assert.equal(readopt.adoptRefusal({ agent: "grok" }), 'Unknown agent "grok": Vidar cannot open this session.');
    assert.equal(readopt.shouldReadopt(sum("grok")), false);
    assert.equal(readopt.shouldReadoptHeld(sum("grok"), new Set(["s-1"])), false);
  }
  readopt.setHostedCodexGate(false);
});

test("Claude and Codex are unchanged with the gate off and on", () => {
  readopt.setHostedCodexGate(false);
  assert.equal(readopt.adoptRefusal({ agent: "claude" }), null);
  assert.equal(readopt.adoptAgent({ agent: "claude" }), "claude");
  assert.match(readopt.adoptRefusal({ agent: "codex" }), /falcon\.hostedCodex/);
  assert.equal(readopt.shouldReadopt(sum("claude")), true);
  assert.equal(readopt.shouldReadopt(sum("codex")), false);
  readopt.setHostedCodexGate(true);
  assert.equal(readopt.adoptRefusal({ agent: "codex" }), null);
  assert.equal(readopt.adoptAgent({ agent: "codex" }), "codex");
  assert.equal(readopt.shouldReadopt(sum("codex")), true);
  readopt.setHostedCodexGate(false);
});

test("the falcon-shell adopt returns before opening a body for a non-AgentId", () => {
  const src = readFileSync(new URL("../src/falcon.ts", import.meta.url), "utf8");
  const adopt = src.slice(src.indexOf("async function adopt("));
  const guard = adopt.indexOf("if (!isAgentId(agent))");
  assert.ok(guard > 0, "guard present");
  assert.ok(guard < adopt.indexOf("createRenderedBody("), "guard precedes the body");
  assert.ok(guard < adopt.indexOf("detachBody()"), "guard precedes detaching the current body");
  assert.match(adopt, /adoptRefusal\(session\)/);
  assert.doesNotMatch(adopt, /session\.agent === "codex" \? "codex" : "claude"/);
});
