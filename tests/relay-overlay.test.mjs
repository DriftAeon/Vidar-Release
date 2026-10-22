// Relay ask overlay and settled state (src/relay/card-ask-state.ts via card.ts, stack.ts): the scrim shows for a
// visible Rendered asker, a scrim click lifts it for that item, the action focuses the tab and fires
// vidar-ask-focus, and a settled event shows Answered In <where> before the card leaves.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": `export const sessionTitle = (id) => ({ "tab-1": "Arc Coyote", "tab-2": "Iron Wren", "tab-3": "Plain Shell" })[id] ?? null;
      export const renderedBody = (id) => (id === "tab-3" ? null : {});
      export const activate = (id) => { (globalThis.__activated ??= []).push(id); };`,
  },
});
const { createRelayCard } = await import("../src/relay/card.ts");
const { mountRelayStack, paintRelayStack } = await import("../src/relay/stack.ts");
const { setShown } = await import("../src/panels/sessions/shown.ts");
const { recordFromAskInput } = await import("../src/asks/record.ts");

let visible = true;
const hooks = { openLarge() {}, onVisible() {}, relayVisible: () => visible };

function item(key, tab) {
  const record = recordFromAskInput({ questions: [{ question: "Which tray layout should ship?", options: [{ label: "Compact Rows" }, { label: "Wide Cards" }] }] },
    { key, origin: "claude", askerTab: tab, askedAtMs: 1000 });
  return { id: key, kind: "question", source: "tab", title: "Which tray layout should ship?", sinceMs: 1000, view: { type: "question", record }, askerTab: tab, resolve: async () => {} };
}
async function mountCard(it) {
  const card = createRelayCard(it, hooks);
  document.body.append(card.el);
  await dom.flush();
  card.update(it, false);
  await dom.flush();
  return card;
}
const scrim = (card) => card.el.querySelector(".relay-ask-scrim");

test("overlay: shows for a visible Rendered asker with the tab name", async () => {
  visible = true;
  setShown(["tab-1"], true);
  const card = await mountCard(item("k-show", "tab-1"));
  assert.ok(scrim(card), "no scrim");
  assert.equal(card.el.querySelector(".relay-ask-go").textContent, "Answer in Arc Coyote");
  card.dispose();
});

test("overlay: absent when the tab is hidden, a PTY tab, or Relay is not on screen; returns with the tab", async () => {
  setShown(["tab-2"], true);
  const hiddenTab = await mountCard(item("k-hid", "tab-1"));
  assert.equal(scrim(hiddenTab), null, "hidden tab");
  setShown(["tab-1", "tab-2"], true);
  assert.ok(scrim(hiddenTab), "tab came back");
  setShown(["tab-2"], true);
  assert.equal(scrim(hiddenTab), null, "tab left again");
  hiddenTab.dispose();

  setShown(["tab-3"], true);
  const pty = await mountCard(item("k-pty", "tab-3"));
  assert.equal(scrim(pty), null, "PTY tab");
  pty.dispose();

  setShown(["tab-1"], true);
  visible = false;
  const off = await mountCard(item("k-off", "tab-1"));
  assert.equal(scrim(off), null, "Relay not on screen");
  visible = true;
  off.update(item("k-off", "tab-1"), false);
  assert.ok(scrim(off), "Relay back on screen");
  off.dispose();
});

test("overlay: a scrim click lifts it for that item only, and it stays lifted", async () => {
  setShown(["tab-1", "tab-2"], true);
  const a = await mountCard(item("k-a", "tab-1"));
  const b = await mountCard(item("k-b", "tab-2"));
  scrim(a).click();
  assert.equal(scrim(a), null);
  assert.ok(scrim(b), "the other item lifted too");
  setShown(["tab-2"], true);
  setShown(["tab-1", "tab-2"], true);
  assert.equal(scrim(a), null, "returned after a click lift");
  a.dispose();
  b.dispose();
});

test("overlay: the action focuses the tab and dispatches vidar-ask-focus with the key", async () => {
  setShown(["tab-1"], true);
  globalThis.__activated = [];
  const seen = [];
  const on = (e) => seen.push(e.detail);
  window.addEventListener("vidar-ask-focus", on);
  const card = await mountCard(item("k-go", "tab-1"));
  card.el.querySelector(".relay-ask-go").click();
  await dom.flush();
  window.removeEventListener("vidar-ask-focus", on);
  assert.deepEqual(globalThis.__activated, ["tab-1"]);
  assert.deepEqual(seen, [{ tabId: "tab-1", key: "k-go" }]);
  assert.ok(scrim(card), "the action leaves the scrim for the tab's answer to settle");
  card.dispose();
});

test("settled: Answered In <where> with question over answer, then the card leaves", async () => {
  setShown(["tab-1"], true);
  visible = true;
  const host = document.createElement("div");
  document.body.append(host);
  mountRelayStack(host, hooks);
  const it = item("k-set", "tab-1");
  paintRelayStack([it], null);
  await dom.flush();
  const card = host.querySelector(".relay-card");
  assert.ok(card);
  window.dispatchEvent(new window.CustomEvent("vidar-ask-settled", { detail: { key: "k-set", where: "Arc Coyote", answer: "Compact Rows" } }));
  assert.equal(card.querySelector(".relay-card-title").textContent, "Answered in Arc Coyote");
  assert.equal(card.querySelector(".relay-done-q").textContent, "Which tray layout should ship?");
  assert.equal(card.querySelector(".relay-done-a").textContent, "Compact Rows");
  assert.equal(card.querySelector(".relay-ask-scrim"), null);
  // the store drops the item: the answered card stays, then leaves on its own timer
  paintRelayStack([], null);
  assert.equal(host.children.length, 1, "left at once");
  await new Promise((r) => setTimeout(r, 4100));
  assert.equal(host.children.length, 0, "stayed past the timer");
});

test("settled: a Relay-side answer removes the card at once; an unreported removal ends after the wait", async () => {
  setShown(["tab-1"], true);
  const host = document.createElement("div");
  document.body.append(host);
  mountRelayStack(host, hooks);
  const it = item("k-rel", "tab-1");
  paintRelayStack([it], null);
  await dom.flush();
  // not answered through the form: the card lingers, then goes without a settled event
  paintRelayStack([], null);
  assert.equal(host.children.length, 1);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(host.children.length, 0);

  // answered through Relay's own form: gone with the item
  paintRelayStack([it], null);
  await dom.flush();
  host.querySelector(".q-opt").click();
  await dom.flush();
  host.querySelector(".relay-ask-send").click();
  await dom.flush();
  paintRelayStack([], null);
  assert.equal(host.children.length, 0);
});
