import test from "node:test";
import assert from "node:assert/strict";
import { baselineEntries, baselineMap, judge, scanSource } from "../tools/ui/lint-copy.mjs";
import { citeOk } from "../tools/ui/lint-copy-note.mjs";

// Label vs exempt classification: only a short lowercase label fails.
test("lint-copy: judge flags short lowercase labels and exempts sentences, code and placeholders", () => {
  assert.deepEqual(judge("Save failed."), []);                                       // full sentence
  assert.deepEqual(judge("Re-pin every file this adapter uses as it is now"), []);  // > 6 words: tooltip
  assert.deepEqual(judge("characters/_removed"), []);                                // path
  assert.deepEqual(judge("{} Chars"), []);                                           // placeholder
  assert.deepEqual(judge("Open in Document"), []);                                   // small word mid-string
  assert.deepEqual(judge("12 ms"), []);                                              // unit after a number
  assert.deepEqual(judge("new thing"), ["new", "thing"]);
  assert.deepEqual(judge("copy failed: {}"), ["copy", "failed"]);
});

// Sink extraction: assignment, setAttribute, button helper and template HTML; copy-ok suppresses.
test("lint-copy: scanSource finds sink literals and honours copy-ok", () => {
  const src = [
    'x.textContent = "new thing";',
    'y.setAttribute("aria-label", "Flow name");',
    'const b = button("save it", "cls");',
    'el.innerHTML = `<label>tail</label><div>not a sink</div>`;',
    'z.title = "fg"; // copy-ok: colour channel abbreviation',
    'w.className = "lower case class";',
  ].join("\n");
  const hits = scanSource(src).map((f) => `${f.line}:${f.sink}:${f.text}`);
  assert.deepEqual(hits, ["1:prop:new thing", "2:attr:Flow name", "3:button:save it", "4:html:tail"]);
});

// Select option labels: select([[value, label]]) pairs and new Option(label, value).
test("lint-copy: option sinks judge select pair labels and new Option labels", () => {
  const src = [
    'const a = select([["", "Windows default"]], "");',
    'const b = select([["hold", "Hold"], ["toggle", "toggle it"]], v);',
    'sel.append(new Option("Fine Label", "x"));',
    'sel.append(new Option("bad label", "x"));',
    'const c = select([["", "Okay Here"]], ""); const d = [["x", "lower case"]];',
  ].join("\n");
  const hits = scanSource(src).map((f) => `${f.line}:${f.sink}:${f.text}`);
  assert.deepEqual(hits, ["1:option:Windows default", "2:option:toggle it", "4:option:bad label"]);
});

// Placeholders: "optional" or a dash qualifier fails in every placeholder sink; copy-ok suppresses.
test("lint-copy: placeholder sinks reject Optional and dash qualifiers", () => {
  const src = [
    'a.placeholder = "Optional Notes";',
    'b.setAttribute("placeholder", "Notes — Required Later");',
    'c.innerHTML = `<input placeholder="Optional">`;',
    'askGate({ placeholder: "Optional — Note" });',
    'd.placeholder = "Notes";',
    'askGate({ placeholder: "Notes" });',
    'e.placeholder = "Optional"; // copy-ok: test',
  ].join("\n");
  const hits = scanSource(src).filter((f) => f.sink === "placeholder").map((f) => `${f.line}:${f.text}`);
  assert.deepEqual(hits, ["1:Optional Notes", "2:Notes — Required Later", "3:Optional", "4:Optional — Note"]);
});

// Descriptor text in a dim sink fails; only a cited note-ok passes it; it is never baselined.
test("lint-copy: note sink fails descriptor text, honours only cited note-ok, never baselines", () => {
  const src = [
    'a.append(text("dim sub", "Covers X Tabs"));',
    'a.append(text("dim sub", `${name} covers Claude tabs`));',
    'a.append(text("dim sub", "Covers X Tabs")); // note-ok: user, 2026-10-01',
    'a.append(text("dim sub", "Covers X Tabs")); // note-ok: it reads better',
    'a.append(text("dim sub", "Covers X Tabs")); // copy-ok: house style',
    'a.append(text("dim sub", "Querying…"), text("sub tool-err", "Can\'t Reach Server"), text("dim sub", `${n} Calls`));',
    'a.append(text("dim sub", `Covers ${n} Tabs`));',
    'a.append(text("dim sub", `${n} Tabs Covered`));',
    'a.append(text("dim sub", "Covers X Tabs")); // note-ok: a/b.md',
    'a.append(text("dim sub", "Covers X Tabs")); // note-ok: user, 9999-12-31',
    'a.append(text("dim sub", on ? "Covers Claude Tabs" : DASH));',
    'a.append(text("dim sub", ok && "Covers All Tabs"));',
  ].join("\n");
  const notes = scanSource(src).filter((f) => f.sink === "note");
  assert.deepEqual(notes.map((f) => f.line), [1, 2, 4, 5, 7, 8, 9, 10, 11, 12]);
  assert.equal(citeOk("./src/panels/status.ts", "·", { file: "src/panels/status.ts" }), false);
  assert.match(notes[2].why, /dated user decision/);
  assert.match(notes[6].why, /dated user decision/);
  assert.match(notes[7].why, /dated user decision/);
  const findings = [...notes.map((f) => ({ file: "x.ts", ...f })), { file: "x.ts", sink: "prop", text: "new thing", line: 9 }];
  assert.deepEqual(baselineEntries(findings).map((e) => e.sink), ["prop"]);
  assert.equal(baselineMap({ entries: [{ file: "x.ts", sink: "note", text: "Covers X Tabs", count: 1 }] }).size, 0);
});
