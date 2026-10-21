// Question form: the Other row is a real option row (not a .q-opt) with single/multi collect rules.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { questionForm } = await import("../src/panels/rendered/question-form.ts");

function build(multiSelect) {
  const card = document.createElement("div");
  const calls = [];
  const input = { questions: [{ question: "Pick?", multiSelect, options: [{ label: "A" }, { label: "B" }] }] };
  const form = questionForm(card, input, (ok) => calls.push(ok));
  const opts = [...card.querySelectorAll(".q-opt")];
  const row = card.querySelector(".q-other-row");
  const other = row.querySelector(".q-other");
  const type = (v) => { other.value = v; other.dispatchEvent(new window.Event("input")); };
  const ans = () => form.collect().answers["Pick?"];
  return { card, form, opts, row, other, type, ans, calls };
}

test("Other row is last inside .q-options and is not a .q-opt", () => {
  const t = build(false);
  assert.equal(t.opts.length, 2);
  assert.equal(t.row.parentElement.className, "q-options");
  assert.equal(t.row, t.row.parentElement.lastElementChild);
  assert.equal(t.other.placeholder, "Other");
  assert.equal(build(true).row.classList.contains("multi"), true);
});

test("single: typing turns Other on and clears picks; a pick turns it off but keeps the text", () => {
  const t = build(false);
  t.opts[0].click();
  assert.equal(t.ans(), "A");
  t.type("Mine");
  assert.equal(t.row.classList.contains("on"), true);
  assert.equal(t.opts[0].classList.contains("on"), false);
  assert.equal(t.ans(), "Mine");
  t.opts[1].click();
  assert.equal(t.row.classList.contains("on"), false);
  assert.equal(t.other.value, "Mine");
  assert.equal(t.ans(), "B");
  assert.equal(t.form.answered(), true);
  t.type("");
  assert.equal(t.row.classList.contains("on"), false);
  assert.equal(t.ans(), "B");
});

test("single: Other alone answers; emptying it unanswers", () => {
  const t = build(false);
  assert.equal(t.form.answered(), false);
  t.type("x");
  assert.equal(t.form.answered(), true);
  t.type("  ");
  assert.equal(t.form.answered(), false);
  assert.equal(t.calls.at(-1), false);
});

test("multi: picks plus Other joined with a comma", () => {
  const t = build(true);
  t.opts[0].click();
  t.opts[1].click();
  t.type("Z");
  assert.equal(t.ans(), "A, B, Z");
  t.opts[0].click();
  assert.equal(t.row.classList.contains("on"), true);
  assert.equal(t.ans(), "B, Z");
  t.type("");
  assert.equal(t.ans(), "B");
});

test("clicking the row's marker area focuses the input", () => {
  const t = build(false);
  document.body.append(t.card);
  t.row.click();
  assert.equal(document.activeElement, t.other);
});

test("single: focusing the empty Other box selects it, leaving it empty deselects it", () => {
  const t = build(false);
  document.body.append(t.card);
  t.opts[0].click();
  t.other.focus();
  assert.equal(t.row.classList.contains("on"), true);
  assert.equal(t.opts[0].classList.contains("on"), false);
  assert.equal(t.form.answered(), false, "an empty Other is not an answer");
  t.type("Mine");
  assert.equal(t.ans(), "Mine");
  t.type("");
  assert.equal(t.row.classList.contains("on"), true, "still focused: Other stays picked");
  t.other.blur();
  assert.equal(t.row.classList.contains("on"), false);
  t.card.remove();
});
