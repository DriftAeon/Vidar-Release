// One Denied line (2026-10-10): no "Permission denied" notice, no "Denied: ..." in the turn footer.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": "export function getActiveSessionCwd() { return null; }",
    "panels/comments": "export function mountComments() {} export function setCommentsDocument() {} export function wrapForComments(x) { return x; }",
  },
});
globalThis.CSS ??= { escape: (s) => String(s) };
const { createRenderedBody } = await import("../src/panels/rendered.ts");
const { ClaudeAdapter } = await import("../src/agents/claude.ts");

const settle = async () => { for (let i = 0; i < 7; i++) await new Promise(setImmediate); await dom.flush(); };

test("permission_denied emits no events", () => {
  const evs = new ClaudeAdapter().feed(JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "Bash" }));
  assert.deepEqual(evs, []);
});

test("turn footer omits the denial and nothing says Permission denied", async () => {
  const noop = () => {};
  const transport = { durable: true, spawn: async () => ({ gen: 7, developerInstructions: null }), send: async () => {}, kill: async () => {} };
  const body = createRenderedBody({
    tabId: "denied-1", host: "vidar-tab", agent: "claude", cwd: "C:/x", permissionMode: "default", transport,
    model: null, effort: null, resume: null, draft: null, onAdopted: null, onResume: noop,
    onSession: noop, onActivity: noop, onDead: noop, onAlive: noop,
    onCharacterStatus: noop, onCharacterActivity: noop, onCharacterCompletion: noop,
    onReplyDone: null, onToolStart: null, onToolDone: null,
  });
  document.body.appendChild(body.el);
  await settle();
  const lines = [
    { type: "system", subtype: "permission_denied", tool_name: "Bash" },
    { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1, result: "ok", permission_denials: [{ tool_name: "Bash" }] },
  ].map((l) => ({ line: JSON.stringify(l) }));
  dom.ipc.listeners["agent-event"]({ payload: { id: "denied-1", gen: 7, batch: lines } });
  await settle();
  const text = body.el.textContent;
  assert.doesNotMatch(text, /Permission denied/);
  assert.doesNotMatch(text, /Denied: Bash/);
  assert.equal(body.el.querySelectorAll(".blk-turn").length, 0, "a clean turn with a denial draws no footer");
  body.dispose();
});
