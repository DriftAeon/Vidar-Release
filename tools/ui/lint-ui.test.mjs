import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintText } from "./lint-ui.mjs";

const LINT = join(dirname(fileURLToPath(import.meta.url)), "lint-ui.mjs");

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

const compound = (css) => lintText(css).filter((f) => f.check === "compound").map((f) => f.selector);

test("lint-ui: an unscoped compound of two shared classes is flagged and names the fix", () => {
  assert.deepEqual(compound(".ws-btn.ws-add { align-self: flex-start; }"), [".ws-btn.ws-add"]);
  assert.match(messages(".ws-btn.ws-add { align-self: flex-start; }", "compound")[0], /scope it under its view root/);
  assert.equal(compound(".ws-btn.ws-add:hover:not(:disabled) { color: red; }").length, 1);
});

test("lint-ui: a scoped compound, a single class or one shared class passes", () => {
  assert.deepEqual(compound(".ob-workspace .ws-btn.ws-add { align-self: center; }"), []);
  assert.deepEqual(compound(".ob-workspace > .ws-btn.ws-add { align-self: center; }"), []);
  assert.deepEqual(compound(":is(.a, .b) .ws-btn.ws-add { align-self: center; }"), []);
  assert.deepEqual(compound(".ws-btn { align-self: center; }"), []);
  assert.deepEqual(compound(".ws-btn:hover { align-self: center; }"), []);
  assert.deepEqual(compound(".ws-btn.active { align-self: center; }"), []);
});

test("lint-ui: baselined compounds pass on the real tree, a new one fails", () => {
  assert.equal(spawnSync(process.execPath, [LINT], { encoding: "utf8" }).status, 0);
  const dir = mkdtempSync(join(tmpdir(), "lint-ui-"));
  try {
    const css = join(dir, "a.css");
    writeFileSync(css, ".ws-btn.ws-add { align-self: flex-start; }\n");
    const r = spawnSync(process.execPath, [LINT, "--file", css], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\[compound\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
