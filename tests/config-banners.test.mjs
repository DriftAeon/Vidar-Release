// Config banners (src/config-banners.ts): the close button dismisses for the page's life, the same
// text stays dismissed, new text shows it again, clearBanner removes it. jsdom stands in for WebView2.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "icons": "export function lucide(name) { const s = document.createElement('i'); s.dataset.icon = name; return s; }",
  },
});
const { setBanner, clearBanner } = await import("../src/config-banners.ts");

const text = (id) => document.querySelector(`#${id} .banner-text`)?.textContent;

test("a banner carries an icon-only Dismiss button and keeps it when the text is replaced", () => {
  setBanner("config-notice", "first");
  const btn = document.querySelector("#config-notice button");
  assert.equal(btn.title, "Dismiss");
  assert.equal(btn.getAttribute("aria-label"), "Dismiss");
  assert.equal(btn.textContent, "");
  assert.equal(btn.querySelector("[data-icon]").dataset.icon, "x");
  setBanner("config-notice", "second");
  assert.equal(document.querySelectorAll("#config-notice").length, 1);
  assert.equal(document.querySelector("#config-notice button"), btn);
  assert.equal(text("config-notice"), "second");
});

test("dismiss removes the banner, the same text stays dismissed, new text shows it again", () => {
  setBanner("prefs-error", "disk full");
  document.querySelector("#prefs-error button").click();
  assert.equal(document.getElementById("prefs-error"), null);
  setBanner("prefs-error", "disk full");
  assert.equal(document.getElementById("prefs-error"), null);
  setBanner("prefs-error", "read only");
  assert.equal(text("prefs-error"), "read only");
});

test("clearBanner removes the banner and ignores an absent one", () => {
  setBanner("config-error", "bad json");
  clearBanner("config-error");
  assert.equal(document.getElementById("config-error"), null);
  clearBanner("config-error");
});
