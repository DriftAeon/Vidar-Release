// Pins the rune kind lists in src-tauri/src/rules/rune.rs to their twins in tools/runes/header.mjs.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

// tools/runes is export-ignored: the twin has nothing to compare against in the public tree.
const skip = missingInputs(import.meta.url, "../tools/runes/header.mjs");
const test = guard(baseTest, skip);
const { ITEM_KINDS, KINDS, KIND_FOLDERS, ITEM_KEYS } = skip ? {} : await import("../tools/runes/header.mjs");

const rust = readFileSync(new URL("../src-tauri/src/rules/rune.rs", import.meta.url), "utf8");

const rustItemKinds = () => {
  const m = /pub const ITEM_KINDS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(rust);
  assert.ok(m, "ITEM_KINDS shape changed in rune.rs; update this test with it");
  const list = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.equal(Number(m[1]), list.length, "ITEM_KINDS length annotation");
  return list;
};

const rustKinds = () => {
  const m = /pub const KINDS: \[\(&str, &str\); (\d+)\] = \[([^\]]*)\];/.exec(rust);
  assert.ok(m, "KINDS shape changed in rune.rs; update this test with it");
  const pairs = [...m[2].matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((x) => [x[1], x[2]]);
  assert.equal(Number(m[1]), pairs.length, "KINDS length annotation");
  return pairs;
};

test("the item kind lists match, model included", () => {
  assert.deepEqual(rustItemKinds(), ITEM_KINDS);
  assert.ok(ITEM_KINDS.includes("model"));
});

test("the kind list and folders match", () => {
  const pairs = rustKinds();
  assert.deepEqual(pairs.map(([, kind]) => kind).sort(), [...KINDS].sort());
  for (const [folder, kind] of pairs) assert.equal(KIND_FOLDERS[kind], folder, kind);
  assert.equal(KIND_FOLDERS.model, "models");
});

test("a model rune carries the model key in both parsers", () => {
  assert.deepEqual(ITEM_KEYS.model, ["model"]);
  assert.match(rust, /"model" => &\["model"\]/);
});
