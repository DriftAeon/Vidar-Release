// Steer on a Falcon-hosted prompt folds it into the running turn (falcon_steer) instead of
// interrupting; a host that predates the op, or a transport without it, falls back to the
// interrupt; Esc keeps the interrupt.
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
const { steerHosted } = await import("../src/panels/rendered/composer.ts");
const { createRenderedBody } = await import("../src/panels/rendered.ts");

const settle = async () => { for (let i = 0; i < 7; i++) await new Promise(setImmediate); await dom.flush(); };
const UNSUPPORTED = "falcon host does not serve steer-prompt; it predates the 'steer' capability";

test("steerHosted: calls the steer op and never interrupts on success", async () => {
  const calls = [];
  let interrupted = 0;
  const transport = { steer: async (...a) => { calls.push(a); } };
  await steerHosted(transport, "t1", 7, "p1", () => interrupted++, () => assert.fail("no error"));
  assert.deepEqual(calls, [["t1", 7, "p1"]]);
  assert.equal(interrupted, 0);
});

test("steerHosted: a host without the op falls back to the interrupt", async () => {
  let interrupted = 0;
  const transport = { steer: async () => { throw UNSUPPORTED; } };
  await steerHosted(transport, "t1", 7, "p1", () => interrupted++, () => assert.fail("no error"));
  assert.equal(interrupted, 1);
  await steerHosted({}, "t1", 7, "p1", () => interrupted++, () => assert.fail("no error"));
  assert.equal(interrupted, 2, "a transport with no steer interrupts too");
});

test("steerHosted: any other refusal is reported and never interrupts", async () => {
  let interrupted = 0;
  const errors = [];
  const transport = { steer: async () => { throw "prompt p1 has already been dispatched"; } };
  await steerHosted(transport, "t1", 7, "p1", () => interrupted++, (e) => errors.push(String(e)));
  assert.equal(interrupted, 0);
  assert.deepEqual(errors, ["prompt p1 has already been dispatched"]);
});

function mount(tabId, transport) {
  const noop = () => {};
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
const queued = (prompt, content) => ({ hostRecord: { record: "prompt-queued", prompt, content } });
const dispatched = (prompt) => ({ hostRecord: { record: "prompt-dispatched", prompt } });
const batch = (id, items) => dom.ipc.listeners["agent-event"]({ payload: { id, gen: 7, batch: items } });

test("hosted body: Steer calls the op, Esc still interrupts", async () => {
  const sent = [];
  const steered = [];
  const transport = {
    durable: true, spawn: async () => ({ gen: 7, developerInstructions: null }), kill: async () => {},
    send: async (_tab, _gen, line) => { sent.push(JSON.parse(line)); },
    steer: async (...a) => { steered.push(a); },
  };
  const body = mount("steer-op-1", transport);
  await settle();
  batch("steer-op-1", [{ hydration: "start" }, { hydration: "end" }]);
  batch("steer-op-1", [queued("p0", "first"), dispatched("p0"), queued("p1", "go left")]);
  await settle();
  const button = [...body.el.querySelectorAll(".blk-queued .queued-send")];
  assert.equal(button.length, 1, "one prompt still waits");
  button[0].click();
  await settle();
  assert.deepEqual(steered, [["steer-op-1", 7, "p1"]]);
  assert.ok(!sent.some((m) => m.type === "interrupt"), "the steer sent no interrupt");

  const textarea = body.el.querySelector("textarea");
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.ok(sent.some((m) => m.type === "interrupt"), "Esc interrupts");
  body.dispose();
});
