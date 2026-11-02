// Explorer `fill` verb and the synthetic `drag` path: allowlist, sandbox gate, refusals, native setter, event order.
// jsdom page and fake ctx; no live port is ever opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fill } from "../tools/drive/verbs/fill.mjs";
import { drag } from "../tools/drive/verbs/drag.mjs";
import { verbs } from "../tools/drive/verbs/index.mjs";
import { explorerRefusal, EXPLORER_VERBS } from "../tools/drive/drive-input.mjs";
import { INPUT_VERBS } from "../tools/drive/run-log.mjs";

const okDevCards = { preConnect: () => ({ ok: true, appRoot: "C:\\sbx\\app" }), attest: async () => ({ ok: true }) };
const badPre = { preConnect: () => ({ ok: false, reason: "port 9222 is a live-window port" }), attest: async () => ({ ok: true }) };

function page() {
  const dom = new JSDOM(`<body>
    <label for="n">Flow Name</label><input id="n" type="text">
    <textarea id="t" aria-label="Notes"></textarea>
    <input id="p" type="password" aria-label="Secret">
    <input id="f" type="file" aria-label="Upload">
    <input id="ro" aria-label="Locked" readonly>
    <div class="xterm"><textarea id="x" aria-label="Terminal input"></textarea></div>
    <button id="b">Go</button>
    <div id="row1" draggable="true">One</div><div id="row2">Two</div></body>`, { runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  const log = [];
  for (const t of ["input", "change"]) d.getElementById("n").addEventListener(t, () => log.push(`n:${t}`));
  w.__vidarExplorer = { byRef: new Map([["e1", new WeakRef(d.getElementById("n"))], ["e2", new WeakRef(d.getElementById("b"))]]) };
  // jsdom has no layout: row1 centre (10,20), row2 centre (110,60).
  const rects = { row1: [0, 10, 20, 20], row2: [100, 50, 20, 20] };
  for (const [id, [l, t, wd, h]] of Object.entries(rects)) {
    const el = d.getElementById(id);
    el.scrollIntoView = () => {};
    el.getBoundingClientRect = () => ({ left: l, top: t, width: wd, height: h });
  }
  d.elementFromPoint = (x) => d.getElementById(x < 50 ? "row1" : "row2");
  const types = [];
  for (const id of ["row1", "row2"]) for (const t of ["pointerdown", "mousedown", "pointermove", "mousemove", "dragstart", "drag", "dragenter", "dragover", "drop", "dragend", "pointerup", "mouseup"]) {
    d.getElementById(id).addEventListener(t, () => types.push(t));
  }
  const sent = [];
  const ctx = (a1, a2, dc = okDevCards) => ({ a1, a2, PORT: "9333", env: { VIDAR_EXPLORER_RUN: "" }, loadDevCards: async () => dc, flags: {},
    evalJs: async (src) => JSON.parse(JSON.stringify(w.eval(src) ?? null)),
    send: async (m, p) => { sent.push([m, p]); return {}; },
    consoleVerb: async () => ({ messages: [] }), snapshotFn: async () => ({ changed: [] }) });
  return { w, log, types, sent, ctx };
}

test("fill is registered, allowlisted and counted as input", () => {
  assert.equal(typeof verbs.fill, "function");
  assert.ok(EXPLORER_VERBS.includes("fill") && EXPLORER_VERBS.includes("drag"));
  assert.equal(explorerRefusal("fill", { VIDAR_DRIVE_EXPLORER: "1" }, "9333"), null);
  assert.ok(INPUT_VERBS.includes("fill") && INPUT_VERBS.includes("drag"));
});

test("fill and drag refuse off the sandbox and touch nothing", async () => {
  const { w, sent, ctx } = page();
  await assert.rejects(fill(ctx("Flow Name", "x", badPre)), (e) => e.exitCode === 2 && /attested sandbox/.test(e.message));
  await assert.rejects(drag(ctx("#row1", "#row2", badPre)), (e) => e.exitCode === 2 && /attested sandbox/.test(e.message));
  assert.equal(w.document.getElementById("n").value, "");
  assert.equal(sent.length, 0);
});

test("fill sets by label and by ref through the native setter, input then change", async () => {
  const { w, log, ctx } = page();
  const out = await fill(ctx("Flow Name", "Alpha"));
  assert.equal(w.document.getElementById("n").value, "Alpha");
  assert.deepEqual(log, ["n:input", "n:change"]);
  assert.equal(out.input.value, "Alpha");
  assert.ok("hit" in out && "delta" in out && Array.isArray(out.console));
  const viaRef = await fill(ctx("e1", "Beta"));
  assert.equal(w.document.getElementById("n").value, "Beta");
  assert.equal(viaRef.target.ref, "e1");
  await fill(ctx("Notes", "line"));
  assert.equal(w.document.getElementById("t").value, "line");
});

test("fill refuses password, file, read-only, terminal and non-input targets", async () => {
  const { ctx } = page();
  await assert.rejects(fill(ctx("Secret", "x")), (e) => e.exitCode === 2 && /password/.test(e.message));
  await assert.rejects(fill(ctx("Upload", "x")), (e) => e.exitCode === 2 && /not one/.test(e.message));
  await assert.rejects(fill(ctx("Locked", "x")), (e) => e.exitCode === 2 && /read-only/.test(e.message));
  await assert.rejects(fill(ctx("Terminal input", "x")), (e) => e.exitCode === 2 && /terminal/.test(e.message));
  await assert.rejects(fill(ctx("e2", "x")), (e) => e.exitCode === 2 && /not one/.test(e.message));
  await assert.rejects(fill(ctx("e9", "x")), (e) => /stale ref/.test(e.message));
});

test("drag from a draggable source dispatches pointer, mouse and HTML5 events in order and reports positions", async () => {
  const { types, sent, ctx } = page();
  const out = await drag(ctx("#row1", "#row2"));
  assert.equal(out.mode, "synthetic");
  assert.equal(sent.length, 0);
  const expect = ["pointerdown", "mousedown", ...Array(6).fill(["pointermove", "mousemove"]).flat(),
    "dragstart", "drag", "dragenter", "dragover", "drop", "dragend", "pointerup", "mouseup"];
  assert.deepEqual(out.events, expect);
  assert.ok(types.indexOf("dragstart") < types.indexOf("drop") && types.indexOf("drop") < types.indexOf("pointerup"));
  assert.deepEqual(out.source.before, { x: 0, y: 10, w: 20, h: 20 });
  assert.ok(out.source.after);
});

test("drag accepts an x,y source, with the same gate and covered-end checks", async () => {
  const { types, sent, ctx } = page();
  await assert.rejects(drag(ctx("10,20", "110,60", badPre)), (e) => e.exitCode === 2 && /attested sandbox/.test(e.message));
  assert.equal(sent.length, 0);
  const out = await drag(ctx("10,20", "110,60"));
  assert.equal(out.dragged, true);
  assert.equal(out.mode, "synthetic"); // the point lands on the draggable row
  assert.deepEqual(out.from.at, { x: 10, y: 20 });
  assert.deepEqual(out.source.before, { x: 0, y: 10, w: 20, h: 20 });
  assert.ok(types.includes("dragstart") && types.includes("drop"));
});

test("drag accepts an x,y target", async () => {
  const { ctx } = page();
  const out = await drag(ctx("#row1", "110,60"));
  assert.equal(out.dragged, true);
  assert.deepEqual(out.to.at, { x: 110, y: 60 });
});
