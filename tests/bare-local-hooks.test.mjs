// tests/fixtures/bare-hooks/settings.json: guard-probe's `--emit` list equals the fixture's `expectBareGuards`,
// the same list the Rust port (src-tauri/src/rules/import/local.rs) preselects; its Rust test checks both too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitBareGuards } from "../tools/bare/guard-probe.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "bare-hooks", "settings.json");

test("guard-probe emits the fixture's expected bareGuards", () => {
  const settings = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(emitBareGuards(settings), settings.expectBareGuards);
  const r = spawnSync(process.execPath, [join(REPO, "tools", "bare", "guard-probe.mjs"), "--emit", "--settings", FIXTURE], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).bareGuards, settings.expectBareGuards);
});

test("the Rust port's block-target list matches guard-probe's", async () => {
  const { BLOCK_TARGETS } = await import("../tools/bare/guard-probe.mjs");
  const rust = readFileSync(join(REPO, "src-tauri", "src", "rules", "import", "local.rs"), "utf8");
  const m = rust.match(/pub const BLOCK_TARGETS: \[&str; \d+\] = \[([^\]]*)\]/);
  assert.ok(m, "BLOCK_TARGETS not found in local.rs");
  assert.deepEqual([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), BLOCK_TARGETS);
});
