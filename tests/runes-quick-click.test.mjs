// A second or third quick click on a rune card summary or a set head must not word- or line-select text:
// mousedown with detail > 1 is default-prevented, a first click (detail 1) is not, so drag selection still works.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { cardDetails } = await import("../src/runes/cards.ts");
const { setHead } = await import("../src/runes/set-card.ts");

const rune = { id: "r1", kind: "rule", scope: ["global"], state: "active", activate: "always",
  description: "About r1", path: "C:/lib/rules/r1.md", body: "Body of r1." };
const CTX = { openInDocument: () => {}, note: () => {} };

function down(target, detail) {
  const e = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, detail });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

test("a rune card summary prevents the default on detail 2 and 3, not on detail 1", () => {
  const sum = cardDetails(rune, { name: "r1", title: "r1" }, CTX).querySelector("summary.runes-blk.card");
  assert.ok(sum);
  assert.equal(down(sum, 1), false);
  assert.equal(down(sum, 2), true);
  assert.equal(down(sum, 3), true);
});

test("a set head prevents the default on detail 2, not on detail 1, also from its name", () => {
  const head = setHead("Rules", 3, null);
  assert.equal(down(head, 1), false);
  assert.equal(down(head, 2), true);
  assert.equal(down(head.querySelector(".runes-sn"), 2), true);
});
