// tools/sandbox/explorer-seed.mjs: the seed writes the deny list, model and effort defaults and prefer_mxc into both
// Claude and both Codex homes (placed by agent-env.mjs resolveHome), plants the git fixture project, keeps the
// user's own settings, saves the project as a workspace with the runes-e2e library pieces, and --revert puts every
// file back. --check fails while an MCP server is named. Temp bases only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { resolve as resolveNode } from "../lib/paths.mjs";
import { MANIFEST, codexConfig, layout, run } from "./explorer-seed.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "explorer-seed-"));
const text = (p) => readFileSync(p, "utf8");
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const seed = () => JSON.parse(text(new URL("../../tests/fixtures/explorer/seed.json", import.meta.url)));

test("a base outside %TEMP% without the sandbox marker is refused", () => {
  const base = join(parse(tmpdir()).root, `vidar-explorer-seed-absent-${process.pid}`);
  const r = run({ base, dryRun: true });
  assert.equal(r.code, 2, r.lines.join("\n"));
  assert.equal(existsSync(base), false);
});

test("seed asserts deny list, prefer_mxc and model defaults in every home, then revert removes them", () => {
  const base = fresh();
  try {
    const l = layout(base);
    const own = '{"theme":"dark","permissions":{"deny":["Bash(rm:*)"]}}';
    put(l.claude[0], own);
    put(l.codex[0], 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n\n[features]\nfoo = true\n\n[projects.x]\ntrust = "y"\n');
    const r = run({ base, denyRoots: ["C:\\Users\\someone"] });
    assert.equal(r.code, 0, r.lines.join("\n"));
    const s = seed();
    for (const f of l.claude) {
      const j = JSON.parse(text(f));
      assert.equal(j.model, s.claude.model, f);
      assert.equal(j.effortLevel, "low", f);
      assert.equal(j.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false", f);
      assert.ok(j.permissions.deny.includes("mcp__*"), f);
      assert.ok(j.permissions.deny.some((d) => d.startsWith("Edit(") && d.includes("C:/Users/someone")), f);
      assert.ok(j.permissions.deny.some((d) => d.startsWith("Write(")) && j.permissions.deny.some((d) => d.startsWith("Bash(")), f);
    }
    const mine = JSON.parse(text(l.claude[0]));
    assert.equal(mine.theme, "dark", "the user's key survives");
    assert.ok(mine.permissions.deny.includes("Bash(rm:*)"));
    for (const f of l.codex) {
      const t = text(f);
      assert.match(t, new RegExp(`^model = "${s.codex.model}"$`, "m"), f);
      assert.match(t, /^model_reasoning_effort = "low"$/m, f);
      assert.match(t, /\[features\]\nprefer_mxc = true/, f);
      assert.equal(t.match(/^model = /gm).length, 1, f);
    }
    assert.match(text(l.codex[0]), /foo = true[\s\S]*\[projects\.x\]\ntrust = "y"/, "other tables kept");
    assert.ok(l.codex[1].includes(join("Vidar", "homes")), "bare home placed by resolveHome");
    assert.match(text(join(l.work, ".git", "HEAD")), /refs\/heads\/main/);
    assert.ok(existsSync(join(l.work, "README.md")));

    const again = run({ base });
    assert.equal(again.code, 0, again.lines.join("\n"));
    assert.equal(text(l.claude[0]).match(/mcp__\*/g).length, 1, "a second run adds nothing twice");

    const back = run({ base, revert: true });
    assert.equal(back.code, 0, back.lines.join("\n"));
    assert.equal(text(l.claude[0]), own, "the user's file is restored byte for byte");
    assert.match(text(l.codex[0]), /^model = "gpt-6-sol"$/m);
    assert.ok(!text(l.codex[0]).includes("prefer_mxc"));
    for (const f of [l.claude[1], l.codex[1]]) assert.equal(existsSync(f), false, `${f} was made by the seed`);
    assert.equal(existsSync(l.work), false);
    assert.equal(existsSync(join(base, MANIFEST)), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("seed saves the fixture project as a workspace with no row sets, then revert restores vidar.json", () => {
  const base = fresh();
  try {
    const l = layout(base);
    const other = join(base, "work", "other");
    mkdirSync(other, { recursive: true });
    const own = JSON.stringify({ theme: "dark", agents: [{ key: "claude-bare", label: "Mine" }], locations: [{ label: "Other", cwd: other }] });
    put(l.config, own);
    const r = run({ base });
    assert.equal(r.code, 0, r.lines.join("\n"));
    const c = JSON.parse(text(l.config));
    assert.equal(c.theme, "dark", "the user's key survives");
    assert.equal(c.rulesLibrary, "runes-e2e");
    assert.deepEqual(c.locations[0], { label: "Other", cwd: other }, "an existing workspace is kept");
    const ws = c.locations.find((x) => x.cwd === l.work);
    assert.equal(ws?.label, "Explorer");
    assert.equal(ws.sets, undefined, "the workspace holds no add-on sets");
    const bare = c.agents.find((a) => a.key === "claude-bare");
    assert.deepEqual(bare, { key: "claude-bare", label: "Mine" }, "an existing row is left as it was, with no sets");
    assert.equal(c.agents.length, 1, "no row is added");
    assert.ok(!JSON.stringify(c).includes('"kit"'), "kit (MCP modules) is left out");
    assert.match(text(join(l.app, "runes-e2e", "sets", "vidar-recall.md")), /<\?recall\?>/);
    assert.match(text(join(l.app, "runes-e2e", "rules", "desktop-only-recall.md")), /activate: recall/);
    assert.equal(existsSync(resolveNode("legacyRuneGenIndex", { root: l.app })), false, "no gen-index is seeded");
    for (const n of ["claude-user", "codex-user"]) assert.equal(existsSync(join(l.imports, n, "sets")), false, `${n} has no row sets`);
    assert.ok(readdirSync(join(l.imports, "claude-user", "rules")).length >= 3, "the library rules are seeded");
    assert.equal(existsSync(join(l.imports, "gen-claude-rendered-bare-5e1d0a7c")), false);
    assert.equal(existsSync(join(l.imports, "kit")), false);
    assert.equal(run({ base }).code, 0, "a second run reseeds");
    assert.equal(JSON.parse(text(l.config)).locations.filter((x) => x.cwd === l.work).length, 1, "the workspace is not added twice");

    const back = run({ base, revert: true });
    assert.equal(back.code, 0, back.lines.join("\n"));
    assert.equal(text(l.config), own, "vidar.json is restored byte for byte");
    assert.equal(existsSync(join(l.app, "runes-e2e")), false);
    for (const n of ["claude-user", "codex-user"]) assert.equal(existsSync(join(l.imports, n)), false, n);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a dry run writes nothing", () => {
  const base = fresh();
  try {
    const r = run({ base, dryRun: true });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.ok(r.lines.some((x) => x.startsWith("would write ") && x.endsWith("settings.json")));
    assert.ok(r.lines.includes(`would write ${layout(base).config}`), "vidar.json is listed");
    assert.ok(r.lines.some((x) => x.startsWith("would write ") && x.endsWith("vidar-recall.md")), "library files are listed");
    assert.equal(existsSync(join(base, "profile")), false);
    assert.equal(existsSync(join(base, "app")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("--check fails while an MCP server is named and passes when the list is empty", () => {
  const base = fresh();
  try {
    const l = layout(base);
    assert.equal(run({ base, check: true }).code, 0);
    put(l.claudeState[0], '{"mcpServers":{"unreal":{"command":"x"}}}');
    const r = run({ base, check: true });
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /unreal/);
    put(l.claudeState[0], "{}");
    assert.equal(run({ base, check: true }).code, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("codexConfig puts a flag in an existing [features] table and in a fresh file", () => {
  assert.equal(codexConfig(null, seed()), 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "low"\n\n[features]\nprefer_mxc = true\n');
  assert.match(codexConfig("[features]\nprefer_mxc = false\n", seed()), /\[features\]\nprefer_mxc = true\n$/);
});
