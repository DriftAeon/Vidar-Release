// falcon-prune.ps1 store entries go only when no kept bundle pins them (see falcon-prune-keeps.test.mjs
// for the trust-boundary header). Rig in tests/lib/falcon-prune-rig.mjs.
//
// The store pass also skips for a running falcon-build.ps1 with a relative -File, from any cwd (the
// script cannot see a process's cwd, so it counts for every root). A real build elsewhere on the machine
// is therefore a true skip, not a failure: the delete-store cases skip with the reported store_skip.
// Any other store_skip fails. A pwsh -Command whose text only names falcon-build.ps1 is not a build
// (release-build.test.mjs spawns one; it made these tests flake before falcon-prune read pwsh's own -File).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, makeTree, run, skip } from "./lib/falcon-prune-rig.mjs";

// True when the pass was skipped for a build running elsewhere (t.skip already called); asserts no other skip.
function skippedForBuild(t, r) {
  if (/^falcon-build running/.test(r.out.store_skip ?? "")) {
    t.skip(`store pass skipped by a build elsewhere: ${r.out.store_skip}`);
    return true;
  }
  assert.equal(r.out.store_skip, null);
  return false;
}

test("falcon-prune deletes only store entries pinned solely by deleted bundles", { skip }, (t) => {
  const tree = makeTree();
  const hex = (c) => c.repeat(64);
  try {
    // Fresh bundles: c current, b previous, d deleted. Future created_utc so store dirs made now are not "in flight".
    rmSync(join(tree.falcon, "bundles"), { recursive: true });
    rmSync(join(tree.falcon, "runtime", "registry.json"));
    const pins = { b: ["a", "1"], c: ["a", "2"], d: ["a", "3"] };
    for (const [c, year] of [["b", 2098], ["c", 2099], ["d", 2097]]) {
      mkdirSync(join(tree.falcon, "bundles", id(c)), { recursive: true });
      writeFileSync(join(tree.falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), created_utc: `${year}-01-01T00:00:00Z`, claude: { exe_sha256: hex(pins[c][0]) }, codex: { store_id: hex(pins[c][1]) } }));
    }
    for (const e of ["claude/" + hex("a"), `claude/${hex("a")}.tmp-0123`, "codex/" + hex("1"), "codex/" + hex("2"), "codex/" + hex("3")]) mkdirSync(join(tree.falcon, "store", e), { recursive: true });
    const r = run(tree);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.delete_bundles, [id("d")]);
    if (skippedForBuild(t, r)) return;
    assert.deepEqual(r.out.delete_store, ["codex/" + hex("3")]);
    assert.ok(r.out.keep_store.includes(`claude/${hex("a")}.tmp-0123`));
    assert.deepEqual(readdirSync(join(tree.falcon, "store", "codex")).sort(), [hex("1"), hex("2")]);

    // A kept bundle without a pin skips the store pass: the unpinned entry stays.
    mkdirSync(join(tree.falcon, "store", "codex", hex("4")));
    writeFileSync(join(tree.falcon, "bundles", id("b"), "runtime-manifest.json"), JSON.stringify({ bundle_id: id("b"), created_utc: "2098-01-01T00:00:00Z", claude: { exe_sha256: hex("a") } }));
    const unpinned = run(tree, "-DryRun");
    assert.equal(unpinned.status, 0, unpinned.stderr);
    assert.deepEqual(unpinned.out.delete_store, []);
    assert.equal(unpinned.out.store_skip, `kept bundle ${id("b")} has no store pins`);
  } finally {
    rmSync(tree.tmp, { recursive: true, force: true });
  }
});

test("falcon-prune keeps the store pass for schema-4 bundles that pin only their declared runtimes", { skip }, (t) => {
  const tree = makeTree();
  const hex = (c) => c.repeat(64);
  try {
    rmSync(join(tree.falcon, "bundles"), { recursive: true });
    rmSync(join(tree.falcon, "runtime", "registry.json"));
    // c current (v4, codex only), b previous (v3 with both pins), d deleted (v3).
    const manifests = {
      c: { schema: 4, runtimes: ["codex"], created_utc: "2099-01-01T00:00:00Z", codex: { store_id: hex("2") } },
      b: { schema: 3, created_utc: "2098-01-01T00:00:00Z", claude: { exe_sha256: hex("a") }, codex: { store_id: hex("1") } },
      d: { schema: 3, created_utc: "2097-01-01T00:00:00Z", claude: { exe_sha256: hex("a") }, codex: { store_id: hex("3") } },
    };
    for (const [c, m] of Object.entries(manifests)) {
      mkdirSync(join(tree.falcon, "bundles", id(c)), { recursive: true });
      writeFileSync(join(tree.falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), ...m }));
    }
    for (const e of ["claude/" + hex("a"), "codex/" + hex("1"), "codex/" + hex("2"), "codex/" + hex("3")]) mkdirSync(join(tree.falcon, "store", e), { recursive: true });
    const r = run(tree, "-DryRun");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.delete_bundles, [id("d")]);
    if (skippedForBuild(t, r)) return;
    assert.deepEqual(r.out.delete_store, ["codex/" + hex("3")]);
    assert.ok(r.out.keep_store.includes("codex/" + hex("2")));

    // A v4 bundle that declares codex but lacks the pin still skips the pass.
    writeFileSync(join(tree.falcon, "bundles", id("c"), "runtime-manifest.json"), JSON.stringify({ bundle_id: id("c"), schema: 4, runtimes: ["codex"], created_utc: "2099-01-01T00:00:00Z" }));
    const unpinned = run(tree, "-DryRun");
    assert.equal(unpinned.status, 0, unpinned.stderr);
    assert.deepEqual(unpinned.out.delete_store, []);
    assert.equal(unpinned.out.store_skip, `kept bundle ${id("c")} has no store pins`);
  } finally {
    rmSync(tree.tmp, { recursive: true, force: true });
  }
});

test("falcon-prune ignores falcon-build.ps1 named inside a pwsh -Command script", { skip }, async (t) => {
  const tree = makeTree();
  const hex = (c) => c.repeat(64);
  rmSync(join(tree.falcon, "bundles"), { recursive: true });
  rmSync(join(tree.falcon, "runtime", "registry.json"));
  for (const [c, year, s] of [["c", 2099, "2"], ["d", 2097, "3"]]) {
    mkdirSync(join(tree.falcon, "bundles", id(c)), { recursive: true });
    writeFileSync(join(tree.falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), created_utc: `${year}-01-01T00:00:00Z`, claude: { exe_sha256: hex("a") }, codex: { store_id: hex(s) } }));
  }
  for (const e of ["claude/" + hex("a"), "codex/" + hex("2"), "codex/" + hex("3")]) mkdirSync(join(tree.falcon, "store", e), { recursive: true });
  // The release-build.test.mjs shape: script text that quotes a relative -File build command.
  const text = '$hint = "pwsh -File tools/release/falcon-build.ps1 -Runtimes codex"; Start-Sleep -Seconds 60';
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", text], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const r = run(tree, "-DryRun");
    assert.equal(r.status, 0, r.stderr);
    if (skippedForBuild(t, r)) return;
    assert.deepEqual(r.out.delete_store, ["codex/" + hex("3")]);
  } finally {
    const closed = new Promise((r) => child.once("close", r));
    child.kill();
    await closed;
    rmSync(tree.tmp, { recursive: true, force: true });
  }
});
