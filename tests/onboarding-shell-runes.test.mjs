// steps.ts runesShown: the Runes step drops out when the release does not list it or the user hid it
// (the Modules step flips `modules.hidden` while the shell is open, so the shell reads it live).
import test from "node:test";
import assert from "node:assert/strict";
import { footerState, runesShown } from "../src/onboarding/steps.ts";

test("runesShown needs the listing and no bench:runelib in modules.hidden", () => {
  assert.equal(runesShown(true, []), true);
  assert.equal(runesShown(true, ["bench:lab"]), true);
  assert.equal(runesShown(true, ["bench:runelib"]), false);
  assert.equal(runesShown(false, []), false);
});

test("hiding Runes turns Modules into the last step", () => {
  const f = (hidden) => footerState("modules", { runesListed: runesShown(true, hidden), depsShown: false, registered: () => true });
  assert.equal(f([]).nextLabel, "Next");
  assert.deepEqual([f(["bench:runelib"]).next, f(["bench:runelib"]).nextLabel], [null, "Finish"]);
});
