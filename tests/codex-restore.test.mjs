// Codex Rendered tab persistence: the pref guard, the snapshot (zero-turn rule) and the restore
// ordering (gate, skip, active).
import test from "node:test";
import assert from "node:assert/strict";
import { GUARDS } from "../src/prefs-core.ts";
import { createSaveGate, restoreCodexTabs, snapshotCodexTabs } from "../src/launcher/codex-restore.ts";

const rec = (over = {}) => ({
  threadId: "t1", cwd: "C:\\x", title: "A", art: "codex", model: null, mode: "default", rules: null, active: false, ...over,
});
const guard = GUARDS["rendered.codexTabs"];

test("guard refuses bad modes and types, keeps unknown fields", () => {
  assert.equal(guard([]), true);
  assert.equal(guard([rec(), rec({ threadId: null, mode: "plan", rules: "r.md", model: "m" })]), true);
  assert.equal(guard([rec({ mode: "acceptEdits" })]), true);
  for (const bad of [
    "x", {}, [null], [rec({ mode: "auto" })], [rec({ mode: undefined })], [rec({ cwd: 3 })],
    [rec({ active: "yes" })], [rec({ threadId: 5 })], [rec({ rules: 1 })], [rec({ title: null })],
  ]) assert.equal(guard(bad), false, JSON.stringify(bad));
  assert.equal(guard([{ ...rec(), extra: { a: 1 } }]), true);
});

const view = (over = {}) => ({
  agent: "codex", body: "rendered", threadId: "t1", turned: true, cwd: "C:\\x", title: "A", art: "codex",
  model: undefined, mode: "default", rulesFile: null, ...over,
});

test("snapshot: strip order, only Codex Rendered, zero-turn tab saves a null thread id", () => {
  const tabs = new Map([
    ["a", view()],
    ["b", view({ threadId: "t2", turned: false, title: "B", mode: "plan" })],
    ["c", view({ agent: "claude" })],
    ["d", view({ body: "terminal" })],
    ["e", view({ threadId: "t5", model: "m", rulesFile: "r.md", mode: "auto" })],
  ]);
  const out = snapshotCodexTabs(["e", "c", "b", "d", "a"], tabs, "b");
  assert.deepEqual(out.map((r) => [r.title, r.threadId, r.active, r.mode]), [
    ["A", "t5", false, "default"], ["B", null, true, "plan"], ["A", "t1", false, "default"],
  ]);
  assert.equal(out[0].model, "m");
  assert.equal(out[0].rules, "r.md");
  assert.equal(guard(out), true);
});

function gateWith() {
  const writes = [];
  const gate = createSaveGate({ dev: false, snapshot: () => [rec()], write: (l) => writes.push(l) });
  return { gate, writes };
}

test("gate: no write in dev, during restore or after pagehide", () => {
  const dev = [];
  createSaveGate({ dev: true, snapshot: () => [], write: (l) => dev.push(l) }).save();
  assert.equal(dev.length, 0);
  const { gate, writes } = gateWith();
  gate.save();
  assert.equal(writes.length, 1);
  gate.beginRestore();
  gate.save();
  assert.equal(writes.length, 1);
  gate.endRestore();
  gate.save();
  assert.equal(writes.length, 2);
  gate.pagehide();
  gate.save();
  assert.equal(writes.length, 2);
});

test("restore: reap first, no write until the end, open ids skipped, active selected only when none is", async () => {
  const log = [];
  const { gate, writes } = gateWith();
  let active = null;
  const records = [
    rec({ threadId: "t1" }), rec({ threadId: "open" }), rec({ threadId: null, title: "Fresh", active: true }), rec({ threadId: "t4" }),
  ];
  const deps = {
    records,
    reap: async () => { log.push("reap"); },
    openThreadIds: () => ["open"],
    open: async (r) => {
      log.push(`open ${r.threadId ?? r.title}`);
      gate.save(); // a save from inside createSession's callbacks must be swallowed
      return `tab-${r.threadId ?? r.title}`;
    },
    activeId: () => active,
    select: (t) => { log.push(`select ${t}`); active = t; },
    gate,
  };
  await restoreCodexTabs(deps);
  assert.deepEqual(log, ["reap", "open t1", "open Fresh","select tab-Fresh", "open t4"]);
  assert.equal(writes.length, 1, "one snapshot at the end");

  // an already active tab is never replaced
  const log2 = [];
  await restoreCodexTabs({ ...deps, activeId: () => "other", select: (t) => log2.push(t), records: [rec({ active: true, threadId: "z" })] });
  assert.deepEqual(log2, []);
  assert.equal(writes.length, 2);
});

test("restore: a failed reap opens nothing, keeps saved records and permits retry", async () => {
  const records = [rec({ threadId: "a" }), rec({ threadId: "b", active: true })];
  const original = structuredClone(records);
  let saved = records;
  const writes = [];
  const opened = [];
  const gate = createSaveGate({
    dev: false,
    snapshot: () => opened.map((threadId) => rec({ threadId })),
    write: (list) => { writes.push(list); saved = list; },
  });
  const deps = {
    records,
    reap: async () => { throw new Error("reap"); },
    openThreadIds: () => [],
    open: async (r) => { opened.push(r.threadId); return `tab-${r.threadId}`; },
    activeId: () => null, select: () => {}, gate,
  };
  const errors = [];
  const origErr = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await restoreCodexTabs(deps);
  } finally { console.error = origErr; }
  assert.deepEqual(opened, []);
  assert.deepEqual(writes, [], "saved records must not be overwritten by an empty snapshot");
  assert.equal(saved, records);
  assert.deepEqual(records, original);
  assert.equal(errors.length, 1, "the failed prerequisite is logged");

  await restoreCodexTabs({ ...deps, records: saved, reap: async () => {} });
  assert.deepEqual(opened, ["a", "b"]);
  assert.equal(writes.length, 1, "the save gate is released for a successful retry");
});

