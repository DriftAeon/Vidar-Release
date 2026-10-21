// Stale pills (tool-pills.ts stalePill): the "no result recorded" note is its own span, added
// once, so the summary's URL spans survive; a late result removes only that pill's note.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createToolPills } = await import("../src/panels/rendered/tool-pills.ts");

function mk() {
  const transcript = document.createElement("div");
  const tools = new Map();
  const group = () => ({ details: transcript, label: document.createElement("span"), counts: new Map(), sealed: false, error: false, userToggled: false, thinking: new Set() });
  const pills = createToolPills({}, {
    transcript, tools, awaiting: new Map(),
    append: (n, p = transcript) => p.appendChild(n),
    groupFor: group, groupCount: () => {}, groupRefresh: () => {}, groupError: () => {},
    markInterim: () => {}, attachCard: () => {}, agent: "claude",
  });
  return { tools, pills };
}
const notes = (details) => details.querySelectorAll(":scope > summary > .tool-summary > .tool-stale-note");

test("stalePill adds one note, twice-called stays one, and URL spans survive", () => {
  const { tools, pills } = mk();
  pills.toolStart("t1", "WebFetch", { url: "https://example.com/path" }, undefined, null);
  const t = tools.get("t1");
  const summary = t.details.querySelector(".tool-summary");
  assert.ok(summary.querySelector(".url-host"), "the fixture drew no URL spans");
  pills.stalePill(t);
  pills.stalePill(t);
  assert.equal(notes(t.details).length, 1, "the stale note was added twice");
  assert.ok(summary.querySelector(".url-scheme") && summary.querySelector(".url-host") && summary.querySelector(".url-path"), "the URL spans were flattened");
});

test("toolDone removes its own stale note and leaves a nested child's", () => {
  const { tools, pills } = mk();
  pills.toolStart("p", "Agent", { description: "x" }, undefined, null);
  pills.toolStart("c", "WebFetch", { url: "https://example.com/a" }, undefined, "p");
  const p = tools.get("p"), c = tools.get("c");
  pills.stalePill(p);
  pills.stalePill(c);
  pills.toolDone("p", "ok", false, undefined, undefined, null);
  assert.equal(notes(p.details).length, 0, "the parent kept its stale note");
  assert.equal(notes(c.details).length, 1, "the parent's result removed the child's note");
  assert.ok(c.details.querySelector(".tool-summary .url-host"), "the child's URL spans went");
});
