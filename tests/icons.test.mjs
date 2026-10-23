// lucidePath answers own keys only: stream tool names must never resolve to inherited values.
import test from "node:test";
import assert from "node:assert/strict";
import { lucidePath } from "../src/icons.ts";

test("inherited names do not resolve", () => {
  assert.equal(lucidePath("constructor"), undefined);
  assert.equal(lucidePath("__proto__"), undefined);
  assert.equal(lucidePath("toString"), undefined);
});

test("merged Rendered names and core names resolve", () => {
  assert.ok(lucidePath("square-terminal")?.length > 0);
  assert.ok(lucidePath("shield")?.length > 0);
  assert.deepEqual(lucidePath("check"), ["M20 6 9 17l-5-5"]);
  assert.ok(lucidePath("refresh-cw")?.length > 0);
});
