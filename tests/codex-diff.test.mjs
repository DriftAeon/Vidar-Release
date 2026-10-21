// Codex fileChange shaping: the approval card's path + diff lines and the Edit pill's structured
// result come from the same {path, kind, diff} changes. approvalDetail itself needs a DOM; it
// draws exactly codexChanges + codexDiffLines, which are covered here.
import test from "node:test";
import assert from "node:assert/strict";
import { codexChanges, codexDiffLines, codexStructured } from "../src/agents/codex-diff.ts";
import { editDiff } from "../src/panels/rendered/edit-diff.ts";

const input = { changes: [
  { path: "src/a.ts", kind: "update", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n" },
  { path: "src/b.ts", kind: "add", diff: "x\ny\n" },
] };

test("codex changes: path and +/- lines for the approval card", () => {
  const cs = codexChanges(input);
  assert.equal(cs[0].path, "src/a.ts");
  assert.deepEqual(codexDiffLines(cs[0]), [{ kind: "del", text: "old" }, { kind: "add", text: "new" }]);
  assert.deepEqual(codexDiffLines(cs[1]), [{ kind: "add", text: "x" }, { kind: "add", text: "y" }]);
  assert.deepEqual(codexChanges({ file_path: "p" }), []);
});

test("codex structured result feeds editDiff", () => {
  const d = editDiff(codexStructured(codexChanges(input), "completed"));
  assert.equal(d.added, 3);
  assert.equal(d.removed, 1);
  assert.equal(editDiff(codexStructured([], "completed")), null);
});
