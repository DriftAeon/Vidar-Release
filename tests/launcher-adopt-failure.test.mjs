// Launcher adopt: a refused adopt drops the tab once (launcher click only) and rejects; the
// 10 s no-settle timeout rejects but keeps the tab and never raises the Falcon shell.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { AdoptError, finishAdopt, shouldShowShellAfterDrop, startAdopt } from "../src/launcher/adopt-settle.ts";

test("onAdopted(false) with dropOnFail drops once, logs the reason and rejects", async () => {
  const dropped = [];
  const logged = [];
  const a = startAdopt();
  a.onAdopted(false, "already controlled by falcon-shell");
  a.onAdopted(false, "again");
  await assert.rejects(
    finishAdopt("tab-1", a.result, { dropOnFail: true, drop: (t) => dropped.push(t), log: (r) => logged.push(r) }),
    (e) => e instanceof AdoptError && e.kind === "refused" && e.dropped && e.reason === "already controlled by falcon-shell",
  );
  assert.deepEqual(dropped, ["tab-1"]);
  assert.deepEqual(logged, ["already controlled by falcon-shell"]);
});

test("onAdopted(false) without dropOnFail rejects and keeps the tab", async () => {
  const dropped = [];
  const a = startAdopt();
  a.onAdopted(false, "boom");
  await assert.rejects(
    finishAdopt("tab-1", a.result, { drop: (t) => dropped.push(t) }),
    (e) => e instanceof AdoptError && e.kind === "refused" && !e.dropped,
  );
  assert.deepEqual(dropped, []);
});

test("onAdopted(true) resolves the tab", async () => {
  const a = startAdopt();
  a.onAdopted(true);
  assert.equal(await finishAdopt("tab-1", a.result, { dropOnFail: true, drop: () => assert.fail("dropped") }), "tab-1");
});

test("no settle rejects at 10 s, keeps the tab and never raises the shell", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const dropped = [];
    const a = startAdopt();
    const done = finishAdopt("tab-1", a.result, { dropOnFail: true, drop: (t) => dropped.push(t) });
    const settled = assert.rejects(done, (e) => {
      assert.ok(e instanceof AdoptError && e.kind === "timeout" && !e.dropped);
      assert.equal(shouldShowShellAfterDrop(e, true), false);
      return true;
    });
    mock.timers.tick(9_999);
    assert.deepEqual(dropped, []);
    mock.timers.tick(1);
    await settled;
    assert.deepEqual(dropped, []);
  } finally {
    mock.timers.reset();
  }
});

test("shell is raised after a drop only on the controller text or a shell-held re-list", () => {
  const refused = (reason, dropped = true) => new AdoptError("x", "refused", reason, dropped);
  assert.equal(shouldShowShellAfterDrop(refused("session is already controlled by falcon-shell"), false), true);
  assert.equal(shouldShowShellAfterDrop(refused("other"), true), true);
  assert.equal(shouldShowShellAfterDrop(refused("other"), false), false);
  assert.equal(shouldShowShellAfterDrop(refused("already controlled by x", false), true), false);
  assert.equal(shouldShowShellAfterDrop(new Error("already controlled by x"), true), false);
});
