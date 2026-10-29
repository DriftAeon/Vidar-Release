// Weekly sweep: runs the lint/dep/dead-code/systems lanes (systems: lanes-systems.mjs, sys-* ids) and diffs them against the newest snapshot.
// Report-only; never wired into gate.mjs.
//
// Usage:
//   node tools/sweep/scan.mjs [--record] [--report] [--lanes a,b] [--baseline <file>] [--all]
//     (default)   run every lane, print the markdown diff vs the newest snapshot, write nothing
//     --record    also write runtime state\sweep\<date>-<head7>.json
//     --report    also write <displayReviews>\sweep-<date>.md
//     --lanes     comma list of lane ids to run (others are carried over from the baseline on --record)
//     --baseline  diff against this snapshot file instead of the newest one
//     --all       also list persisting findings
//   Exit 0 ran, 1 a lane errored, 2 usage.
//
// Refuses: an unknown lane id or flag (exit 2); --record on a dirty git tree (exit 2); a lane that errors
// never counts findings as fixed (its previous findings are carried forward marked stale).
// Needs network for npm-outdated, npm-pins, npm-audit and cargo-audit; offline those lanes error.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve as resolveId } from "../lib/paths.mjs";
import { LANES as DEPS_LANES } from "./lanes-deps.mjs";
import { LANES as CODE_LANES } from "./lanes-code.mjs";
import { LANES as SYSTEMS_LANES } from "./lanes-systems.mjs";
const REPO = path.resolve(path.join(import.meta.dirname, "..", ".."));
const LIST_CAP = 200;

export const ALL_LANES = [...CODE_LANES, ...SYSTEMS_LANES, ...DEPS_LANES];

/** Real exec: spawnSync with shell:true, as tools/gate/gate.mjs. */
export function makeExec(root) {
  return (cmd) => {
    const t = Date.now();
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 1 << 28 });
    return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "", ms: Date.now() - t };
  };
}

/** Repeated keys in one lane get a #n suffix so the by-key diff stays a set. */
export function uniqueKeys(findings) {
  const seen = new Map();
  return findings.map((f) => {
    const n = (seen.get(f.key) || 0) + 1;
    seen.set(f.key, n);
    return n === 1 ? f : { ...f, key: `${f.key}#${n}` };
  });
}

/**
 * Diff one lane by key. prev: previous findings array or undefined.
 * An errored lane reports nothing new or fixed; its previous findings persist, marked stale.
 */
export function diffLane(kind, prev, cur) {
  const before = prev || [];
  if (!cur.ok) {
    const stale = before.map((f) => ({ ...f, stale: true }));
    return { new: [], fixed: [], persisting: stale, findings: stale };
  }
  if (kind === "delta") return { new: cur.findings, fixed: [], persisting: [], findings: cur.findings };
  const prevKeys = new Set(before.map((f) => f.key));
  const curKeys = new Set(cur.findings.map((f) => f.key));
  return {
    new: cur.findings.filter((f) => !prevKeys.has(f.key)),
    fixed: before.filter((f) => !curKeys.has(f.key)),
    persisting: cur.findings.filter((f) => prevKeys.has(f.key)),
    findings: cur.findings,
  };
}

function newestSnapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => {
    const p = path.join(dir, n);
    return { p, m: fs.statSync(p).mtimeMs };
  });
  files.sort((a, b) => b.m - a.m);
  return files[0]?.p ?? null;
}

function versionChanges(prev, cur) {
  const out = [];
  for (const [tool, v] of Object.entries(cur || {})) {
    const was = prev?.[tool];
    if (was && v && was !== v) out.push(`${tool} ${was} -> ${v}`);
  }
  return out;
}

export function renderMarkdown({ date, head, baseline, rows, versionNotes, all }) {
  const L = [];
  L.push(`# Weekly sweep ${date} (${head})`);
  L.push(`Baseline: ${baseline ? `${baseline.date} (${baseline.head})` : "none, first run"}`);
  if (versionNotes.length) L.push(`Tool versions changed (key churn possible): ${versionNotes.join("; ")}`);
  L.push("", "| lane | status | total | new | fixed |", "|---|---|---|---|---|");
  for (const r of rows) {
    const status = r.res.ok ? "ok" : "ERROR (stale)";
    L.push(`| ${r.id} | ${status} | ${r.d.findings.length} | ${r.d.new.length} | ${r.d.fixed.length} |`);
  }
  for (const r of rows) {
    const bits = [];
    if (!r.res.ok) bits.push(`error: ${r.res.error}`);
    const showNew = baseline || r.kind === "delta";
    const list = (title, items, fmt) => {
      if (!items.length) return;
      bits.push(`${title} (${items.length})`);
      for (const f of items.slice(0, LIST_CAP)) bits.push(`- ${fmt(f)}`);
      if (items.length > LIST_CAP) bits.push(`- ... ${items.length - LIST_CAP} more`);
    };
    if (showNew) list(r.kind === "delta" ? "touched" : "new", r.d.new, (f) => `${f.key}${f.msg ? ` : ${f.msg}` : ""}`);
    if (baseline) list("fixed", r.d.fixed, (f) => f.key);
    if (all) list("persisting", r.d.persisting, (f) => f.key);
    if (bits.length) L.push("", `## ${r.id}`, ...bits);
  }
  return `${L.join("\n")}\n`;
}

