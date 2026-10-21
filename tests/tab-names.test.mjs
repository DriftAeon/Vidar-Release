// Themed tab names: the generator (uniqueness, exhaustion) and the id-or-name resolver.
import test from "node:test";
import assert from "node:assert/strict";
import { TAB_DESCRIPTORS, TAB_NOUNS, mintTabName, resolveTabRef } from "../src/tab-names.ts";

const all = TAB_DESCRIPTORS.flatMap((d) => TAB_NOUNS.map((n) => `${d} ${n}`));

test("a minted name is a descriptor and a noun", () => {
  const [d, n] = mintTabName([]).split(" ");
  assert.ok(TAB_DESCRIPTORS.includes(d) && TAB_NOUNS.includes(n));
});

test("never reuses an open title, case-insensitively", () => {
  const open = all.slice(1).map((t) => t.toUpperCase());
  for (let i = 0; i < 20; i++) assert.equal(mintTabName(open, () => i / 20), all[0]);
});

test("all 576 taken: a random pair gets a numeric suffix, then the next free one", () => {
  assert.equal(mintTabName(all, () => 0), "Amber Raptor 2");
  assert.equal(mintTabName([...all, "Amber Raptor 2"], () => 0), "Amber Raptor 3");
  assert.equal(mintTabName(all, () => 0.999999), "Gale Viper 2");
});

test("resolver: id first, then one case-insensitive title match", () => {
  const tabs = [
    { id: "s1-a", title: "Amber Raptor" },
    { id: "s2-a", title: "Iron Hydra" },
    { id: "Iron Hydra", title: "Decoy" },
  ];
  assert.equal(resolveTabRef(tabs, "s2-a"), "s2-a");
  assert.equal(resolveTabRef(tabs, "amber raptor"), "s1-a");
  assert.equal(resolveTabRef(tabs, "  AMBER RAPTOR "), "s1-a");
  assert.equal(resolveTabRef(tabs, "Iron Hydra"), "Iron Hydra"); // an exact id beats a title
});

test("resolver: zero or several matches fail", () => {
  const tabs = [{ id: "a", title: "Dup Name" }, { id: "b", title: "dup name" }, { id: "c", title: "Solo" }];
  assert.equal(resolveTabRef(tabs, "Dup Name"), null);
  assert.equal(resolveTabRef(tabs, "Nobody"), null);
  assert.equal(resolveTabRef(tabs, ""), null);
  assert.equal(resolveTabRef(tabs, "Sol"), null); // exact, not prefix
});