test("restore: a failed open does not stop the rest", async () => {
  const { gate, writes } = gateWith();
  const opened = [];
  const origErr = console.error;
  console.error = () => {};
  try {
    await restoreCodexTabs({
      records: [rec({ threadId: "a" }), rec({ threadId: "b" })],
      reap: async () => {},
      openThreadIds: () => [],
      open: async (r) => { if (r.threadId === "a") throw new Error("boom"); opened.push(r.threadId); return "x"; },
      activeId: () => null, select: () => {}, gate,
    });
  } finally { console.error = origErr; }
  assert.deepEqual(opened, ["b"]);
  assert.equal(writes.length, 1);
});

test("restore: failed records survive later saves and disappear only after successful retry", async () => {
  const failed = rec({ threadId: "failed", title: "Failed", active: true });
  const fresh = rec({ threadId: null, title: "Unopened Fresh" });
  const opened = [];
  let saved = [failed, fresh, rec({ threadId: "ok" })];
  const gate = createSaveGate({ dev: false, snapshot: () => opened.map((r) => ({ ...r, active: false })), write: (rows) => { saved = rows; } });
  const deps = { records: saved, reap: async () => {}, openThreadIds: () => opened.map((r) => r.threadId).filter(Boolean),
    open: async (r) => { if (r.threadId !== "ok") throw new Error("unavailable"); opened.push(r); return "tab"; },
    activeId: () => "other", select: () => {}, gate };
  const origErr = console.error;
  console.error = () => {};
  try { await restoreCodexTabs(deps); } finally { console.error = origErr; }
  assert.deepEqual(saved.map((r) => r.title).sort(), ["A", "Failed", "Unopened Fresh"]);
  gate.save();
  assert.equal(saved.length, 3, "an unrelated save must retain unopened tabs");
  await restoreCodexTabs({ ...deps, records: saved, open: async (r) => { opened.push(r); return `tab-${r.title}`; } });
  assert.equal(saved.length, 3, "successful retry must not keep an extra retained copy");
  opened.splice(opened.findIndex((r) => r.threadId === "failed"), 1);
  gate.save();
  assert.equal(saved.some((r) => r.threadId === "failed"), false, "a later intentional close stays closed");
});

test("restore: failed reap retains records through an unrelated subsequent save", async () => {
  const records = [rec({ threadId: "saved" })];
  let saved = records;
  const gate = createSaveGate({ dev: false, snapshot: () => [], write: (rows) => { saved = rows; } });
  const origErr = console.error;
  console.error = () => {};
  try {
    await restoreCodexTabs({ records, gate, reap: async () => { throw new Error("no reap"); },
      openThreadIds: () => [], open: async () => "", activeId: () => null, select: () => {} });
  } finally { console.error = origErr; }
  gate.save();
  assert.deepEqual(saved, records);
});

test("profile, rowKey and sets: old records validate and snapshot keeps the override", () => {
  assert.equal(guard([rec()]), true);
  assert.equal(guard([rec({ profile: "bare", rowKey: "codex-bare" })]), true);
  assert.equal(guard([rec({ profile: 3 })]), false);
  assert.equal(guard([rec({ rowKey: 3 })]), false);
  const out = snapshotCodexTabs(["a", "b"], new Map([
    ["a", view({ profile: "bare", rowKey: "codex-bare", sets: [] })], ["b", view({ title: "B" })],
  ]), null);
  assert.deepEqual([out[0].profile, out[0].rowKey], ["bare", "codex-bare"]);
  assert.deepEqual(out[0].sets, []);
  assert.equal("profile" in out[1] || "rowKey" in out[1], false);
});

test("restore passes the profile record through; a row that no longer resolves is not opened, is noticed once and is dropped", async () => {
  const { gate, writes } = gateWith();
  const opened = [];
  let staleSeen = [];
  const good = rec({ threadId: "g", profile: "bare", rowKey: "k1" });
  const gone = rec({ threadId: "x", title: "Gone", profile: "bare", rowKey: "k2" });
  await restoreCodexTabs({
    records: [good, gone, rec({ threadId: "p" })],
    reap: async () => {}, openThreadIds: () => [],
    open: async (r) => { opened.push(r); return `tab-${r.threadId}`; },
    activeId: () => null, select: () => {}, gate,
    resolves: (r) => r.rowKey === "k1",
    stale: (rs) => { staleSeen = rs; },
  });
  assert.deepEqual(opened.map((r) => [r.threadId, r.profile, r.rowKey]), [["g", "bare", "k1"], ["p", undefined, undefined]]);
  assert.deepEqual(staleSeen.map((r) => r.title), ["Gone"]);
  assert.ok(!writes.at(-1).some((r) => r.threadId === "x"), "stale record dropped after one notice");
});
