// Pure chord parse/normalize/rejection and the rollback decision.
import test from "node:test";
import assert from "node:assert/strict";
import { chordOf, matchShortcut, rejection, resolveAfterSave, RESERVED } from "../src/shortcuts-core.ts";

function keyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
  };
}

test("chordOf: parses a plain letter with Ctrl", () => {
  assert.equal(chordOf(keyEvent("t", { ctrl: true })), "Ctrl+T");
});

test("chordOf: normalizes modifier order regardless of event order", () => {
  const a = chordOf(keyEvent("t", { ctrl: true, shift: true }));
  const b = chordOf(keyEvent("T", { shift: true, ctrl: true }));
  assert.equal(a, "Ctrl+Shift+T");
  assert.equal(a, b);
});

test("chordOf: a bare modifier keypress parses to null", () => {
  assert.equal(chordOf(keyEvent("Control", { ctrl: true })), null);
});

test("chordOf: space normalizes to the word Space", () => {
  assert.equal(chordOf(keyEvent(" ", { alt: true })), "Alt+Space");
});

test("rejection: a chord with no Ctrl/Alt/Meta and not an F-key is refused", () => {
  const why = rejection("T", "x", new Map(), []);
  assert.equal(why, "needs Ctrl, Alt or an F-key");
});

test("rejection: a bare F-key is accepted without a modifier", () => {
  const why = rejection("F5", "x", new Map(), []);
  assert.equal(why, null);
});

test("rejection: a reserved terminal chord is refused", () => {
  for (const chord of RESERVED) {
    assert.equal(rejection(chord, "x", new Map(), []), "used by the terminal");
  }
});

test("rejection: a chord already bound to another shortcut is refused by name", () => {
  const current = new Map([["other", "Ctrl+K"]]);
  const bindings = [{ id: "other", name: "Open Palette" }];
  assert.equal(rejection("Ctrl+K", "mine", current, bindings), "already bound to Open Palette");
});

test("rejection: the same chord already bound to the row itself is not a conflict", () => {
  const current = new Map([["mine", "Ctrl+K"]]);
  const bindings = [{ id: "mine", name: "Mine" }];
  assert.equal(rejection("Ctrl+K", "mine", current, bindings), null);
});

test("resolveAfterSave: a successful save keeps the attempted chord", () => {
  assert.equal(resolveAfterSave("Ctrl+A", "Ctrl+B", null), "Ctrl+B");
});

test("resolveAfterSave: a failed save rolls back to the previous chord", () => {
  assert.equal(resolveAfterSave("Ctrl+A", "Ctrl+B", "disk full"), "Ctrl+A");
});

// The key-matching layer the `shortcut <id>` drive verb skips: defaultKeys → handler.
test("matchShortcut: a keydown fires the shortcut its defaultKeys bind, Shift picks the back binding", () => {
  const registry = [
    { id: "cycle-tab", defaultKeys: "Ctrl+Tab" },
    { id: "cycle-tab-back", defaultKeys: "Ctrl+Shift+Tab" },
  ];
  const current = new Map(registry.map((s) => [s.id, s.defaultKeys]));
  assert.equal(matchShortcut(chordOf(keyEvent("Tab", { ctrl: true })), registry, current)?.id, "cycle-tab");
  assert.equal(matchShortcut(chordOf(keyEvent("Tab", { ctrl: true, shift: true })), registry, current)?.id, "cycle-tab-back");
  assert.equal(matchShortcut(chordOf(keyEvent("Tab", { alt: true })), registry, current), undefined);
});
