// runes/bare/view-entry.ts and onboarding/runes-row.ts: the First Runeset step's pure parts.
import test from "node:test";
import assert from "node:assert/strict";
import { startView, doneGate } from "../src/runes/bare/view-entry.ts";
import { renderedBareKey } from "../src/onboarding/runes-row.ts";

test("startView opens Local Files only when asked", () => {
  assert.equal(startView("files"), "files");
  assert.equal(startView(undefined), "actives");
  assert.equal(startView("actives"), "actives");
});

test("doneGate fires once, only after a run, on Actives", () => {
  let n = 0;
  const g = doneGate(() => { n++; });
  g.atActives();
  assert.equal(n, 0);
  g.ran();
  g.atActives();
  g.atActives();
  assert.equal(n, 1);
  g.ran();
  g.atActives();
  assert.equal(n, 2);
  doneGate().atActives(); // no callback: no throw
});

test("renderedBareKey picks the primary's Rendered Bare row", () => {
  const rows = [
    { id: "claude", key: "claude-bare", profile: "bare" },
    { id: "claude", key: "claude-rendered-bare", body: "rendered", profile: "bare" },
    { id: "codex", key: "codex-rendered-bare", body: "rendered", profile: "bare" },
    { id: "claude", key: "claude-rendered", body: "rendered" },
  ];
  assert.equal(renderedBareKey(rows, "claude"), "claude-rendered-bare");
  assert.equal(renderedBareKey(rows, "codex"), "codex-rendered-bare");
  assert.equal(renderedBareKey(rows.slice(0, 1), "claude"), null);
  assert.equal(renderedBareKey(rows, null), null);
});
