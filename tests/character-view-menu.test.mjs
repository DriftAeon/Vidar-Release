// panels/character.ts view menu on popover.ts: the right-click on the canvas that opens it does not
// close it, presses on its rows' padding keep it open, an outside press and Escape close it, a row
// pick closes it, and dispose leaves no popover listener behind.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const { flush, ledger, window } = setupDom({
  stubs: {
    config: `export function invalidateConfig() {} export function onSettingsChanged() { return () => {}; }
      export function loadConfig() { return Promise.resolve({ config: { characterViews: {} } }); }`,
    prefs: "export function getPref() { return null; } export function setPref() {}",
    "character/packs": `export function characterList() { return []; } export function characterRevision() { return 0; }
      export function ensureCharacters() { return Promise.resolve(); } export function onCharactersChanged() { return () => {}; }
      export function setStyleNote() {}`,
    "character/resolve": `export function resolveCharacter() {
        return { id: "c1", usable: true, entry: { pack: { name: "C" }, status: "ok", folder: "c" } }; }`,
    "character/behavior": "export function characterLoop() { return ''; } export function reduceLowContext() { return false; }",
    "panels/sessions": "export function getFocusedSession() { return null; }",
    "panels/codex-model": "export function watchCodexModel() {}",
    "character/arena": "export function createCharacterArena() { return { render() {}, dispose() {}, setStage() {}, unavailable: false }; }",
    "character/renderer": `export async function createCharacterRenderer() {
        globalThis.__resets = 0;
        return { clips: [], styleNote: "", initialClip: "", setPlaying() {}, setLoop() {}, selectClip() {}, dispose() {},
          resetView() { globalThis.__resets++; }, captureView() { return {}; }, applyView() {}, playOnce() {} }; }`,
  },
});
// The panel creates its arena only once the host is seen: report it visible on observe.
globalThis.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() { queueMicrotask(() => this.cb([{ isIntersecting: true }])); }
  disconnect() {}
};
globalThis.AbortController = window.AbortController; // character.ts passes its signal to jsdom listeners
globalThis.Option = window.Option;

const down = (el, button = 0) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button }));
const press = (el) => { down(el); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const rightClick = (el) => {
  down(el, 2);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 40 }));
};

const sidebar = document.createElement("div");
sidebar.innerHTML = `<section><div class="character-stage"></div><div class="character-status"></div>
  <select class="character-animation"></select></section>`;
const outside = document.createElement("div");
document.body.append(sidebar, outside);
const baseline = ledger.count();
const { initCharacter } = await import("../src/panels/character.ts");
const dispose = initCharacter(sidebar.firstElementChild, () => Promise.resolve(new ArrayBuffer(0)));
for (let i = 0; i < 5; i++) await flush();
const canvas = document.createElement("canvas");
sidebar.querySelector(".character-stage").append(canvas);
const menu = () => document.getElementById("character-view-menu");
const shown = () => !!menu() && !menu().classList.contains("hidden");

test("character view menu: opening right-click keeps it open; inside keeps it; outside closes", () => {
  rightClick(canvas);
  assert.ok(shown(), "the opening right-click does not close it");
  assert.equal(menu().style.left, "30px");
  assert.equal(menu().style.top, "40px");
  down(menu());
  assert.ok(shown(), "a press inside keeps it open");
  rightClick(canvas);
  assert.ok(shown(), "a second right-click reopens it at the point");
  press(outside);
  assert.equal(shown(), false, "an outside press closes it");
  assert.ok(menu().isConnected, "persistent: hidden, not removed");
});

test("character view menu: Escape closes it; a row pick closes and runs", () => {
  rightClick(canvas);
  key(document.body, "Escape");
  assert.equal(shown(), false, "Escape closes it");
  rightClick(canvas);
  const reset = [...menu().querySelectorAll("button")].find((b) => b.textContent === "Reset View");
  press(reset);
  assert.equal(shown(), false, "a pick closes it");
  assert.equal(globalThis.__resets, 1, "the pick ran");
});

test("character view menu: dispose with the menu open leaves no listener behind", () => {
  rightClick(canvas);
  assert.ok(shown());
  dispose();
  assert.equal(menu(), null, "the menu is gone from body");
  assert.equal(ledger.count(), baseline, "panel and popover listeners all removed");
});
