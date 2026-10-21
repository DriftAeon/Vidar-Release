import test from "node:test";
import assert from "node:assert/strict";
import { placeMenu, centerOn } from "../src/modules/place-menu.ts";

test("opens at the pointer when it fits", () => {
  assert.deepEqual(placeMenu(300, 200, 166, 120, 1200, 800), { left: 300, top: 200 });
});

test("clamps to the right and bottom edges", () => {
  assert.deepEqual(placeMenu(1190, 790, 166, 120, 1200, 800), { left: 1026, top: 672 });
});

test("clamps to the left and top edges", () => {
  assert.deepEqual(placeMenu(-5, 2, 166, 120, 1200, 800), { left: 8, top: 8 });
});

test("a menu larger than the window pins to the top-left edge", () => {
  assert.deepEqual(placeMenu(50, 50, 400, 400, 300, 300), { left: 8, top: 8 });
});

test("centerOn centers the popup on the anchor when it fits", () => {
  assert.equal(centerOn(600, 200, 1200), 500);
});

test("centerOn clamps to the right edge", () => {
  assert.equal(centerOn(1190, 200, 1200), 992);
});

test("centerOn clamps to the left edge", () => {
  assert.equal(centerOn(10, 200, 1200), 8);
});
