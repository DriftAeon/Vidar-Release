// A pend or ctl-ask Relay question is also drawn in its asker's tab (rendered/tab-asks.ts): one card per
// item, gone when the item is, nothing for another tab's item, Answer resolves once with pick and comment,
// and Relay's focus event lands on the card's first choice.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
globalThis.CustomEvent = window.CustomEvent; // jsdom dispatches only its own event class
const { createTabAsks } = await import("../src/panels/rendered/tab-asks.ts");
const store = await import("../src/relay/store.ts");
const { recordFromAskInput, ASK_FOCUS_EVENT, ASK_SETTLED_EVENT } = await import("../src/asks/record.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

function item(key, askerTab, resolve = async () => {}) {
  const record = recordFromAskInput(
    { questions: [{ question: "Ship It?", options: [{ label: "Yes" }, { label: "No" }] }] },
    { key, origin: "pend", askerTab, askedAtMs: 1 },
  );
  return { id: `q:${key}`, kind: "question", source: "test", title: "Question", sinceMs: 1, askerTab, view: { type: "question", record }, resolve };
}

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const tabs = createTabAsks({ tabId: "tab-1", tabName: "Vidar Work", host, hydrating: () => false });
  return { host, tabs };
}

test("an item for this tab draws one card, removing it removes the card", () => {
  const { host, tabs } = mount();
  store.setItems("test", [item("k1", "tab-1")]);
  assert.equal(host.querySelectorAll('[data-ask-key="k1"]').length, 1);
  store.setItems("test", []);
  assert.equal(host.querySelectorAll(".blk-question").length, 0);
  tabs.dispose();
});

test("an item for another tab draws nothing", () => {
  const { host, tabs } = mount();
  store.setItems("test", [item("k2", "tab-2")]);
  assert.equal(host.querySelectorAll(".blk-question").length, 0);
  store.setItems("test", []);
  tabs.dispose();
});

test("Answer resolves once with the pick and the comment", async () => {
  const { host, tabs } = mount();
  const calls = [];
  let settled = null;
  window.addEventListener(ASK_SETTLED_EVENT, (e) => { settled = e.detail; }, { once: true });
  store.setItems("test", [item("k3", "tab-1", async (v) => { calls.push(v); })]);
  const card = host.querySelector('[data-ask-key="k3"]');
  const answer = card.querySelector(".approval-allow");
  assert.equal(answer.disabled, true);
  card.querySelector(".q-opt").click();
  const note = card.querySelector(".q-comment");
  note.value = "Soon";
  note.dispatchEvent(new window.Event("input"));
  assert.equal(answer.disabled, false);
  answer.click();
  answer.click();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verdict, "approve");
  assert.equal(calls[0].choice, "Yes");
  assert.equal(calls[0].comment, "Soon");
  assert.deepEqual(calls[0].reply, { answers: { "0:Ship It?": "Yes" }, notes: "Soon" });
  assert.equal(settled.key, "k3");
  assert.equal(settled.where, "Vidar Work");
  store.setItems("test", []);
  tabs.dispose();
});

test("a refused answer shows its message in the card", async () => {
  const { host, tabs } = mount();
  store.setItems("test", [item("k4", "tab-1", async () => { throw new Error("Already Answered"); })]);
  const card = host.querySelector('[data-ask-key="k4"]');
  card.querySelector(".q-opt").click();
  card.querySelector(".approval-allow").click();
  await tick();
  assert.equal(card.querySelector(".approval-error").textContent, "Already Answered");
  store.setItems("test", []);
  tabs.dispose();
});

test("a focus event for this tab focuses the first choice", () => {
  const { host, tabs } = mount();
  store.setItems("test", [item("k5", "tab-1")]);
  window.dispatchEvent(new window.CustomEvent(ASK_FOCUS_EVENT, { detail: { tabId: "tab-1", key: "k5" } }));
  assert.equal(document.activeElement, host.querySelector('[data-ask-key="k5"] .q-opt'));
  store.setItems("test", []);
  tabs.dispose();
});
