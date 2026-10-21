// The Flow run selector: a dropdown on the Flow picker's rows, not a native select. Each run reads
// `<icon> Word 18 Oct 12:51 pm` (status as a prefix icon, a word hashed from the run id, no comma, no
// dash, no status text); the status word is the row's tooltip.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "flow/store": `export const setActiveGraph = () => {}; export const scheduleGraphSave = () => {};
      export const applyTemplateDraft = () => {}; export const activeDraft = () => null;
      export const deleteGraph = () => false; export const flushGraphSave = () => {};`,
    "flow/nodes": "export const loadGraph = () => {};",
    "flow/roster": "export const wiredModels = () => []; export const modelLabel = (id) => id;",
    "flow/engine": "export const startRun = () => ({ id: 'x' }); export const cancelRun = () => {}; export const heldRunIds = () => globalThis.__held;",
    "flow/runs-store": "export const getRun = (id) => globalThis.__runs.find((r) => r.id === id) ?? null; export const runsForGraph = () => globalThis.__runs;",
    "flow/run-view": "export const paintRun = (r) => { globalThis.__painted = r.id; }; export const clearRunPaint = () => { globalThis.__painted = null; }; export const CANCEL_RUN_TOOLTIP = 'Cancel';",
    "flow/viewport": "export const showFlowToast = () => {};",
  },
});
const { RUN_WORDS, runWord, runLabel } = await import("../src/flow/run-names.ts");
const { buildRunControls } = await import("../src/flow/run-controls.ts");
const { S } = await import("../src/flow/state.ts");

const run = (id, status, startedAt, nodes = {}) => ({ id, graphId: "g", graphSnapshot: {}, status, startedAt, nodes });
globalThis.__held = new Set();
globalThis.__runs = [
  run("run-a", "success", "2026-10-18T12:51:00"),
  run("run-b", "error", "2026-10-18T09:05:00"),
  run("run-c", "error", "2026-10-17T08:00:00", { n1: { error: "Interrupted" } }),
  run("run-d", "canceled", "2026-10-16T08:00:00"),
  run("run-e", "denied", "2026-10-15T08:00:00"),
  run("run-f", "running", "2026-10-14T08:00:00"),
];
S.activeGraphId = "g";

test("run words: 64 unique Title Case nouns, stable per id", () => {
  assert.equal(RUN_WORDS.length, 64);
  assert.equal(new Set(RUN_WORDS).size, 64);
  assert.ok(RUN_WORDS.every((w) => /^[A-Z][a-z]+$/.test(w)));
  assert.equal(runWord("run-a"), runWord("run-a"));
  assert.ok(RUN_WORDS.includes(runWord("anything")));
  assert.equal(new Set(Array.from({ length: 200 }, (_, i) => runWord(`run-${i}`))).size > 30, true, "the hash spreads");
});

test("the label is word, date and time joined by spaces", () => {
  const label = runLabel("run-a", "2026-10-18T12:51:00");
  assert.match(label, new RegExp(`^${runWord("run-a")} \\S+ \\S+ \\S+`));
  assert.doesNotMatch(label, /[,—()]|Success|Run /);
});

test("the selector opens a dropdown of icon rows with the status as the tooltip", () => {
  const controls = buildRunControls();
  document.body.append(controls.runPick);
  controls.refresh();
  assert.equal(controls.runPick.tagName, "BUTTON");
  assert.equal(document.querySelector(".flow-run-select"), null);
  // closed face: the selected run's icon and name
  assert.match(controls.runPick.querySelector(".nm").textContent, new RegExp(`^${runWord("run-a")} `));
  assert.match(controls.runPick.querySelector(".nm img.icn").src, /check-circle/);
  assert.equal(controls.runPick.title, "Success");
  controls.runPick.click();
  const rows = [...document.querySelectorAll("#flow-pick-menu .display-pick-row")];
  assert.equal(rows.length, 7, "the Run row plus six runs");
  assert.equal(rows[0].textContent, "Run");
  const byIcon = rows.slice(1).map((r) => [r.querySelector("img.icn").src.match(/([\w-]+)\.svg$/)[1], r.title]);
  assert.deepEqual(byIcon, [
    ["check-circle", "Success"], ["dismiss-circle", "Error"], ["warning", "Interrupted"],
    ["cancel", "Canceled"], ["shield", "Denied"], ["timer", "Running"],
  ]);
  assert.ok(rows[1].classList.contains("active"));
  assert.equal(globalThis.__painted, "run-a");
  controls.runPick.click();
});

test("picking a row selects that run; the Run row clears the canvas", () => {
  const controls = buildRunControls();
  document.body.append(controls.runPick);
  controls.refresh();
  controls.runPick.click();
  document.querySelectorAll("#flow-pick-menu .display-pick-row")[4].click();
  assert.equal(S.activeRunId, "run-d");
  assert.equal(globalThis.__painted, "run-d");
  assert.match(controls.runPick.querySelector(".nm img.icn").src, /cancel/);
  assert.equal(document.getElementById("flow-pick-menu"), null, "the menu closes on a pick");
  controls.runPick.click();
  document.querySelectorAll("#flow-pick-menu .display-pick-row")[0].click();
  assert.equal(S.activeRunId, null);
  assert.equal(globalThis.__painted, null);
  assert.equal(controls.runPick.querySelector(".nm").textContent, "Run");
  assert.equal(controls.cancelBtn.disabled, true);
});

test("a live run enables Cancel; refresh keeps the selection", () => {
  globalThis.__held = new Set(["run-f"]);
  S.activeRunId = "run-f";
  const controls = buildRunControls();
  controls.refresh();
  assert.equal(controls.cancelBtn.disabled, false);
  assert.match(controls.runPick.querySelector(".nm img.icn").src, /timer/);
  globalThis.__held = new Set();
});
