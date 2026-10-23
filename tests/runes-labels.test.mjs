// Inline heading labels for Bare rune rows: title drop, parenthetical strip, change-only emission.
import test from "node:test";
import assert from "node:assert/strict";
import { rowLabels } from "../src/runes/bare/labels.ts";

const texts = (l) => l.map((x) => x.map((y) => `${y.depth}:${y.text}`));

test("a heading shared by every brick is the title and is dropped", () => {
  const l = rowLabels([["Notes", "Style"], ["Notes", "Work"]]);
  assert.deepEqual(texts(l), [["0:Style"], ["0:Work"]]);
});

test("parentheticals are stripped and the heading is Title Cased", () => {
  const l = rowLabels([["Top", "keep it short (always)"], ["Top", "Other"]]);
  assert.deepEqual(texts(l)[0], ["0:Keep It Short"]);
});

test("a label is emitted only when the heading path changes", () => {
  const l = rowLabels([["T", "A", "x"], ["T", "A", "x"], ["T", "A", "y"], ["T", "B"], ["T", "B"]]);
  assert.deepEqual(texts(l), [["0:A", "1:X"], [], ["1:Y"], ["0:B"], []]);
});

test("a set with no headings stays flat", () => {
  assert.deepEqual(texts(rowLabels([[], []])), [[], []]);
  assert.deepEqual(rowLabels([]), []);
});

test("rows before any heading are unlabelled", () => {
  const l = rowLabels([[], ["Intro"], ["Intro"]]);
  assert.deepEqual(texts(l), [[], ["0:Intro"], []]);
});

test("the title test looks at every brick, not only the drawn ones", () => {
  const all = [["A"], ["B"]];
  assert.deepEqual(texts(rowLabels([["A"]], all)), [["0:A"]]);
});
