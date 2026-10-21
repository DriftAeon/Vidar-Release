// Flow mount contract: mountFlowView into a detached parent, attach, show/hide, then
// disposeFlowView (panels/flow.ts) must leave no #flow-view, no body-level popover card or
// connector (popover.ts), no window/document listener and no running ResizeObserver; a remount
// after it yields exactly one card.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  answers: {
    flow_store_open: { writable: true, entries: {}, page: 1, seq: 0 },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
  },
});
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage(); // main.ts runs this before any mount

test("flow mount: dispose leaves nothing behind and a remount has one popover", async () => {
  const baseline = dom.ledger.count();
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  assert.ok(document.querySelector(".flow-pop"), "popover card not mounted on body");
  document.body.appendChild(parent);
  flow.onFlowShown();
  await dom.flush();
  flow.onFlowHidden();
  flow.disposeFlowView();
  await dom.flush();

  assert.equal(document.querySelector("#flow-view"), null, "#flow-view outlived dispose");
  assert.equal(document.querySelector(".flow-pop, .flow-pop-connector"), null, "popover outlived dispose");
  assert.equal(dom.ledger.count(), baseline, `window/document listeners left: ${dom.ledger.types().join(", ")}`);
  assert.ok(dom.observers.length > 0 && dom.observers.every((o) => o.disconnected), "a ResizeObserver still runs");

  flow.mountFlowView(document.createElement("div"), () => {});
  assert.equal(document.querySelectorAll(".flow-pop").length, 1, "remount left more than one popover card");
  flow.disposeFlowView();
});
