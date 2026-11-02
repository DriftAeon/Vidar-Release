// Wake Word "None": the saved model value turns the wake listener off entirely.
import test from "node:test";
import assert from "node:assert/strict";
import { WAKE_NONE, wakeActive } from "../src/wake-none.ts";

test("none is the only value that disables the wake listener", () => {
  assert.equal(WAKE_NONE, "none");
  assert.equal(wakeActive("none"), false);
  assert.equal(wakeActive("hey_jarvis_v0.1"), true);
  assert.equal(wakeActive(""), true);
  assert.equal(wakeActive(undefined), true);
});
