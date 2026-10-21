// Vendor names live in packs: no runtime path a released set (codex: no Claude; claude: no Codex)
// ships names a pack's declared trace term outside that pack's own folder and `owns` (same boundary and
// engine as trace-check.ps1), and the real packs close over claude. This previews the artifact gate over
// shippedPaths(set), by pack terms and by the set's own gated terms (modules-resolve.mjs --terms).
// Runtime only (plan-phase-b-v2 Amendment A1/A2): the set's `reportOnly` prefixes (source trees and
// package files) are source, reported by the burn-down, not gated here. The `omit` entries are cut
// from shippedPaths, so they need no burn-down line.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rel } from "../tools/lib/paths.mjs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

const skip = missingInputs(import.meta.url, "../tools/release/modules-resolve.mjs", "../tools/release/trace-scan.mjs", "../tools/release/start-here-fill.mjs");
const { ROOT, cutPaths, readContract, readSet, reportOnlyPaths, resolveSet, shippedPaths, traceReportTerms, traceTerms, underAny } = skip ? {} : await import("../tools/release/modules-resolve.mjs");
const { compileTerms, scanBuffer } = skip ? {} : await import("../tools/release/trace-scan.mjs");
const { filledStartHere } = skip ? {} : await import("../tools/release/start-here-fill.mjs");
const test = guard(baseTest, skip);

const under = (f, o) => (o.endsWith("/") ? f.startsWith(o) : f === o);
// Burn-down: runtime files still naming a Claude trace term after Claude moved into its pack, each
// with the Phase B unit that clears it. An entry that stops hitting fails the test, so it is removed.
const PENDING = new Map([
]);
const RELEASED = ["codex", "claude"];

function runtimeFiles(id, r) {
  const reportOnly = reportOnlyPaths(id);
  return shippedPaths(id, { resolved: r }).filter((f) => !underAny(f, reportOnly));
}

// START-HERE.md is filled per set at staging (release-zip.ps1), so the zip trace sees the set's fill,
// not the repo copy (the full fill); every other file is read as is.
function shippedBytes(f, set) {
  const buf = readFileSync(join(ROOT, f));
  return f === "START-HERE.md" && set ? Buffer.from(filledStartHere(set, buf.toString("utf8")), "utf8") : buf;
}

function scan(files, res, set) {
  const found = [];
  for (const f of files) {
    for (const [term, re] of res.name) if (f.match(re)) found.push(`name:${f}:${term}`);
    for (const h of scanBuffer(shippedBytes(f, set), res)) found.push(`file:${f}:${h.term}`);
  }
  return found;
}

for (const id of RELEASED) {
  // Packs the set leaves out: a shipped pack's names are the build's own (claude's tools ship in the
  // claude set). For codex that is every pack with trace terms, as before the claude set existed.
  test(`${id}: no shipped runtime path outside a pack's own files names an excluded pack's trace term`, () => {
    const r = resolveSet(id);
    const packs = r.all.filter((m) => m.source === "pack" && m.trace.length > 0 && !r.included.includes(m.id));
    // Only the claude pack declares trace terms now, so the claude set has none to scan.
    if (id === "codex") assert.ok(packs.length >= 1, "real packs declare trace terms");
    const { trace } = readContract();
    const files = runtimeFiles(id, r);
    assert.ok(files.includes("contracts/modules.json") && !files.some((f) => f.startsWith("src/")), "runtime surface only");
    const hits = [];
    const pendingHit = new Set();
    for (const m of packs) {
      const own = [`${rel("packs")}/${m.folder}/`, ...m.owns];
      const res = compileTerms(trace.boundary, trace.termToken, m.trace);
      for (const f of files) {
        if (own.some((o) => under(f, o))) continue;
        const found = scan([f], res, id);
        if (found.length > 0 && m.id === "claude" && PENDING.has(f)) pendingHit.add(f);
        else hits.push(...found);
      }
    }
    assert.deepEqual(hits, []);
    const cleared = [...PENDING.keys()].filter((f) => !pendingHit.has(f));
    assert.deepEqual(cleared, [], "cleared burn-down entries: remove them from PENDING");
  });

  test(`${id}: the set's gated terms hit no shipped runtime path; its traceReport terms are not gated`, () => {
    const r = resolveSet(id);
    const { trace } = readContract();
    const gated = traceTerms(id);
    for (const t of traceReportTerms(id)) assert.ok(!gated.includes(t), `${t} is report-only, not gated`);
    assert.deepEqual(scan(runtimeFiles(id, r), compileTerms(trace.boundary, trace.termToken, gated), id), []);
  });
}

