// Rune Vault seed: sandbox path refusal, vault-shaped fixture and reset of old row artifacts.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { DEL_LIBRARY, DEL_RUNES, MANIFEST, delFiles, run, tokensFor } from "../tools/sandbox/runes-seed.mjs";

// realpath expands 8.3 short TEMP names (RUNNER~1) to the long form the scripts report
const fresh = () => realpathSync.native(mkdtempSync(join(tmpdir(), "runes-seed-")));
const text = (p) => readFileSync(p, "utf8");
const one = (p) => ({ version: 2, files: [{ path: p, text: "x\n" }] });

test("base outside TEMP without the sandbox marker is refused", () => {
  const base = join(parse(tmpdir()).root, `vidar-runes-seed-absent-${process.pid}`);
  const r = run({ base, dryRun: true });
  assert.equal(r.code, 2);
  assert.equal(existsSync(base), false);
});

test("path, credential and legacy git-step refusals write nothing", () => {
  for (const seed of [
    one("<HOME>/AppData/Local/Vidar/homes/k/x.md"), one("<HOME>/.claude/.credentials.json"),
    one("<HOME>/.codex/Auth.json"), one("<APP>/../escape.md"), one("<ELSEWHERE>/x.md"),
    { ...one("<APP>/x.md"), steps: [{ op: "git-worktree" }] },
  ]) {
    const base = fresh();
    try { assert.equal(run({ base, seed }).code, 2); assert.deepEqual(readdirSync(base), []); }
    finally { rmSync(base, { recursive: true, force: true }); }
  }
});

test("seed writes library picks and no row or gen-index artifact", () => {
  const base = fresh();
  try {
    const r = run({ base });
    assert.equal(r.code, 0, r.lines.join("\n"));
    const t = tokensFor(base), app = t["<APP>"];
    const config = JSON.parse(text(join(app, "vidar.json")));
    assert.equal(config.rulesLibrary, "runes-e2e");
    assert.ok(config.agents.every((a) => !a.sets));
    assert.ok(config.locations.every((l) => !l.sets));
    for (const set of ["first", "second"]) assert.match(text(join(app, "runes-e2e", "sets", `${set}.md`)), /<\?rune shared\?>/);
    assert.ok(existsSync(join(app, "runes-e2e", "rules", "one-off.md")));
    assert.match(text(join(app, "runes-e2e", "rules", "e2e-pinned.md")), /E2E-PINNED-OLD/);
    assert.ok(existsSync(join(app, "runes-e2e", "skills", "e2e-review.md")));
    assert.equal(existsSync(join(app, "runtime/runes/gen-index.json")), false);
    const manifest = JSON.parse(text(join(base, MANIFEST)));
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.dirs, []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("reseed clears legacy imports and reports foreign discoverable files before writing", () => {
  const base = fresh();
  try {
    assert.equal(run({ base }).code, 0);
    const t = tokensFor(base), app = t["<APP>"];
    const index = join(app, "runtime/runes/gen-index.json");
    mkdirSync(join(index, ".."), { recursive: true }); writeFileSync(index, "{}\n");
    assert.equal(run({ base }).code, 0);
    assert.equal(existsSync(index), false);
    const foreign = join(t["<HOME>"], ".codex", "skills", "foreign", "SKILL.md");
    mkdirSync(join(foreign, ".."), { recursive: true }); writeFileSync(foreign, "x\n");
    const config = join(app, "vidar.json"); writeFileSync(config, "{}\n");
    const r = run({ base });
    assert.equal(r.code, 1);
    assert.ok(r.lines.at(-1).includes(foreign));
    assert.equal(text(config), "{}\n");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("seed empties saved Codex tabs an earlier run left, keeping the rest of the UI state", () => {
  const base = fresh();
  try {
    const file = join(tokensFor(base)["<APP>"], "runtime", "vidar-state.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "olive", "rendered.codexTabs": [{ title: "Onyx Talon", sets: [{ set: "vidar-recall" }] }] }));
    const dry = run({ base, dryRun: true });
    assert.ok(dry.lines.some((l) => l.startsWith("would drop rendered.codexTabs")), dry.lines.join("\n"));
    assert.equal(JSON.parse(text(file))["rendered.codexTabs"].length, 1);
    assert.equal(run({ base }).code, 0);
    assert.deepEqual(JSON.parse(text(file)), { theme: "olive", "rendered.codexTabs": [] });
    assert.ok(!run({ base }).lines.some((l) => l.includes("drop")), "nothing to drop on a clean state");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("seed empties vault state an earlier run left: custom vault, edited stock vault, session record, defaults", () => {
  const base = fresh();
  try {
    const vaults = join(tokensFor(base)["<APP>"], "runtime", "vaults");
    const stale = [join(vaults, "custom-ddf9b7", "vault.json"), join(vaults, "stock-claude", "vault.json"),
      join(vaults, "sessions", "s1.json"), join(vaults, "defaults.json")];
    for (const f of stale) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "{}\n"); }
    const dry = run({ base, dryRun: true });
    assert.ok(dry.lines.some((l) => l === `would clear ${vaults}`), dry.lines.join("\n"));
    assert.ok(stale.every(existsSync), "dry run writes nothing");
    assert.equal(run({ base }).code, 0);
    assert.ok(stale.every((f) => !existsSync(f)));
    assert.equal(existsSync(vaults), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("default seed adds case 11's throwaway import library with two runes, and no other library changes", () => {
  const base = fresh();
  try {
    assert.equal(run({ base }).code, 0);
    const imports = join(tokensFor(base)["<APP>"], "runtime/runes", DEL_LIBRARY);
    assert.deepEqual(readdirSync(join(imports, "rules")).sort(), DEL_RUNES.map((id) => `${id}.md`));
    assert.match(text(join(imports, "rules", "del-a.md")), /^---\nname: del-a\nkind: rule\n/);
    assert.equal(delFiles().length, 2);
    assert.ok(existsSync(join(tokensFor(base)["<APP>"], "runes-e2e", "rules", "one-off.md")));
    assert.equal(run({ base }).code, 0, "a reseed restores a deleted throwaway library");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("dry run lists files without writing", () => {
  const base = fresh();
  try { const r = run({ base, dryRun: true }); assert.equal(r.code, 0); assert.ok(r.lines.some((l) => l.endsWith("one-off.md"))); assert.deepEqual(readdirSync(base), []); }
  finally { rmSync(base, { recursive: true, force: true }); }
});
