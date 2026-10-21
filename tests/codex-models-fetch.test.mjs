// The tab-less Codex model fetch (src/agents/codex-models.ts): the saved shape is the Codex tab's own,
// the fetch runs once per launch and only while nothing is saved, and an empty or failed fetch saves nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { read_state: {}, patch_state: null } });
const { initPrefs, getPref, setPref } = await import("../src/prefs.ts");
const { codexModelsFromPages, ensureCodexModels, resetCodexModelsForTest } = await import("../src/agents/codex-models.ts");
const { codexModelsPref } = await import("../src/agents/codex-settings.ts");
await initPrefs();

const row = (model, efforts = [], extra = {}) => ({ model, displayName: model, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), ...extra });
const fetches = () => dom.ipc.invoked.filter((c) => c === "codex_list_models").length;
const fresh = () => { resetCodexModelsForTest(); setPref("codexModels", undefined); dom.ipc.invoked.length = 0; };

test("pages map through the adapter catalog into the shape a Codex tab saves", () => {
  const pages = [[row("gpt-a", ["low", "xhigh", "minimal"])], [row("gpt-b"), row("gpt-hidden", [], { hidden: true }), { nope: 1 }]];
  const got = codexModelsFromPages(pages);
  assert.deepEqual(got.map((m) => [m.value, m.effortLevels]), [["gpt-a", ["low", "xhigh"]], ["gpt-b", []]]);
  // the same rows a tab's `models` event carries map to the same saved value
  const tabRows = got.map((m) => ({ value: m.value, resolved: m.value, label: m.label, effortLevels: m.effortLevels }));
  assert.deepEqual(codexModelsPref(tabRows), got);
  assert.deepEqual(codexModelsFromPages([]), []);
});

test("the fetch runs once per launch and saves the catalog", async () => {
  fresh();
  dom.ipc.answers.codex_list_models = [[row("gpt-a", ["high"])]];
  await Promise.all([ensureCodexModels(), ensureCodexModels()]);
  assert.equal(fetches(), 1, "two callers share one run");
  assert.deepEqual(getPref("codexModels"), [{ value: "gpt-a", label: "Gpt-a", effortLevels: ["high"] }]);
  setPref("codexModels", undefined);
  await ensureCodexModels();
  assert.equal(fetches(), 1, "never twice in one launch, even after the pref empties");
});

test("a saved catalog means no fetch", async () => {
  fresh();
  setPref("codexModels", [{ value: "gpt-saved", label: "Saved", effortLevels: [] }]);
  await ensureCodexModels();
  assert.equal(fetches(), 0);
  assert.equal(getPref("codexModels")[0].value, "gpt-saved");
});

test("an empty list or a failed fetch leaves the pref empty", async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    fresh();
    dom.ipc.answers.codex_list_models = [[], [row("gpt-hidden", [], { hidden: true })]];
    await ensureCodexModels();
    assert.equal(getPref("codexModels"), undefined);
    fresh();
    dom.ipc.answers.codex_list_models = () => { throw new Error("codex.js not found"); };
    await ensureCodexModels();
    await ensureCodexModels();
    assert.equal(getPref("codexModels"), undefined);
    assert.equal(fetches(), 1);
    assert.equal(warned.length, 2, "one line per failed launch");
  } finally {
    console.warn = warn;
  }
});
