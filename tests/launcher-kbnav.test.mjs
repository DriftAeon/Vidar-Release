// Launcher keyboard mode (kbNav) after a keyboard walk: a real pointer move in a flyout column ends
// it, as one over the root menu does, so hover opens work again without crossing the root menu;
// a synthetic move at the resting spot does not; the launcher's close ends it too.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: {
  "onboarding/shell": "export function onboardingOpen() { return false; }",
} });
const kb = await import("../src/launcher/keyboard.ts");
const { col, hoverOpen, hideColsFrom, setColumnRoot } = await import("../src/launcher/columns.ts");

const menu = document.createElement("div");
document.body.append(menu);
setColumnRoot(menu);
kb.initLauncherKeyboard({ launcherMenu: menu, launcherSub: col(0), launcherCols: [], col, openLauncher() {} });
const move = (el, x, y) => el.dispatchEvent(new window.MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
const enter = (row) => row.dispatchEvent(new window.Event("mouseenter"));

test("a real pointer move in a flyout column ends keyboard mode and hover opens again", () => {
  kb.openLauncherByKeyboard();
  assert.equal(kb.kbNav, true);
  const c = col(1);
  const row = c.appendChild(document.createElement("button"));
  hideColsFrom(2);
  let calls = 0;
  hoverOpen(row, 2, () => { calls++; });
  move(c, 10, 10);
  move(c, 10, 10);
  assert.equal(kb.kbNav, true, "a synthetic move at the resting spot keeps keyboard mode");
  enter(row);
  assert.equal(calls, 0, "hover is gated while in keyboard mode");
  move(c, 14, 12);
  assert.equal(kb.kbNav, false, "a move to a new spot in the column ends it");
  enter(row);
  assert.equal(calls, 1, "hover opens again");
});

test("endKbNav (the launcher's close) leaves keyboard mode", () => {
  kb.openLauncherByKeyboard();
  assert.equal(kb.kbNav, true);
  kb.endKbNav();
  assert.equal(kb.kbNav, false);
});
