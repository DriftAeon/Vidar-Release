import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { runeLedger, loadedLine } = await import("../src/runes/ledger.ts");

const item = (id) => ({ id, path: `C:/lib/rules/${id}.md` });
const set = (id, targetAbs, members) => ({ set: { id, targetAbs, members: members.map((id) => ({ id })) } });
const traced = {
  lib: { runes: ["always", "path", "plain", "recall"].map(item) },
  sets: [set("base", "C:/lib/CLAUDE.md", ["always"]), set("touch", "C:/lib/.claude/rules/path.md", ["path", "plain"]),
    set("missing", "C:/lib/missing.md", ["recall"])],
};
const loaded = (files, extra = {}) => ({ source: "transcript", files, truncated: false, ...extra });

test("start-loaded set target says Always", () => {
  const ledger = runeLedger(traced, loaded([{ path: "c:\\lib\\claude.md", when: "start" }]));
  assert.deepEqual(ledger.get("always"), { reason: "always" });
  assert.equal(loadedLine(ledger.get("always")), "Loaded: Always");
});

test("touch-loaded target preserves a named trigger and omits an ambiguous one", () => {
  const path = "C:/lib/.claude/rules/path.md";
  const named = runeLedger(traced, loaded([{ path, when: "touch", trigger: "src/view.ts" }]));
  assert.deepEqual(named.get("path"), { reason: "path", trigger: "src/view.ts" });
  assert.equal(loadedLine(named.get("path")), "Loaded: Path (src/view.ts)");
  const ambiguous = runeLedger(traced, loaded([{ path, when: "touch" }]));
  assert.deepEqual(ambiguous.get("plain"), { reason: "path" });
  assert.equal(loadedLine(ambiguous.get("plain")), "Loaded: Path");
});

test("a rune skill read says Recall despite its set target being absent", () => {
  const ledger = runeLedger(traced, loaded([], { runeReads: ["recall"] }));
  assert.deepEqual(ledger.get("recall"), { reason: "recall" });
  assert.equal(loadedLine(ledger.get("recall")), "Loaded: Recall");
  assert.equal(ledger.has("always"), false);
});
