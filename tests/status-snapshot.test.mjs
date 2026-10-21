// Ordering claim (G4): the status poller emits on change only, so the bar asks once for a snapshot
// after it listens. A snapshot reply that arrives after a status-update event is older than it and
// must not overwrite it.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const payload = (name) => ({ session_name: name, context_window: { used_percentage: 10 } });
const tab = (name) => ({ tab: "s1", age_secs: 1, mtime_ms: Date.now(), payload: payload(name) });

async function mount(snapshot) {
  const dom = setupDom({ answers: { status_snapshot: () => snapshot.promise } });
  globalThis.CustomEvent = dom.window.CustomEvent; // node's own would be rejected by jsdom's dispatchEvent
  const { initStatus } = await import("../src/panels/status.ts");
  const compact = document.createElement("div");
  const expanded = document.createElement("div");
  document.body.append(compact, expanded);
  const ac = new dom.window.AbortController(); // jsdom listeners reject node's AbortSignal
  await initStatus(compact, expanded, ac.signal);
  document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: { id: "s1" } }));
  return { dom, compact, expanded, ac };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("a snapshot reply that lands after a status-update does not overwrite it", async () => {
  const snapshot = deferred();
  const { dom, compact, expanded, ac } = await mount(snapshot);
  try {
    assert.ok(dom.ipc.invoked.includes("status_snapshot"));
    dom.ipc.listeners["status-update"]({ payload: [tab("From Event")] });
    snapshot.resolve([tab("From Snapshot")]);
    await dom.flush();
    compact.click(); // the flyout fills when it opens
    assert.match(expanded.innerHTML, /From Event/);
    assert.doesNotMatch(expanded.innerHTML, /From Snapshot/);
  } finally {
    ac.abort();
  }
});

test("a snapshot with no event before it fills the bar", async () => {
  const snapshot = deferred();
  const { dom, compact, expanded, ac } = await mount(snapshot);
  try {
    snapshot.resolve([tab("From Snapshot")]);
    await dom.flush();
    compact.click();
    assert.match(expanded.innerHTML, /From Snapshot/);
  } finally {
    ac.abort();
  }
});
