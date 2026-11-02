// Runes: the Rune Library takes the left pane during Modify (panels/runes.ts syncCover). Source assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runesSrc = readFileSync(new URL("../src/panels/runes.ts", import.meta.url), "utf8");
const viewSrc = readFileSync(new URL("../src/runes/bare/view.ts", import.meta.url), "utf8");
const fn = (name) => runesSrc.slice(runesSrc.indexOf(`function ${name}(`)).split(/\r?\n}\r?\n/)[0];

test("the cover is set only while shown, in Modify, with the entry's handle", () => {
  const sync = fn("syncCover");
  assert.match(runesSrc, /from "\.\/sessions\/left-cover"/);
  assert.doesNotMatch(runesSrc, /from "\.\/sessions"/);
  assert.match(sync, /!visible \|\| !e \|\| !e\.modifying \|\| e\.coverGone/);
  assert.match(sync, /setLeftCover\(null\)/);
  assert.match(sync, /setLeftCover\(e\.cover\)/);
  assert.match(sync, /appendChild\(e\.handle\.libraryRoot\)/);
});

test("the bare view is mounted with placesLibrary and an onModifyChange that syncs the cover", () => {
  assert.match(runesSrc, /placesLibrary: true/);
  assert.match(runesSrc, /onModifyChange: \(on\) => \{[^}]*e\.modifying = on;[^}]*syncCover\(\)/s);
});

test("hide, non-bare draws, focus switches and dispose all go through syncCover", () => {
  assert.match(fn("dropBare"), /syncCover\(\)/); // onRunesHidden, drawPick, ordinary draw
  assert.match(fn("drawBare"), /syncCover\(\)/); // a focus switch lands on a tab in or out of Modify
  assert.match(viewSrc, /dispose\(\) \{ if \(modify && !disposed\) ctx\.onModifyChange\?\.\(false\);/);
});

test("a cover taken by another route stays gone until the next Modify entry", () => {
  assert.match(runesSrc, /onLeftCoverChange\(\(\) => \{\s*if \(!coverEl \|\| getLeftCover\(\) === coverEl\) return;\s*if \(coverOwner\) coverOwner\.coverGone = true;/);
  assert.match(runesSrc, /if \(on\) e\.coverGone = false;/);
  assert.match(runesSrc, /unsubCover\?\.\(\);/);
});
