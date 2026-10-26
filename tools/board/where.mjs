#!/usr/bin/env node
// where: one read of the board system. Joins docs/projects/*/board.json, open parks in run NOTES,
// git state (with the newest five commits) and the newest runs into one text page.
//   node tools/board/where.mjs [--display] [--root <dir>]
// --display also writes <display>/where.md (byte-identical to stdout).
// Park rules: opener `- parked <id>: ` is strict; a closer `- unparked <id>` ends at `:`, whitespace, `(` or end of line.
// Filed runs: a run listed in the archive index § Runs (`- ../runs/<slug>/ — ...`) is filed, /tidy having homed its
// residuals, so it is skipped in both Parked and Close-out gaps (closed runs are never edited, so nobody could close them).
// Exit 0 when the page printed; 1 with a message on stderr if a section or the Display write throws. Node built-ins only.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { root as findRoot, resolve as resolveId } from "../lib/paths.mjs";
import { validate } from "./board.mjs";
import { owedGaps, PARK_MARK, PARK_OPEN, PARK_CLOSE } from "./owed.mjs"; // marker shapes shared by openParks and runsSection

const args = process.argv.slice(2);
const rootAt = args.indexOf("--root");
let ROOT; // ROOT, RUNS and PROJECTS are set inside the try block at the bottom so a throw there is handled
let RUNS;
let PROJECTS;
const DISPLAY = args.includes("--display");
const CAPS = { boards: 10, rows: 6, cards: 8, parks: 15, gaps: 8, status: 10, commits: 5, runs: 3, bullets: 3, cardParks: 3 };
const ORDER = ["decide", "doing", "todo"];
const RUN_RE = /^[A-Za-z0-9._-]+$/;
const out = [];
const line = (s = "") => out.push(s);
const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const more = (total, cap, pad = "") => total > cap && line(`${pad}+${total - cap} more`);

