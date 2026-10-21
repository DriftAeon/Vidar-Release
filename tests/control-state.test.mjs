// control(): a state change patches the button in place, and a press while aria-disabled never
// reaches onPress (aria-disabled, unlike `disabled`, still delivers clicks). jsdom stands in for WebView2.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  MouseEvent: window.MouseEvent,
});
const { control } = await import("../src/panels/controls/control.ts");

test("a focused control keeps its node and focus across set({ blocked: true })", () => {
  const c = control({ cls: "st-btn", text: "Opus", onPress: () => {} });
  document.body.replaceChildren(c.el);
  c.el.focus();
  const node = c.el;
  c.set({ blocked: true, text: "Opus" });
  assert.equal(c.el, node);
  assert.equal(node.isConnected, true);
  assert.equal(document.activeElement, node);
  assert.equal(node.getAttribute("aria-disabled"), "true");
  assert.equal(node.hasAttribute("data-block"), true);
});

test("a click while aria-disabled does not call onPress", () => {
  let pressed = 0;
  const c = control({ cls: "st-btn", text: "Plan", onPress: () => { pressed++; } });
  document.body.replaceChildren(c.el);
  c.set({ pending: true });
  c.el.click();
  assert.equal(pressed, 0);
  c.set({ pending: false });
  c.el.click();
  assert.equal(pressed, 1);
});
