import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// Exercise the real sanitizer and CSSOM. jsdom 30 supports constructed sheets;
// no parser shim, script execution, resource loading or live Vidar is needed.
// These are structure/policy checks, not measurements of WebView2 enforcement.
const { window } = new JSDOM("<!doctype html><html><body></body></html>");
for (const name of [
  "document", "DOMParser", "Node", "CSSStyleSheet", "CSSStyleRule", "CSSMediaRule",
  "CSSSupportsRule", "CSSKeyframesRule", "CSSKeyframeRule", "CSSImportRule", "CSSFontFaceRule",
]) globalThis[name] = window[name];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
after(() => window.close());

const { reconstruct, buildDocument, structuralCheck, renderPreview, filterDecls, hasExternalRef } =
  await import("../src/panels/preview.ts");
// Hostile CSS cases: the filter must record a drop for each.
const hostileCss = new Set([
  "style-import", "style-url", "style-url-escaped", "style-custom-prop-var", "style-var-fallback",
  "style-nested", "style-keyframes", "style-image-set", "inline-style-url", "font-face", "cursor-url",
]);
// jsdom's CSS parser drops these declarations before filterDecls sees them, so the
// drop-count assert cannot hold; the direct unit test below covers the filter instead.
const jsdomDropsEarly = new Set(["style-url-escaped", "style-image-set"]);
const fixtures = new URL("./preview-fixtures/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtures), "utf8"));
const parse = (html) => new DOMParser().parseFromString(html, "text/html");
const fallbackReasons = {
  "budget-2mib": "input over 2 MiB",
  "budget-deep": "nesting over 256 deep",
};

test("preview corpus contains all 41 distinct manifest cases", () => {
  assert.equal(manifest.cases.length, 41);
  assert.equal(new Set(manifest.cases.map((c) => c.id)).size, 41);
});

for (const c of manifest.cases) {
  test(`preview corpus: ${c.id} (${c.category})`, () => {
    assert.equal(c.expect["recon-only"], "none", "manifest must require inert reconstruction");
    const input = readFileSync(new URL(c.file, fixtures), "utf8")
      .replaceAll("{{URL}}", `https://preview.invalid/${c.id}`)
      .replaceAll("{{SENTINEL}}", `vidar-sentinel:corpus:${c.id}`);
    const result = reconstruct(input);
    if (fallbackReasons[c.id]) {
      assert.deepEqual(result.fellBack, { reason: fallbackReasons[c.id] });
      assert.equal(result.body, "");
      assert.deepEqual(result.styles, []);
    } else {
      assert.equal(result.fellBack, false, "do not pass by dropping the whole document");
    }
    assert.equal(result.dropped["css-parse"] ?? 0, 0, "CSS must be parsed, not silently discarded");
    if (hostileCss.has(c.id) && !jsdomDropsEarly.has(c.id)) {
      const drops = (result.dropped["css-decl"] ?? 0) + (result.dropped["css-rule"] ?? 0) + (result.dropped["css-nested"] ?? 0);
      assert.ok(drops > 0, "the filter must record a drop, not pass because the parser never saw the declaration");
    }
    // Omit CSP so a clean check cannot be credited to the policy layer.
    const output = buildDocument(result, false);
    assert.deepEqual(structuralCheck(output), []);
    // Independent oracle: the URL a case plants must not appear anywhere in the output.
    assert.ok(!output.includes("https://preview.invalid/" + c.id), "planted URL survived");
    const doc = parse(output);
    // The sentinel sits in script/handler/href payloads. It may survive only as inert
    // text (the sanitizer keeps a dead link's href as a title); never as code or a live attribute.
    const sentinel = `vidar-sentinel:corpus:${c.id}`;
    if (input.includes(sentinel)) {
      for (const el of doc.querySelectorAll("*")) {
        assert.ok(!el.textContent.includes(sentinel) || el.children.length > 0, "sentinel in element text");
        for (const a of el.attributes) {
          if (a.value.includes(sentinel)) assert.equal(a.name, "title", `sentinel in live attribute ${a.name}`);
        }
      }
    }
    assert.equal(doc.querySelector(
      "script, iframe, object, embed, link, base, form, input, button, video, source, picture, a, foreignObject, image",
    ), null, "active, navigable and unsupported elements must not survive");
    assert.equal(doc.querySelector('meta[http-equiv="refresh"]'), null);

    // Positive controls keep useful content; blanket removal must fail the suite.
    switch (c.id) {
      case "pos-data-png":
        assert.match(doc.querySelector("img").getAttribute("src"), /^data:image\/png;base64,/);
        break;
      case "pos-inline-svg":
        assert.equal(doc.querySelector("use").getAttribute("href"), "#s");
        assert.equal(doc.querySelector("rect").getAttribute("fill"), "url(#g)");
        break;
      case "pos-head-style-table":
        assert.equal(doc.querySelectorAll("td").length, 2);
        assert.equal(result.styles.length, 1);
        assert.match(result.styles[0], /border:\s*2px solid teal/);
        break;
      case "pos-details":
        assert.equal(doc.querySelector("details").hasAttribute("open"), true);
        assert.equal(doc.querySelector("summary").textContent, "sum");
        break;
      case "pos-url-in-prose":
        assert.match(doc.body.textContent, /http:\/\/example\.com\/docs/);
        assert.equal(doc.querySelector("span").getAttribute("title"), "http://example.com/");
        break;
      case "pos-malformed-mixed":
        assert.equal(doc.querySelector("b").textContent.includes("bold"), true);
        assert.ok(doc.querySelector("rect"));
        break;
      case "pos-style-frag-url":
        assert.match(doc.querySelector("rect").getAttribute("style"), /clip-path:\s*url\(["']?#c["']?\)/);
        break;
      case "budget-css-rules":
        assert.ok(result.dropped["css-rule-cap"] > 0, "oversized sheets must hit the rule budget");
        assert.ok(result.styles.length > 0, "keep rules within the budget");
        break;
    }
  });
}

test("filter rejects Blink's serialised forms of the jsdom-dropped cases", () => {
  for (const val of ['url("https://preview.invalid/x")', 'image-set("https://preview.invalid/x" 1x)']) {
    assert.equal(hasExternalRef(val), true, val);
    const dropped = {};
    const style = { length: 1, 0: "background-image", getPropertyValue: () => val, getPropertyPriority: () => "" };
    assert.deepEqual(filterDecls(style, dropped), [], val);
    assert.equal(dropped["css-decl"], 1, val);
  }
  assert.equal(hasExternalRef('url("#g")'), false);
});

test("preview structural check rejects external resources and handlers without rejecting prose", () => {
  for (const body of [
    '<img src="https://preview.invalid/image">',
    '<svg><use href="https://preview.invalid/svg#x"/></svg>',
    '<p onclick="alert(1)">x</p>',
    '<p style="background-image:url(https://preview.invalid/image)">x</p>',
    '<style>@font-face { font-family: p; src: url(https://preview.invalid/font) }</style>',
    '<style>p { background-image: url(https://preview.invalid/image) }</style>',
  ]) assert.ok(structuralCheck(`<html><head></head><body>${body}</body></html>`).length > 0, body);
  assert.deepEqual(structuralCheck('<p>https://preview.invalid/prose</p>'), []);
});

test("HTML preview puts the resource-denying CSP first and keeps an empty sandbox", () => {
  // Exercise renderPreview itself: testing buildDocument alone misses a caller
  // disabling CSP or adding permissions through mountFrame's harness arguments.
  const result = renderPreview("html", '<html><head><style>p { color: red }</style></head><body><p>Preview</p></body></html>');
  assert.equal(result.fellBack, false);
  assert.equal(result.el.localName, "iframe");
  assert.equal(result.el.getAttribute("sandbox"), "", "no scripts, same-origin or navigation permissions");
  const doc = parse(result.el.srcdoc);
  const policies = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  assert.equal(policies.length, 1);
  assert.equal(doc.head.firstElementChild, policies[0], "policy precedes all content and styles");
  assert.deepEqual(
    policies[0].getAttribute("content").split(";").map((d) => d.trim()).sort(),
    ["default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'", "img-src data:", "base-uri 'none'", "form-action 'none'"].sort(),
  );
  assert.equal(doc.querySelector("p").textContent, "Preview");
});
