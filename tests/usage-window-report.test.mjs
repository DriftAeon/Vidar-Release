// tools/usage/window-report.mjs and tools/claude-sidecar-ledger.mjs: weighting, dedupe, restart-safe logged $,
// drift, window replacement, source classification, and the sidecar's ledger line. Fixtures live in a temp dir.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerEntry, startLedger, resolveLedgerPath } from "../tools/claude-sidecar-ledger.mjs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

// The window report is usage tooling that does not ship; the sidecar ledger tests below it do.
const skip = missingInputs(import.meta.url, "../tools/usage/window-report.mjs");
const {
  unitsOf, modelWeight, transcriptUnits, loggedUsd, windowSpan, newestWindow, driftOf, isDrift, median,
  buildLine, replaceWindowLine, classifyTranscript, ledgerTotals, report, table,
} = skip ? {} : await import("../tools/usage/window-report.mjs");
const test = guard(baseTest, skip);

const T0 = Date.parse("2026-01-01T10:00:00Z");
const iso = (min) => new Date(T0 + min * 60000).toISOString();

test("units weight tokens and models", () => {
  const c = { input: 100, output: 10, cacheRead: 1000, cacheWrite: 40 };
  assert.equal(unitsOf(c, "claude-opus-5-5"), 100 + 10 * 5 + 1000 * 0.1 + 40 * 1.25);
  assert.equal(unitsOf(c, "claude-sonnet-5"), 0.6 * unitsOf(c, "claude-opus-5-5"));
  assert.equal(unitsOf(c, "claude-haiku-4-5"), 0.2 * unitsOf(c, "opus"));
  assert.equal(modelWeight("gpt-5"), 0);
  assert.equal(modelWeight("<synthetic>"), 0);
});