const git = (...a) =>
  attempt(() => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd(), null);

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m}m ago`;
  if (m < 2880) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const stamp = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace("T", " ");
const attempt = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const dirs = (base) => attempt(() => readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name), []);
const mtime = (file) => attempt(() => statSync(file).mtimeMs, null);
const readLines = (file) => attempt(() => readFileSync(file, "utf8").split(/\r?\n/), null);

// Open parks in one NOTES.md: `- parked <id>: <text>` closed by any later `- unparked <id>` (owed.mjs: the
// closer ends at `:`, whitespace, `(` or end of line).
function openParks(runName) {
  const lines = readLines(join(RUNS, runName, "NOTES.md")) ?? [];
  const open = new Map();
  for (const l of lines) {
    const c = PARK_CLOSE.exec(l);
    if (c) {
      open.delete(c[1]);
      continue;
    }
    const o = PARK_OPEN.exec(l);
    if (o) open.set(o[1], l.slice(o[0].length).trim());
  }
  return [...open].map(([id, text]) => ({ id, text }));
}

// Runs the archive index lists (`- ../runs/<slug>/ — ...` under § Runs) are filed: /tidy homed their residuals.
function filedRuns() {
  const text = attempt(() => readFileSync(join(dirname(RUNS), "archive", "INDEX.md"), "utf8"), "");
  return new Set([...text.matchAll(/^- \.\.\/runs\/([A-Za-z0-9._-]+)\//gm)].map((m) => m[1]));
}

const runDirs = () => dirs(RUNS).filter((n) => !n.startsWith("_"));
const openRunDirs = () => {
  const filed = filedRuns();
  return runDirs().filter((n) => !filed.has(n));
};

function boardSection() {
  line("## Boards");
  const files = dirs(PROJECTS).map((n) => [n, join(PROJECTS, n, "board.json")]).filter(([, f]) => existsSync(f));
  if (files.length === 0) line(`none (${PROJECTS})`);
  for (const [slug, file] of files.slice(0, CAPS.boards)) {
    try {
      boardBlock(slug, file);
    } catch (e) {
      line(`${slug}: error: ${clip(String(e.message), 100)}`);
    }
  }
  more(files.length, CAPS.boards);
  line();
}

function boardBlock(slug, file) {
  let board;
  try {
    board = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    line(`${slug}: cannot read board.json: ${clip(e.message, 100)}`);
    return;
  }
  const errs = validate(board);
  line(`${slug} · ${board?.title ?? "(no title)"}`);
  if (errs.length) {
    line(`  invalid: ${errs.slice(0, 3).join("; ")}${errs.length > 3 ? ` (+${errs.length - 3} more)` : ""}`);
    return;
  }
  const open = ORDER.flatMap((s) => board.cards.filter((c) => c.status === s));
  if (open.length === 0) {
    const unresolved = board.exitTest.filter((r) => r.status !== "pass"); // validate's passed status is "pass"
    for (const r of unresolved.slice(0, CAPS.rows)) line(`  [${r.status}] ${clip(r.text)}`);
    more(unresolved.length, CAPS.rows, "  ");
    line(`  all done (${board.cards.length} cards)`);
    return;
  }
  for (const r of board.exitTest.slice(0, CAPS.rows)) line(`  [${r.status}] ${clip(r.text)}`);
  more(board.exitTest.length, CAPS.rows, "  ");
  for (const c of open.slice(0, CAPS.cards)) {
    line(`  ${c.status} · ${c.id} · ${c.title} · ${clip(c.next, 120)}`);
    const paths = c.evidence.map((p) => ":(literal)" + p);
    const hit = paths.length ? git("log", "-1", "--format=%h %cr", "--", ...paths) : null;
    line(`    last evidence commit: ${hit || "none"}`);
    if (c.run === undefined) continue;
    const ok = typeof c.run === "string" && RUN_RE.test(c.run) && dirs(RUNS).includes(c.run);
    if (!ok) {
      line("    run: invalid");
      continue;
    }
    const m = mtime(join(RUNS, c.run, "NOTES.md"));
    line(`    run ${c.run}: ${m === null ? "no NOTES.md" : `NOTES.md ${stamp(m)} (${ago(m)})`}`);
    const parks = openParks(c.run);
    for (const p of parks.slice(0, CAPS.cardParks)) line(`    parked ${p.id}: ${clip(p.text, 100)}`);
    more(parks.length, CAPS.cardParks, "    ");
  }
  more(open.length, CAPS.cards, "  ");
}

function parkedSection() {
  line("## Parked");
  if (!existsSync(RUNS)) {
    line(`none (${RUNS})`);
    line();
    return;
  }
  const all = [];
  for (const run of openRunDirs()) {
    const m = mtime(join(RUNS, run, "NOTES.md"));
    for (const p of openParks(run)) all.push({ run, age: m === null ? "?" : ago(m), ...p });
  }
  if (all.length === 0) line("none open");
  for (const p of all.slice(0, CAPS.parks)) line(`${p.run} · ${p.age} · parked ${p.id}: ${clip(p.text, 100)}`);
  more(all.length, CAPS.parks);
  line();
}

function closeOutSection() {
  line("## Close-out gaps");
  if (!existsSync(RUNS)) {
    line(`none (${RUNS})`);
    line();
    return;
  }
  const text = (run, f) => attempt(() => readFileSync(join(RUNS, run, f), "utf8"), "");
  const gaps = owedGaps(openRunDirs().map((name) => ({ name, notes: text(name, "NOTES.md"), context: text(name, "CONTEXT.md") })));
  if (gaps.length === 0) line("none open");
  for (const g of gaps.slice(0, CAPS.gaps)) line(`${g.run} · ${g.problem}`);
  more(gaps.length, CAPS.gaps);
  line();
}

function gitSection() {
  line("## Git");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === null) {
    line(`none (no git repository at ${ROOT})`);
    line();
    return;
  }
  const ahead = git("rev-list", "--count", `origin/${branch}..HEAD`);
  line(`branch ${branch} · ${ahead === null ? "ahead: no upstream" : `ahead of origin/${branch}: ${ahead}`}`);
  const status = (git("status", "--short") ?? "").split("\n").filter(Boolean);
  line(status.length ? "status:" : "status: clean");
  for (const s of status.slice(0, CAPS.status)) line(`  ${s}`);
  more(status.length, CAPS.status, "  ");
  const log = (git("log", "-5", "--format=%h %s") ?? "").split("\n").filter(Boolean);
  line(log.length ? "recent commits:" : "recent commits: none");
  for (const c of log.slice(0, CAPS.commits)) line(`  ${clip(c, 120)}`);
  more(log.length, CAPS.commits, "  ");
  line();
}

function runsSection() {
  line("## Runs");
  const runs = runDirs()
    .map((n) => ({ n, m: mtime(join(RUNS, n, "NOTES.md")) }))
    .filter((r) => r.m !== null)
    .sort((a, b) => b.m - a.m);
  if (runs.length === 0) line(`none (${RUNS})`);
  for (const r of runs.slice(0, CAPS.runs)) {
    line(`${r.n} · ${stamp(r.m)} (${ago(r.m)})`);
    const bullets = (readLines(join(RUNS, r.n, "NOTES.md")) ?? []).filter((l) => /^\s*- /.test(l) && !PARK_MARK.test(l)); // park markers live in Parked
    for (const b of bullets.slice(-CAPS.bullets)) line(`  ${clip(b.trim(), 160)}`);
    more(bullets.length, CAPS.bullets, "  ");
  }
  more(runs.length, CAPS.runs);
}

try {
  ROOT = findRoot(rootAt >= 0 ? args[rootAt + 1] : undefined);
  RUNS = resolveId("runs", { root: ROOT });
  PROJECTS = join(dirname(RUNS), "projects"); // runs sits directly under docs; no `projects` id exists
  boardSection();
  parkedSection();
  closeOutSection();
  gitSection();
  runsSection();

  const text = out.join("\n") + "\n";
  process.stdout.write(text);
  if (DISPLAY) {
    const dir = resolveId("display", { root: ROOT });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "where.md"), text, "utf8");
  }
} catch (e) {
  process.stderr.write(`where: ${e?.message ?? e}\n`);
  process.exitCode = 1;
}
