// falcon-prune.ps1 real (non-dry) run: leaves exactly the keeps on disk and sweeps trash (see
// falcon-prune-keeps.test.mjs for the trust-boundary header). Rig in tests/lib/falcon-prune-rig.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { id, makeTree, run, skip } from "./lib/falcon-prune-rig.mjs";

test("falcon-prune real run leaves exactly the keeps on disk and sweeps trash", { skip }, () => {
  const t = makeTree();
  try {
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(t.falcon, "bundles")).sort(), ["a", "b", "c", "e", "f"].map(id));
    assert.deepEqual(readdirSync(join(t.lad, "test.falcon")).sort(), ["0.1.0-99999999", id("a"), "EBWebView", "notes"].sort());
    assert.deepEqual(readdirSync(join(t.falcon, "prune-trash")), []);
    const profileTrash = join(t.lad, "test.falcon.prune-trash");
    assert.ok(!existsSync(profileTrash) || readdirSync(profileTrash).length === 0);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});
