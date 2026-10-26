import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { nextRuneState, runeState, stateDisabled, stateLabel, stateTooltip, REQUIRED_TIP, SHADOW_TIP } =
  await import("../src/runes/bare/rune-state.ts");
const { runeControls } = await import("../src/runes/bare/view-sets.ts");

test("Rune controls keep the existing state labels and icons", () => {
  assert.deepEqual(["off", "on", "shadow"].map((s) => nextRuneState(s)), ["on", "shadow", "off"]);
  assert.deepEqual(["off", "on"].map((s) => nextRuneState(s, true)), ["on", "off"]);
  for (const state of ["off", "on", "shadow"]) {
    const sw = runeControls({ on: state === "on" }, state, false, "", () => {})[0];
    assert.equal(sw.getAttribute("aria-label"), stateLabel(state));
    if (state === "shadow") assert.equal(sw.title, SHADOW_TIP);
  }
});

test("Required runes stay on and show a locked control", () => {
  const rune = { id: "must", on: false, state: "shadow", required: true };
  const [chip, sw] = runeControls(rune, runeState(rune), false, "", () => assert.fail("required rune switched"));
  assert.equal(stateDisabled(rune), true);
  assert.equal(chip.textContent, "Required");
  assert.equal(sw.disabled, true);
  assert.equal(sw.title, REQUIRED_TIP);
  assert.equal(stateTooltip("on", true), REQUIRED_TIP);
});
