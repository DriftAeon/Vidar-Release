import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createStMenu } = await import("../src/panels/rendered/st-menu.ts");

test("a menu reopened after a row pick survives a click on its anchor", async () => {
  const S = { stMenu: null };
  const { openStMenu } = createStMenu(S);
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const picked = [];
  const items = [{ label: "One", value: "one" }, { label: "Two", value: "two" }];
  const tick = () => new Promise((r) => setTimeout(r, 5));

  openStMenu(anchor, items, (v) => picked.push(v));
  await tick();
  S.stMenu.querySelector("button").click();
  assert.deepEqual(picked, ["one"]);
  assert.equal(S.stMenu, null);

  // the real flow: the status-bar button's own click handler opens the menu
  anchor.addEventListener("click", () => openStMenu(anchor, items, (v) => picked.push(v)));
  anchor.click();
  await tick();
  assert.ok(S.stMenu, "reopening by the anchor click lost the menu to a stale away-listener");
  // a second click on the open menu's anchor toggles it closed (2026-10-04)
  anchor.click();
  await tick();
  assert.equal(S.stMenu, null);
});
