// Stop with a card open denies it first (A7): an interrupt that lands while the agent waits on a
// permission makes the SDK throw, so stopAgent (shutdown, Close Session, /clear) and the composer's
// interrupt (Steer) settle every open card as deny, as Esc does, before the interrupt goes out.
import test, { mock } from "node:test";
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

const settle = async () => { for (let i = 0; i < 7; i++) await new Promise(setImmediate); await dom.flush(); };

/** A body whose transport records every line it delivers; an interrupt ends the turn at once.
 *  `denyDelay` ms holds a permission response before it is delivered (Infinity: never). */
async function mount(tabId, gen, durable = false, denyDelay = 0) {
  const sent = [];
  const feed = (...msgs) => dom.ipc.listeners["agent-event"]({ payload: { id: tabId, gen, batch: msgs.map((m) => ({ line: JSON.stringify(m) })) } });
  const transport = {
    durable,
    spawn: async () => ({ gen, developerInstructions: null }),
    send: async (_id, _gen, line) => {
      const m = JSON.parse(line);
      if (m.type === "permission_response" && denyDelay) await new Promise((r) => { if (denyDelay !== Infinity) setTimeout(r, denyDelay); });
      sent.push(m);
      if (m.type === "interrupt") setImmediate(() => feed({ type: "result", subtype: "error_during_execution", is_error: true, result: "" }));
    },
    kill: async () => { sent.push({ type: "kill" }); },
  };
  const noop = () => {};
  const body = createRenderedBody({
    tabId, host: "vidar-tab", agent: "claude", cwd: "C:/x", permissionMode: "default", transport,
    model: null, effort: null, resume: null, draft: null, onAdopted: null, onResume: noop,
    onSession: noop, onActivity: noop, onDead: noop, onAlive: noop,
    onCharacterStatus: noop, onCharacterActivity: noop, onCharacterCompletion: noop,
    onReplyDone: null, onToolStart: null, onToolDone: null,
  });
  document.body.appendChild(body.el);
  await settle();
  return { body, sent, feed };
}

const TURN = { type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } };
const CARD = { type: "permission_request", id: "perm-1", toolUseId: null, tool: "Bash", input: { command: "ls" }, inputBytes: 16, suggestions: [] };
const kinds = (sent) => sent.map((m) => (m.type === "permission_response" ? `${m.type}:${m.behavior}` : m.type));

test("shutdown with a card open sends the deny before the interrupt", async () => {
  const { body, sent, feed } = await mount("stop-deny-1", 11);
  feed(TURN, CARD);
  await settle();
  await body.shutdown();
  assert.deepEqual(kinds(sent), ["permission_response:deny", "interrupt", "kill"]);
  assert.equal(sent[0].id, "perm-1");
  body.dispose();
});

test("a hosted shutdown awaits the deny before the interrupt goes out", async () => {
  const { body, sent, feed } = await mount("stop-deny-2", 12, true, 50);
  feed(TURN, CARD);
  await settle();
  await body.shutdown();
  assert.deepEqual(kinds(sent), ["permission_response:deny", "interrupt", "kill"]);
  body.dispose();
});

test("a hosted deny that never lands does not hold the stop past its short wait", async () => {
  const { body, sent, feed } = await mount("stop-deny-5", 15, true, Infinity);
  feed(TURN, CARD);
  await settle();
  // the stop holds for the short wait (DENY_WAIT_MS, 2 s) and no longer: fake the clock past it
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const stopped = body.shutdown();
    for (let i = 0; i < 7; i++) await new Promise(setImmediate);
    mock.timers.tick(2000);
    await stopped;
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(kinds(sent), ["interrupt", "kill"]);
  body.dispose();
});

test("Steer with a card open denies it before the interrupt", async () => {
  const { body, sent, feed } = await mount("stop-deny-3", 13);
  feed(TURN, CARD);
  await settle();
  assert.equal(await body.write("next one\r"), true);
  await settle();
  const steer = body.el.querySelector(".queued-send");
  assert.ok(steer, "the mid-turn message was not queued");
  steer.click();
  await settle();
  assert.deepEqual(kinds(sent).slice(0, 2), ["permission_response:deny", "interrupt"]);
  body.dispose();
});

// C2: a hosted deny that never lands caps the Steer/Stop interrupt at the same short wait, and a
// repeat press meanwhile does not send the interrupt with the card still open.
test("a hosted Steer whose deny hangs: a repeat press waits, the interrupt goes out once after the cap", async () => {
  const { body, sent, feed } = await mount("stop-deny-6", 16, true, Infinity);
  feed(TURN, CARD);
  await settle();
  // setTimeout is faked from here: settle() flushes through a timer, so this stretch spins on setImmediate
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const spin = async () => { for (let i = 0; i < 7; i++) await new Promise(setImmediate); };
    // host-queued prompts (no steer op on this transport: Steer falls back to the interrupt)
    const steerOne = async (prompt) => {
      dom.ipc.listeners["agent-event"]({ payload: { id: "stop-deny-6", gen: 16, batch: [{ hostRecord: { body: { record: "prompt-queued", prompt, content: prompt } } }] } });
      await spin();
      const steer = [...body.el.querySelectorAll(".queued-send")].pop();
      assert.ok(steer, "the mid-turn message was not queued");
      steer.click();
      await spin();
    };
    await steerOne("first");
    await steerOne("second");
    assert.deepEqual(kinds(sent).filter((k) => k === "interrupt"), [], "an interrupt went out with the card open");
    mock.timers.tick(2300);
    await spin();
    assert.deepEqual(kinds(sent).filter((k) => k === "interrupt"), ["interrupt"]);
  } finally {
    mock.timers.reset();
  }
  body.dispose();
});

test("shutdown with no card open interrupts as before", async () => {
  const { body, sent, feed } = await mount("stop-deny-4", 14);
  feed(TURN);
  await settle();
  await body.shutdown();
  assert.deepEqual(kinds(sent), ["interrupt", "kill"]);
  body.dispose();
});