function parseArgs(argv, ids) {
  const o = { record: false, report: false, all: false, lanes: null, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--record") o.record = true;
    else if (a === "--report") o.report = true;
    else if (a === "--all") o.all = true;
    else if (a === "--lanes" || a === "--baseline") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--lanes") o.lanes = v.split(",").map((s) => s.trim()).filter(Boolean);
      else o.baseline = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (o.lanes) {
    const bad = o.lanes.filter((l) => !ids.includes(l));
    if (bad.length) return { error: `unknown lane id ${bad.join(", ")}; known: ${ids.join(", ")}` };
  }
  return { o };
}

/**
 * Entry point with injectable dependencies (tests). Returns the exit code.
 * deps: {root, exec, lanes, stateDir, reviewsDir, out, err, now}
 */
export function main(argv, deps = {}) {
  const root = deps.root ?? REPO;
  const exec = deps.exec ?? makeExec(root);
  const lanes = deps.lanes ?? ALL_LANES;
  const stateDir = deps.stateDir ?? resolveId("sweepState", { root });
  const reviewsDir = deps.reviewsDir ?? resolveId("displayReviews", { root });
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const now = deps.now ?? (() => new Date());

  const parsed = parseArgs(argv, lanes.map((l) => l.id));
  if (parsed.error) {
    err(`sweep: ${parsed.error}\nusage: node tools/sweep/scan.mjs [--record] [--report] [--lanes a,b] [--baseline <file>] [--all]\n`);
    return 2;
  }
  const o = parsed.o;

  if (o.record) {
    const dirty = exec("git status --porcelain");
    if (dirty.code !== 0 || dirty.stdout.trim()) {
      err("sweep: --record refuses a dirty tree (git status --porcelain is not empty); commit or stash first\n");
      return 2;
    }
  }

  const baselineFile = o.baseline ? path.resolve(root, o.baseline) : newestSnapshot(stateDir);
  let baseline = null;
  if (baselineFile) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    } catch (e) {
      err(`sweep: cannot read baseline ${baselineFile}: ${e.message}\n`);
      return 2;
    }
  }

  const head = exec("git rev-parse HEAD").stdout.trim();
  const head7 = head.slice(0, 7);
  const d = now();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let since = baseline?.head;
  if (!since) since = exec("git rev-list -1 --before=7.days HEAD").stdout.trim() || head;
  const ctx = { root, since, exec };

  const selected = lanes.filter((l) => !o.lanes || o.lanes.includes(l.id));
  const rows = [];
  for (const lane of selected) {
    let res;
    try {
      res = lane.run(ctx);
    } catch (e) {
      res = { ok: false, cmd: "", error: String(e?.message ?? e), findings: [] };
    }
    res = { ...res, findings: res.ok ? uniqueKeys(res.findings || []) : [] };
    const d2 = diffLane(lane.kind, baseline?.lanes?.[lane.id]?.findings, res);
    rows.push({ id: lane.id, kind: lane.kind, res, d: d2 });
  }

  const tools = deps.versions ?? collectVersions(exec);
  const notes = versionChanges(baseline?.versions, tools);
  const md = renderMarkdown({
    date, head: head7, baseline: baseline ? { date: baseline.date, head: baseline.head?.slice(0, 7) } : null,
    rows, versionNotes: notes, all: o.all,
  });
  out(md);

  if (o.record) {
    const snap = { version: 1, date, head, versions: tools, lanes: { ...(baseline?.lanes || {}) } };
    for (const r of rows) {
      snap.lanes[r.id] = {
        ok: r.res.ok, cmd: r.res.cmd, ...(r.res.error ? { error: r.res.error } : {}), findings: r.d.findings,
      };
    }
    fs.mkdirSync(stateDir, { recursive: true });
    const snapFile = path.join(stateDir, `${date}-${head7}.json`);
    fs.writeFileSync(snapFile, JSON.stringify(snap, null, 1), "utf8");
    err(`sweep: recorded ${snapFile}\n`);
  }
  if (o.report) {
    fs.mkdirSync(reviewsDir, { recursive: true });
    const f = path.join(reviewsDir, `sweep-${date}.md`);
    fs.writeFileSync(f, md, "utf8");
    err(`sweep: wrote ${f}\n`);
  }
  return rows.some((r) => !r.res.ok) ? 1 : 0;
}

function collectVersions(exec) {
  const v = {};
  const get = (name, cmd) => {
    const r = exec(cmd);
    v[name] = r.code === 0 ? (r.stdout.trim().split("\n")[0] || "") : "";
  };
  get("node", "node --version");
  get("npm", "npm --version");
  get("cargo", "cargo --version");
  get("cargo-audit", "cargo audit --version");
  get("knip", "npx --no -- knip --version");
  get("tsc", "npx --no -- tsc --version");
  return v;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t = Date.now();
  const code = main(process.argv.slice(2));
  process.stderr.write(`sweep: ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
  process.exit(code);
}
