import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_IDS, PTY_ONLY_IDS } from "../src/agents/id.ts";
import { agentKind, setGatewayIds } from "../src/launcher/agent-kind.ts";

test("agent kind covers every declared agent and PTY-only id", () => {
  assert.equal(new Set([...AGENT_IDS, ...PTY_ONLY_IDS]).size, AGENT_IDS.length + PTY_ONLY_IDS.length);
  for (const id of [...AGENT_IDS, ...PTY_ONLY_IDS]) assert.equal(agentKind(id), id);
  assert.equal(agentKind(""), "shell");
  assert.equal(agentKind("grok"), "shell");
});

test("gateway art uses its declared host agent", () => {
  setGatewayIds(["acme"]);
  assert.equal(agentKind("acme"), "claude");
  setGatewayIds([]);
});
