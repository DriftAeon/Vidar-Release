import test from "node:test";
import assert from "node:assert/strict";

const { splitShelf, isBottomShelf, SHELF_KEY } = await import("../src/panels/document-shelf-split.ts");

const e = (path) => ({ path });

test("shelf key matches the backend group", () => {
  assert.equal(SHELF_KEY, "Docs · shelf");
});

test("splitShelf separates bottom-shelf and keeps each group's order", () => {
  const input = [
    e("C:\\d\\docs\\shelf\\b-new.md"),
    e("C:\\d\\docs\\shelf\\bottom-shelf\\x-new.md"),
    e("C:\\d\\docs\\shelf\\a-old.md"),
    e("C:\\d\\docs\\shelf\\bottom-shelf\\y-old.md"),
    e("C:\\d\\docs\\shelf\\README.md"),
    e("C:\\d\\docs\\shelf\\bottom-shelf\\README.md"),
  ];
  const { top, bottom } = splitShelf(input);
  assert.deepEqual(top.map((x) => x.path.split("\\").pop()), ["b-new.md", "a-old.md", "README.md"]);
  assert.deepEqual(bottom.map((x) => x.path.split("\\").pop()), ["x-new.md", "y-old.md", "README.md"]);
});

test("splitShelf handles forward slashes and empty groups", () => {
  assert.equal(isBottomShelf(e("/d/shelf/bottom-shelf/a.md")), true);
  assert.equal(isBottomShelf(e("/d/shelf/other/a.md")), false);
  assert.deepEqual(splitShelf([e("/d/shelf/a.md")]), { top: [e("/d/shelf/a.md")], bottom: [] });
  assert.deepEqual(splitShelf([e("/d/shelf/bottom-shelf/a.md")]), { top: [], bottom: [e("/d/shelf/bottom-shelf/a.md")] });
  assert.deepEqual(splitShelf([]), { top: [], bottom: [] });
});
