#!/usr/bin/env node
// one-home.mjs — fails the build when a code shape that has one home (contracts/one-home.json) appears elsewhere.
// A family is `{ id, home[], use, scan{roots,ext}, shapes[{re}|{lit}], mark, frozen{file:count}, origin }`:
//   home    repo-relative files exempt from the scan (the one place the shape lives)
//   use     what to call instead; printed on every failure line
//   scan    roots (repo-relative dirs) and ext (".ts", ".rs", ...) walked; *.test.* and *.d.ts are skipped
//   shapes  `{re}` (regex source, optional `flags`) or `{lit}` (literal substring), tested per line
//   mark    a line holding it is exempt with a reason after it (default `home-ok:`)
//   frozen  file -> count of tolerated copies: more fails, fewer prints `warning one-home: <id> <file> can drop to N`
// Usage:
//   node tools/gate/one-home.mjs                       whole tree, every family; exit 1 on a copy
//   node tools/gate/one-home.mjs --staged [paths...]   judge staged blobs (`git show :path`), not the working copy;
//                                                      no paths = every staged file the families cover
//   node tools/gate/one-home.mjs --family <id>         one family only
//   node tools/gate/one-home.mjs --all [--family <id>] list every hit (frozen or not), exit 0
//   node tools/gate/one-home.mjs --write --family <id> seed frozen counts for a family, or lower them; never raises
//   --root <dir> and --contract <file> point the scan elsewhere (tests).
// Failure lines read `one-home: <file>:<line> <id> — use <use>`. Refuses: --write without --family, with --staged,
// an unknown family, or an unreadable contract.
// Adding a family belongs to the commit that consolidates or freezes it: consolidate, add the entry, run
// `--family <id> --all` (copies at the pre-change commit, none after) or `--write --family <id>` to freeze.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { root } from "../lib/paths.mjs";

const REPO = root();
const CONTRACT = join(REPO, "contracts", "one-home.json");
const SKIP_DIRS = new Set(["node_modules", "target", "dist"]);
const DEFAULT_MARK = "home-ok:";

const norm = (p) => p.split("\\").join("/");
const skipName = (n) => /\.test\./.test(n) || n.endsWith(".d.ts");

/** Compile a family's shapes into predicates `(line) => boolean`. */
export function compileShapes(family) {
  return family.shapes.map((s) => {
    if (typeof s.re === "string") {
      const re = new RegExp(s.re, s.flags || "");
      return (line) => re.test(line);
    }
    if (typeof s.lit === "string") return (line) => line.includes(s.lit);
    throw new Error(`one-home: family ${family.id}: a shape needs re or lit`);
  });
}

/** Offending lines of one file's text: `{ line, text }` per shape hit without the family's mark. */
export function findHits(family, text) {
  const mark = family.mark || DEFAULT_MARK;
  const tests = compileShapes(family);
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(mark)) return;
    if (tests.some((t) => t(line))) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

/** True when the family scans this repo-relative path (root, ext, not a test or .d.ts, not a home file). */
export function familyCovers(family, relPath) {
  const p = norm(relPath);
  if ((family.home || []).includes(p)) return false;
  const name = p.split("/").pop();
  if (skipName(name)) return false;
  if (!family.scan.ext.includes(extname(name))) return false;
  if (p.split("/").slice(0, -1).some((s) => SKIP_DIRS.has(s) || s.startsWith("."))) return false;
  return family.scan.roots.some((r) => p.startsWith(norm(r).replace(/\/$/, "") + "/"));
}

export function loadFamilies(path = CONTRACT) {
  return JSON.parse(readFileSync(path, "utf8")).families;
}

