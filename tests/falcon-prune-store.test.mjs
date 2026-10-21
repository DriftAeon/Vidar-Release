// falcon-prune.ps1 store entries go only when no kept bundle pins them (see falcon-prune-keeps.test.mjs
// for the trust-boundary header). Rig in tests/lib/falcon-prune-rig.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, makeTree, run, skip } from "./lib/falcon-prune-rig.mjs";

test("falcon-prune deletes only store entries pinned solely by deleted bundles", { skip }, () => {
  const t = makeTree();
  const hex = (c) => c.repeat(64);
  try {
    // Fresh bundles: c current, b previous, d deleted. Future created_utc so store dirs made now are not "in flight".
    rmSync(join(t.falcon, "bundles"), { recursive: true });
    rmSync(join(t.falcon, "runtime", "registry.json"));
    const pins = { b: ["a", "1"], c: ["a", "2"], d: ["a", "3"] };
    for (const [c, year] of [["b", 2098], ["c", 2099], ["d", 2097]]) {
      mkdirSync(join(t.falcon, "bundles", id(c)), { recursive: true });
      writeFileSync(join(t.falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), created_utc: `${year}-01-01T00:00:00Z`, claude: { exe_sha256: hex(pins[c][0]) }, codex: { store_id: hex(pins[c][1]) } }));
    }
    for (const e of ["claude/" + hex("a"), `claude/${hex("a")}.tmp-0123`, "codex/" + hex("1"), "codex/" + hex("2"), "codex/" + hex("3")]) mkdirSync(join(t.falcon, "store", e), { recursive: true });
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.delete_bundles, [id("d")]);
    assert.deepEqual(r.out.delete_store, ["codex/" + hex("3")]);
    assert.ok(r.out.keep_store.includes(`claude/${hex("a")}.tmp-0123`));
    assert.deepEqual(readdirSync(join(t.falcon, "store", "codex")).sort(), [hex("1"), hex("2")]);

    // A kept bundle without a pin skips the store pass: the unpinned entry stays.
    mkdirSync(join(t.falcon, "store", "codex", hex("4")));
    writeFileSync(join(t.falcon, "bundles", id("b"), "runtime-manifest.json"), JSON.stringify({ bundle_id: id("b"), created_utc: "2098-01-01T00:00:00Z", claude: { exe_sha256: hex("a") } }));
    const unpinned = run(t, "-DryRun");
    assert.equal(unpinned.status, 0, unpinned.stderr);
    assert.deepEqual(unpinned.out.delete_store, []);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("falcon-prune keeps the store pass for schema-4 bundles that pin only their declared runtimes", { skip }, () => {
  const t = makeTree();
  const hex = (c) => c.repeat(64);
  try {
    rmSync(join(t.falcon, "bundles"), { recursive: true });
    rmSync(join(t.falcon, "runtime", "registry.json"));
    // c current (v4, codex only), b previous (v3 with both pins), d deleted (v3).
    const manifests = {
      c: { schema: 4, runtimes: ["codex"], created_utc: "2099-01-01T00:00:00Z", codex: { store_id: hex("2") } },
      b: { schema: 3, created_utc: "2098-01-01T00:00:00Z", claude: { exe_sha256: hex("a") }, codex: { store_id: hex("1") } },
      d: { schema: 3, created_utc: "2097-01-01T00:00:00Z", claude: { exe_sha256: hex("a") }, codex: { store_id: hex("3") } },
    };
    for (const [c, m] of Object.entries(manifests)) {
      mkdirSync(join(t.falcon, "bundles", id(c)), { recursive: true });
      writeFileSync(join(t.falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), ...m }));
    }
    for (const e of ["claude/" + hex("a"), "codex/" + hex("1"), "codex/" + hex("2"), "codex/" + hex("3")]) mkdirSync(join(t.falcon, "store", e), { recursive: true });
    const r = run(t, "-DryRun");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.delete_bundles, [id("d")]);
    assert.deepEqual(r.out.delete_store, ["codex/" + hex("3")]);
    assert.ok(r.out.keep_store.includes("codex/" + hex("2")));

    // A v4 bundle that declares codex but lacks the pin still skips the pass.
    writeFileSync(join(t.falcon, "bundles", id("c"), "runtime-manifest.json"), JSON.stringify({ bundle_id: id("c"), schema: 4, runtimes: ["codex"], created_utc: "2099-01-01T00:00:00Z" }));
    const unpinned = run(t, "-DryRun");
    assert.equal(unpinned.status, 0, unpinned.stderr);
    assert.deepEqual(unpinned.out.delete_store, []);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});
