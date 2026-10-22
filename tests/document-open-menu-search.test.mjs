import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
globalThis.CSS ??= { escape: (value) => value }; // jsdom omits CSS.escape; fixture keys need no escaping
const { mountOpenMenu, setCatalog } = await import("../src/panels/document-open-menu.ts");
const picker = document.createElement("button");
document.body.append(picker);
mountOpenMenu(picker, { onNew() {}, onOpen() {}, openPath: () => undefined });

const entry = (path, group, mtime_ms) => ({ path, group, kind: "md", mtime_ms });
const inbox = entry("D:\\docs\\inbox\\Shared Note.md", "Inbox", 100);
const review = entry("D:\\display\\reviews\\Shared Review.md", "Reviews", 300);
const run = entry("D:\\runs\\one\\briefs\\Other.md", "Run · one", 200);
const files = () => [...document.querySelectorAll(".doc-om-file")];
const press = (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key, bubbles: true, cancelable: true,
}));

test("Document Open search spans folders and survives catalog refresh until Escape clears and closes", () => {
  setCatalog([inbox, review, run]);
  picker.click();
  let search = document.querySelector(".doc-om-search");
  assert.equal(document.activeElement, search, "menu opens in the search field");
  assert.equal(search.type, "search");
  assert.equal(search.placeholder, "");
  assert.equal(search.getAttribute("aria-label"), "Search Documents");
  assert.equal(search.spellcheck, false);

  search.value = "sHaReD";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(files().map((row) => row.dataset.value), [review.path, inbox.path], "all folders, newest first");
  assert.deepEqual(files().map((row) => row.querySelector(".t").textContent), ["Reviews", "Inbox"]);
  assert.deepEqual([...document.querySelectorAll(".doc-om-fold")].map((row) => row.querySelector(".nm").textContent),
    ["Inbox", "Reviews", "Runs"], "search leaves the folder pane intact");

  press(search, "ArrowDown");
  assert.equal(document.activeElement, files()[0]);
  press(files()[0], "ArrowUp");
  assert.equal(document.activeElement, search);
  search.setSelectionRange(3, 3);

  const refreshed = entry("D:\\docs\\inbox\\Shared New.md", "Inbox", 400);
  setCatalog([inbox, review, run, refreshed]);
  search = document.querySelector(".doc-om-search");
  assert.equal(document.activeElement, search, "catalog refresh keeps focus");
  assert.equal(search.value, "sHaReD", "catalog refresh keeps the query");
  assert.equal(search.selectionStart, 3, "catalog refresh keeps the caret");
  assert.deepEqual(files().map((row) => row.dataset.value), [refreshed.path, review.path, inbox.path]);

  press(search, "Escape");
  assert.equal(document.querySelector("#doc-om") !== null, true, "first Escape keeps the menu open");
  assert.equal(search.value, "");
  assert.deepEqual(files().map((row) => row.dataset.value), [refreshed.path, inbox.path], "empty query restores the selected folder");
  press(search, "ArrowDown");
  assert.equal(document.activeElement.dataset.folder, "Inbox");
  press(document.activeElement, "Escape");
  assert.equal(document.querySelector("#doc-om"), null, "second Escape closes the menu");
});
