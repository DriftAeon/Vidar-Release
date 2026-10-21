// depFound is the strict twin of isAvailable: null until the first report, then found/missing/false.
// Own file because the report cache is module state: the first test needs it still empty.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
const { depFound, loadDeps } = await import("../src/deps/state.ts");

test("depFound is null before the report arrives", () => {
  assert.equal(depFound("codex"), null);
});

test("depFound reports found, missing and unknown ids once the report is in", async () => {
  dom.ipc.answers.detect_dependencies = {
    root: "r",
    deps: [{ id: "codex", found: true }, { id: "desks", found: false }],
  };
  await loadDeps();
  assert.equal(depFound("codex"), true);
  assert.equal(depFound("desks"), false);
  assert.equal(depFound("not-in-report"), false);
});
