// Bare Runes generate progress reducer (src/runes/bare/progress.ts) against the fixture lane D's Rust events match.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADD_TO_VAULT_LABEL, addToVault, addToVaultOps, chunkLabel, emptyProgress, progressRows, reduceProgress, stopProgress } from "../src/runes/bare/progress.ts";

const EVENTS = JSON.parse(readFileSync(new URL("./fixtures/rune-gen-progress.json", import.meta.url), "utf8"));
const fold = (events, s = emptyProgress()) => events.reduce(reduceProgress, s);

test("fixture: the plan gives pending rows, a split file's chunk on each of its rows, and a Merge row", () => {
  assert.deepEqual(progressRows(fold(EVENTS.slice(0, 1))), [
    { label: "~\\CLAUDE.md, ~\\rules\\ui.md", state: "pending", text: "" },
    { label: "~\\memory - Chunk 1 of 2", state: "pending", text: "" },
    { label: "~\\memory - Chunk 2 of 2", state: "pending", text: "" },
    { label: "Merge", state: "pending", text: "" },
  ]);
});

test("fixture: running, retrying and done states with Rune counts", () => {
  const rows = progressRows(fold(EVENTS.slice(0, 4)));
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.state, r.text]), [["running", ""], ["running", "Retrying"]]);
  const done = progressRows(fold(EVENTS.slice(0, 6)));
  assert.deepEqual(done.slice(0, 2).map((r) => [r.state, r.text]), [["done", "12 Runes"], ["done", "1 Rune"]]);
});

test("fixture: failed, stopped and the merge states", () => {
  assert.deepEqual(progressRows(fold(EVENTS.slice(0, 7)))[2], { label: "~\\memory - Chunk 2 of 2", state: "failed", text: "Failed" });
  assert.deepEqual(progressRows(fold(EVENTS.slice(0, 8)))[2].state, "stopped");
  assert.equal(progressRows(fold(EVENTS.slice(0, 8)))[2].text, "Stopped");
  const merge = (n) => progressRows(fold(EVENTS.slice(0, n))).at(-1);
  assert.deepEqual(merge(9), { label: "Merge", state: "running", text: "" });
  assert.deepEqual(merge(10), { label: "Merge", state: "done", text: "Done" });
  assert.deepEqual(merge(11), { label: "Merge", state: "failed", text: "Failed" });
});

test("a chunk event before the plan creates its row; the plan then names it", () => {
  const s = fold([EVENTS[1]]);
  assert.deepEqual(progressRows(s), [{ label: "Chunk 1", state: "running", text: "" }]);
  const later = fold([EVENTS[0]], s);
  assert.equal(progressRows(later)[0].label, "~\\CLAUDE.md, ~\\rules\\ui.md");
  assert.equal(progressRows(later)[0].state, "running");
});

test("one chunk shows no Merge row", () => {
  const s = fold([{ runId: "x", stage: "plan", chunks: [{ files: [{ path: "a.md", part: null }] }] }]);
  assert.deepEqual(progressRows(s), [{ label: "a.md", state: "pending", text: "" }]);
});

test("a final error or cancel turns unfinished rows into Stopped, keeping done and failed", () => {
  const rows = progressRows(stopProgress(fold(EVENTS.slice(0, 7).filter((_, i) => i !== 5 && i !== 3))));
  assert.deepEqual(rows.map((r) => [r.state, r.text]), [
    ["done", "12 Runes"], ["stopped", "Stopped"], ["failed", "Failed"], ["stopped", "Stopped"],
  ]);
});

test("chunkLabel joins the paths and names a split file's chunk", () => {
  assert.equal(chunkLabel([{ path: "a", part: null }, { path: "b", part: { k: 2, of: 3 } }]), "a, b - Chunk 2 of 3");
});

const GEN = { library: "gen-0a1b2c3d", set: "generated-20261017" };

test("Add to Vault sends one addRuneset of the generated set to the tab's vault, unlocked", async () => {
  assert.equal(ADD_TO_VAULT_LABEL, "Add to Vault");
  const calls = [];
  const err = await addToVault(async (a) => { calls.push(a); return {}; }, "v1", GEN);
  assert.equal(err, null);
  assert.deepEqual(calls, [{ id: "v1", ops: [{ op: "addRuneset", ref: GEN }], mode: "unlocked" }]);
  assert.deepEqual(addToVaultOps(GEN), [{ op: "addRuneset", ref: GEN }]);
});

test("Add to Vault on a locked vault shows the store's error; no vault calls nothing", async () => {
  const err = await addToVault(async () => { throw "invalid: vault `v1` is locked"; }, "v1", GEN);
  assert.equal(err, "invalid: vault `v1` is locked");
  let called = false;
  assert.ok(await addToVault(async () => { called = true; }, null, GEN));
  assert.equal(called, false);
});
