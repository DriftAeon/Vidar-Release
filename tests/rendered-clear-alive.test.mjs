// /clear regression: stopAgent latches the
// route's exit during the kill, so an exit the transport fires before kill resolves (same gen)
// never reaches onExit; a kill that throws keeps the route and replays a latched exit.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": "export function getActiveSessionCwd() { return null; }",
    "panels/comments": "export function mountComments() {} export function setCommentsDocument() {} export function wrapForComments(x) { return x; }",
  },
});
const { createRenderedBody } = await import("../src/panels/rendered.ts");
const { routeOf } = await import("../src/panels/rendered/host-router.ts");

function mount(tabId, transport, calls, overrides = {}) {
  const noop = () => {};
  const body = createRenderedBody({
    tabId, host: "vidar-tab", agent: "claude", cwd: "C:/x", permissionMode: "default", transport,
    model: null, effort: null, resume: null, draft: null, onAdopted: null, onResume: noop,
    onSession: noop, onActivity: noop,
    onDead: () => calls.push("dead"), onAlive: () => calls.push("alive"),
    onCharacterStatus: noop, onCharacterActivity: noop, onCharacterCompletion: noop,
    onReplyDone: null, onToolStart: null, onToolDone: null,
    ...overrides,
  });
  document.body.appendChild(body.el);
  return body;
}
const settle = async () => { for (let i = 0; i < 5; i++) await dom.flush(); };

test("rendered /clear: an exit fired inside kill does not leave the tab dead", async () => {
  let gen = 0;
  const calls = [];
  const transport = {
    spawn: async () => ({ gen: ++gen, developerInstructions: null }),
    send: async () => {},
    kill: async (id, g) => { dom.ipc.listeners["agent-exit"]({ payload: { id, gen: g, code: 0 } }); },
  };
  const body = mount("clear-1", transport, calls);
  await settle();
  assert.deepEqual(calls, ["alive"]);

  assert.equal(await body.write("/clear\r"), true);
  await settle();
  assert.deepEqual(calls, ["alive", "alive"], "onDead fired on /clear, or the respawn never reported alive");
  assert.equal(body.alive(), true);
  assert.equal(await body.write("hello"), true, "write refused after /clear");
  body.dispose();
});

test("rendered stopAgent: a kill that throws restores the route", async () => {
  const calls = [];
  const transport = {
    spawn: async () => ({ gen: 100, developerInstructions: null }),
    send: async () => {},
    kill: async () => { throw new Error("host refused"); },
  };
  const body = mount("clear-2", transport, calls);
  await settle();
  const route = routeOf("clear-2");
  assert.ok(route);
  await assert.rejects(body.shutdown(), /host refused/);
  assert.equal(routeOf("clear-2"), route, "the route was not restored");
  assert.equal(body.alive(), true);
  assert.deepEqual(calls, ["alive"]);
  body.dispose();
});

test("rendered stopAgent: a kill that throws after the exit arrived still marks the tab dead", async () => {
  const calls = [];
  const transport = {
    spawn: async () => ({ gen: 200, developerInstructions: null }),
    send: async () => {},
    kill: async (id, g) => {
      dom.ipc.listeners["agent-exit"]({ payload: { id, gen: g, code: 0 } });
      throw new Error("request timed out");
    },
  };
  const body = mount("clear-3", transport, calls);
  await settle();
  await assert.rejects(body.shutdown(), /timed out/);
  assert.deepEqual(calls, ["alive", "dead"], "the exit latched during the kill was lost");
  assert.equal(body.alive(), false);
  body.dispose();
});

test("rendered spawn: a stale spawn failing late leaves the newer route for the same id", async () => {
  let failOld;
  const oldTransport = {
    spawn: () => new Promise((_, reject) => { failOld = reject; }),
    send: async () => {},
    kill: async () => {},
  };
  const newTransport = { spawn: async () => ({ gen: 400, developerInstructions: null }), send: async () => {}, kill: async () => {} };
  const staleCalls = [];
  const stale = mount("clear-5", oldTransport, staleCalls);
  await settle();
  const staleRoute = routeOf("clear-5");
  assert.ok(staleRoute && failOld, "the first spawn never registered its route");
  const fresh = mount("clear-5", newTransport, []);
  await settle();
  const freshRoute = routeOf("clear-5");
  assert.notEqual(freshRoute, staleRoute);
  failOld(new Error("spawn timed out"));
  await settle();
  assert.equal(routeOf("clear-5"), freshRoute, "the stale spawn's release removed the newer route");
  assert.deepEqual(staleCalls, [], "a stale spawn failure must not mark the replacement tab dead");
  stale.dispose();
  assert.equal(routeOf("clear-5"), freshRoute, "disposing an old body must retain the newer route");
  fresh.dispose();
});

test("rendered spawn: a stale success emits no adoption or model handshake on the replacement", async () => {
  let finishOld;
  const staleCalls = [], sent = [], killed = [];
  const stale = mount("late-success", {
    spawn: () => new Promise((resolve) => { finishOld = resolve; }),
    send: async (...args) => sent.push(args), kill: async (...args) => killed.push(args),
  }, staleCalls, { onAdopted: (...args) => staleCalls.push(args) });
  await settle();
  const fresh = mount("late-success", { spawn: async () => ({ gen: 602, developerInstructions: null }), send: async () => {}, kill: async () => {} }, []);
  await settle();
  const owned = routeOf("late-success");
  finishOld({ gen: 601, developerInstructions: null });
  await settle();
  assert.equal(routeOf("late-success"), owned);
  assert.deepEqual(staleCalls, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(killed, [["late-success", 601]], "cleanup is bound to the retired generation");
  stale.dispose();
  assert.equal(routeOf("late-success"), owned);
  fresh.dispose();
});

test("rendered: an exit before spawn resolves stays dead; Resume brings it back alive", async () => {
  let gen = 300;
  let exitEarly = true;
  const calls = [];
  const transport = {
    spawn: async ({ tabId }) => {
      const g = ++gen;
      if (exitEarly) dom.ipc.listeners["agent-exit"]({ payload: { id: tabId, gen: g, code: 1 } });
      return { gen: g, developerInstructions: null };
    },
    send: async () => {},
    kill: async () => {},
  };
  const body = mount("clear-4", transport, calls);
  await settle();
  assert.deepEqual(calls, ["dead"], "onAlive ran after the exit and hid the dead marker");
  assert.equal(body.alive(), false);

  exitEarly = false;
  body.el.querySelector(".rendered-resume").click();
  await settle();
  assert.deepEqual(calls, ["dead", "alive"]);
  assert.equal(body.alive(), true);
  body.dispose();
});

test("a hosted spawn completing after disposal releases only its view and keeps the session alive", async () => {
  let finish;
  const detached = [], killed = [], calls = [];
  const body = mount("disposed-hosted", {
    durable: true,
    spawn: () => new Promise((resolve) => { finish = resolve; }), send: async () => {},
    kill: async (...args) => killed.push(args), detach: async (...args) => detached.push(args),
  }, calls, { onAdopted: (...args) => calls.push(args) });
  await settle();
  body.dispose();
  finish({ gen: 701, developerInstructions: null });
  await settle();
  assert.deepEqual(detached, [["disposed-hosted", 701]]);
  assert.deepEqual(killed, []);
  assert.deepEqual(calls, []);
  assert.equal(routeOf("disposed-hosted"), undefined);
});
