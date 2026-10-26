// launcher/menu.ts re-reads vidar.json on open: changed agents/locations rebuild the menu (workspaces
// included), an unchanged file does not, a read error or an open flyout column keeps the current menu.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": "export function focusActive() {}",
    "onboarding/shell": "export function onboardingOpen() { return false; }",
    "launcher/hosted": "export function resetHostedProbe() {} export function setHostedClose() {}",
    "launcher/recent-cache": "export function resetRecentCache() {}",
    "launcher/workspaces": "export const workspaces = []; export function setWorkspaces(l) { globalThis.__built.push(JSON.stringify(l)); }",
    "launcher/roster": `export function setRoster() {} export function shownKey() { return ""; }
      export function shownRoots() { return []; } export function typeLabel() { return ""; }
      export function setCloseLauncher() {}`,
    "deps/state": "export function onDepsChange() {}",
    "launcher/menu-rows": `export function markFor() { return null; } export function onGatewayMarksChange() {}
      export function menuRow(parent, label) { const b = document.createElement("button"); b.textContent = label; parent.append(b); return b; }`,
  },
});
globalThis.__built = [];

document.body.innerHTML = `<nav id="leftbar"><button id="new-session"></button></nav>`;
const menu = await import("../src/launcher/menu.ts");
const { col } = await import("../src/launcher/columns.ts");

const loc = (sets) => [{ label: "Vidar", cwd: "C:\\v", sets }];
let file = { config: { agents: [], locations: loc([{ set: "vidar-recall" }]) }, error: null };
const rebuildFrom = (c) => { menu.buildTypeMenu([], c.locations ?? []); menu.noteBuilt(c); };
menu.initLauncherMenu({
  openLocations() {},
  reload: () => Promise.resolve(file),
  rebuild: rebuildFrom,
});
rebuildFrom(file.config); // the boot build
const builds = () => globalThis.__built.length;
const tick = () => new Promise((r) => setTimeout(r, 0));
const cycle = async () => { menu.openLauncher(); await tick(); menu.closeLauncher(); };

test("open: an unchanged file does not rebuild", async () => {
  const before = builds();
  await cycle();
  assert.equal(builds(), before);
});

test("open: a changed locations[].sets rebuilds the workspaces", async () => {
  file = { config: { agents: [], locations: loc([]) }, error: null };
  const before = builds();
  await cycle();
  assert.equal(builds(), before + 1);
  assert.equal(globalThis.__built.at(-1), JSON.stringify(loc([])));
  await cycle();
  assert.equal(builds(), before + 1, "the same file again is not a change");
});

test("open: a read error keeps the current menu", async () => {
  file = { config: { agents: [], locations: loc([{ set: "x" }]) }, error: "bad json" };
  const before = builds();
  await cycle();
  assert.equal(builds(), before);
});

test("open: an open flyout column defers the rebuild to the next open", async () => {
  file = { config: { agents: [], locations: loc([{ set: "y" }]) }, error: null };
  const before = builds();
  menu.openLauncher();
  col(0).classList.remove("hidden");
  await tick();
  assert.equal(builds(), before);
  menu.closeLauncher();
  await cycle();
  assert.equal(builds(), before + 1);
});
