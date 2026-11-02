// Shared DOM builders in src/dom.ts: button, span, el.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { button, span, el } = await import("../src/dom.ts");

test("button: type, class, text and click handler", () => {
  let n = 0;
  const b = button("Go", "ws-btn x", () => { n++; });
  assert.equal(b.tagName, "BUTTON");
  assert.equal(b.type, "button");
  assert.equal(b.className, "ws-btn x");
  assert.equal(b.textContent, "Go");
  b.click();
  assert.equal(n, 1);
});

test("button: no handler is fine", () => {
  assert.equal(button("", "c").textContent, "");
});

test("span and el: text only when given", () => {
  assert.equal(span("a").textContent, "");
  assert.equal(span("a", "t").textContent, "t");
  const d = el("div", "k", "<b>");
  assert.equal(d.className, "k");
  assert.equal(d.textContent, "<b>");
  assert.equal(el("p").hasAttribute("class"), false);
});
