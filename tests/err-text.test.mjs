// The shared caught-value text, and the kind head plural the Generate Runes file list now takes from kind-groups.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { errText } = await import("../src/err-text.ts");
const { kindHeadName } = await import("../src/runes/kind-groups.ts");

test("errText reads an Error, a thrown object's string message, else the value", () => {
  assert.equal(errText(new Error("boom")), "boom");
  assert.equal(errText({ message: "from the sidecar" }), "from the sidecar");
  assert.equal(errText("backend said no"), "backend said no");
  assert.equal(errText({ message: 3 }), "[object Object]");
  assert.equal(errText(null), "null");
});

test("kind heads read as plurals: Memories, not Memorys", () => {
  assert.equal(kindHeadName("memory"), "Memories");
  assert.equal(kindHeadName("skill"), "Skills");
  assert.equal(kindHeadName("rule"), "Rules");
});
