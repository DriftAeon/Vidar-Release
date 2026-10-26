// Jettison from the tab menu (sessions/hosted.ts jettisonFromMenu): a failed falcon_show rolls the
// tab back onto the same session and the reason reaches the sessions toast; an early return (a tab
// that is not hosted) reaches it too. Same resolve-hook harness as tab-strip-press.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  ipc: "export function invoke(cmd, args) { return globalThis.__jt.invoke(cmd, args); }",
  "panels/sessions/tab-strip": "export function openTabMenu(id) { globalThis.__jt.menus.push(id); }",
  "panels/sessions/rendered-body": `export function attachRenderedBody(s, sid, draft) { globalThis.__jt.attached.push({ id: s.id, sid, draft }); }
    export function detachRenderedBody(s) { globalThis.__jt.detached.push(s.id); }
    export function retireRenderedBody() {}`,
  "panels/sessions/hosted-close": "export function hostedCloseDecision() { return 'keep'; }",
  "panels/sessions/close-flow": "export function closeInBackground() { return Promise.resolve(); }",
  "panels/sessions/close-notice": "export function reportCloseFailure() {}",
  "panels/sessions/zoom": "export function showSessionsToast(message, ms) { globalThis.__jt.toasts.push({ message, ms }); }",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const url = new URL(specifier, context.parentURL);
      const key = url.href.slice(SRC.length).replace(/\.ts$/, "");
      if (Object.hasOwn(STUBS, key)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const jt = { calls: [], menus: [], attached: [], detached: [], toasts: [], invoke: async () => null };
globalThis.__jt = jt;
const hosted = await import("../src/panels/sessions/hosted.ts");

const sessions = new Map();
const removed = [];
hosted.bindHosted({ sessions, removeSessionView: (id) => removed.push(id) });

function hostedTab(id, isHosted = true) {
  const body = {
    hosted: () => isHosted,
    draft: () => "half a prompt",
    detach: async () => { jt.calls.push("detach"); },
    sessionId: () => "claude-sid",
    dispose() {},
  };
  const s = { id, button: {}, falconSession: "falcon-1", rendered: body, container: { dataset: {} } };
  sessions.set(id, s);
  return s;
}

function reset() {
  for (const k of ["calls", "menus", "attached", "detached", "toasts"]) jt[k].length = 0;
  removed.length = 0;
  sessions.clear();
}

test("a failed falcon_show rolls back onto the same session and toasts the reason", async () => {
  reset();
  const s = hostedTab("t1");
  jt.invoke = async (cmd) => {
    jt.calls.push(cmd);
    if (cmd === "falcon_show") throw new Error("activation pipe timed out");
    return null;
  };
  const result = await hosted.jettisonFromMenu("t1");
  assert.equal(result.ok, false);
  assert.match(result.reason, /activation pipe timed out/);
  assert.deepEqual(jt.calls, ["detach", "falcon_handoff_write", "falcon_show", "falcon_handoff_clear"]);
  assert.deepEqual(jt.attached, [{ id: "t1", sid: "claude-sid", draft: "half a prompt" }], "re-attached");
  assert.equal(s.falconSession, "falcon-1");
  assert.deepEqual(removed, [], "the tab stays");
  assert.equal(jt.toasts.length, 1);
  assert.match(jt.toasts[0].message, /^Jettison Failed — .*activation pipe timed out/);
  assert.equal(jt.toasts[0].ms, 4000);
});

test("a tab that is not hosted reaches the toast with its reason", async () => {
  reset();
  hostedTab("t2", false);
  jt.invoke = async (cmd) => { jt.calls.push(cmd); return null; };
  const result = await hosted.jettisonFromMenu("t2");
  assert.equal(result.ok, false);
  assert.deepEqual(jt.calls, [], "nothing was called");
  assert.equal(jt.toasts.length, 1);
  assert.equal(jt.toasts[0].message, "Jettison Failed — tab is not a hosted Rendered Claude tab");
});

test("a successful jettison shows no toast", async () => {
  reset();
  hostedTab("t3");
  jt.invoke = async (cmd) => { jt.calls.push(cmd); return null; };
  const result = await hosted.jettisonFromMenu("t3");
  assert.equal(result.ok, true);
  assert.deepEqual(removed, ["t3"]);
  assert.equal(jt.toasts.length, 0);
});
