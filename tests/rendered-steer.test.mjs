// Steer: a turn cut short while queued prompts wait draws no footer; the prompt it hands over
// carries the steer header, live and on a Falcon replay (result precedes prompt-dispatched).
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
const { turnSubtype } = await import("../src/panels/rendered/format.ts");
const { queuedBlock, settleQueuedBlock, markSteered, steeredTurn } = await import("../src/panels/rendered/queued-block.ts");
const { createRenderedBody } = await import("../src/panels/rendered.ts");

const settle = async () => { for (let i = 0; i < 7; i++) await new Promise(setImmediate); await dom.flush(); };

test("turnSubtype: footer copy is Title Case", () => {
  assert.equal(turnSubtype("error_during_execution", false), "Failed During Execution");
  assert.equal(turnSubtype("error_during_execution", true), "Interrupted");
  assert.equal(turnSubtype("error_max_turns", false), "Turn Limit Reached");
  assert.equal(turnSubtype("odd", false), "odd");
});

test("turnSubtype: Codex's interrupted and failed statuses read like Claude's", () => {
  assert.equal(turnSubtype("interrupted", false), "Interrupted");
  assert.equal(turnSubtype("failed", false), "Failed");
});

test("steeredTurn: a Codex interrupted turn with a queued prompt is a steer", () => {
  assert.equal(steeredTurn("interrupted", 1), true);
  assert.equal(steeredTurn("interrupted", 0), false);
  assert.equal(steeredTurn("failed", 1), false);
});

test("steeredTurn: only an execution error with a queued prompt waiting", () => {
  assert.equal(steeredTurn("error_during_execution", 1), true);
  assert.equal(steeredTurn("error_during_execution", 2), true);
  assert.equal(steeredTurn("error_during_execution", 0), false);
  assert.equal(steeredTurn("success", 1), false);
  assert.equal(steeredTurn("error_max_turns", 1), false);
});

test("queued block: the Steer button carries the wheel and the sentence tooltip", () => {
  const host = queuedBlock("go left", () => {});
  const b = host.querySelector(".queued-send");
  assert.equal(b.textContent, "Steer");
  assert.match(b.querySelector("img.icn").getAttribute("src"), /\/icons\/color\/steer\.png$/);
  assert.equal(b.title, "Stop the current turn and send this now");
});

test("queued block: a [Voice] prompt draws the mic icon for the marker and keeps the rest", () => {
  const span = queuedBlock("[Voice] go left", () => {}).querySelector(".queued-text");
  assert.match(span.querySelector("img.voice-mark").getAttribute("src"), /\/icons\/color\/mic\.svg$/);
  assert.equal(span.textContent, "go left");
});

test("queued block: a folding Steer says it adds to the running turn", () => {
  const b = queuedBlock("go left", () => {}, true).querySelector(".queued-send");
  assert.equal(b.title, "Add this to the running turn without stopping it");
});

test("markSteered: header over the message, survives settleQueuedBlock, idempotent", () => {
  const host = queuedBlock("go left", () => {});
  markSteered(host);
  markSteered(host);
  assert.equal(host.querySelectorAll(".steer-head").length, 1);
  assert.equal(host.querySelector(":scope > .steer-head").textContent, "Steer");
  assert.equal(host.querySelector(":scope > .steer-body").textContent, "go left");
  assert.equal(host.querySelector(".queued-send"), null, "the button goes: the turn is over");
  settleQueuedBlock(host);
  assert.ok(!host.classList.contains("blk-queued"));
  assert.ok(host.classList.contains("blk-steered"));
  assert.equal(host.querySelector(":scope > .steer-head").textContent, "Steer");
});

function mount(tabId) {
  const noop = () => {};
  const transport = { durable: true, spawn: async () => ({ gen: 7, developerInstructions: null }), send: async () => {}, kill: async () => {} };
  const body = createRenderedBody({
    tabId, host: "vidar-tab", agent: "claude", cwd: "C:/x", permissionMode: "default", transport,
    model: null, effort: null, resume: null, draft: null, onAdopted: null, onResume: noop,
    onSession: noop, onActivity: noop, onDead: noop, onAlive: noop,
    onCharacterStatus: noop, onCharacterActivity: noop, onCharacterCompletion: noop,
    onReplyDone: null, onToolStart: null, onToolDone: null,
  });
  document.body.appendChild(body.el);
  return body;
}
const result = (subtype) => ({ line: JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", result: "" }) });
const queued = (prompt, content) => ({ hostRecord: { record: "prompt-queued", prompt, content } });
const dispatched = (prompt) => ({ hostRecord: { record: "prompt-dispatched", prompt } });
const batch = (id, items) => dom.ipc.listeners["agent-event"]({ payload: { id, gen: 7, batch: items } });

test("replay: a steered turn draws no footer and the dispatched prompt keeps the steer header", async () => {
  const body = mount("steer-1");
  await settle();
  // journal order (src-falcon/src/serve/spawn.rs: result published, then pump records prompt-dispatched)
  batch("steer-1", [
    { hydration: "start" },
    queued("p1", "turn left here"),
    queued("p2", "and then right"),
    result("error_during_execution"),
    dispatched("p1"),
    { hydration: "end" },
  ]);
  await settle();
  const t = body.el;
  assert.equal(t.querySelector(".blk-turn"), null, "no Failed/Interrupted footer");
  const steered = t.querySelectorAll(".blk-steered");
  assert.equal(steered.length, 1, "only the prompt the host hands over is marked");
  assert.match(steered[0].textContent, /^Steerturn left here$/);
  assert.ok(!steered[0].classList.contains("blk-queued"), "promoted by prompt-dispatched");
  const waiting = t.querySelector(".blk-queued");
  assert.match(waiting.textContent, /and then right/);
  assert.equal(waiting.querySelector(".steer-head"), null);
  body.dispose();
});

test("replay: an execution error with nothing queued keeps its footer", async () => {
  const body = mount("steer-2");
  await settle();
  batch("steer-2", [{ hydration: "start" }, result("error_during_execution"), { hydration: "end" }]);
  await settle();
  assert.equal(body.el.querySelector(".blk-turn")?.firstChild?.textContent, "Failed During Execution");
  assert.equal(body.el.querySelector(".blk-steered"), null);
  body.dispose();
});

test("live: a hosted steer marks the waiting prompt and drops the footer", async () => {
  const body = mount("steer-3");
  await settle();
  batch("steer-3", [{ hydration: "start" }, { hydration: "end" }]);
  await settle();
  batch("steer-3", [queued("p9", "stop and fix the test")]);
  batch("steer-3", [result("error_during_execution")]);
  batch("steer-3", [dispatched("p9")]);
  await settle();
  assert.equal(body.el.querySelector(".blk-turn"), null);
  const s = body.el.querySelector(".blk-steered");
  assert.ok(s && !s.classList.contains("blk-queued"));
  assert.equal(s.querySelector(".steer-head").textContent, "Steer");
  body.dispose();
});
