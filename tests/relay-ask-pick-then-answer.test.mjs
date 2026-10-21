// Relay pick-then-answer ask (src/relay/ask-view.ts createAskForm): a choice click only selects it, Answer
// sends the picked choice and the typed comment exactly once, and nothing is sent while the tab is not ready.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": `export const findTabByFalconSessionHosted = async () => "tab-1";
      export const sessionTitle = () => "Tab One";
      export const renderedBody = () => ({ alive: () => true, promptReady: () => globalThis.__ready === true });`,
  },
});
const { createAskForm } = await import("../src/relay/ask-view.ts");

const ASK = {
  id: "0123456789abcdef", session: "s1", question: "Which database should we pick?",
  choices: ["sqlite", "postgres"], askedAtMs: 1000, sha256: "aaa",
};

function makeItem(onResolve) {
  return { id: ASK.id, kind: "ask", source: "asks", title: ASK.question, sinceMs: 1000, view: { type: "ask", ask: ASK }, resolve: onResolve };
}
const choice = (host, label) => [...host.querySelectorAll(".q-opt")].find((b) => b.dataset.label === label);
const isOn = (b) => b.classList.contains("on") && b.getAttribute("aria-checked") === "true";

test("relay ask: a choice click selects; Answer sends once with the pick and the comment", async () => {
  globalThis.__ready = true;
  const calls = [];
  let release;
  const host = document.createElement("div");
  document.body.append(host);
  const form = createAskForm(host, makeItem((v) => { calls.push(v); return new Promise((r) => { release = r; }); }));
  await dom.flush();
  host.querySelector(".relay-ask-comment").value = "fast enough";
  const b = choice(host, "postgres");
  b.click();
  await dom.flush();
  assert.deepEqual(calls, [], "a choice click sent");
  assert.equal(isOn(b), true);
  assert.equal(b.getAttribute("role"), "radio");
  const send = host.querySelector(".relay-ask-send");
  assert.equal(send.classList.contains("hidden"), false, "Answer hidden beside choices");
  assert.equal(send.disabled, false);
  send.click();
  send.disabled = false; // a second click that slips through while sending
  send.click();
  release();
  await dom.flush();
  assert.deepEqual(calls, [{ verdict: "approve", comment: "fast enough", choice: "postgres" }]);
  form.dispose();
});

test("relay ask: picking another choice moves the selection", async () => {
  globalThis.__ready = true;
  const host = document.createElement("div");
  document.body.append(host);
  const form = createAskForm(host, makeItem(async () => {}));
  await dom.flush();
  choice(host, "sqlite").click();
  choice(host, "postgres").click();
  assert.equal(isOn(choice(host, "postgres")), true);
  assert.equal(choice(host, "sqlite").classList.contains("on"), false);
  assert.equal(choice(host, "sqlite").getAttribute("aria-checked"), "false");
  form.dispose();
});

test("relay ask: Answer is disabled and sends nothing while the tab is not ready", async () => {
  globalThis.__ready = false;
  const calls = [];
  const host = document.createElement("div");
  document.body.append(host);
  const form = createAskForm(host, makeItem(async (v) => { calls.push(v); }));
  await dom.flush();
  choice(host, "sqlite").click();
  const send = host.querySelector(".relay-ask-send");
  assert.equal(send.disabled, true, "a not-ready tab left Answer live");
  send.disabled = false;
  send.click();
  await dom.flush();
  assert.deepEqual(calls, []);
  assert.equal(host.querySelector(".relay-ask-state").textContent, "Tab Not Ready");
  form.dispose();
});

test("relay ask: Answer is disabled with choices and nothing picked or typed", async () => {
  globalThis.__ready = true;
  const host = document.createElement("div");
  document.body.append(host);
  const form = createAskForm(host, makeItem(async () => {}));
  await dom.flush();
  assert.equal(host.querySelector(".relay-ask-send").disabled, true);
  form.dispose();
});
