import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { setLeftCover, getLeftCover, onLeftCoverChange, leftSlot } = await import("../src/panels/sessions/left-cover.ts");
const sessionsSrc = readFileSync(new URL("../src/panels/sessions.ts", import.meta.url), "utf8");
const fn = (name) => sessionsSrc.slice(sessionsSrc.indexOf(`function ${name}(`)).split(/\r?\n}\r?\n/)[0];

test("a cover hides the left session but keeps it focused", () => {
  const el = { tag: "cover" };
  setLeftCover(el);
  const visible = ["a"];
  const slot = leftSlot(visible, true);
  assert.equal(slot.hidden, "a");
  assert.equal(slot.cover, el);
  assert.deepEqual(visible, ["a"]); // the slot answer never edits visible; activeId is not an input
  // layout() hides only slot.hidden and leaves activeId alone
  const layout = fn("layout");
  assert.match(layout, /oid !== slot\.hidden/);
  assert.doesNotMatch(layout, /activeId\s*=[^=]/);
  setLeftCover(null);
});

test("a cover applies only with the workbench open and a session in the slot", () => {
  setLeftCover({});
  assert.equal(leftSlot(["a"], false).hidden, undefined);
  assert.equal(leftSlot([], true).hidden, undefined);
  assert.equal(leftSlot(["a", "b"], true).hidden, "a");
  setLeftCover(null);
});

test("clearing restores the session and notifies once per real change", () => {
  let n = 0;
  const off = onLeftCoverChange(() => { n++; });
  const el = {};
  setLeftCover(el);
  setLeftCover(el);
  assert.equal(n, 1);
  setLeftCover(null);
  assert.equal(n, 2);
  assert.equal(getLeftCover(), null);
  assert.equal(leftSlot(["a"], true).hidden, undefined);
  off();
  setLeftCover(el);
  assert.equal(n, 2);
  setLeftCover(null);
});

test("openRelay and openDual clear the cover; a cover change re-runs layout", () => {
  assert.match(fn("openRelay"), /setLeftCover\(null\)/);
  assert.match(fn("openDual"), /setLeftCover\(null\)/);
  assert.match(sessionsSrc, /onLeftCoverChange\(\(\) => layout\(false\)\)/);
});
