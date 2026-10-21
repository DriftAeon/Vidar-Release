import test from "node:test";
import assert from "node:assert/strict";
import { currentModelIndex, groupModels, menuLabel } from "../src/panels/rendered/model-groups.ts";

test("groupModels splits Latest from Legacy per family and keeps CLI order", () => {
  const rows = [
    { label: "Default (recommended)", value: "default" },
    { label: "Opus", value: "opus", resolved: "claude-opus-5-5" },
    { label: "Opus 5.5", value: "claude-opus-5-5" },
    { label: "Opus 5", value: "claude-opus-5" },
    { label: "Sonnet 5", value: "claude-sonnet-5" },
    { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
    { label: "Sonnet 4", value: "claude-sonnet-4-20250514" },
    { label: "Mystery", value: "3-5-weird" },
  ];
  const out = groupModels(rows);
  assert.deepEqual(out.map((r) => r.label), rows.map((r) => r.label));
  assert.deepEqual(out.filter((r) => r.group === "legacy").map((r) => r.label), ["Opus 5", "Sonnet 4"]);
  assert.equal(menuLabel("Default (recommended)"), "Default");
});

test("currentModelIndex ticks exactly the picked row; Default only when nothing explicit matches", () => {
  const rows = [
    { value: "default", resolved: "claude-opus-5-5", nameMatch: false },
    { value: "opus", resolved: "claude-opus-5-5", nameMatch: false },
    { value: "sonnet", resolved: "claude-sonnet-5", nameMatch: false },
  ];
  assert.equal(currentModelIndex(rows, "opus", true), 1); // picked alias, Default resolves to the same id
  assert.equal(currentModelIndex(rows, "default", true), 0); // picked Default
  assert.equal(currentModelIndex(rows, "claude-opus-5-5", true), 1); // resume: explicit row beats Default
  assert.equal(currentModelIndex(rows.filter((r) => r.value !== "opus"), "claude-opus-5-5", true), 0); // only Default covers it
  assert.equal(currentModelIndex(rows, "claude-opus-5-5", false), 1); // fresh tab: the hinted model's row, not Default
  assert.equal(currentModelIndex(rows, null, false), 1); // no hint: the row Default resolves to
});

test("currentModelIndex: the confirmed pick wins over Default when both resolve to the CLI's ack id", () => {
  const rows = [
    { value: "default", resolved: "claude-sonnet-5", nameMatch: false },
    { value: "sonnet", nameMatch: false }, // explicit row without `resolved`
    { value: "opus", resolved: "claude-opus-5-5", nameMatch: false },
  ];
  assert.equal(currentModelIndex(rows, "claude-sonnet-5", true), 0); // without the pick: Default
  assert.equal(currentModelIndex(rows, "claude-sonnet-5", true, "sonnet"), 1);
});
