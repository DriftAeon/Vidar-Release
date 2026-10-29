// Loaded-of-total counts, the Always/Paths/Recall order of the Bare Runes view.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { isLoaded, loadedOfTotal, orderByLoad } = await import("../src/runes/bare/loaded-count.ts");

const r = (id, activate, section = ["Cat"]) => ({ id, activate, section, path: `C:/r/rules/${id}.md` });

test("loaded counts always and missing activate, not recall or paths", () => {
  const items = [r("a", "always"), r("b", "recall"), r("c", "paths"), r("d", undefined), r("e", "always")];
  assert.equal(isLoaded(items[3]), true);
  assert.equal(loadedOfTotal(items), "3/5");
  assert.equal(loadedOfTotal(items, 2), "3/7");
  assert.equal(loadedOfTotal([r("a", "always"), r("b", "recall")]), "1/2");
});

test("order is always, paths, recall, alphabetical, per category", () => {
  const bricks = [
    r("zeta", "always"), r("beta", "recall"), r("alpha", "paths"), r("gamma", "always"), r("delta", "recall"),
    r("omega", "recall", ["Two"]), r("mid", "always", ["Two"]),
  ];
  const out = orderByLoad(bricks, (i) => i === 5);
  assert.deepEqual(out.map((b) => b.id), ["gamma", "zeta", "alpha", "beta", "delta", "mid", "omega"]);
});
