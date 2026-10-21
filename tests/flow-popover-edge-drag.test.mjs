import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  answers: {
    flow_store_open: { writable: true, entries: {}, page: 1, seq: 0 },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
  },
});
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const { S } = await import("../src/flow/state.ts");
const { setSelection } = await import("../src/flow/selection.ts");
const { renderPopover, repositionPopover } = await import("../src/flow/popover.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();

test("edge drag hides the selected popover until drop or cancellation", () => {
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  S.canvasEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 });
  S.canvasEl.setPointerCapture = () => {};
  S.scale = 1;
  S.panX = 100;
  S.panY = 0;
  const source = S.nodes.find((n) => n.outputs.length);
  assert.ok(source);
  setSelection(new Set([source.id]));

  const card = document.querySelector(".flow-pop");
  const connector = document.querySelector(".flow-pop-connector");
  const port = S.nodeEls.get(source.id).querySelector(".flow-port-out");
  assert.equal(card.style.display, "");
  assert.equal(connector.style.display, "");

  const start = () => {
    port.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    assert.equal(S.dragging?.kind, "edge");
    assert.equal(card.style.display, "none");
    assert.equal(connector.style.display, "none");
    assert.deepEqual([...S.selected], [source.id]);
    renderPopover();
    repositionPopover();
    assert.equal(card.style.display, "none");
    assert.equal(connector.style.display, "none");
  };

  start();
  S.canvasEl.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 3000, clientY: 3000 }));
  assert.equal(S.dragging, null);
  assert.equal(card.style.display, "");
  assert.equal(connector.style.display, "");

  start();
  S.canvasEl.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
  assert.equal(S.dragging, null);
  assert.equal(card.style.display, "");
  assert.equal(connector.style.display, "");
  assert.deepEqual([...S.selected], [source.id]);

  const target = S.nodes.find((n) => n.id !== source.id && n.kind === "output");
  assert.ok(target);
  const inPort = S.nodeEls.get(target.id).querySelector(".flow-port-in");
  inPort.getBoundingClientRect = () => ({ left: 500, right: 520, top: 500, bottom: 520, width: 20, height: 20 });
  start();
  setSelection(new Set([target.id]));
  assert.equal(card.style.display, "none");
  S.canvasEl.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 510, clientY: 510 }));
  assert.equal(S.dragging, null);
  assert.ok(S.edges.some((e) => e.from.node === source.id && e.to.node === target.id));
  assert.equal(card.style.display, "");
  assert.equal(connector.style.display, "");
  assert.deepEqual([...S.selected], [target.id]);
  assert.match(card.textContent, /Output/);

  flow.disposeFlowView();
  parent.remove();
});
