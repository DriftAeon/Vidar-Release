// falcon-prune.ps1 skips the store pass only for a running falcon-build.ps1 that targets the pruned root:
// absolute -File under the root counts, absolute under another root does not (a relative one counts, cwd unseen).
// Rig in tests/lib/falcon-prune-rig.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id, makeTree, run, skip } from "./lib/falcon-prune-rig.mjs";

const hex = (c) => c.repeat(64);

function storeTree() {
  const t = makeTree();
  rmSync(join(t.falcon, "bundles"), { recursive: true });
  rmSync(join(t.falcon, "runtime", "registry.json"));
  mkdirSync(join(t.falcon, "bundles", id("c")), { recursive: true });
  writeFileSync(join(t.falcon, "bundles", id("c"), "runtime-manifest.json"), JSON.stringify({ bundle_id: id("c"), created_utc: "2099-01-01T00:00:00Z", claude: { exe_sha256: hex("a") }, codex: { store_id: hex("2") } }));
  for (const e of ["claude/" + hex("a"), "codex/" + hex("2"), "codex/" + hex("3")]) mkdirSync(join(t.falcon, "store", e), { recursive: true });
  return t;
}

// A stand-in for a running build: pwsh whose first -File is a falcon-build.ps1 that just waits.
async function withBuild(dir, file, cwd, fn) {
  mkdirSync(dir, { recursive: true });
  const ready = join(dir, "ready.flag");
  writeFileSync(join(dir, "falcon-build.ps1"), `Set-Content -LiteralPath '${ready}' -Value 1\nStart-Sleep -Seconds 60\n`);
  const child = spawn("pwsh", ["-NoProfile", "-File", file], { cwd, stdio: "ignore" });
  try {
    // Wait for the script to be running (it writes the flag first) instead of a fixed 2.5 s sleep.
    for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(ready), "the stand-in build never started");
    await new Promise((r) => setTimeout(r, 300));
    return fn();
  } finally {
    const closed = new Promise((r) => child.once("close", r));
    child.kill();
    await closed;
  }
}

test("falcon-prune store pass honours only builds that target its root", { skip }, async () => {
  const t = storeTree();
  try {
    const base = run(t, "-DryRun");
    assert.deepEqual(base.out.delete_store, ["codex/" + hex("3")]);

    const inRoot = join(t.root, "tools", "release");
    const underRoot = await withBuild(inRoot, join(inRoot, "falcon-build.ps1"), tmpdir(), () => run(t, "-DryRun"));
    assert.deepEqual(underRoot.out.delete_store, []);

    const other = join(t.tmp, "other", "tools", "release");
    const elsewhere = await withBuild(other, join(other, "falcon-build.ps1"), tmpdir(), () => run(t, "-DryRun"));
    assert.deepEqual(elsewhere.out.delete_store, ["codex/" + hex("3")]);
    // No live case for a relative -File: it counts for every root on the machine, so a sleeper would
    // make the sibling prune tests (run in parallel) skip their store pass.
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});
