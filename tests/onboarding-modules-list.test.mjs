// onboarding/modules-list.ts: the Modules step's row list, in step order, from a registry fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { moduleRows, rowOn, ONBOARDING_MODULE_IDS } from "../src/onboarding/modules-list.ts";

const reg = [
  { id: "relay", label: "Relay", level: "core" },
  { id: "slack", label: "Slack", level: "optional" },
  { id: "tray", label: "Tray", level: "required-hideable" },
  { id: "doc", label: "Document", level: "required-hideable" },
  { id: "runelib", label: "Runes", level: "optional" },
  { id: "lab", label: "Lab", level: "optional" },
  { id: "jira", label: "Jira", level: "optional" },
];
const all = () => true;

test("rows follow the step order, not the registry order", () => {
  assert.deepEqual(moduleRows(reg, all).map((r) => r.key), ["tray", "doc", "runelib", "lab", "jira", "slack"]);
  assert.deepEqual(ONBOARDING_MODULE_IDS.slice(0, 4), ["tray", "doc", "flow", "runelib"]);
});

test("a row carries the Settings id and the registry label", () => {
  assert.deepEqual(moduleRows(reg, all)[1], { key: "doc", id: "bench:doc", label: "Document" });
});

test("a module the release does not list, or the registry lacks, gets no row; core never does", () => {
  const rows = moduleRows(reg, (id) => id !== "lab");
  assert.ok(!rows.some((r) => r.key === "lab"));
  assert.ok(!rows.some((r) => r.key === "flow")); // not in the fixture
  assert.ok(!moduleRows(reg, all).some((r) => r.key === "relay"));
  assert.deepEqual(moduleRows(reg, () => false), []);
});

test("rowOn reads modules.hidden by the bench: id", () => {
  const row = { key: "lab", id: "bench:lab", label: "Lab" };
  assert.equal(rowOn(row, []), true);
  assert.equal(rowOn(row, ["bench:lab"]), false);
  assert.equal(rowOn(row, ["lab"]), true);
});
