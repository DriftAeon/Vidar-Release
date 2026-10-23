// launcher/menu.ts on popover.ts: the ＋ press that opens the launcher does not close it, presses in the
// menu and its flyout columns keep it open, an outside press and Escape close it (Escape hands focus
// back through focusActive), and the external closer (roster/hosted's closeLauncher) tears it down.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": "export function focusActive() { globalThis.__launcher.focused++; }",
    "onboarding/shell": "export function onboardingOpen() { return false; }",
    "launcher/hosted": "export function resetHostedProbe() {} export function setHostedClose(fn) { globalThis.__launcher.closers.push(fn); }",
    "launcher/recent-cache": "export function resetRecentCache() {}",
    "launcher/workspaces": "export const workspaces = []; export function setWorkspaces() {}",
    "launcher/roster": `export function setRoster() {} export function shownKey() { return ""; }
      export function shownRoots() { return []; } export function typeLabel() { return ""; }
      export function setCloseLauncher(fn) { globalThis.__launcher.closers.push(fn); }`,
    "deps/state": "export function onDepsChange() {}",
    "launcher/menu-rows": `export function markFor() { return null; } export function onGatewayMarksChange() {}
      export function menuRow(parent, label) { const b = document.createElement("button"); b.textContent = label; parent.append(b); return b; }`,
  },
});
globalThis.__launcher = { focused: 0, closers: [] };

document.body.innerHTML = `<nav id="leftbar"><button id="new-session"></button></nav><div id="outside"></div>`;
const menu = await import("../src/launcher/menu.ts");
const { col } = await import("../src/launcher/columns.ts");
const { closeLauncher, openLauncher } = menu;
menu.initLauncherMenu({ openLocations() {} });
const launcherMenu = menu.launcherMenu; // a live binding, set by initLauncherMenu

const down = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const press = (el) => { down(el); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const newBtn = document.getElementById("new-session");
const outside = document.getElementById("outside");
const shown = () => !launcherMenu.classList.contains("hidden");

test("launcher: the opening press keeps it open; menu and column presses keep it open; outside closes", () => {
  press(newBtn);
  assert.ok(shown(), "the ＋ press opens it and does not close it");
  const column = col(0);
  column.classList.remove("hidden");
  const row = document.createElement("button");
  column.append(row);
  press(row);
  assert.ok(shown(), "a press in a flyout column (outside the menu element) keeps it open");
  const menuRow = document.createElement("button");
  launcherMenu.append(menuRow);
  press(menuRow);
  assert.ok(shown(), "a press in the menu keeps it open");
  press(outside);
  assert.equal(shown(), false, "an outside press closes it");
  assert.ok(column.classList.contains("hidden"), "onClose tears the columns down");
  assert.ok(launcherMenu.isConnected, "persistent: hidden, not removed");
});

test("launcher: ＋ toggles it closed; Escape closes and hands focus back", () => {
  press(newBtn);
  assert.ok(shown());
  press(newBtn);
  assert.equal(shown(), false, "a second ＋ press closes it");
  press(newBtn);
  const before = globalThis.__launcher.focused;
  key(document.body, "Escape");
  assert.equal(shown(), false, "Escape closes it");
  assert.equal(globalThis.__launcher.focused, before + 1, "focusActive runs on Escape");
  key(document.body, "Escape");
  assert.equal(globalThis.__launcher.focused, before + 1, "a closed launcher no longer hears Escape");
});

test("launcher: external closers and a repeat open", () => {
  press(newBtn);
  const column = col(0);
  column.classList.remove("hidden");
  for (const close of globalThis.__launcher.closers) assert.equal(close, closeLauncher);
  globalThis.__launcher.closers[0]();
  assert.equal(shown(), false, "the stored closer closes it");
  assert.ok(column.classList.contains("hidden"));
  press(newBtn);
  column.classList.remove("hidden");
  openLauncher();
  assert.ok(shown() && !column.classList.contains("hidden"), "openLauncher while open re-places, keeps columns");
  closeLauncher();
  assert.equal(shown(), false);
  press(outside);
  assert.equal(shown(), false, "no stale listener reopens or throws");
});
