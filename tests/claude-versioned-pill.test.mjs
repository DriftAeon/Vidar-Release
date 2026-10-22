// A Claude tab spawned on an alias ("opus") shows the versioned model once the catalog lands,
// before the first reply; system/init stays the live truth.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createEvents } = await import("../src/panels/rendered/events.ts");
const { initPrefs } = await import("../src/prefs.ts");
const { prettyModel } = await import("../src/format.ts");

Object.assign(globalThis.__domMount.answers, { read_state: {}, patch_state: null });
await initPrefs();

function tab(model, pill = prettyModel(model)) {
  const S = { models: [], characterModelLive: false, characterModel: model, modelHinted: false };
  const sl = { model: pill };
  const seen = [];
  const { handle } = createEvents(S, {
    opts: { agent: "claude", model, cwd: "C:/work", onSession: (s) => seen.push(s.model) },
    sl, redrawStatus() {}, emitCharacterStatus() {}, tools: new Map(),
  });
  return { S, sl, seen, handle };
}
const catalog = [
  { value: "default", label: "Default", resolved: "claude-opus-5-5" },
  { value: "opus", label: "Opus", resolved: "claude-opus-5-5" },
  { value: "sonnet", label: "Sonnet", resolved: "claude-sonnet-5-5" },
  { value: "opus[1m]", label: "Opus 1M", resolved: "claude-opus-5-5" },
];

test("the new Sonnet and Haiku ids have their written names", () => {
  assert.equal(prettyModel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(prettyModel("claude-haiku-5-5"), "Haiku 5.5");
});

test("an alias pill takes the catalog row's versioned name before the first reply", () => {
  const t = tab("sonnet");
  assert.equal(t.sl.model, "Sonnet");
  t.handle({ kind: "models", models: catalog });
  assert.equal(t.sl.model, "Sonnet 5.5");
  assert.equal(t.S.characterModel, "claude-sonnet-5-5");
  assert.deepEqual(t.seen, ["claude-sonnet-5-5"]);
});

test("the 1M alias keeps its 1M mark", () => {
  const t = tab("opus[1m]");
  t.handle({ kind: "models", models: catalog });
  assert.equal(t.sl.model, "Opus 5.5 1M");
});

test("no matching row, or a pill that moved on, leaves the label unchanged", () => {
  const none = tab("haiku");
  none.handle({ kind: "models", models: catalog });
  assert.equal(none.sl.model, "Haiku");
  const live = tab("sonnet");
  live.S.characterModelLive = true; // system/init already landed
  live.handle({ kind: "models", models: catalog });
  assert.equal(live.sl.model, "Sonnet");
  const moved = tab("sonnet", "Opus 5");
  moved.handle({ kind: "models", models: catalog });
  assert.equal(moved.sl.model, "Opus 5");
});
