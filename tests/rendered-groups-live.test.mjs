// Live tool groups (groups.ts data-live): a group built during a running turn is flagged so CSS
// shows only its newest pill; replayed groups never are; the first header click and turn-end
// collapse both drop the flag, so a group can never stay stuck on one line.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
globalThis.CSS ??= { escape: (s) => String(s) }; // chain.ts builds selectors with CSS.escape
const { createGroups } = await import("../src/panels/rendered/groups.ts");

function mk(replaying) {
  const S = { replaying, curGroup: null, turnGroups: [] };
  const host = document.createElement("div");
  const groups = createGroups(S, { append: (n, p = host) => p.appendChild(n), agent: "claude" });
  return { S, groups };
}

test("live group: flagged while live, never on replay; header click and turn end drop the flag", () => {
  const replay = mk(true);
  assert.equal("live" in replay.groups.groupFor().details.dataset, false, "a replayed group was flagged live");

  const live = mk(false);
  const a = live.groups.groupFor();
  assert.equal("live" in a.details.dataset, true, "a live group was not flagged");
  a.details.querySelector("summary").click();
  assert.equal(a.details.open, true, "the first click folded the live group instead of expanding it");
  assert.equal("live" in a.details.dataset, false, "the first click left the group on one line");

  live.groups.sealGroup();
  const b = live.groups.groupFor();
  live.groups.collapseTurnGroups();
  assert.equal("live" in b.details.dataset, false, "turn-end collapse left the group flagged");
});

function pill(g, cls) {
  const p = document.createElement("details");
  p.className = `blk-tool ${cls}`;
  g.details.appendChild(p);
  return p;
}

test("sealing folds an idle live group before the turn ends", () => {
  const { groups } = mk(false);
  const g = groups.groupFor();
  pill(g, "done");
  groups.groupCount(g, "Bash");
  assert.equal(g.details.open, true, "folded before it was sealed");
  groups.sealGroup();
  assert.equal(g.details.open, false, "sealed idle group stayed open");
  assert.equal("live" in g.details.dataset, false, "sealed idle group kept the live flag");
});

test("a running group folds when its last pill settles after the seal", () => {
  const { groups } = mk(false);
  const g = groups.groupFor();
  const p = pill(g, "running");
  groups.groupCount(g, "Bash");
  groups.sealGroup();
  assert.equal(g.details.open, true, "folded with a pill still running");
  assert.equal("live" in g.details.dataset, true, "live flag dropped with a pill still running");
  p.className = "blk-tool done";
  groups.groupRefresh(g);
  assert.equal(g.details.open, false, "settled sealed group stayed open");
  g.details.open = true; // a later reopen is not fought
  groups.groupRefresh(g);
  assert.equal(g.details.open, true, "folded a second time");
});

test("an open thought holds the fold until it settles", () => {
  const { S, groups } = mk(false);
  groups.thinkingBlock("t1", false);
  const d = S.curGroup.details;
  groups.sealGroup();
  assert.equal(d.open, true, "folded with a thought open");
  groups.thinkingBlock("t1", true);
  assert.equal(d.open, false, "settled thought left the sealed group open");
});

test("user-toggled and errored groups are not folded", () => {
  const { groups } = mk(false);
  const u = groups.groupFor();
  pill(u, "done");
  u.userToggled = true;
  groups.sealGroup();
  assert.equal(u.details.open, true, "folded a user-toggled group");

  const e = groups.groupFor();
  pill(e, "done");
  groups.groupError(e);
  groups.sealGroup();
  assert.equal(e.details.open, true, "folded an errored group");
});

test("a keepOpen (bang) group is not folded by seal or refresh, only by turn end", () => {
  const { groups } = mk(false);
  const g = groups.groupFor();
  const p = pill(g, "running");
  groups.sealGroup(true);
  p.className = "blk-tool done";
  groups.groupRefresh(g);
  assert.equal(g.details.open, true, "bang group folded early");
  groups.collapseTurnGroups();
  assert.equal(g.details.open, false, "turn end no longer collapses a bang group");
});

test("replay is unaffected by sealing", () => {
  const { groups } = mk(true);
  const g = groups.groupFor();
  pill(g, "done");
  groups.sealGroup();
  assert.equal(g.details.open, false, "replayed group opened");
  assert.equal(g.folded, undefined, "replay went through the live fold");
});
