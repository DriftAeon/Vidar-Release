// The login card's folded "Logged In" row carries one Dismiss control (the card shell's dismiss part)
// for Codex and Claude alike; it removes the row from the view only, and a card still asking has none.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { loginCard } = await import("../src/panels/rendered/api-key-card.ts");

const noop = { chatgpt() {}, apiKey() {}, cancel() {} };

test("an open login card has no dismiss control", () => {
  const c = loginCard(noop);
  assert.equal(c.card.querySelector(".card-dismiss"), null);
});

test("the folded row has one Dismiss that removes the card", () => {
  const host = document.createElement("div");
  const c = loginCard(noop);
  host.append(c.card);
  c.fold();
  const x = c.card.querySelectorAll(".card-dismiss");
  assert.equal(x.length, 1);
  assert.equal(x[0].title, "Dismiss");
  x[0].click();
  assert.equal(host.contains(c.card), false);
});

test("a look-driven (Claude) card folds with the same control", () => {
  const c = loginCard(noop, { title: "Log In To Claude", choices: () => [] });
  c.fold();
  assert.equal(c.card.querySelectorAll(".card-dismiss").length, 1);
});
