// Lab is the last workbench module by default (contracts/modules.json surface.order), and the
// onboarding Modules step lists it last. A saved user order still wins; that merge is modules/order.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ONBOARDING_MODULE_IDS } from "../src/onboarding/modules-list.ts";

const contract = JSON.parse(readFileSync(new URL("../contracts/modules.json", import.meta.url), "utf8"));
const bench = contract.core
  .filter((m) => m.kind === "surface" && m.surface?.placement === "workbench")
  .sort((a, b) => a.surface.order - b.surface.order);

test("lab has the highest workbench order", () => {
  assert.equal(bench.at(-1).id, "lab");
});

test("workbench orders are unique", () => {
  const orders = bench.map((m) => m.surface.order);
  assert.equal(new Set(orders).size, orders.length);
});

test("onboarding lists lab last", () => {
  assert.equal(ONBOARDING_MODULE_IDS.at(-1), "lab");
});
