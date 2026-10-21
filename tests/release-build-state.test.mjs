// Settings > Build: the dependsOn closure the toggles follow, and the result line the page reads.
import test from "node:test";
import assert from "node:assert/strict";
import { dimmed, droppedIds, flip, includeList, setOn, toggles } from "../src/settings/build/state.ts";

// Shaped like release-build.ps1 -List (kinds other than agent/surface land in Content).
const catalog = {
  sets: [
    { id: "codex", label: "Codex", include: ["codex", "tray", "gone"], personal: false },
    { id: "full", label: "Full", include: ["*"], personal: true },
  ],
  modules: [
    { id: "relay", label: "Relay", kind: "surface", level: "core", dependsOn: [] },
    { id: "tray", label: "Tray", kind: "surface", level: "required-hideable", dependsOn: [] },
    { id: "claude", label: "Claude", kind: "agent", level: "optional", dependsOn: [] },
    { id: "codex", label: "Codex", kind: "agent", level: "optional", dependsOn: [] },
    { id: "deepseek", label: "DeepSeek", kind: "agent", level: "optional", dependsOn: ["claude"] },
    { id: "sample-cap", label: "Sample Cap", kind: "capability", level: "required-hideable", dependsOn: ["claude"] },
    { id: "deep-child", label: "Deep Child", kind: "capability", level: "optional", dependsOn: ["deepseek"] },
    { id: "needs-core", label: "Needs Core", kind: "surface", level: "optional", dependsOn: ["relay"] },
  ],
};
const list = toggles(catalog);

test("core modules are no toggles and kinds map to the three groups", () => {
  assert.ok(!list.some((t) => t.id === "relay"));
  const group = Object.fromEntries(list.map((t) => [t.id, t.group]));
  assert.equal(group.claude, "Agents");
  assert.equal(group.tray, "Surfaces");
  assert.equal(group["sample-cap"], "Content");
});

test("a set's include starts the toggles; * is all; unknown ids drop", () => {
  assert.deepEqual([...setOn(catalog.sets[0], list)].sort(), ["codex", "tray"]);
  assert.equal(setOn(catalog.sets[1], list).size, list.length);
});

test("turning a parent off dims its dependants, transitively, and leaves their switches", () => {
  const all = setOn(catalog.sets[1], list);
  assert.equal(dimmed(all, list).size, 0);
  const off = flip(all, "claude", list);
  assert.ok(off.has("deepseek") && off.has("sample-cap"), "switches untouched");
  const dims = dimmed(off, list);
  assert.equal(dims.get("deepseek"), "Claude");
  assert.equal(dims.get("sample-cap"), "Claude");
  assert.equal(dims.get("deep-child"), "DeepSeek");
  assert.ok(!dims.has("codex") && !dims.has("needs-core"), "a core parent always ships");
});

test("turning a dimmed dependant on turns its parents on", () => {
  const none = new Set();
  const on = flip(none, "deep-child", list);
  assert.deepEqual([...on].sort(), ["claude", "deep-child", "deepseek"]);
  assert.equal(dimmed(on, list).size, 0);
  assert.deepEqual(includeList(on, list), ["claude", "deepseek", "deep-child"]);
});

test("a one-item dropped list the wrapper serialized as a string still reads as a list", () => {
  assert.deepEqual(droppedIds({ t: "result", ok: true, dropped: "agent-profiles" }), ["agent-profiles"]);
  assert.deepEqual(droppedIds({ t: "result", ok: true, dropped: [] }), []);
  assert.deepEqual(droppedIds({ t: "result", ok: false }), []);
});
