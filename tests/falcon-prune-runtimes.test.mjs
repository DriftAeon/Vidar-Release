// falcon-prune.ps1 reads its runtime list from tools/lib/FalconRuntimes.ps1: a declared runtime the table
// does not know, or a missing pin, skips the store pass and deletes no store entry. Every run is real
// (no -DryRun) but against a temp Vidar root and temp LOCALAPPDATA only (tests/lib/falcon-prune-rig.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, makeTree, run, skip } from "./lib/falcon-prune-rig.mjs";

const hex = (c) => c.repeat(64);
const STORE = ["claude/" + hex("a"), "codex/" + hex("1"), "codex/" + hex("2"), "codex/" + hex("3")];

// c current, b previous (kept); d old (deleted bundle, owns pin 3). Future dates keep store dirs from reading as in flight.
const both = (n) => ({ schema: 3, claude: { exe_sha256: hex("a") }, codex: { store_id: hex(n) } });
const SCENARIOS = [
  { name: "schema 3 both pins", c: both("2"), b: both("1"), deleted: ["codex/" + hex("3")] },
  { name: "schema 4 codex only", c: { schema: 4, runtimes: ["codex"], codex: { store_id: hex("2") } }, b: both("1"), deleted: ["codex/" + hex("3")] },
  { name: "schema 4 declares an unknown runtime", c: { schema: 4, runtimes: ["claude", "grok"], claude: { exe_sha256: hex("a") }, grok: { store_id: hex("9") } }, b: both("1"), deleted: [], skip: /no pin reader/ },
  { name: "schema 4 declares only an unknown runtime", c: { schema: 4, runtimes: ["grok"] }, b: both("1"), deleted: [], skip: /no pin reader/ },
  { name: "schema 3 missing pin", c: { schema: 3, claude: { exe_sha256: hex("a") } }, b: both("1"), deleted: [], skip: /no store pins/ },
];

function listStore(tree) {
  const out = [];
  for (const kind of ["claude", "codex"]) for (const e of readdirSync(join(tree.falcon, "store", kind))) out.push(`${kind}/${e}`);
  return out.sort();
}

test("falcon-prune store pass over 20 mixed runs deletes only the expected set", { skip }, (t) => {
  let ran = 0;
  for (let i = 0; i < 20; i++) {
    const s = SCENARIOS[i % SCENARIOS.length];
    const tree = makeTree();
    try {
      rmSync(join(tree.falcon, "bundles"), { recursive: true });
      rmSync(join(tree.falcon, "runtime", "registry.json"));
      const manifests = { c: [2099, s.c], b: [2098, s.b], d: [2097, both("3")] };
      for (const [c, [year, m]] of Object.entries(manifests)) {
        mkdirSync(join(tree.falcon, "bundles", id(c)), { recursive: true });
        writeFileSync(join(tree.falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), created_utc: `${year}-01-01T00:00:00Z`, ...m }));
      }
      for (const e of STORE) mkdirSync(join(tree.falcon, "store", e), { recursive: true });
      // Strays a prune must never touch.
      mkdirSync(join(tree.falcon, "store", "grok", hex("9")), { recursive: true });
      mkdirSync(join(tree.falcon, "store", "codex", "tmp-copy"), { recursive: true });
      const before = listStore(tree);
      const r = run(tree);
      assert.equal(r.status, 0, `${s.name} run ${i}: ${r.stderr}`);
      if (/^falcon-build running/.test(r.out.store_skip ?? "")) { t.diagnostic(`run ${i} skipped by a build elsewhere`); continue; }
      ran++;
      assert.deepEqual(r.out.delete_bundles, [id("d")], `${s.name} run ${i}`);
      const expected = before.filter((e) => !s.deleted.includes(e));
      assert.deepEqual(listStore(tree), expected, `${s.name} run ${i}: store after`);
      assert.deepEqual(readdirSync(join(tree.falcon, "store", "grok")), [hex("9")], `${s.name} run ${i}: unknown store kind untouched`);
      assert.deepEqual(r.out.delete_store, s.deleted, `${s.name} run ${i}: delete_store`);
      if (s.skip) assert.match(r.out.store_skip, s.skip, `${s.name} run ${i}`);
      else assert.equal(r.out.store_skip, null, `${s.name} run ${i}`);
    } finally {
      rmSync(tree.tmp, { recursive: true, force: true });
    }
  }
  if (ran === 0) t.skip("every run skipped by a build elsewhere");
});
