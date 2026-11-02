// Reorder drag over toggle rows (src/panels/reorder.ts with the real press.ts): a rack row whose
// .rack-name is a press-toggle (rack-row.ts onPress) must never be left flipped by a drag, and a
// drag must still move the row. Releases follow Chromium: pointerup, mouseup, then a click on the
// pressed element when the release lands on it, else on the nearest common ancestor.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { installDom } from "./helpers/jsdom-globals.mjs";

installDom(["Node", "HTMLElement", "HTMLButtonElement"]);

const SRC = new URL("../src/", import.meta.url).href;
const PREFS = `const m = new Map(); export function getPref(k) { return m.get(k); } export function setPref(k, v) { m.set(k, v); return true; }`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const key = new URL(specifier, context.parentURL).href.slice(SRC.length).replace(/\.ts$/, "");
      if (key === "prefs") return { url: `data:text/javascript,${encodeURIComponent(PREFS)}`, shortCircuit: true };
      if (!/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { enableReorder } = await import("../src/panels/reorder.ts");
const { onPress } = await import("../src/panels/press.ts");

const ROW_H = 40;
const fire = (el, type, init = {}) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

/** Rows built like rack-row.ts: button.rack-name toggled on press through onPress. */
function build() {
  const list = document.createElement("div");
  const toggles = {};
  for (const k of ["claude", "codex", "astra", "terminal"]) {
    const row = document.createElement("div");
    row.className = "rack-row";
    row.dataset.key = k;
    row.getBoundingClientRect = () => {
      const i = [...list.children].indexOf(row);
      return { top: i * ROW_H, bottom: (i + 1) * ROW_H, height: ROW_H, left: 0, right: 200, width: 200 };
    };
    const name = document.createElement("button");
    name.className = "rack-name";
    toggles[k] = 0;
    onPress(name, () => { toggles[k]++; });
    row.appendChild(name);
    list.appendChild(row);
  }
  const outside = document.createElement("div");
  document.body.replaceChildren(list, outside);
  enableReorder(list, "order.rack");
  const name = (k) => list.querySelector(`[data-key="${k}"] > .rack-name`);
  const order = () => [...list.children].map((r) => r.dataset.key);
  return { list, outside, toggles, name, order };
}

const commonAncestor = (a, b) => { let n = a; while (n && !n.contains(b)) n = n.parentNode; return n; };

/** Chromium's release: pointerup and mouseup on the element under the pointer, then the click. */
function release(downEl, upEl, y) {
  fire(upEl, "pointerup", { button: 0, buttons: 0, clientY: y });
  fire(upEl, "mouseup", { button: 0, buttons: 0, clientY: y });
  fire(downEl === upEl ? upEl : commonAncestor(downEl, upEl), "click", { button: 0, buttons: 0, clientY: y });
}

const press = (el, y) => fire(el, "pointerdown", { button: 0, buttons: 1, clientY: y });
const move = (el, y) => fire(el, "pointermove", { buttons: 1, clientY: y });

test("a. drag past DRAG_PX and release on another row moves the row and leaves the toggle", () => {
  const t = build();
  const src = t.name("terminal");
  press(src, 130); // terminal is row 3 (120-160)
  for (const y of [124, 110, 90, 50]) move(src, y); // into codex's upper half (40-80)
  release(src, t.name("codex"), 50);
  assert.deepEqual(t.order(), ["claude", "terminal", "codex", "astra"]);
  assert.equal(t.toggles.terminal % 2, 0, "terminal toggle net unchanged");
  assert.equal(t.toggles.codex, 0, "codex never toggled");
  assert.equal(t.list.querySelector(".dragging"), null);
});

test("b. a press that moves under DRAG_PX is an ordinary click that toggles once", () => {
  const t = build();
  const src = t.name("codex");
  press(src, 60);
  move(src, 62);
  move(src, 63);
  release(src, src, 63);
  assert.equal(t.toggles.codex, 1);
  assert.deepEqual(t.order(), ["claude", "codex", "astra", "terminal"]);
});

test("c. drag past DRAG_PX released off the list leaves no net toggle", () => {
  const t = build();
  const src = t.name("codex");
  press(src, 60);
  move(src, 70);
  move(src, 400); // below every row: no move
  release(src, t.outside, 400);
  assert.equal(t.toggles.codex % 2, 0);
  assert.deepEqual(t.order(), ["claude", "codex", "astra", "terminal"]);
});

test("d. pointercancel or blur mid-drag leaves no net toggle", () => {
  for (const stop of ["pointercancel", "blur"]) {
    const t = build();
    const src = t.name("codex");
    press(src, 60);
    move(src, 70);
    if (stop === "blur") window.dispatchEvent(new window.Event("blur"));
    else fire(src, "pointercancel", { buttons: 0 });
    assert.equal(t.toggles.codex % 2, 0, stop);
    move(src, 130); // the drag is over: no row follows the pointer
    assert.deepEqual(t.order(), ["claude", "codex", "astra", "terminal"], stop);
  }
});

test("e. the post-drag click is swallowed and the press is undone exactly once", () => {
  const t = build();
  const src = t.name("codex");
  press(src, 60);
  assert.equal(t.toggles.codex, 1, "press acts at once");
  move(src, 70);
  assert.equal(t.toggles.codex, 2, "drag start undoes the press");
  for (const y of [72, 74, 76]) move(src, y); // more moves past the threshold never undo again
  assert.equal(t.toggles.codex, 2);
  release(src, src, 76); // pointerup before click, as Chromium orders them
  assert.equal(t.toggles.codex, 2, "the click after the drag does not toggle");
});

test("2. release on the pressed element after a drag: Chromium's click is suppressed", () => {
  const t = build();
  const src = t.name("codex");
  press(src, 50);
  move(src, 58); // past DRAG_PX, still inside codex (40-80): no other row under the pointer
  release(src, src, 58);
  assert.equal(t.toggles.codex % 2, 0);
  assert.deepEqual(t.order(), ["claude", "codex", "astra", "terminal"]);
});

test("2. release on a different element after a drag: the click lands on the list, no toggle", () => {
  const t = build();
  const src = t.name("codex");
  press(src, 60);
  move(src, 100); // into astra's upper half: codex stays before astra
  move(src, 150); // terminal's lower half: codex goes after terminal
  release(src, t.name("astra"), 150);
  assert.deepEqual(t.order(), ["claude", "astra", "terminal", "codex"]);
  assert.equal(t.toggles.codex % 2, 0);
  assert.equal(t.toggles.astra, 0);
  assert.equal(t.toggles.terminal, 0);
});

test("a click well after a drag still toggles (the suppression window closes)", async () => {
  const t = build();
  const src = t.name("codex");
  press(src, 60);
  move(src, 70);
  release(src, t.outside, 400);
  await new Promise((r) => setTimeout(r, 350));
  press(src, 60);
  release(src, src, 60);
  assert.equal(t.toggles.codex % 2, 1);
});
