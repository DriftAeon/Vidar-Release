// Jira grouping, icon lookup, page merge and count label (jira/model.ts): plan D3-D5.
import test from "node:test";
import assert from "node:assert/strict";
import { groupIssues, groupKey, mergePage, typeIcon } from "../src/jira/model.ts";

const issue = (key, type, typeLevel = 0, parent = "") => ({ key, summary: `s ${key}`, status: "To Do", statusCategory: "new", type, priority: "", updated: "", url: `https://x.atlassian.net/browse/${key}`, typeLevel, parent });

test("groups run level descending, then name A-Z, and rows keep their order", () => {
  const groups = groupIssues([
    issue("A-1", "Task"), issue("A-2", "Sub-task", -1), issue("A-3", "Epic", 1), issue("A-4", "Bug"),
    issue("A-5", "Story"), issue("A-6", "Bug"), issue("A-7", "Epic", 1),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ["Epic", "Bug", "Story", "Task", "Sub-task"]);
  assert.deepEqual(groups[0].issues.map((i) => i.key), ["A-3", "A-7"], "same name and level merge");
  assert.deepEqual(groups[1].issues.map((i) => i.key), ["A-4", "A-6"], "JQL order inside a section");
});

test("the collapse key is the level plus the name", () => {
  assert.equal(groupKey(1, "Epic"), "1:Epic");
  assert.notEqual(groupKey(1, "Epic"), groupKey(0, "Epic"));
  const groups = groupIssues([issue("A-1", "Epic", 1), issue("A-2", "Epic", 0), issue("A-3", "Epic", 1)]);
  assert.deepEqual(groups.map((g) => [g.key, g.issues.length]), [["1:Epic", 2], ["0:Epic", 1]]);
});

test("a row with no type name goes under Other, after every named section", () => {
  const groups = groupIssues([issue("A-1", ""), issue("A-2", "Sub-task", -1), issue("A-3", "  ", 2), issue("A-4", "Task")]);
  assert.deepEqual(groups.map((g) => g.label), ["Task", "Sub-task", "Other"]);
  assert.deepEqual(groups[2].issues.map((i) => i.key), ["A-1", "A-3"]);
});

test("the icon is keyed by level first, then name", () => {
  assert.deepEqual(typeIcon(1, "Epic"), { color: "books" });
  assert.deepEqual(typeIcon(2, "Initiative"), { color: "books" });
  assert.deepEqual(typeIcon(1, "Story"), { color: "books" }, "level wins over name");
  assert.deepEqual(typeIcon(0, "Story"), { color: "book" });
  assert.deepEqual(typeIcon(0, "Bug"), { lucide: "bug" });
  assert.deepEqual(typeIcon(0, "Task"), { color: "content-view" });
  assert.deepEqual(typeIcon(-1, "Sub-task"), { color: "contact-card" });
  assert.deepEqual(typeIcon(0, "Spike"), { lucide: "circle-dot" });
  assert.deepEqual(typeIcon(0, "Other"), { lucide: "circle-dot" });
});

test("a page merges by key, first seen wins", () => {
  const first = { ...issue("A-1", "Bug"), summary: "old" };
  const merged = mergePage([first, issue("A-2", "Bug")], [{ ...issue("A-1", "Bug"), summary: "new" }, issue("A-3", "Bug"), issue("A-3", "Bug")]);
  assert.deepEqual(merged.map((i) => i.key), ["A-1", "A-2", "A-3"]);
  assert.equal(merged[0].summary, "old");
});
