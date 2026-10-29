// Bare rune cards by Activate (src/runes/bare/view-sets.ts runeCard, src/runes/cards.ts cardDetails): recall and
// paths cards carry their class, a paths card shows its first glob and keeps the Activate chip, recall read stays.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { runeCard } = await import("../src/runes/bare/view-sets.ts");

const lib = { library: "L", scope: "global", bricks: [] };
const brick = (id, activate, extra = {}) => ({ id, section: [], studs: 1, on: true, state: "on", path: `${id}.md`, kind: "rule", activate, description: "", body: "", ...extra });
const card = (b, o = {}) => runeCard(lib, b, { dim: false, tail: [], card: {}, ...o });

test("a recall card gets act-recall, and a read one is marked is-read", () => {
  const c = card(brick("r1", "recall"));
  assert.ok(c.classList.contains("act-recall"));
  assert.ok(!c.classList.contains("is-read"));
  assert.ok(card(brick("r2", "recall"), { read: true }).classList.contains("is-read"));
  assert.ok(card(brick("r3", "recall"), { dim: true }).classList.contains("is-dim"), "the dim stays its own class");
});

test("a paths card gets act-paths, its first glob beside the name, and keeps its Activate chip", () => {
  const c = card(brick("p1", "paths", { paths: ["src/launcher/**", "vidar.example.json"] }));
  assert.ok(c.classList.contains("act-paths"));
  const sum = c.querySelector("summary");
  const kids = [...sum.children].map((k) => k.className);
  assert.deepEqual(kids.slice(1, 3), ["runes-rname", "runes-glob"]);
  const glob = sum.querySelector(".runes-glob");
  assert.equal(glob.textContent, "src/launcher/**");
  assert.equal(glob.title, "src/launcher/**\nvidar.example.json");
  assert.equal(sum.querySelectorAll(".runes-chips .runes-chip").length, 2, "Scope and Activate");
  assert.ok([...sum.querySelectorAll(".runes-chip")].some((x) => x.title === "Paths"));
});

test("an always card, and a paths card without globs, get no extra look", () => {
  const a = card(brick("a1", "always"));
  assert.ok(!a.classList.contains("act-recall") && !a.classList.contains("act-paths"));
  assert.equal(a.querySelector(".runes-glob"), null);
  assert.equal(card(brick("p2", "paths")).querySelector(".runes-glob"), null);
});
