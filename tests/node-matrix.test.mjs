// The Node Matrix renderer shared by the Run Flow ask, the Open Astra Tab ask and the Relay tool approval.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({});
const { renderNodeMatrix, FOLD_AT } = await import("../src/control/node-matrix.ts");

const nodes = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}`, title: `Node ${i + 1}` }));
const matrix = (n, cells) => ({
  facts: [{ label: "Flow", icon: "flow", value: "Review Flow", strong: true }],
  nodes: nodes(n),
  fields: cells,
});
const same = (n, v) => Array.from({ length: n }, () => v);

test("a value every node shares is one spanning cell; differing values get a cell each", () => {
  const el = renderNodeMatrix(matrix(3, [
    { label: "Working Directory", icon: "folder", cells: same(3, "C:\\Work") },
    { label: "Model", icon: "model", cells: ["a", "b", "c"] },
  ]));
  const [shared, own] = [...el.querySelectorAll("tbody tr")];
  assert.equal(shared.querySelectorAll("td").length, 2, "label cell plus one span");
  assert.equal(shared.querySelector("td.nm-span").colSpan, 3);
  assert.equal(own.querySelectorAll("td").length, 4);
  assert.deepEqual([...el.querySelectorAll("thead th")].map((t) => t.textContent), ["", "Node 1", "Node 2", "Node 3"]);
});

test("a field with no value on any node is left out, and labels are icons with a tooltip", () => {
  const el = renderNodeMatrix(matrix(2, [
    { label: "Allowlist", icon: "key", cells: ["", ""] },
    { label: "Retries", icon: "retry", cells: ["0", "1"] },
  ]));
  assert.equal(el.querySelectorAll("tbody tr").length, 1);
  const label = el.querySelector("tbody td:first-child .nm-ico");
  assert.equal(label.title, "Retries");
  assert.equal(label.textContent, "", "no label text in the first column");
  assert.ok(label.querySelector("svg"));
});

test("five or more nodes scroll inside their own wrapper with the label column pinned", () => {
  for (const n of [1, 4, 5, 6]) {
    const el = renderNodeMatrix(matrix(n, [{ label: "Model", icon: "model", cells: nodes(n).map((_, i) => `m${i}`) }]));
    const wrap = el.querySelector(".nm-scroll");
    assert.ok(wrap, `${n} nodes sit in a scroll wrapper`);
    assert.equal(wrap.querySelector("table").style.getPropertyValue("--nm-n"), String(n), "the width floor scales with the node count");
    assert.equal(wrap.querySelector("table").parentElement, wrap);
    assert.equal(el.querySelectorAll("thead th").length, n + 1);
  }
});

test("the stylesheet scrolls the wrapper sideways and pins the icon column", () => {
  const css = readFileSync(new URL("../src/styles/node-matrix.css", import.meta.url), "utf8");
  assert.match(css, /\.nm-scroll \{[^}]*overflow-x: auto/);
  assert.match(css, /\.nm-table \{[^}]*min-width: calc\([^}]*var\(--nm-n\)/, "the table never squishes below n columns");
  assert.match(css, /\.nm-table th:first-child, \.nm-table td:first-child \{[^}]*position: sticky; left: 0/);
});

test("a single node renders one column", () => {
  const el = renderNodeMatrix(matrix(1, [{ label: "Model", icon: "model", cells: ["only"] }]));
  assert.equal(el.querySelectorAll("tbody td").length, 2);
  assert.equal(el.querySelector("td.nm-span"), null, "one node never spans");
});

test("a long value renders folded and opens on click; a short one stays plain", () => {
  const long = "x".repeat(FOLD_AT + 1);
  const el = renderNodeMatrix(matrix(2, [{ label: "Task", icon: "task", cells: [long, "short"] }]));
  const [a, b] = [...el.querySelectorAll("tbody td:not(:first-child)")];
  const fold = a.querySelector("details.nm-fold");
  assert.ok(fold, "long value folds");
  assert.equal(fold.open, false);
  assert.equal(fold.querySelector("summary").textContent, long, "the full text is kept, only clipped by CSS");
  fold.querySelector("summary").click();
  assert.equal(fold.open, true, "click opens it");
  assert.equal(b.querySelector("details"), null);
  assert.equal(b.textContent, "short");
  const multi = renderNodeMatrix(matrix(1, [{ label: "Task", icon: "task", cells: ["a\nb"] }]));
  assert.ok(multi.querySelector("details.nm-fold"), "a line break folds too");
});

test("facts render as an icon grid; a block fact sits under it and no matrix without nodes", () => {
  const el = renderNodeMatrix({ nodes: [], fields: [], facts: [
    { label: "Flow", icon: "flow", value: "Review Flow" },
    { label: "Request", icon: "request", value: "git status", block: true },
  ] });
  assert.equal(el.querySelector("table"), null);
  assert.equal(el.querySelectorAll(".nm-facts .nm-ico").length, 1);
  assert.equal(el.querySelector(".nm-facts .nm-v").textContent, "Review Flow");
  assert.equal(el.querySelector(".nm-pre").textContent, "git status");
  assert.equal(el.textContent.includes("Order"), false);
});
