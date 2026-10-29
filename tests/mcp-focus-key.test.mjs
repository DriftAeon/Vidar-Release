import test from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: { "launcher/agent-kind": `export const isGateway = () => false;` } });
// MCP_FOCUS_MODULE lets the pre-change file be pinned too (a scratch copy of the master version).
const mod = await import(process.env.MCP_FOCUS_MODULE ?? "../src/panels/mcp-focus.ts");

test("mcpFocusKey bytes for a Claude focus and a Codex focus stay fixed", () => {
  const claude = { id: "t1", agent: "claude", art: "code", cwd: "C:/Work/A" };
  assert.equal(mod.mcpFocusKey(mod.mcpFocus(claude)), '["claude","C:/Work/A",null,null,null]');
  const claudeBare = { ...claude, profile: "p", rowKey: "r" };
  assert.equal(mod.mcpFocusKey(mod.mcpFocus(claudeBare)), '["claude","C:/Work/A","p","t1","r"]');
  const codex = { id: "t2", agent: "codex", art: "codex", cwd: "C:/Work/A", profile: "p", rowKey: "r" };
  assert.equal(mod.mcpFocusKey(mod.mcpFocus(codex)), '["codex","t2","p","r"]');
  assert.equal(mod.mcpFocusKey(mod.mcpFocus({ id: "t3", agent: "codex", art: "codex" })), '["codex","t3",null,null]');
  assert.equal(mod.mcpFocusKey(mod.mcpFocus(null)), '["claude",null,null,null,null]');
});
