// tools/sandbox/runes-seed.mjs: the refusals (no marker, homes path, credential name), a full materialise of
// tests/fixtures/runes-e2e/seed.json into a temp base, a second run that resets (stale file gone, foreign file
// reported), and a dry run that writes nothing. Every base is a fresh %TEMP% folder.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { MANIFEST, memorySlug, run, slug, tokensFor } from "../tools/sandbox/runes-seed.mjs";
import { resolve } from "../tools/lib/paths.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "runes-seed-"));
const one = (path) => ({ version: 1, files: [{ path, text: "x\n" }] });
const text = (p) => readFileSync(p, "utf8");

test("a base outside %TEMP% without the sandbox marker is refused", () => {
  const base = join(parse(tmpdir()).root, `vidar-runes-seed-absent-${process.pid}`);
  const r = run({ base, dryRun: true });
  assert.equal(r.code, 2, r.lines.join("\n"));
  assert.match(r.lines.at(-1), /REFUSED: .*holds no \.vidar-sandbox/);
  assert.equal(existsSync(base), false);
});

test("a seed path under the agent homes or naming a credential file is refused, writing nothing", () => {
  for (const path of ["<HOME>/AppData/Local/Vidar/homes/k/claude-config/x.md", "<HOME>/.claude/.credentials.json",
    "<HOME>/.codex/Auth.json", "<APP>/../escape.md", "<ELSEWHERE>/x.md"]) {
    const base = fresh();
    try {
      const r = run({ base, seed: one(path) });
      assert.equal(r.code, 2, `${path}: ${r.lines.join("\n")}`);
      assert.deepEqual(readdirSync(base), [], path);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});

test("the seed materialises: tokens, JSON form, the memory slug and the linked worktree", () => {
  const base = fresh();
  try {
    const r = run({ base });
    assert.equal(r.code, 0, r.lines.join("\n"));
    const t = tokensFor(base);
    assert.equal(t["<WORK_SLUG>"], memorySlug(join(base, "work", "runes-e2e")));
    assert.ok(t["<MEMORY_LIB>"].startsWith("memory-") && t["<MEMORY_LIB>"].length <= 32, t["<MEMORY_LIB>"]);
    assert.equal(slug("memory-C--A-b"), "memory-c-a-b");
    const config = JSON.parse(text(join(t["<APP>"], "vidar.json")));
    assert.equal(config.locations[0].cwd, t["<WORK>"]);
    assert.equal(config.agents[1].sets[1].library, t["<MEMORY_LIB>"]);
    const imports = resolve("runeImports", { root: t["<APP>"] });
    assert.equal(text(join(imports, "gen-index.json")), '{\n  "claude-rendered-bare": "gen-claude-rendered-bare-5e1d0a7c"\n}\n');
    const memImport = JSON.parse(text(join(imports, t["<MEMORY_LIB>"], "import.json")));
    assert.equal(memImport.source, `~\\.claude\\projects\\${t["<WORK_SLUG>"]}\\memory`);
    assert.ok(existsSync(join(t["<HOME>"], ".claude", "projects", t["<WORK_SLUG>"], "memory", "feedback-short.md")));
    const settings = JSON.parse(text(join(t["<HOME>"], ".claude", "settings.json")));
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(`"${t["<HOME>"]}\\.claude\\hooks\\guard-install.mjs"`));
    assert.ok(!text(join(t["<HOME>"], ".claude", "CLAUDE.md")).includes("\r"), "LF as written");
    const wt = join(t["<WORK>"], ".worktrees", "e2e");
    assert.match(text(join(wt, ".git")), /^gitdir: /, "linked worktree");
    assert.ok(existsSync(join(wt, "AGENTS.md")) && existsSync(join(t["<WORK>"], ".git", "HEAD")));
    const manifest = JSON.parse(text(join(base, MANIFEST)));
    assert.equal(manifest.files.length, JSON.parse(text(new URL("./fixtures/runes-e2e/seed.json", import.meta.url))).files.length);
    assert.deepEqual(manifest.dirs, [join(t["<WORK>"], ".git"), wt]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a second run resets: stale seeder files go, runtime runes clear, a foreign discoverable file fails", () => {
  const base = fresh();
  try {
    assert.equal(run({ base }).code, 0);
    const t = tokensFor(base);
    const stale = join(t["<HOME>"], ".claude", "rules", "stale.md");
    writeFileSync(stale, "old\n");
    const m = JSON.parse(text(join(base, MANIFEST)));
    writeFileSync(join(base, MANIFEST), JSON.stringify({ ...m, files: [...m.files, stale] }));
    const junk = join(resolve("runeImports", { root: t["<APP>"] }), "junk", "sets", "x.md");
    mkdirSync(join(junk, ".."), { recursive: true });
    writeFileSync(junk, "x\n");
    const again = run({ base });
    assert.equal(again.code, 0, again.lines.join("\n"));
    assert.equal(existsSync(stale), false, "a file the last run wrote and the seed dropped is removed");
    assert.equal(existsSync(junk), false, "runtime runes cleared");
    assert.ok(existsSync(join(t["<WORK>"], ".worktrees", "e2e", ".git")), "worktree rebuilt");

    const foreign = join(t["<HOME>"], ".codex", "skills", "foreign", "SKILL.md");
    mkdirSync(join(foreign, ".."), { recursive: true });
    writeFileSync(foreign, "x\n");
    const vidarJson = join(t["<APP>"], "vidar.json");
    writeFileSync(vidarJson, "{}\n");
    const r = run({ base });
    assert.equal(r.code, 1, r.lines.join("\n"));
    assert.ok(r.lines.at(-1).includes(foreign), r.lines.at(-1));
    assert.equal(text(vidarJson), "{}\n", "a failed check writes nothing");
    assert.ok(existsSync(foreign), "a foreign file is reported, never removed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a dry run prints the plan and writes nothing", () => {
  const base = fresh();
  try {
    const r = run({ base, dryRun: true });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("would write ") && l.endsWith("vidar.json")));
    assert.ok(r.lines.some((l) => l.startsWith("would run git-worktree")));
    assert.deepEqual(readdirSync(base), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
