// Shared path helpers in src/paths.ts: basename, baseAny, normWin.
import test from "node:test";
import assert from "node:assert/strict";
import { basename, baseAny, normWin } from "../src/paths.ts";

test("basename splits on backslash only", () => {
  assert.equal(basename("C:\\a\\b.txt"), "b.txt");
  assert.equal(basename("plain"), "plain");
  assert.equal(basename("a/b"), "a/b");
});

test("baseAny splits on either separator", () => {
  assert.equal(baseAny("C:\\a\\b.txt"), "b.txt");
  assert.equal(baseAny("/a/b.txt"), "b.txt");
  assert.equal(baseAny("x"), "x");
});

test("normWin: forward slashes, no trailing slash, case kept", () => {
  assert.equal(normWin("C:\\Dev\\Proj\\"), "C:/Dev/Proj");
  assert.equal(normWin("C:/Dev//"), "C:/Dev");
  assert.equal(normWin(""), "");
});
