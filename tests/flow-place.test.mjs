// New nodes land clear of existing ones: freeSpot is pure, and the "+" palette's three place
// functions go through it. The card's ADD belongs to Modifiers and adds no node.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

// jsdom rejects Node's AbortSignal in addEventListener options; the palette's outside-close uses one.
setupDom({
  answers: {
    flow_store_open: { writable: true, entries: {}, page: 1, seq: 0 },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
    rune_vault_list: () => [],
  },
});
globalThis.AbortController = window.AbortController;
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const { S, NODE_W } = await import("../src/flow/state.ts");
const { setSelection } = await import("../src/flow/selection.ts");
const { freeSpot, NODE_H_NOMINAL } = await import("../src/flow/place.ts");
const { openNodeKindPalette } = await import("../src/flow/palette.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();

const GRID = 16;
const hit = (a, b) =>
  a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H_NOMINAL && b.y < a.y + NODE_H_NOMINAL;

test("the same drop point twice gives two non-intersecting rects", () => {
  const nodes = [];
  const at = { x: 200, y: 200 };
  const a = freeSpot(at, nodes, GRID);
  nodes.push(a);
  const b = freeSpot(at, nodes, GRID);
  assert.ok(!hit(a, b));
  assert.equal(b.x % GRID, 0);
  assert.equal(b.y % GRID, 0);
});

test("a blank flow's Input and Output are cleared by a drop between them", () => {
  const nodes = [{ x: 0, y: 80 }, { x: 0, y: 176 }];
  const p = freeSpot({ x: 128, y: 144 }, nodes, GRID);
  for (const n of nodes) assert.ok(!hit(p, n), `overlaps ${JSON.stringify(n)}`);
});

test("Agent then Custom through the DOM adds one node; the card's ADD adds none", () => {
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const pick = (anchor, label) => {
    const item = [...anchor.querySelectorAll(".flow-palette-item")].find((i) => i.textContent === label);
    assert.ok(item, `no ${label} item`);
    click(item);
  };
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);

  const before = S.nodes.length;
  const at = { x: 128, y: 144 };
  openNodeKindPalette(anchor, at);
  pick(anchor, "Agent");
  pick(anchor, "Custom");
  assert.equal(S.nodes.length, before + 1);
  const first = S.nodes[S.nodes.length - 1];

  openNodeKindPalette(anchor, at);
  pick(anchor, "Agent");
  pick(anchor, "Custom");
  assert.equal(S.nodes.length, before + 2);
  const second = S.nodes[S.nodes.length - 1];
  assert.ok(!hit(first, second));
  for (const n of S.nodes.slice(0, before)) assert.ok(!hit(second, n), `overlaps ${n.id}`);

  setSelection(new Set([second.id]));
  const add = document.querySelector(".flow-pop .flow-pop-chip-add");
  assert.ok(add, "card has an ADD button");
  click(add);
  assert.equal(S.nodes.length, before + 2);

  flow.disposeFlowView();
  parent.remove();
  anchor.remove();
});