const row = (id, minute, out, model = "claude-opus-5-5") => ({
  timestamp: iso(minute),
  message: { id, model, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

test("transcript rows dedupe by message id (largest counts win) and respect the span", () => {
  const rows = [row("m1", 1, 2), row("m1", 1, 8), row("m2", 2, 1), row("m3", 99, 100), { timestamp: iso(1), type: "user" }];
  // m1: 10 + 8*5 = 50, m2: 10 + 5 = 15, m3 is outside the span
  assert.equal(transcriptUnits(rows, T0, T0 + 10 * 60000), 65);
});

test("logged $ is last minus first per sid and restarts count from the drop", () => {
  const meter = [
    { sid: "a", cost: 1 }, { sid: "a", cost: 3 },
    { sid: "b", cost: 5 }, { sid: "b", cost: 6 },
    { sid: "a", cost: 0.5 }, { sid: "a", cost: 1.5 }, // restart at 0.5: segment 1, plus (3 - 1) before
  ];
  assert.equal(loggedUsd(meter), 2 + 1 + 1);
});

test("window span is first to last row of the newest fiveResets and points are max minus min", () => {
  const meter = [
    { ts: iso(-60), fiveResets: 100, five: 90 },
    { ts: iso(0), fiveResets: 200, five: 3 },
    { ts: iso(30), fiveResets: 200, five: 8 },
    { ts: iso(20), fiveResets: 200, five: 5 },
  ];
  assert.equal(newestWindow(meter), 200);
  const s = windowSpan(meter, 200);
  assert.deepEqual([s.fromMs, s.toMs, s.fivePoints], [T0, T0 + 30 * 60000, 5]);
  assert.equal(windowSpan(meter, 999), null);
});

test("drift compares units per point with the median of earlier rows in the last 7 days", () => {
  const day = 86400;
  const earlier = [
    { window: 1000 - day, unitsPerPoint: 100 },
    { window: 1000 - 2 * day, unitsPerPoint: 120 },
    { window: 1000 - 9 * day, unitsPerPoint: 5000 }, // older than 7 days
    { window: 1000, unitsPerPoint: 1 }, // the window itself
    { window: 1000 + day, unitsPerPoint: 7 }, // later
  ];
  const d = driftOf(77, 1000, earlier);
  assert.equal(d.medianUnitsPerPoint7d, 110);
  assert.equal(d.drift, 77 / 110);
  assert.equal(isDrift(d.drift), true);
  assert.equal(isDrift(1.05), false);
  assert.equal(isDrift(0.89), true);
  assert.equal(isDrift(1.11), true);
  assert.equal(driftOf(5, 1000, []).drift, null);
  assert.equal(median([3, 1, 2]), 2);
});

test("a re-run replaces the window's line instead of appending", () => {
  const a = buildLine({ window: 1, fromMs: T0, toMs: T0 + 1, fivePoints: 2, units: { "cli-main": 10 }, loggedUsdValue: 1, ledgerUsd: 0, earlier: [] });
  assert.equal(a.unitsPerPoint, 5);
  assert.equal(a.usdPerPoint, 0.5);
  let text = replaceWindowLine("", a);
  text = replaceWindowLine(text, { ...a, window: 2 });
  text = replaceWindowLine(text, { ...a, fivePoints: 4, unitsPerPoint: 2.5 });
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.window), [2, 1]);
  assert.equal(lines[1].fivePoints, 4);
});

test("ledger lines without a transcript count by source; every line's $ counts", () => {
  const ledger = [
    { ts: iso(1), source: "rune-gen", model: "claude-opus-5-5", in: 10, out: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.2, transcript: false },
    { ts: iso(2), source: "flow", model: "claude-opus-5-5", in: 10, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.3, transcript: true },
    { ts: iso(500), source: "rune-gen", model: "claude-opus-5-5", in: 99, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 9, transcript: false },
  ];
  const t = ledgerTotals(ledger, T0, T0 + 10 * 60000);
  assert.deepEqual(t.units, { "rune-gen": 60 });
  assert.equal(Math.round(t.usd * 10) / 10, 0.5);
});

test("transcripts classify as falcon, bare, subagent or main", () => {
  const bare = [join("X", "bare", "projects")];
  const falcon = new Set(["fsid"]);
  const p = (...s) => join("C", ...s);
  assert.equal(classifyTranscript(p("cli", "projects", "proj", "fsid.jsonl"), bare, falcon), "falcon");
  assert.equal(classifyTranscript(p("cli", "projects", "proj", "fsid", "subagents", "agent-1.jsonl"), bare, falcon), "falcon");
  assert.equal(classifyTranscript(join("X", "bare", "projects", "p", "s.jsonl"), bare, falcon), "bare");
  assert.equal(classifyTranscript(p("cli", "projects", "proj", "s1", "subagents", "agent-1.jsonl"), bare, falcon), "cli-subagent");
  assert.equal(classifyTranscript(p("cli", "projects", "proj", "s1.jsonl"), bare, falcon), "cli-main");
});

test("report joins meter, ledger and transcripts from a temp tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-report-"));
  try {
    const jl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const meter = join(dir, "meter.jsonl");
    writeFileSync(meter, jl([
      { ts: iso(0), sid: "s1", cost: 1, five: 10, fiveResets: 500 },
      { ts: iso(30), sid: "s1", cost: 4, five: 12, fiveResets: 500 },
    ]));
    const cli = join(dir, "cli");
    const bare = join(dir, "bare");
    mkdirSync(join(cli, "proj", "s1", "subagents"), { recursive: true });
    mkdirSync(join(bare, "p"), { recursive: true });
    writeFileSync(join(cli, "proj", "s1.jsonl"), jl([row("a", 5, 10)]));
    writeFileSync(join(cli, "proj", "s1", "subagents", "agent-x.jsonl"), jl([row("b", 6, 10, "claude-haiku-4-5")]));
    writeFileSync(join(bare, "p", "b1.jsonl"), jl([row("c", 7, 10)]));
    writeFileSync(join(cli, "proj", "f1.jsonl"), jl([row("d", 8, 10)]));
    const ledger = join(dir, "ledger.jsonl");
    writeFileSync(ledger, jl([
      { ts: iso(9), source: "falcon", sid: "f1", model: "claude-opus-5-5", in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.1, transcript: true },
      { ts: iso(10), source: "rune-gen", sid: null, model: "claude-opus-5-5", in: 0, out: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.4, transcript: false },
    ]));
    const line = report({ meter, ledger, windows: join(dir, "none.jsonl"), cliProjects: cli, bareProjects: [bare] });
    assert.equal(line.window, 500);
    assert.equal(line.fivePoints, 2);
    assert.deepEqual(line.units, { "cli-main": 60, "cli-subagent": 12, bare: 60, falcon: 60, "rune-gen": 10 });
    assert.equal(line.usd.logged, 3);
    assert.equal(line.usd.ledger, 0.5);
    assert.equal(line.unitsPerPoint, 101);
    assert.equal(line.drift, null);
    assert.match(table(line), /units\/point 101/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

baseTest("sidecar ledger line maps a result message and ignores everything else", () => {
  const msg = {
    type: "result", session_id: "sid-1", total_cost_usd: 0.75,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    modelUsage: { "claude-haiku-4-5": { costUSD: 0.05 }, "claude-opus-5-5": { costUSD: 0.7 } },
  };
  assert.deepEqual(ledgerEntry(msg, "T"), {
    ts: "T", source: "falcon", sid: "sid-1", model: "claude-opus-5-5",
    in: 1, out: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.75, transcript: true,
  });
  assert.equal(ledgerEntry({ type: "assistant" }), null);
  assert.deepEqual(Object.keys(ledgerEntry({ type: "result" }, "T")), ["ts", "source", "sid", "model", "in", "out", "cacheRead", "cacheWrite", "costUsd", "transcript"]);
});

baseTest("sidecar ledger appends one line per result, only when enabled, and survives a bad path", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-sidecar-"));
  try {
    const file = join(dir, "sub", "ledger.jsonl");
    const observe = startLedger({ enabled: true, path: file });
    observe({ type: "assistant" });
    observe({ type: "result", session_id: "a", usage: { input_tokens: 5 } });
    observe({ type: "result", session_id: "b" });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.sid, l.in]), [["a", 5], ["b", 0]]);
    startLedger({ enabled: false, path: file })({ type: "result", session_id: "c" });
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
    assert.doesNotThrow(() => startLedger({ path: join(file, "x", "y.jsonl") })({ type: "result" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

baseTest("sidecar ledger path follows the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-path-"));
  try {
    const ids = JSON.parse(readFileSync(new URL("../contracts/paths.json", import.meta.url), "utf8")).ids;
    const fresh = resolveLedgerPath(dir, ids);
    assert.equal(fresh, join(dir, "runtime", "state", "usage-ledger.jsonl"));
    mkdirSync(join(dir, "state"));
    assert.equal(resolveLedgerPath(dir, ids), fresh);
    assert.equal(resolveLedgerPath(dir, ids, "nope"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
