// editDiff: the Edit/Write pill's +/− list from a structured result — context dropped, cap, counts,
// Write-create content as additions, nothing to list → null (the pill falls back to the raw output).
import test from "node:test";
import assert from "node:assert/strict";
import { editDiff } from "../src/panels/rendered/edit-diff.ts";

test("editDiff: patch lines, cap and counts; Write create; nothing to list", () => {
  const lines = [" ctx", "-a", "+b", "\\ No newline at end of file"];
  for (let i = 0; i < 9; i++) lines.push(`+n${i}`);
  const d = editDiff({ structuredPatch: [{ oldStart: 1, lines }] }, 8);
  assert.deepEqual(d.shown.slice(0, 2), [{ kind: "del", text: "a" }, { kind: "add", text: "b" }]);
  assert.equal(d.shown.length, 8);
  assert.equal(d.rest.length, 3);
  assert.equal(d.added, 10);
  assert.equal(d.removed, 1);

  const w = editDiff({ type: "create", structuredPatch: [], content: "x\r\ny\n" });
  assert.deepEqual(w.shown, [{ kind: "add", text: "x" }, { kind: "add", text: "y" }]);
  assert.equal(w.removed, 0);

  assert.equal(editDiff({ structuredPatch: [] }), null);
  assert.equal(editDiff(null), null);
});
