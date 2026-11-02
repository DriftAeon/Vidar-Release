// Explorer `select` verb: resolve by ref or label, set by option label, events, unknown option, wrong element, allowlist.
// jsdom page and fake ctx; no live port is ever opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { select } from "../tools/drive/verbs/select.mjs";
import { verbs } from "../tools/drive/verbs/index.mjs";
import { explorerRefusal } from "../tools/drive/drive-input.mjs";
import { INPUT_VERBS } from "../tools/drive/run-log.mjs";

const okDevCards = { preConnect: () => ({ ok: true, appRoot: "C:\\sbx\\app" }), attest: async () => ({ ok: true }) };
const badPre = { preConnect: () => ({ ok: false, reason: "port 9222 is a live-window port" }), attest: async () => ({ ok: true }) };

function page() {
  const dom = new JSDOM(`<body>
    <label for="m">Model</label>
    <select id="m"><option value="a">Sonnet</option><option value="b">Opus</option><option value="c" disabled>Gone</option></select>
    <select id="e" aria-label="Effort"><option value="lo">Low</option><option value="hi">High</option></select>
    <button id="b">Go</button></body>`, { runScripts: "outside-only" });
  const w = dom.window;
  const events = [];
  for (const id of ["m", "e"]) for (const t of ["input", "change"]) w.document.getElementById(id).addEventListener(t, () => events.push(`${id}:${t}`));
  const refs = new Map([["e1", new WeakRef(w.document.getElementById("e"))], ["e2", new WeakRef(w.document.getElementById("b"))]]);
  w.__vidarExplorer = { byRef: refs };
  const ctx = (a1, a2, dc = okDevCards) => ({ a1, a2, PORT: "9333", loadDevCards: async () => dc,
    evalJs: async (src) => JSON.parse(JSON.stringify(w.eval(src) ?? null)) });
  return { w, events, ctx };
}

test("resolves by label text and sets by option label, firing input then change", async () => {
  const { w, events, ctx } = page();
  const out = await select(ctx("Model", "Opus"));
  assert.equal(out.selected, "Opus");
  assert.equal(w.document.getElementById("m").value, "b");
  assert.deepEqual(events, ["m:input", "m:change"]);
});

test("resolves by aria-label and by snapshot ref", async () => {
  const { w, ctx } = page();
  assert.equal((await select(ctx("Effort", "High"))).value, "hi");
  w.document.getElementById("e").value = "lo";
  const out = await select(ctx("e1", "high"));
  assert.equal(out.selected, "High");
  assert.deepEqual(out.target.ref, "e1");
  assert.equal(w.document.getElementById("e").value, "hi");
});

test("unknown option fails and lists the available labels", async () => {
  const { w, ctx } = page();
  await assert.rejects(select(ctx("Model", "Haiku")), (e) => /no option "Haiku"/.test(e.message) && /"Sonnet", "Opus", "Gone"/.test(e.message));
  assert.equal(w.document.getElementById("m").value, "a");
});

test("a disabled option, a non-select, a missing target and a stale ref fail clearly", async () => {
  const { ctx } = page();
  await assert.rejects(select(ctx("Model", "Gone")), /disabled/);
  await assert.rejects(select(ctx("e2", "Go")), /not a native select/);
  await assert.rejects(select(ctx("Nope", "x")), /no select matches/);
  await assert.rejects(select(ctx("e99", "x")), (e) => e.exitCode === 2 && /stale ref/.test(e.message));
});

test("refuses off the attested sandbox and stays on the explorer allowlist and run log", async () => {
  const { events, ctx } = page();
  await assert.rejects(select(ctx("Model", "Opus", badPre)), (e) => e.exitCode === 2);
  assert.deepEqual(events, []);
  assert.equal(typeof verbs.select, "function");
  assert.equal(explorerRefusal("select", { VIDAR_DRIVE_EXPLORER: "1" }, "9333"), null);
  assert.ok(INPUT_VERBS.includes("select"));
});
