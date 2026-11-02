// Lab: an empty catalog draws nothing in the detail pane; "No Suite Yet" stays for a catalog with runes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/panels/lab.ts", import.meta.url), "utf8");

test("an empty catalog shows no placeholder text; No Suite Yet is kept", () => {
  assert.doesNotMatch(src, /No Lab Runes/);
  assert.match(src, /catalog && !none \? \[el\("div", "lab-empty", "No Suite Yet"\)\] : \[\]/);
});
