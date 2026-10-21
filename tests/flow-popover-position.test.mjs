import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { S } = await import("../src/flow/state.ts");
const { positionPopover } = await import("../src/flow/popover-position.ts");

function fixture(height = 300) {
  const node = { id: "selected", x: 100, y: 400 };
  const nodeEl = document.createElement("div");
  const header = document.createElement("div");
  header.className = "flow-node-header";
  Object.defineProperty(header, "offsetHeight", { value: 32 });
  nodeEl.append(header);
  Object.defineProperties(nodeEl, { offsetWidth: { value: 240 }, offsetHeight: { value: 80 } });
  S.nodeEls = new Map([[node.id, nodeEl]]);
  S.scale = 1;
  S.panX = S.panY = 0;
  S.canvasEl = document.createElement("div");
  S.canvasEl.getBoundingClientRect = () => ({ left: 50, top: 100, width: 1000, height: 500 });
  const card = document.createElement("div");
  // jsdom has no layout. Model the browser's height cap, including a stale previous cap.
  card.style.maxHeight = "150px";
  Object.defineProperty(card, "offsetHeight", {
    get: () => Math.min(height, parseFloat(card.style.maxHeight) || height),
  });
  const connector = document.createElement("div");
  return { node, card, connector };
}

test("bottom-edge card shifts only enough to fit; connector stays on selected node", () => {
  const { node, card, connector } = fixture();
  positionPopover(card, connector, node);
  assert.equal(card.style.top, "292px");
  assert.equal(connector.style.top, "515px");
  assert.equal(connector.style.left, "390px");
  const firstTop = card.style.top;
  positionPopover(card, connector, node);
  assert.equal(card.style.top, firstTop, "placement must not change on a second frame");
});

test("oversized card stays inside graph while connector follows pan, zoom and left placement", () => {
  const { node, card, connector } = fixture(900);
  node.x = 700;
  positionPopover(card, connector, node);
  assert.equal(card.style.maxHeight, "492px");
  assert.equal(card.style.top, "100px");
  assert.equal(card.style.left, "434px");
  assert.equal(connector.style.top, "515px");
  S.scale = 0.5;
  S.panY = 50;
  positionPopover(card, connector, node);
  assert.equal(connector.style.top, "357px");
  assert.equal(card.style.top, "100px");
  assert.equal(connector.style.display, "");
});

test("offscreen node hides card and line; returning restores them", () => {
  const { node, card, connector } = fixture();
  S.panY = -1000;
  positionPopover(card, connector, node);
  assert.equal(card.style.display, "none");
  assert.equal(connector.style.display, "none");
  S.panY = 0;
  positionPopover(card, connector, node);
  assert.equal(card.style.display, "");
  assert.equal(connector.style.display, "");
});
