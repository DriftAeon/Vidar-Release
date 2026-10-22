// Relay question form (src/relay/ask-view.ts createAskForm): a pick only selects it, Answer sends the
// reply (picks and note) exactly once, a pend record waits for a ready tab, a card-backed record needs
// no tab, and a record that is not inline offers Answer In Tab instead of a form.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": `export const findTabByFalconSessionHosted = async () => "tab-1";
      export const sessionTitle = () => "Tab One";
      export const renderedBody = () => ({ alive: () => true, promptReady: () => globalThis.__ready === true });
      export const activate = (id) => { (globalThis.__activated ??= []).push(id); };`,
  },
});
const { createAskForm } = await import("../src/relay/ask-view.ts");
const { recordFromAskInput } = await import("../src/asks/record.ts");

const ASK = {
  id: "0123456789abcdef", session: "s1", question: "Which database should we pick?",
  choices: ["sqlite", "postgres"], askedAtMs: 1000, sha256: "aaa",
};
const PEND_ID = "0:Which database should we pick?";

function pendItem(onResolve) {
  const record = recordFromAskInput({ questions: [{ question: ASK.question, options: ASK.choices.map((label) => ({ label })) }] },
    { key: ASK.id, origin: "pend", askerTab: "tab-1", askerSession: "s1", askedAtMs: 1000 });
  return { id: ASK.id, kind: "question", source: "asks", title: ASK.question, sinceMs: 1000, view: { type: "question", record, pend: ASK }, askerTab: "tab-1", resolve: onResolve };
}

const MULTI = {
  questions: [
    { question: "Pick colors", options: [{ label: "red" }, { label: "blue" }], multiSelect: true },
    { question: "Pick size", options: [{ label: "S" }, { label: "L" }] },
  ],
};
function cardItem(onResolve, input = MULTI, base = {}) {
  const record = recordFromAskInput(input, { key: "k1", origin: "claude", askerTab: "tab-9", askedAtMs: 1000, ...base });
  return { id: "k1", kind: "question", source: "tab", title: "Pick colors", sinceMs: 1000, view: { type: "question", record }, askerTab: "tab-9", resolve: onResolve };
}

const choice = (host, label) => [...host.querySelectorAll(".q-opt")].find((b) => b.dataset.label === label);
const isOn = (b) => b.classList.contains("on") && b.getAttribute("aria-checked") === "true";
const mount = () => { const host = document.createElement("div"); document.body.append(host); return host; };

test("relay question: a pick selects; Answer sends once with the pick and the note", async () => {
  globalThis.__ready = true;
  const calls = [];
  let release;
  const host = mount();
  const form = createAskForm(host, pendItem((v) => { calls.push(v); return new Promise((r) => { release = r; }); }));
  await dom.flush();
  host.querySelector(".relay-ask-comment").value = "fast enough";
  const b = choice(host, "postgres");
  b.click();
  await dom.flush();
  assert.deepEqual(calls, [], "a pick sent");
  assert.equal(isOn(b), true);
  assert.equal(b.getAttribute("role"), "radio");
  const send = host.querySelector(".relay-ask-send");
  assert.equal(send.classList.contains("hidden"), false);
  assert.equal(send.disabled, false);
  send.click();
  send.disabled = false; // a second click that slips through while sending
  send.click();
  release();
  await dom.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reply, { answers: { [PEND_ID]: "postgres" }, notes: "fast enough" });
  assert.equal(calls[0].verdict, "approve");
  form.dispose();
});

test("relay question: picking another choice moves the selection", async () => {
  globalThis.__ready = true;
  const host = mount();
  const form = createAskForm(host, pendItem(async () => {}));
  await dom.flush();
  choice(host, "sqlite").click();
  choice(host, "postgres").click();
  assert.equal(isOn(choice(host, "postgres")), true);
  assert.equal(choice(host, "sqlite").classList.contains("on"), false);
  form.dispose();
});

test("relay question: a pend record's Answer is disabled while the tab is not ready", async () => {
  globalThis.__ready = false;
  const calls = [];
  const host = mount();
  const form = createAskForm(host, pendItem(async (v) => { calls.push(v); }));
  await dom.flush();
  choice(host, "sqlite").click();
  const send = host.querySelector(".relay-ask-send");
  assert.equal(send.disabled, true);
  send.disabled = false;
  send.click();
  await dom.flush();
  assert.deepEqual(calls, []);
  assert.equal(host.querySelector(".relay-ask-state").textContent, "Tab Not Ready");
  form.dispose();
});

test("relay question: Answer is disabled with nothing picked or typed", async () => {
  globalThis.__ready = true;
  const host = mount();
  const form = createAskForm(host, pendItem(async () => {}));
  await dom.flush();
  assert.equal(host.querySelector(".relay-ask-send").disabled, true);
  form.dispose();
});

test("relay question: a card-backed record resolves with the AskReply, no tab needed", async () => {
  globalThis.__ready = false;
  const calls = [];
  const host = mount();
  const form = createAskForm(host, cardItem(async (v) => { calls.push(v); }));
  await dom.flush();
  assert.equal(host.querySelector(".relay-ask-comment"), null, "a card-backed record has no note");
  const send = host.querySelector(".relay-ask-send");
  choice(host, "red").click();
  choice(host, "blue").click();
  assert.equal(send.disabled, true, "one of two questions answered");
  choice(host, "L").click();
  assert.equal(send.disabled, false);
  send.click();
  await dom.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reply, { answers: { "0:Pick colors": "red, blue", "1:Pick size": "L" }, notes: "" });
  assert.equal(host.querySelector(".relay-ask-state").textContent, "");
  form.dispose();
});

test("relay question: a refused resolve shows its message on the state line", async () => {
  const host = mount();
  const form = createAskForm(host, cardItem(async () => { throw new Error("Already Answered"); }));
  await dom.flush();
  choice(host, "red").click();
  choice(host, "S").click();
  host.querySelector(".relay-ask-send").click();
  await dom.flush();
  assert.equal(host.querySelector(".relay-ask-state").textContent, "Already Answered");
  form.dispose();
});

test("relay question: dismiss null hides Dismiss; a settle record shows it", async () => {
  const hostA = mount();
  const a = createAskForm(hostA, cardItem(async () => {}, MULTI, { dismiss: null }));
  assert.equal(hostA.querySelector(".relay-ask-dismiss"), null);
  a.dispose();
  const hostB = mount();
  const b = createAskForm(hostB, pendItem(async () => {}));
  assert.ok(hostB.querySelector(".relay-ask-dismiss"));
  b.dispose();
});

test("relay question: inline false shows the text and Answer In Tab, no form", async () => {
  globalThis.__activated = [];
  const host = mount();
  const form = createAskForm(host, cardItem(async () => {}, { questions: [{ id: "q1", question: "Token?", isSecret: true }] }, { origin: "codex" }));
  await dom.flush();
  assert.equal(host.querySelector(".q-opt"), null);
  assert.equal(host.querySelector("input"), null);
  assert.equal(host.querySelector(".relay-ask-send"), null);
  assert.equal(host.querySelector(".q-text").textContent, "Token?");
  host.querySelector(".relay-ask-tab").click();
  await dom.flush();
  assert.deepEqual(globalThis.__activated, ["tab-9"]);
  form.dispose();
});