/** True when any family (or the contract itself) makes this repo-relative path worth a scan. */
export function covers(relPath, families = loadFamilies()) {
  const p = norm(relPath);
  if (p === "contracts/one-home.json") return true;
  return families.some((f) => familyCovers(f, p));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function stagedText(root, rel) {
  const r = spawnSync("git", ["show", `:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}

function stagedPaths(root) {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Per-family per-file hits. `only` null = walk the roots; else a repo-relative path list.
 * Returns `[{ family, files: Map<rel, hits[]> }]` (files with no hits omitted).
 */
export function scan({ root = REPO, families, only = null, staged = false }) {
  return families.map((family) => {
    const files = new Map();
    const paths = only
      ? only.map(norm).filter((p) => familyCovers(family, p))
      : family.scan.roots.flatMap((r) => walk(join(root, r)).map((p) => norm(relative(root, p)))).filter((p) => familyCovers(family, p));
    for (const rel of paths) {
      const text = staged ? stagedText(root, rel) : existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null;
      if (text == null) continue;
      const hits = findHits(family, text);
      if (hits.length) files.set(rel, hits);
    }
    return { family, files };
  });
}

/** Judge scan results against `frozen`: `{ failures[], warnings[] }` of printable lines. */
export function judge(results) {
  const failures = [];
  const warnings = [];
  for (const { family, files } of results) {
    const frozen = family.frozen || {};
    const fail = (rel, h) => failures.push(`one-home: ${rel}:${h.line} ${family.id} — use ${family.use}`);
    for (const [rel, hits] of files) {
      const allowed = frozen[rel] ?? 0;
      if (hits.length > allowed) hits.forEach((h) => fail(rel, h));
      else if (hits.length < allowed) warnings.push(`warning one-home: ${family.id} ${rel} can drop to ${hits.length}`);
    }
    for (const [rel, allowed] of Object.entries(frozen)) {
      if (!files.has(rel) && allowed > 0) warnings.push(`warning one-home: ${family.id} ${rel} can drop to 0`);
    }
  }
  return { failures, warnings };
}

/** New frozen map for a family: counts seeded for unlisted files, lowered for listed ones, never raised, zeros dropped. */
export function nextFrozen(family, files) {
  const old = family.frozen || {};
  const out = {};
  for (const [rel, hits] of files) out[rel] = rel in old ? Math.min(old[rel], hits.length) : hits.length;
  return Object.fromEntries(Object.entries(out).filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function parseArgs(argv) {
  const a = { staged: false, all: false, write: false, family: null, root: REPO, contract: CONTRACT, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--staged") a.staged = true;
    else if (k === "--all") a.all = true;
    else if (k === "--write") a.write = true;
    else if (k === "--family") a.family = argv[++i];
    else if (k === "--root") a.root = resolve(argv[++i]);
    else if (k === "--contract") a.contract = resolve(argv[++i]);
    else a.paths.push(k);
  }
  return a;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  let doc;
  try {
    doc = JSON.parse(readFileSync(a.contract, "utf8"));
  } catch (e) {
    console.error(`one-home: cannot read ${a.contract}: ${e.message}`);
    return 1;
  }
  let families = doc.families;
  if (a.family) {
    families = families.filter((f) => f.id === a.family);
    if (!families.length) {
      console.error(`one-home: unknown family ${a.family}`);
      return 1;
    }
  }
  if (a.write && (!a.family || a.staged)) {
    console.error("one-home: --write needs --family <id> and no --staged");
    return 1;
  }
  const only = a.staged ? (a.paths.length ? a.paths : stagedPaths(a.root)) : a.paths.length ? a.paths : null;
  const results = scan({ root: a.root, families, only, staged: a.staged });

  if (a.all) {
    for (const { family, files } of results)
      for (const [rel, hits] of files) for (const h of hits) console.log(`${family.id} ${rel}:${h.line}: ${h.text}`);
    return 0;
  }
  if (a.write) {
    const { family, files } = results[0];
    const target = doc.families.find((f) => f.id === family.id);
    target.frozen = nextFrozen(family, files);
    writeFileSync(a.contract, JSON.stringify(doc, null, 2) + "\n");
    console.log(`one-home: ${family.id} frozen ${JSON.stringify(target.frozen)}`);
    return 0;
  }
  const { failures, warnings } = judge(results);
  warnings.forEach((w) => console.log(w));
  if (failures.length) {
    failures.forEach((f) => console.error(f));
    return 1;
  }
  console.log("one-home: ok");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
