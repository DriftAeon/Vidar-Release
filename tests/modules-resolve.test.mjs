// Build-set resolver (tools/release/modules-resolve.mjs) on the module fixtures: set closure,
// the unknown-dependsOn rule, and the shipped-path cut.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packsDir } from "../tools/lib/release-layout.mjs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

const skip = missingInputs(import.meta.url, "../tools/release/modules-resolve.mjs");
const { cutPaths, isCut, reportOnlyPaths, resolveSet, shipsDep, shippedPaths, traceReportTerms } = skip ? {} : await import("../tools/release/modules-resolve.mjs");
const test = guard(baseTest, skip);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "tests", "fixtures", "modules");
// Claude is a pack (content/packs/claude), so the real packs root goes in beside the fixtures.
const CLAUDE = packsDir(ROOT);
const packsRoot = [join(FX, "ok-gateway"), join(FX, "ok-content")];
const set = (include) => ({ id: "t", label: "T", include, trace: [] });

test("a set that lists no core module still gets them; excluding claude drops its dependants", () => {
  const bare = resolveSet(set([]), { packsRoot });
  const core = bare.modules.filter((m) => m.level === "core").map((m) => m.id);
  assert.ok(core.includes("relay") && !core.includes("codex"), "relay is core; codex is a pack");
  assert.deepEqual(bare.included, core, "an empty include ships exactly the core modules");
  const r = resolveSet(set(["acme", "notes"]), { packsRoot });
  assert.deepEqual(r.included, core);
  assert.deepEqual(r.dropped.map((d) => [d.id, d.needs]), [["acme", "claude"], ["notes", "claude"]]);
  assert.deepEqual(r.lines, ["Dropped acme: Needs claude", "Dropped notes: Needs claude"]);
});

test("an unknown dependsOn marks the module dropped without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "modres-"));
  try {
    mkdirSync(join(dir, "lost"));
    writeFileSync(join(dir, "lost", "pack.json"), JSON.stringify({
      id: "lost", version: 1, provides: [],
      module: { id: "lost", label: "Lost", level: "optional", kind: "content", dependsOn: ["ghost"] },
    }));
    const r = resolveSet(set(["*"]), { packsRoot: dir });
    assert.deepEqual(r.dropped, [{ id: "lost", needs: "ghost" }]);

    assert.ok(!r.included.includes("lost"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a set's omit entries are cut like owns; reportOnly and traceReport are read, not cut", () => {
  const withOmit = { ...set(["codex"]), omit: ["tools/README.md", "tools/bare/"], reportOnly: ["src/"], traceReport: ["claude"] };
  const r = resolveSet(withOmit, { packsRoot: CLAUDE });
  const cut = cutPaths(r);
  assert.ok(cut.includes("tools/README.md") && cut.includes("tools/bare/"));
  assert.ok(!cut.includes("src/"), "reportOnly is not a cut");
  assert.deepEqual(reportOnlyPaths(withOmit), ["src/"]);
  assert.deepEqual(traceReportTerms(withOmit), ["claude"]);
  const kept = shippedPaths(withOmit, { resolved: r });
  assert.ok(!kept.includes("tools/README.md") && !kept.some((f) => f.startsWith("tools/bare/")));
  assert.ok(kept.some((f) => f.startsWith("src/")), "report-only source still ships");
});

test("cuts compare case-folded: a cut of tools/bare/ matches Tools/Bare/a.json", () => {
  assert.ok(isCut("Tools/Bare/a.json", ["tools/bare/"]));
  assert.ok(isCut("tools/bare/A.json", ["Tools/Bare/"]));
  assert.ok(isCut("Tools/README.md", ["tools/readme.md"]));
  assert.ok(!isCut("tools/bare/canaries.json", ["tools/bare/sweep.mjs"]));
  assert.ok(!isCut("tools/barely/a.json", ["tools/bare/"]));
});

test("shipsDep follows the module that declares the dep", () => {
  const withClaude = resolveSet(set(["codex", "falcon", "claude"]), { packsRoot: CLAUDE });
  assert.equal(shipsDep(withClaude, "falcon"), true);
  const without = resolveSet(set(["codex"]), { packsRoot: CLAUDE });
  assert.equal(shipsDep(without, "falcon"), false);
  assert.equal(shipsDep(resolveSet("codex"), "falcon"), true);
  assert.equal(shipsDep(resolveSet("codex"), "claude"), false);
  assert.equal(shipsDep(resolveSet("claude"), "falcon"), true);
  assert.equal(shipsDep(resolveSet("full"), "falcon"), true);
});

// release-zip.ps1 writes this --json `included` as release-manifest.json `set.included`, the list
// src-tauri/src/modules/set.rs filters the runtime registry by: it is the resolved list (dependants
// of excluded modules already dropped), so build and runtime agree.
const resolveCli = (id) => JSON.parse(execFileSync(process.execPath, [join(ROOT, "tools", "release", "modules-resolve.mjs"), id, "--json"], { encoding: "utf8" }));

test("codex --json included is the resolved set the runtime filters by", () => {
  const { id, included, dropped } = resolveCli("codex");
  assert.equal(id, "codex");
  assert.deepEqual(included, resolveSet("codex").included);
  for (const m of ["lab", "runelib", "tray", "doc", "flow", "changes", "unreal", "jira", "notion", "slack", "codex", "codex-profiles", "voice-stock"]) {
    assert.ok(included.includes(m), `codex ships ${m}`);
  }
  for (const d of dropped) assert.ok(!included.includes(d), `dropped ${d} is not included`);
});

// claude and codex are both a set id and a module id: a bare name on the resolver CLI is a set
// (sets/<id>.json), and the module of the same name is resolved as one of its members.
test("claude --json resolves the claude set: its include plus core, nothing dropped", () => {
  const { id, included, dropped, excluded } = resolveCli("claude");
  assert.equal(id, "claude");
  const r = resolveSet("claude");
  assert.deepEqual(included, r.included);
  const core = r.all.filter((m) => m.level === "core").map((m) => m.id);
  const want = ["claude", "agent-profiles", "falcon", "voice-stock", "tray", "doc", "flow", "runelib", "changes", "unreal", "jira", "notion", "slack"];
  assert.deepEqual([...included].sort(), [...new Set([...core, ...want])].sort());
  assert.deepEqual(dropped, []);
  assert.ok(excluded.includes("codex") && excluded.includes("codex-profiles"));
  assert.equal(resolveSet("codex").set.id, "codex", "the set file, not the codex module");
});

test("shippedPaths drops an excluded fixture folder", () => {
  const kept = shippedPaths(set(["*"]), { packsRoot: [join(FX, "ok-gateway"), CLAUDE] });
  assert.ok(kept.includes("tests/fixtures/modules/ok-gateway/acme/pack.json"));
  const cut = shippedPaths(set(["claude", "codex"]), { packsRoot: [join(FX, "ok-gateway"), CLAUDE] });
  assert.ok(!cut.some((f) => f.startsWith("tests/fixtures/modules/ok-gateway/acme/")));
  assert.ok(cut.includes("contracts/modules.json"));
  // tools/release/ is export-ignored except the Falcon bundle pruner build:falcon runs (.gitattributes)
  assert.ok(!cut.some((f) => f.startsWith("tools/release/") && f !== "tools/release/falcon-prune.ps1"), "an export-ignored directory is not shipped");
});
