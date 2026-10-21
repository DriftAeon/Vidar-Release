// Rendered mount contract: a body built detached, attached, then disposed before the first
// listen() IPC resolves must never spawn an agent (rendered.ts, the ensureListeners().then
// at the end of createRenderedBody) and must leave no route, root or window/document listener.
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

test("rendered mount: dispose before listeners resolve spawns nothing and leaves nothing", async () => {
  const baseline = dom.ledger.count();
  const spawned = [];
  const transport = {
    spawn: async (p) => { spawned.push(p.tabId); return { gen: 1, developerInstructions: null }; },
    send: async () => {},
    kill: async () => {},
  };
  const noop = () => {};
  const body = createRenderedBody({
    tabId: "mount-1", host: "vidar-tab", agent: "claude", cwd: "C:/x", permissionMode: "default", transport,
    model: null, effort: null, resume: null, draft: null, onAdopted: null, onResume: noop,
    onSession: noop, onDead: noop, onAlive: null, onActivity: noop,
    onCharacterStatus: noop, onCharacterActivity: noop, onCharacterCompletion: noop,
    onReplyDone: null, onToolStart: null, onToolDone: null,
  });
  assert.equal(body.el.isConnected, false, "body mounted itself into the document");
  document.body.appendChild(body.el);
  body.dispose();
  await dom.flush();
  await dom.flush();

  assert.deepEqual(spawned, [], "an agent was spawned behind a disposed body");
  assert.equal(routeOf("mount-1"), undefined, "the route outlived dispose");
  assert.equal(body.el.isConnected, false, "the root outlived dispose");
  assert.equal(dom.ledger.count(), baseline, `window/document listeners left: ${dom.ledger.types().join(", ")}`);
});
