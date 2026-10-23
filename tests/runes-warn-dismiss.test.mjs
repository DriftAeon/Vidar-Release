// A Bare launch warning line has a Dismiss button; the dismissal is per tab and per text, in memory only.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const LOOKUP = `
export const getFocusedSession = () => null;
export const renderedSessionId = () => null;
export const sessionLaunchInfo = () => null;`;

setupDom({ stubs: { "panels/sessions/lookup": LOOKUP } });
const { bareTraceParts } = await import("../src/panels/runes.ts");

const W = "Codex 0.164.0 differs from the verified 0.163.0; launching anyway";
const launch = { warnings: [W, "Second Warning"] };
const texts = (parts) => parts.map((p) => p.querySelector(".runes-warn-text")?.textContent);

test("Dismiss hides that warning for that tab only", () => {
  const trace = document.createElement("div");
  trace.className = "runes-bare-trace";
  trace.append(...bareTraceParts(launch, null, null, "tabA"));
  assert.deepEqual(texts([...trace.children]), [W, "Second Warning"]);
  const btn = trace.children[0].querySelector("button.cx-ico");
  assert.equal(btn.title, "Dismiss");
  assert.equal(btn.getAttribute("aria-label"), "Dismiss");
  btn.click();
  assert.equal(trace.children.length, 1, "the dismissed line is removed");
  assert.deepEqual(texts(bareTraceParts(launch, null, null, "tabA")), ["Second Warning"]);
  assert.deepEqual(texts(bareTraceParts(launch, null, null, "tabB")), [W, "Second Warning"]);
  assert.deepEqual(texts(bareTraceParts({ warnings: ["Other"] }, null, null, "tabA")), ["Other"]);
});

test("Dismissing the last warning collapses the trace", () => {
  const trace = document.createElement("div");
  trace.className = "runes-bare-trace";
  trace.append(...bareTraceParts({ warnings: ["Only"] }, null, null, "tabC"));
  trace.children[0].querySelector("button").click();
  assert.equal(trace.hidden, true);
});
