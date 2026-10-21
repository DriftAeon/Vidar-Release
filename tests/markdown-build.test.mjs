// Markdown builder trust boundary (src/panels/markdown-build.ts): hostile Markdown becomes inert DOM,
// the builder never goes through an HTML string, and oversized or over-deep input falls back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { renderMarkdownOrText } = await import("../src/panels/markdown-build.ts");

test("markdown build: links, images and raw HTML come out inert", () => {
  const src = [
    "[click](https://e.example/a) <https://e.example>",
    "",
    "![pic](https://e.example/x.png)",
    "",
    "<script>alert(1)</script><img src=x onerror=alert(1)>",
    "",
    "<iframe src=\"https://e.example\"></iframe>",
  ].join("\n");
  const { el, dropped, fellBack } = renderMarkdownOrText("a.md", src);
  assert.equal(fellBack, false);
  assert.equal(el.querySelectorAll("a, img, script, iframe, [onerror], [href], [src]").length, 0);
  const links = el.querySelectorAll("span.doc-link");
  assert.equal(links.length, 2);
  assert.equal(links[0].title, "https://e.example/a");
  assert.match(el.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(el.textContent, /\[image: pic\]/);
  assert.equal(dropped.image, 1);
});

test("markdown build: the builder never parses an HTML string", () => {
  const code = readFileSync(new URL("../src/panels/markdown-build.ts", import.meta.url), "utf8")
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|\.render\(|document\.write/);
});

// Retired rune rendered-dom-textcontent: no HTML-string sink anywhere in the Rendered body.
// Allow-list: path -> reason (none today).
const RENDERED_SINK_ALLOW = new Map();
function renderedFiles() {
  const root = new URL("../src/panels/", import.meta.url);
  const out = [new URL("rendered.ts", root)];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(u); else if (/\.tsx?$/.test(e.name)) out.push(u);
    }
  };
  walk(new URL("rendered/", root));
  return out;
}
const SINK = /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write/;

test("rendered body: no file under src/panels/rendered/** or rendered.ts uses an HTML-string sink", () => {
  const files = renderedFiles();
  assert.ok(files.length > 20);
  for (const u of files) {
    const rel = u.pathname.split("/src/panels/")[1];
    if (RENDERED_SINK_ALLOW.has(rel)) continue;
    const code = readFileSync(u, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, SINK, rel);
  }
});

test("markdown build: softBreaks br keeps single newlines as line breaks, default folds them", () => {
  const src = ["one", "two", "three", "", "```", "a", "b", "```"].join("\n");
  const br = renderMarkdownOrText("a.md", src, { softBreaks: "br" });
  assert.equal(br.el.querySelectorAll("p br").length, 2);
  assert.equal(br.el.querySelectorAll("br").length, 2);
  assert.equal(br.el.querySelector("pre code").textContent, "a\nb\n");
  assert.equal(br.el.querySelectorAll("pre br").length, 0);
  const def = renderMarkdownOrText("a.md", src);
  assert.equal(def.el.querySelectorAll("br").length, 0);
  assert.equal(def.el.querySelector("p").textContent, "one two three");
});

test("markdown build: oversized and over-deep input fall back instead of building", () => {
  const big = renderMarkdownOrText("a.md", "x".repeat(3 * 1024 * 1024));
  assert.ok(big.fellBack);
  assert.equal(big.el.childNodes.length, 0);

  const deep = renderMarkdownOrText("a.md", "> ".repeat(90) + "x");
  assert.ok(deep.fellBack);
});
