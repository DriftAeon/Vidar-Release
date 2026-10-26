// A press on the transcript while the composer is focused keeps the composer's focused look
// (`focus-held`) until the click hands focus back, so the border does not flash; controls and
// code blocks are left alone, and a click that ended a drag-select does not steal the selection.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { wireTranscriptFocus } = await import("../src/panels/rendered/transcript-focus.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

function mk() {
  const transcript = document.createElement("div");
  transcript.tabIndex = -1;
  const p = document.createElement("p");
  p.textContent = "some agent text";
  const button = document.createElement("button");
  const pre = document.createElement("pre");
  transcript.append(p, button, pre);
  const textarea = document.createElement("textarea");
  document.body.append(transcript, textarea);
  const dispose = wireTranscriptFocus(transcript, textarea);
  return { transcript, p, button, pre, textarea, dispose };
}

// the browser's default for a mousedown on a focusable ancestor: focus moves to it
function press(target, transcript) {
  const ok = target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  if (ok) (target.closest("button") ?? transcript).focus();
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

test("a press on transcript text holds the composer look and the click refocuses it", async () => {
  const t = mk();
  t.textarea.focus();
  t.p.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  t.transcript.focus(); // default action: the composer blurs
  assert.ok(t.textarea.classList.contains("focus-held"), "held while the press is down");
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  t.p.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  assert.equal(document.activeElement, t.textarea);
  await tick();
  assert.ok(!t.textarea.classList.contains("focus-held"));
  t.dispose();
  document.body.replaceChildren();
});

test("a click that ended a selection leaves the selection and drops the hold", async () => {
  const t = mk();
  t.textarea.focus();
  t.p.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  t.transcript.focus();
  const r = document.createRange();
  r.selectNodeContents(t.p);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  t.p.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  assert.equal(document.activeElement, t.transcript, "focus stays off the composer");
  assert.equal(window.getSelection().toString(), "some agent text");
  await tick();
  assert.ok(!t.textarea.classList.contains("focus-held"), "an unfocused composer must not look focused");
  window.getSelection().removeAllRanges();
  t.dispose();
  document.body.replaceChildren();
});

test("the mousedown default is never prevented, so drag-select can start", () => {
  const t = mk();
  t.textarea.focus();
  const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  t.p.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false);
  t.dispose();
  document.body.replaceChildren();
});

test("controls and code blocks keep their own click: no hold, no refocus", async () => {
  for (const key of ["button", "pre"]) {
    const t = mk();
    t.textarea.focus();
    press(t[key], t.transcript);
    assert.ok(!t.textarea.classList.contains("focus-held"), key);
    assert.notEqual(document.activeElement, t.textarea, key);
    await tick();
    t.dispose();
    document.body.replaceChildren();
  }
});

test("no hold when the composer was not focused at the press", async () => {
  const t = mk();
  t.p.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  assert.ok(!t.textarea.classList.contains("focus-held"));
  await tick();
  t.dispose();
  document.body.replaceChildren();
});
