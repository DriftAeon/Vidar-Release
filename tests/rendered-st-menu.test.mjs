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

test("an anchor click while open closes the menu once and does not reopen it", async () => {
  const S = { stMenu: null };
  const { openStMenu } = createStMenu(S);
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  anchor.addEventListener("click", () => openStMenu(anchor, [{ label: "One", value: "one" }], () => {}));
  anchor.click();
  assert.ok(S.stMenu);
  anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // exempt: only the click toggles
  assert.ok(S.stMenu);
  anchor.click();
  assert.equal(S.stMenu, null);
  assert.equal(document.querySelector(".st-menu"), null);
});

test("arrow keys, Home and End move focus between rows and wrap; Tab is left alone", () => {
  const S = { stMenu: null };
  const { openStMenu } = createStMenu(S);
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  openStMenu(anchor, [{ label: "One", value: "one" }, { label: "Two", value: "two" }, { label: "Three", value: "three" }], () => {});
  const rows = [...S.stMenu.querySelectorAll("button")];
  const press = (key) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(e);
    return e;
  };
  assert.equal(document.activeElement, rows[0]);
  press("ArrowDown"); assert.equal(document.activeElement, rows[1]);
  press("ArrowDown"); press("ArrowDown"); assert.equal(document.activeElement, rows[0], "ArrowDown wraps");
  press("ArrowUp"); assert.equal(document.activeElement, rows[2], "ArrowUp wraps");
  press("Home"); assert.equal(document.activeElement, rows[0]);
  press("End"); assert.equal(document.activeElement, rows[2]);
  assert.equal(press("Tab").defaultPrevented, false);
  assert.ok(S.stMenu, "Tab leaves the menu open");
  S.stMenu.querySelector("button").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});

test("Escape closes the menu and refocuses the anchor", () => {
  const S = { stMenu: null };
  const { openStMenu } = createStMenu(S);
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  openStMenu(anchor, [{ label: "One", value: "one" }], () => {});
  assert.ok(S.stMenu);
  S.stMenu.querySelector("button").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(S.stMenu, null);
  assert.equal(document.activeElement, anchor);
});
