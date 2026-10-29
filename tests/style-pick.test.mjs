// Output styles are exclusive in a vault: switching one on switches the vault's other styles off (src/runes/bare/style-pick.ts).
import test from "node:test";
import assert from "node:assert/strict";

const { withStyleReplace } = await import("../src/runes/bare/style-pick.ts");

const rune = (library, id, kind, set = null, recall = false) => ({
  set, library, id, kind, activate: "always", description: "", section: [], recall, body: "", drift: false,
});
const kitSet = { library: "kit", set: "kit" };
const view = {
  vault: { runesets: [{ file: "kit.md", source: kitSet, copiedUtc: "", sourceHash: "" }], runes: [{ library: "mine", id: "terse" }] },
  runes: [
    rune("mine", "terse", "output-style"),
    rune("kit", "explain", "output-style", kitSet),
    rune("kit", "recalled", "output-style", kitSet, true),
    rune("kit", "tidy", "skill", kitSet),
  ],
};
const add = (library, id) => ({ op: "addRune", ref: { library, id } });

test("adding a style removes the vault's other styles first, in one edit", () => {
  assert.deepEqual(withStyleReplace({ library: "mine", id: "brief", kind: "output-style" }, add("mine", "brief"), view), [
    { op: "removeRune", ref: { library: "mine", id: "terse" } },
    { op: "member", ref: { library: "kit", runeset: "kit", rune: { library: "kit", id: "explain" }, on: false } },
    add("mine", "brief"),
  ]);
});

test("re-picking a held style leaves it and still drops the other", () => {
  const ops = withStyleReplace({ library: "mine", id: "terse", kind: "output-style" }, add("mine", "terse"), view);
  assert.deepEqual(ops.map((o) => o.op), ["member", "addRune"]);
});

test("any other kind adds alone", () => {
  assert.deepEqual(withStyleReplace({ library: "mine", id: "lint", kind: "skill" }, add("mine", "lint"), view), [add("mine", "lint")]);
});
