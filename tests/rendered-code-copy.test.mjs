// A fenced block in agent text gets one Copy button; a click copies the raw source; a streaming
// repaint (morph) keeps the one button instead of adding another.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    clipboard: `export function copyText(t) { (globalThis.__copied ??= []).push(t); return Promise.resolve(true); }`,
    // minimal fence parser: ```\n...(\n```)? -> <div class=doc-md><pre><code>raw</code></pre></div>
    "panels/document": `export function renderMarkdownOrText(_n, md) {
      const root = document.createElement("div"); root.className = "doc-md";
      const m = /\`\`\`[^\\n]*\\n([\\s\\S]*?)(\\n\`\`\`|$)/.exec(md);
      if (m) { const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = m[1]; pre.appendChild(code); root.appendChild(pre); }
      else root.textContent = md;
      return { el: root, fellBack: null };
    }`,
  },
});
const { createTextStream } = await import("../src/panels/rendered/text-stream.ts");

function mk() {
  const transcript = document.createElement("div");
  const S = { replaying: false, hydrating: false, interimCandidates: [] };
  const ts = createTextStream(S, {
    transcript, follow: { toBottom: () => {} },
    append: (n, p = transcript) => p.appendChild(n),
    sealGroup: () => {}, toolHost: () => transcript,
  });
  return { transcript, ts };
}
const buttons = (root) => root.querySelectorAll("pre > button.code-copy");

test("a fenced block gets one Copy button named Copy", () => {
  const { transcript, ts } = mk();
  ts.textDone("m1:0", "text\n```js\nconst a = 1;\n```", null);
  const b = buttons(transcript);
  assert.equal(b.length, 1);
  assert.equal(b[0].getAttribute("aria-label"), "Copy");
  assert.equal(b[0].title, "Copy");
});

test("a click copies the raw source", async () => {
  globalThis.__copied = [];
  const { transcript, ts } = mk();
  ts.textDone("m1:0", "```js\nconst a = 1;\n```", null);
  buttons(transcript)[0].click();
  assert.deepEqual(globalThis.__copied, ["const a = 1;"]);
});

test("a repaint of a streaming block keeps one button and copies what has arrived", async () => {
  globalThis.__copied = [];
  const { transcript, ts } = mk();
  ts.textDone("m1:0", "```js\nline one", null);
  const first = buttons(transcript)[0];
  ts.textDone("m1:0", "```js\nline one\nline two", null);
  assert.equal(buttons(transcript).length, 1);
  assert.equal(buttons(transcript)[0], first, "the button node was rebuilt");
  first.click();
  assert.deepEqual(globalThis.__copied, ["line one\nline two"]);
});
