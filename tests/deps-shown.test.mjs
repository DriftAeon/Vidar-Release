// Regression: gating covered roots only and never refreshed. roster-shown.ts
// is the one pure filter over roots and variants; the menu re-runs it on every report, so a row must
// come back once its dependency becomes available.
import test from "node:test";
import assert from "node:assert/strict";
import { shownRootsOf, shownVariantsOf } from "../src/launcher/roster-shown.ts";
import { setupDom } from "./helpers/dom-mount.mjs";

// The real deps/state over a stubbed detect_dependencies.
const dom = setupDom();
const { isAvailable, loadDeps } = await import("../src/deps/state.ts");

test("a row requiring node drops while node is missing and returns when it is found", () => {
  const rendered = { key: "claude-rendered", id: "claude", requires: ["node"] };
  const plain = { key: "claude", id: "claude" };
  const rows = [plain, rendered];
  const available = new Set();
  const isAvailable = (id) => available.has(id);

  assert.deepEqual(shownRootsOf(rows, isAvailable), [plain]);
  available.add("node");
  assert.deepEqual(shownRootsOf(rows, isAvailable), [plain, rendered]);
});

// Order matters: the report cache is module state, empty until the first loadDeps.
test("isAvailable: before a report everything reads available; after one an unknown id does not", async () => {
  assert.equal(isAvailable("acme-key"), true);
  dom.ipc.answers.detect_dependencies = {
    root: "r",
    deps: [{ id: "claude", found: true }, { id: "acme-key", found: false }, { id: "beta-key", found: true }],
  };
  await loadDeps();
  assert.equal(isAvailable("claude"), true);
  assert.equal(isAvailable("acme-key"), false);
  assert.equal(isAvailable("not-in-report"), false);
});

test("gateway rows hide without their key and show with it", async () => {
  const acme = { key: "acme", id: "acme", requires: ["claude", "acme-key"] };
  const beta = { key: "beta", id: "beta", requires: ["claude", "beta-key"] };
  const answer = (deps) => { dom.ipc.answers.detect_dependencies = { root: "r", deps }; return loadDeps(); };
  await answer([{ id: "claude", found: true }, { id: "acme-key", found: false }, { id: "beta-key", found: true }]);
  assert.deepEqual(shownRootsOf([acme, beta], isAvailable), [beta]);
  await answer([{ id: "claude", found: true }, { id: "acme-key", found: true }]);
  assert.deepEqual(shownRootsOf([acme, beta], isAvailable), [acme]);
});

test("rows without requires always stay", () => {
  const rows = [{ key: "a", id: "a" }, { key: "b", id: "b" }];
  assert.deepEqual(shownRootsOf(rows, () => false), rows);
});

// Non-promotion: a hidden root takes its variants with it, including a variant that
// requires nothing itself, so the launcher never reaches Astra through a Codex it does not show.
test("a root whose dependency is missing hides its variants too", () => {
  const codex = { key: "codex", id: "codex", requires: ["codex"] };
  const astra = { key: "astra", id: "codex", under: "codex", role: "astra" };
  const rendered = { key: "codex-rendered", id: "codex", under: "codex", requires: ["codex", "node"] };
  const shell = { key: "terminal", id: "shell" };
  const roots = [codex, shell];
  const variantsOf = new Map([[codex, [astra, rendered]]]);
  const available = new Set(["node"]);
  const isAvailable = (id) => available.has(id);

  const shown = shownRootsOf(roots, isAvailable);
  assert.deepEqual(shown, [shell]);
  assert.deepEqual(shownVariantsOf(codex, roots, variantsOf, isAvailable), []);
  assert.deepEqual(shown.flatMap((r) => shownVariantsOf(r, roots, variantsOf, isAvailable)), []);

  available.add("codex");
  assert.deepEqual(shownRootsOf(roots, isAvailable), [codex, shell]);
  assert.deepEqual(shownVariantsOf(codex, roots, variantsOf, isAvailable), [astra, rendered]);
});
