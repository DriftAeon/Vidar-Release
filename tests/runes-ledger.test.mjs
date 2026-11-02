import test from "node:test";
import assert from "node:assert/strict";
import { loadedLine } from "../src/runes/ledger.ts";

test("loadedLine words each reason, naming a path trigger when there is one", () => {
  assert.equal(loadedLine({ reason: "always" }), "Loaded: Always");
  assert.equal(loadedLine({ reason: "path", trigger: "src/view.ts" }), "Loaded: Path (src/view.ts)");
  assert.equal(loadedLine({ reason: "path" }), "Loaded: Path");
  assert.equal(loadedLine({ reason: "recall" }), "Loaded: Recall");
});
