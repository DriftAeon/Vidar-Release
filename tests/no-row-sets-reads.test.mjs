// Guard scan (run 2026-10-25-rune-vault, CONTEXT anti-drift 4): once the delete lane (wave 5) lands,
// nothing reads or writes a launcher row's `sets`, the gen-index or a sidecar list outside migration code.
// Model: docs/projects/bare/runeset-model.md § Not the model (one collection per launcher row, gen
// index add-back, `.layer.json` sidecars) and R2 (a session loads exactly one vault). The launcher
// pre-pick may read `defaults.json` and nothing else here. Scans tracked code files only (git
// ls-files); writes nothing.
// Usage: node --test tests/no-row-sets-reads.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODE = /\.(rs|ts|mjs|js|ps1)$/;

// Tokens that mean a row-sets, gen-index or sidecar read.
const ROW_TOKENS = ["row_sets_for", "row_sets(", "runeGenIndex", ".layer.json", "resolveSets(", "gen-index"];
const ROW_WRITES = [/set_row_refs(?:_in)?\s*\(/, /\.insert\(\s*["']sets["']/, /\[["']agents["']\][^\n]*\[["']sets["']\]\s*=/];
const DEFAULTS = "defaults.json";

// Migration code and its tests may name every token.
const MIGRATION = [/^src-tauri\/src\/bare\/vault\/migrate(_items|_tests|_durable)?(\.rs|\/)/, /^tests\/[^/]*migrat[^/]*\.test\.mjs$/];
// The launcher pre-pick, the vault store that holds its defaults.json, and their tests may name defaults.json only.
const PRE_PICK = [/^src\/launcher\//, /^src-tauri\/src\/bare\/vault\/mod\.rs$/, /^src-tauri\/src\/bare\/vault_gate_tests\.rs$/, /^tests\/[^/]*(pre-pick|vault-pick)[^/]*\.test\.mjs$/];
// This gate's own files quote the tokens.
const SELF = [/^tests\/no-row-sets-reads\.test\.mjs$/, /^tests\/runes-vault-gate\.test\.mjs$/, /^tests\/fixtures\/rune-vault\//];
const LEGACY_HELPERS = [/^src-tauri\/src\/bare\/set_layer\.rs$/];

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((f) => CODE.test(f));
}

function offenders(files) {
  const bad = [];
  for (const f of files) {
    if ([...MIGRATION, ...SELF].some((re) => re.test(f)) || f.startsWith("tests/") ||
      /(^|\/)(tests|\w+_tests?)\.rs$/.test(f) || f.endsWith(".test.mjs")) continue;
    let text;
    try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    // Rust unit fixtures may live after a cfg(test) block in the same file.
    if (f.endsWith(".rs")) text = text.split("#[cfg(test)]")[0];
    // Names in comments document retired migration paths; only executable reads count.
    text = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    for (const t of ROW_TOKENS) if (text.includes(t) && !(t === ".layer.json" && LEGACY_HELPERS.some((re) => re.test(f)))) bad.push(`${f}: ${t}`);
    for (const re of ROW_WRITES) if (re.test(text)) bad.push(`${f}: row-set write ${re}`);
    if (text.includes(DEFAULTS) && !PRE_PICK.some((re) => re.test(f))) bad.push(`${f}: ${DEFAULTS}`);
  }
  return bad;
}

test("no row-set read or write, gen-index or sidecar read outside migration code", () => {
  // D1/D2 (wave 5) delete the readers; L2d moves the row-set readers to the session record or vault.
  assert.deepEqual(offenders(tracked()), [], "read the session's vault (bare/vault) instead");
});

test("the scan catches a seeded reader and spares migration and the pre-pick", () => {
  // Self-check of the matcher on names only (no file is read for these paths).
  const seeded = (f, text) => {
    if ([...MIGRATION, ...SELF].some((re) => re.test(f))) return [];
    const out = ROW_TOKENS.filter((t) => text.includes(t)).map((t) => `${f}: ${t}`);
    for (const re of ROW_WRITES) if (re.test(text)) out.push(`${f}: row-set write ${re}`);
    if (text.includes(DEFAULTS) && !PRE_PICK.some((re) => re.test(f))) out.push(`${f}: ${DEFAULTS}`);
    return out;
  };
  assert.equal(seeded("src-tauri/src/bare/mod.rs", "layer::row_sets(&cfg, key)").length, 1);
  assert.equal(seeded("src/panels/runes/view.ts", "read defaults.json").length, 1);
  assert.equal(seeded("src-tauri/src/bare/vault/migrate.rs", "row_sets_for gen-index").length, 0);
  assert.equal(seeded("src/launcher/set-pick.ts", "defaults.json").length, 0);
  assert.equal(seeded("src/launcher/set-pick.ts", "runeGenIndex").length, 1, "the pre-pick may read defaults.json only");
  assert.equal(seeded("src-tauri/src/rules/import/assign.rs", 'entry.insert("sets", refs)').length, 1);
  assert.equal(seeded("src-tauri/src/rules/import/commands.rs", 'assign::set_row_refs(config, lib, set, rows)').length, 1);
});
