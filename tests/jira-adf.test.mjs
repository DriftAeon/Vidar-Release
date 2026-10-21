// Jira ADF renderer (jira/adf.ts): allowlisted DOM only, inert links, one traversal budget for the structured
// render and the plain-text fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { adfRenderer } = await import("../src/jira/adf.ts");

const opened = [];
const ctx = { openUrl: (u) => opened.push(u), loadChildren: () => Promise.resolve({ error: { title: "", message: "" } }), alive: () => true };
const para = (...content) => ({ type: "paragraph", content });
const text = (t, marks) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const doc = (...content) => ({ type: "doc", version: 1, content });
const draw = (d) => adfRenderer.render(d, ctx);

const ALLOWED = new Set(["div", "span", "p", "pre", "code", "blockquote", "ul", "ol", "li", "h4", "h5", "hr", "br", "table", "tbody", "tr", "th", "td", "strong", "em", "s", "u"]);

test("blocks and marks map to allowlisted tags with fixed ja classes", () => {
  const { el, fellBack } = draw(doc(
    { type: "heading", attrs: { level: 1 }, content: [text("Big")] },
    { type: "heading", attrs: { level: 4 }, content: [text("Small")] },
    para(text("a", [{ type: "strong" }, { type: "em" }]), text("b", [{ type: "code" }]), text("c", [{ type: "strike" }]), text("d", [{ type: "underline" }])),
    { type: "bulletList", content: [{ type: "listItem", content: [para(text("one"))] }] },
    { type: "orderedList", content: [{ type: "listItem", content: [para(text("two"))] }] },
    { type: "blockquote", content: [para(text("quoted"))] },
    { type: "codeBlock", content: [text("let x = 1;")] },
    { type: "rule" },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [para(text("H"))] }, { type: "tableCell", content: [para(text("C"))] }] }] },
  ));
  assert.equal(fellBack, false);
  const tags = new Set([...el.querySelectorAll("*")].map((n) => n.tagName.toLowerCase()));
  for (const t of tags) assert.ok(ALLOWED.has(t), t);
  assert.deepEqual([...el.querySelectorAll("h4, h5")].map((n) => n.tagName + n.textContent), ["H4Big", "H5Small"]);
  assert.ok(el.querySelector("strong em, em strong"));
  assert.ok(el.querySelector("pre code").textContent === "let x = 1;");
  assert.ok(el.querySelector("table td") && el.querySelector("table th") && el.querySelector("ul li") && el.querySelector("ol li") && el.querySelector("blockquote") && el.querySelector("hr"));
  for (const n of el.querySelectorAll("*")) assert.ok([...n.classList].every((c) => c.startsWith("ja-") || c === "rich-link"), n.className);
});

test("inline nodes read as text: mention, emoji, status, date, media", () => {
  const { el } = draw(doc(para(
    { type: "mention", attrs: { text: "@Ada" } }, text(" "),
    { type: "emoji", attrs: { shortName: ":ok:", text: "ok" } }, text(" "),
    { type: "status", attrs: { text: "In Review", color: "blue" } }, text(" "),
    { type: "date", attrs: { timestamp: "1760000000000" } }, text(" "),
    { type: "media", attrs: { alt: "diagram", id: "x" } },
  )));
  assert.equal(el.textContent, "@Ada ok In Review 2025-10-09 Image diagram");
});

test("a hostile doc yields only allowlisted tags, no href, src, style or on* attributes, and a bad link opens nothing", () => {
  opened.length = 0;
  const { el } = draw(doc(
    { type: "paragraph", attrs: { style: "x", onclick: "alert(1)" }, content: [
      text("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
      text("good", [{ type: "link", attrs: { href: "https://example.com/a" } }]),
      { type: "media", attrs: { src: "javascript:1", alt: "<img src=x onerror=alert(1)>", onerror: "x" } },
    ] },
    { type: "unknownThing", attrs: { style: "x", onclick: "y" }, text: "<script>alert(1)</script>" },
    { type: "<img src=x onerror=1>", content: [text("<b>bold</b>")] },
  ));
  const all = [...el.querySelectorAll("*")];
  for (const n of all) {
    assert.ok(ALLOWED.has(n.tagName.toLowerCase()) || n.classList.contains("rich-link"), n.tagName);
    for (const a of n.getAttributeNames()) assert.ok(!/^(href|src|style|on)/.test(a), `${n.tagName} ${a}`);
  }
  assert.equal(el.querySelector("script, img, b"), null);
  const links = el.querySelectorAll(".rich-link");
  assert.equal(links.length, 2);
  links[0].click();
  assert.deepEqual(opened, []);
  links[1].click();
  assert.deepEqual(opened, ["https://example.com/a"]);
  assert.ok(el.textContent.includes("<script>alert(1)</script>"), "unknown node text stays text");
});

test("a doc nested 10 000 deep falls back to bounded plain text in under a second", () => {
  let inner = text("deep text");
  for (let i = 0; i < 10_000; i++) inner = { type: "blockquote", content: [inner] };
  const t0 = performance.now();
  const { el, fellBack } = draw(doc(inner));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms} ms`);
  assert.ok(fellBack && typeof fellBack.reason === "string");
  assert.equal(el.querySelector("blockquote"), null, "no structured tags in the fallback");
  assert.ok(el.textContent.length <= 100_001);
  assert.ok(el.textContent.includes("deep text"));
});

test("a doc with 100 000 sibling text nodes falls back in under a second with output capped", () => {
  const big = para(...Array.from({ length: 100_000 }, () => text("x".repeat(20))));
  const t0 = performance.now();
  const { el, fellBack } = draw(doc(big));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms} ms`);
  assert.ok(fellBack);
  const len = el.textContent.length;
  assert.ok(len <= 100_001, String(len));
  assert.ok(el.textContent.endsWith("…"));
  assert.ok(el.querySelectorAll("*").length < 10);
});

test("a doc cut by the node budget alone ends the fallback text with the ellipsis", () => {
  const big = para(...Array.from({ length: 25_000 }, () => text("x")));
  const { el, fellBack } = draw(doc(big));
  assert.ok(fellBack);
  assert.ok(el.textContent.length < 100_000);
  assert.ok(el.textContent.endsWith("…"));
});

test("a non-object doc renders empty and excerpt is plain text capped", () => {
  assert.equal(draw(null).el.textContent, "");
  assert.equal(draw("<b>x</b>").el.querySelector("b"), null);
  const d = doc(para(text("one two three four")), para(text("five")));
  assert.equal(adfRenderer.excerpt(d, 100), "one two three four five");
  assert.equal(adfRenderer.excerpt(d, 7), "one two");
  assert.equal(adfRenderer.excerpt(null, 10), "");
});
