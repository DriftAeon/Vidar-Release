// Pure parts of the tab-row feeds and paint (sessions/tab-state-format.ts): the Relay
// row's count line and ask-to-tab counting, merged with a chip through deriveRendered.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { relayCountText, countAsksByTab } from "../src/panels/sessions/tab-state-format.ts";
import { deriveRendered } from "../src/panels/sessions/tab-state.ts";
import { chipState } from "../src/panels/rendered/state-chip.ts";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ stubs: {
  "panels/sessions/tab-row-paint": "export function startTabRowPaint() {}",
} });
const { bindLookup } = await import("../src/panels/sessions/lookup.ts");
const { initTabState, feedRendered, dropTabState } = await import("../src/panels/sessions/tab-state-feeds.ts");
const { get } = await import("../src/panels/sessions/tab-state-store.ts");
const { setItems } = await import("../src/relay/store.ts");
const tabs = new Map();
bindLookup({ sessions: tabs, getActiveId: () => null });
initTabState();

const base = { hydrating: false, disconnected: false, isAlive: true, pendingApproval: null, inTurn: false, loggedOut: false, sessionId: null, costTotal: 0 };
const chip = (over = {}) => chipState({ ...base, ...over }, false, 0);

test("relay count line joins non-zero kinds with singular and plural labels", () => {
  assert.equal(relayCountText([]), "");
  assert.equal(relayCountText(["ask"]), "1 Ask");
  assert.equal(relayCountText(["display", "ask"]), "1 Ask · 1 Display");
  assert.equal(relayCountText(["doc", "doc", "ask", "ask", "display", "display", "display"]), "2 Asks · 3 Displays · 2 Docs");
});

test("asks count per tab; unresolved sessions count nowhere", () => {
  const map = { s1: "t1", s2: "t2" };
  const counts = countAsksByTab(["s1", "s1", "s2", "gone"], (s) => map[s] ?? null);
  assert.deepEqual([...counts], [["t1", 2], ["t2", 1]]);
  assert.equal(countAsksByTab([], () => "x").size, 0);
});

test("a chip merged with the tab's ask count: relay outranks ready and working", () => {
  const counts = countAsksByTab(["s1"], () => "t1");
  const d = deriveRendered(chip({ inTurn: true }), null, counts.get("t1") ?? 0);
  assert.equal(d.phase, "needs");
  assert.deepEqual(d.reason, { kind: "relay", count: 1 });
  const other = deriveRendered(chip({ inTurn: true }), null, counts.get("t2") ?? 0);
  assert.equal(other.phase, "working");
  assert.equal(other.reason, null);
});

test("a dead tab keeps its phase whatever the ask count", () => {
  assert.equal(deriveRendered(chip({ isAlive: false }), null, 2).phase, "dead");
});

const ask = (session) => ({
  id: session, kind: "ask", source: "test", title: "Question", sinceMs: 1,
  view: { type: "ask", ask: { session } },
});
const hostedTab = () => ({ rendered: { hosted: () => true, sessionId: () => "claude-1" } });

// shared module state (tabs, Relay items, cached mappings) resets per test so one failure cannot cascade
afterEach(async () => {
  for (const id of [...tabs.keys()]) {
    tabs.delete(id);
    dropTabState(id);
  }
  setItems("test", []);
  await dom.flush();
  dom.ipc.answers = {};
  dom.ipc.invoked.length = 0;
});

test("one Relay pass looks each hosted tab up once, however many sessions are unattributed", async () => {
  dom.ipc.answers.falcon_hosted_session = ({ id }) => `falcon-${id}`;
  tabs.set("a", hostedTab());
  tabs.set("b", hostedTab());
  feedRendered("a", chip(), null, false);
  feedRendered("b", chip(), null, false);
  await dom.flush();
  dom.ipc.invoked.length = 0;
  setItems("test", [ask("falcon-a"), ask("unknown-1"), ask("unknown-2"), ask("unknown-3")]);
  await dom.flush();
  assert.equal(dom.ipc.invoked.filter((c) => c === "falcon_hosted_session").length, 2);
  assert.deepEqual(get("a").reason, { kind: "relay", count: 1 });
});

test("late Relay lookup after close leaves no state or cached mapping", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  dom.ipc.answers.falcon_hosted_session = () => pending;
  tabs.set("closed", hostedTab());
  feedRendered("closed", chip(), null, false);
  setItems("test", [ask("falcon-1")]);
  tabs.delete("closed");
  dropTabState("closed");
  resolve("falcon-1");
  await dom.flush();
  assert.equal(get("closed"), null);

  // Resolving the same Falcon session to a surviving tab detects a stale cache entry.
  dom.ipc.answers.falcon_hosted_session = () => "falcon-1";
  tabs.set("replacement", { ...hostedTab(), falconSession: "falcon-1" });
  feedRendered("replacement", chip(), null, false);
  await dom.flush();
  assert.deepEqual(get("replacement").reason, { kind: "relay", count: 1 });
  tabs.delete("replacement");
  dropTabState("replacement");
  setItems("test", []);
  await dom.flush();
});

test("adoption refreshes a cached mapping without a new Relay snapshot", async () => {
  const adopted = hostedTab();
  adopted.falconSession = "falcon-old";
  tabs.set("adopted", adopted);
  feedRendered("adopted", chip(), null, false);
  setItems("test", [ask("falcon-old"), ask("falcon-new"), ask("falcon-new")]);
  await dom.flush();
  assert.deepEqual(get("adopted").reason, { kind: "relay", count: 1 });

  adopted.falconSession = "falcon-new";
  feedRendered("adopted", chip(), null, false);
  await dom.flush();
  assert.deepEqual(get("adopted").reason, { kind: "relay", count: 2 });
  tabs.delete("adopted");
  dropTabState("adopted");
  setItems("test", []);
  await dom.flush();
});

test("closing one tab restarts pending Relay resolution for surviving tabs", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  dom.ipc.answers.falcon_hosted_session = () => pending;
  tabs.set("survivor", hostedTab());
  tabs.set("closing", { falconSession: "falcon-closing" });
  feedRendered("survivor", chip(), null, false);
  setItems("test", [ask("falcon-survivor")]);
  tabs.delete("closing");
  dropTabState("closing");
  resolve("falcon-survivor");
  await dom.flush();
  assert.deepEqual(get("survivor").reason, { kind: "relay", count: 1 });
  tabs.delete("survivor");
  dropTabState("survivor");
  setItems("test", []);
  await dom.flush();
});