test("the codex set omits the Claude-named tool files and reports source trees only", () => {
  const codex = readSet("codex");
  assert.deepEqual(codex.include, ["codex", "codex-profiles", "falcon", "voice-stock", "tray", "doc", "flow", "runelib", "lab", "changes", "unreal", "jira", "notion", "slack"], "codex ships no Claude");
  const r = resolveSet("codex");
  assert.ok(r.included.includes("codex") && r.included.includes("codex-profiles"), "codex ships the codex pack and the codex-profiles pack");
  assert.ok(!r.excluded.includes("codex"));
  assert.ok(r.included.includes("falcon") && !r.included.includes("claude"), "codex ships the falcon pack without Claude");
  for (const f of ["falcon-slice0.ps1", "falcon-slice1.ps1"]) assert.ok(!shippedPaths("codex").includes("tools/falcon/" + f), `${f} stays out of the codex zip`);
  assert.ok(codex.include.includes("lab"), "Lab lists AGENTS.md-targeting runes when Codex is on (2026-10-19)");
  assert.ok(codex.traceReport.includes("claude") && codex.traceReport.includes("anthropic"));
  const shipped = shippedPaths("codex");
  for (const o of codex.omit) assert.ok(!shipped.some((f) => under(f, o) || f.startsWith(o + "/")), `${o} still ships`);
  // The codex zip drops source and the package lock (2026-10-18); package.json still ships and is report-only.
  for (const p of ["src/", "src-tauri/", "src-falcon/"]) {
    assert.ok(codex.omit.includes(p), `${p} is omitted`);
    assert.ok(!shipped.some((f) => under(f, p)), `${p} still ships`);
  }
  assert.ok(codex.omit.includes("package-lock.json"), "package-lock.json is in codex.omit");
  assert.ok(!shipped.some((f) => under(f, "package-lock.json")), "no shipped path is under package-lock.json");
  assert.ok(codex.reportOnly.includes("package.json"), "package.json is in codex.reportOnly");
  assert.ok(shipped.some((f) => under(f, "package.json")), "package.json ships");
});

test("the claude set mirrors codex: Claude and its dependants in, Codex out, Claude tools shipped", () => {
  const claude = readSet("claude");
  const codex = readSet("codex");
  assert.equal(claude.personal, undefined, "not personal");
  assert.deepEqual(claude.trace, codex.trace);
  assert.deepEqual(claude.traceReport, ["codex", "openai"]);
  assert.deepEqual(claude.reportOnly, ["src/", "src-tauri/", "src-falcon/", "package.json", "package-lock.json", "NOTICE", "public/THIRD-PARTY-NOTICES.txt"], "claude keeps source");
  const r = resolveSet("claude");
  const core = r.all.filter((m) => m.level === "core").map((m) => m.id);
  assert.deepEqual([...r.included].sort(), [...new Set([...core, ...claude.include])].sort(), "include plus core, nothing dropped");
  assert.deepEqual(r.dropped, []);
  for (const id of ["codex", "codex-profiles", "lab"]) assert.ok(r.excluded.includes(id), `${id} is excluded`);
  const shipped = shippedPaths("claude");
  for (const o of claude.omit) assert.ok(!shipped.some((f) => under(f, o) || f.startsWith(o + "/")), `${o} still ships`);
  assert.ok(cutPaths(r).includes(`${rel("packs")}/codex/`));
  // Omitted from codex only for naming Claude: these ship in the Claude build.
  for (const f of ["tools/bare/probe-claude.ps1", "tools/drive/sidecar-smoke.mjs", "tools/claude-sidecar.mjs"]) {
    assert.ok(shipped.includes(f), `${f} ships`);
  }
  for (const p of claude.reportOnly) assert.ok(shipped.some((f) => under(f, p)), `${p} still ships (A1: the build keeps source)`);
});

test("a no-Codex set cuts the codex pack and drops codex-profiles with it", () => {
  const codex = readSet("codex");
  const r = resolveSet({ ...codex, include: codex.include.filter((id) => id !== "codex") });
  assert.ok(!r.included.includes("codex") && !r.included.includes("codex-profiles"));
  assert.deepEqual(r.dropped, [{ id: "codex-profiles", needs: "codex" }]);
  assert.ok(cutPaths(r).includes(`${rel("packs")}/codex/`));
});

test("the no-Claude set drops agent-profiles and cuts claude's owns", () => {
  const codex = readSet("codex");
  const packIds = resolveSet("full").all.filter((m) => m.source === "pack").map((m) => m.id);
  const set = { ...codex, include: [...codex.include, ...packIds].filter((id) => id !== "claude") };
  const r = resolveSet(set);
  for (const id of ["agent-profiles"]) {
    assert.ok(r.dropped.some((d) => d.id === id), `${id} leaves with claude`);
    assert.ok(!r.included.includes(id));
  }
  assert.ok(r.included.includes("codex") && !r.included.includes("claude"));
  const claude = r.all.find((m) => m.id === "claude");
  const cut = cutPaths(r);
  assert.ok(cut.includes(`${rel("packs")}/claude/`));
  for (const o of claude.owns) assert.ok(cut.includes(o), `${o} is cut`);
  for (const o of codex.omit) assert.ok(cut.includes(o), `${o} is cut`);
  const shipped = shippedPaths(set, { resolved: r });
  for (const o of claude.owns) assert.ok(!shipped.some((f) => under(f, o)), `${o} still ships`);
  assert.ok(shipped.includes("contracts/modules.json"));
});
