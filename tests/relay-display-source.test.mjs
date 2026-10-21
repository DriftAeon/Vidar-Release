// Relay Display source contract (src/relay/source-display.ts): resolve is bound to the sha the view
// painted, a malformed sidecar keeps its item, and a stale refresh never overwrites a newer one.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

// display-decision and display-name load for real; the ipc stub answers the rest
const dom = setupDom();
const { refresh } = await import("../src/relay/source-display.ts");
const store = await import("../src/relay/store.ts");

const A = { path: "D:\\display\\2026-10-03-plan-aaaaaaaa.html", kind: "html", mtime_ms: 100 };
const B = { path: "D:\\display\\2026-10-03-other-bbbbbbbb.html", kind: "html", mtime_ms: 200 };
const saves = [];
Object.assign(dom.ipc.answers, {
  list_display: { files: [A], docs: [], newest: A.path },
  read_display_decision: null,
  save_display_decision: (args) => { saves.push(args); },
});

test("relay display: resolve sends exactly the given binding sha and refuses without one", async () => {
  await refresh();
  const item = store.items().find((i) => i.id === A.path);
  assert.ok(item, "the undecided request-id file was not an item");
  assert.equal(item.title, "plan.html");
  await assert.rejects(item.resolve({ verdict: "approve", comment: "" }), /no binding/);
  await assert.rejects(item.resolve({ verdict: "approve", comment: "", binding: { path: B.path, sha256: "x" } }), /another file/);
  assert.equal(saves.length, 0, "a refused resolve still saved");
  await item.resolve({ verdict: "deny", comment: "no", binding: { path: A.path, sha256: "abc123" } });
  assert.deepEqual(saves, [{ path: A.path, sha256: "abc123", verdict: "deny", comment: "no" }]);
});

test("relay display: a malformed sidecar keeps the item with the error set", async () => {
  dom.ipc.answers.read_display_decision = () => { throw new Error("bad sidecar json"); };
  await refresh();
  const item = store.items().find((i) => i.id === A.path);
  assert.ok(item, "the malformed-sidecar item was dropped");
  assert.equal(item.error, "bad sidecar json");
});

test("relay display: a refresh result from an older generation is dropped", async () => {
  dom.ipc.answers.read_display_decision = null;
  const pending = [];
  dom.ipc.answers.list_display = () => new Promise((resolve) => pending.push(resolve));
  const first = refresh();
  const second = refresh();
  assert.equal(pending.length, 2);
  pending[1]({ files: [B], docs: [], newest: B.path });
  await second;
  pending[0]({ files: [A], docs: [], newest: A.path });
  await first;
  assert.deepEqual(store.items().map((i) => i.id), [B.path]);
});
