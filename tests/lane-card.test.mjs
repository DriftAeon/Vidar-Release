// W2-8: the spawn/prompt card's Text row is the whole text that approval sends, never a cut.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({});
const { cardText } = await import("../src/control/lane-card.ts");

test("the spawn card Text row carries a 64 KiB, 300-line text whole", () => {
  const body = Array.from({ length: 300 }, (_, i) => `${i}${"x".repeat(200)}`).join("\n");
  const text = body + "z".repeat(65536 - body.length);
  assert.equal(text.split("\n").length, 300);
  assert.equal(new TextEncoder().encode(text).length, 64 * 1024);
  assert.equal(cardText(text), text);
});
