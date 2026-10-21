import test from "node:test";
import assert from "node:assert/strict";
import { bindTabOrder, beginTabOrderRestore, endTabOrderRestore, insertionBefore, saveTabOrder, TAB_ORDER_RESTORE_CAP_MS } from "../src/panels/sessions/tab-order.ts";

// C6: a boot restore that never settles must not leave saving off for the whole session.
test("a hung boot restore ends at the cap; saving resumes and the late settle is a no-op", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes = [];
  const sessions = new Map([["a", { falconSession: "s1" }], ["b", { falconSession: "s2" }]]);
  let order = ["a", "b"];
  bindTabOrder({ sessions, orderedIds: () => order, moveBefore: () => {}, read: () => [], write: (o) => writes.push(o) });
  beginTabOrderRestore();
  saveTabOrder();
  assert.deepEqual(writes, [], "a save during the restore went out");
  t.mock.timers.tick(TAB_ORDER_RESTORE_CAP_MS);
  assert.deepEqual(writes, [["h:s1", "h:s2"]], "the cap did not end the restore");
  order = ["b", "a"];
  saveTabOrder();
  assert.deepEqual(writes.at(-1), ["h:s2", "h:s1"], "a reorder after the cap was not saved");
  endTabOrderRestore(); // the hung restore finally settles
  assert.equal(writes.length, 2);
  // a restore that settles in time cancels its cap
  beginTabOrderRestore();
  endTabOrderRestore();
  t.mock.timers.tick(TAB_ORDER_RESTORE_CAP_MS);
  assert.equal(writes.length, 3);
});

test("mixed hosted and in-process tabs take saved slots despite out-of-order arrival", () => {
  const saved = ["h:claude", "c:first", "h:hosted-codex", "c:last"];
  const keys = new Map();
  const live = [];
  const arrive = (id, key, restored = true) => {
    keys.set(id, key);
    const before = restored ? insertionBefore(live, keys, saved, key) : null;
    live.splice(before === null ? live.length : live.indexOf(before), 0, id);
  };

  arrive("last", "c:last");
  arrive("first", "c:first");
  arrive("user", "c:user", false);
  arrive("claude", "h:claude");
  arrive("hosted", "h:hosted-codex");
  assert.deepEqual(live, ["claude", "first", "hosted", "last", "user"]);
  arrive("unsaved", "h:new");
  assert.deepEqual(live, ["claude", "first", "hosted", "last", "user", "unsaved"]);
});
