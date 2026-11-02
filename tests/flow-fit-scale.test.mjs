// Flow Reset Layout zoom: min(1, fit) snapped down to a stop; plain fit is uncapped.
import test from "node:test";
import assert from "node:assert/strict";
import { fitScale } from "../src/flow/fit-scale.ts";

const STOPS = [0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

test("a small graph resets to 100%, not zoomed in", () => {
  assert.equal(fitScale(3.2, STOPS, 1), 1);
  assert.equal(fitScale(1.2, STOPS, 1), 1);
  assert.equal(fitScale(1, STOPS, 1), 1);
});

test("a graph that does not fit zooms out to the fitting stop", () => {
  assert.equal(fitScale(0.72, STOPS, 1), 0.67);
  assert.equal(fitScale(0.1, STOPS, 1), 0.4);
});

test("uncapped fit still zooms in", () => {
  assert.equal(fitScale(1.3, STOPS), 1.25);
});
