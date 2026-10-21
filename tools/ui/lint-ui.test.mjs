import test from "node:test";
import assert from "node:assert/strict";
import { lintText } from "./lint-ui.mjs";

const find = (css, kind) => lintText(css, kind).map((f) => `${f.check}: ${f.property}: ${f.value}`);
const messages = (css, check) => lintText(css).filter((f) => f.check === check).map((f) => f.message);

test("lint-ui: a legacy var is flagged, and passes with a comment on the line", () => {
  assert.deepEqual(find(".a { padding: var(--space-6); }"), ["legacy: padding: var(--space-6)"]);
  assert.deepEqual(find(".a { color: var(--accent2); }"), ["legacy: color: var(--accent2)"]);
  assert.deepEqual(find(".a { padding: var(--space-6); /* matches the old tab strip */ }"), []);
  assert.deepEqual(find(".a { padding: var(--space-4); color: var(--accent); }"), []);
});

test("lint-ui: 6px padding is flagged and names the new-ui neighbours", () => {
  const [m] = messages(".a { padding: 6px; }", "token");
  assert.match(m, /var\(--space-4\) or var\(--space-8\)/);
  assert.deepEqual(find(".a { padding: 6px; /* optical */ }"), []);
});

test("lint-ui: 28px height is on the new scale and points at --row-28", () => {
  const [m] = messages(".a { height: 28px; }", "token");
  assert.match(m, /use var\(--row-28\)/);
  assert.match(messages(".a { line-height: 20px; }", "token")[0], /use var\(--line-20\)/);
});

test("lint-ui: a literal font-family is flagged; var(--font-mono) and inherit pass", () => {
  assert.deepEqual(find('.a { font-family: "Segoe UI", sans-serif; }'), ['family: font-family: "Segoe UI", sans-serif']);
  assert.deepEqual(find(".a { font-family: var(--font-mono); }"), []);
  assert.deepEqual(find(".a { font-family: inherit; }"), []);
});

test("lint-ui: declarations in :root are skipped", () => {
  assert.deepEqual(find(':root { --space-6: 6px; --font-ui: "Segoe UI", sans-serif; color: #fff; }'), []);
});

test("lint-ui: TS inline-style literals are checked, built values are skipped", () => {
  const ts = [
    "function render(el) {",
    '  el.style.fontFamily = "monospace";',
    '  el.style.left = x + "px";',
    '  el.innerHTML = `<i style="padding:6px;color:${c}"></i>`;',
    "}",
  ].join("\n");
  const hits = lintText(ts, "ts").map((f) => `${f.selector} ${f.check} ${f.property}`);
  assert.deepEqual(hits, ["ts:render family font-family", "ts:render token padding"]);
});
