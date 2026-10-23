import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const { window } = setupDom({ answers: { swap_pending: { build: false, swap: false }, swap_state: null } });
const { initSwap } = await import("../src/panels/swap.ts");

function mount() {
  document.body.replaceChildren();
  const bar = Object.assign(document.createElement("div"), { id: "bottombar" });
  const status = Object.assign(document.createElement("div"), { id: "swap-status" });
  const btn = document.createElement("button");
  bar.append(btn);
  document.body.append(bar, status);
  const ac = new window.AbortController(); // jsdom rejects Node's AbortSignal
  initSwap(btn, ac.signal);
  return { btn, ac };
}
const rightClick = (btn) => btn.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

test("swap menu: a second right click on the button closes it and does not reopen", () => {
  const { btn, ac } = mount();
  rightClick(btn);
  assert.ok(document.getElementById("swap-menu"));
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  // the anchor's own mousedown is exempt from the outside close, so only the toggle closes it
  btn.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  assert.ok(document.getElementById("swap-menu"));
  rightClick(btn);
  assert.equal(document.getElementById("swap-menu"), null);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  ac.abort();
});

test("swap menu: an outside mousedown closes it; Escape closes and refocuses the button", () => {
  const { btn, ac } = mount();
  rightClick(btn);
  document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(document.getElementById("swap-menu"), null);
  rightClick(btn);
  assert.ok(document.getElementById("swap-menu"));
  document.getElementById("swap-menu").querySelector("button").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(document.getElementById("swap-menu"), null);
  assert.equal(document.activeElement, btn);
  ac.abort();
});
