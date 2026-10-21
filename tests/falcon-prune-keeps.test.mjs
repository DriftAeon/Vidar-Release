// Trust boundary: falcon-prune.ps1 deletes bundles and WebView2 profiles, so its keep selection is
// what stands between a refresh and a deleted live host or profile. Runs the real script against a
// temp Vidar root and a temp LOCALAPPDATA: current, previous, registry, in-flight (newer than
// current) and unreadable-manifest bundles stay, profiles follow their bundle, non-bundle-shaped
// profile children (a root-level EBWebView) are never touched, and the script fails closed.
// Split from falcon-prune.test.mjs so the three pwsh-heavy cases run in parallel; rig in tests/lib.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, makeTree, run, skip } from "./lib/falcon-prune-rig.mjs";

test("falcon-prune selects keeps and fails closed", { skip }, () => {
  const t = makeTree();
  try {
    const ok = run(t, "-DryRun");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.out.aborted, null);
    assert.deepEqual(ok.out.keep_bundles, ["a", "b", "c", "e", "f"].map(id));
    assert.deepEqual(ok.out.delete_bundles, [id("d")]);
    // The profile root is shared by every install root: a bundle-shaped profile this root never had
    // (0.1.0-99999999, another checkout's bundle) is kept; only a deleted bundle's profile goes.
    assert.deepEqual(ok.out.keep_profiles, ["0.1.0-99999999", id("a"), "EBWebView", "notes"].sort());
    assert.deepEqual(ok.out.delete_profiles, [id("d")]);

    const vidar = run(t, "-DryRun", "-ProfileIdentifier", "com.zero.vidar");
    assert.equal(vidar.status, 1);
    assert.match(vidar.out.aborted, /not a Falcon identifier/);

    writeFileSync(join(t.falcon, "runtime", "registry.json"), "{ not json");
    const closed = run(t, "-DryRun");
    assert.equal(closed.status, 1);
    assert.match(closed.out.aborted, /registry\.json unreadable/);
    assert.deepEqual([closed.out.delete_bundles, closed.out.delete_profiles], [[], []]);

    // Real run (temp roots only): the deleted bundle's profile is gone, the foreign one stays.
    writeFileSync(join(t.falcon, "runtime", "registry.json"), JSON.stringify({ bundle_id: id("a"), pid: 0 }));
    const real = run(t);
    assert.equal(real.status, 0, real.stderr);
    assert.equal(existsSync(join(t.lad, "test.falcon", id("d"))), false);
    assert.equal(existsSync(join(t.lad, "test.falcon", "0.1.0-99999999")), true);
    assert.equal(existsSync(join(t.lad, "test.falcon", id("a"))), true);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});
