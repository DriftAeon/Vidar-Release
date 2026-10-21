// An empty text_done for a block that never drew (an abandoned stream's close, claude-blocks.ts)
// must not create the block: textStart seals the current tool group, splitting it in two.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/document": `export function renderMarkdownOrText(_n, md) { const el = document.createElement("div"); el.textContent = md; return { el, fellBack: null }; }`,
  },
});
const { createTextStream } = await import("../src/panels/rendered/text-stream.ts");

function mk() {
  const transcript = document.createElement("div");
  let seals = 0;
  const S = { replaying: false, hydrating: false, interimCandidates: [] };
  const ts = createTextStream(S, {
    transcript, follow: { toBottom: () => {} },
    append: (n, p = transcript) => p.appendChild(n),
    sealGroup: () => { seals++; }, toolHost: () => transcript,
  });
  return { transcript, ts, seals: () => seals };
}

test("an empty close of an undrawn block seals nothing and draws nothing", () => {
  const { transcript, ts, seals } = mk();
  ts.textDone("m1:0", "", null);
  assert.equal(seals(), 0, "the empty close sealed the tool group");
  assert.equal(transcript.children.length, 0);
});

test("an empty close of a drawn block removes it", () => {
  const { transcript, ts } = mk();
  ts.textDelta("m1:0", "par");
  assert.equal(transcript.children.length, 1);
  ts.textDone("m1:0", "", null);
  assert.equal(transcript.children.length, 0, "the stale preview stayed drawn");
});
