// Knip production gate: dead exports, types, files and duplicate exports, as a ratchet against a baseline.
//   node tools/gate/knip-gate.mjs [--warn] [--staged [path...]]    check (default: whole tree, exit 1 on a new finding)
//   node tools/gate/knip-gate.mjs --prune                           lower the baseline to the current findings
//   node tools/gate/knip-gate.mjs --accept <key> <reason>           raise the baseline by one finding (MAIN THREAD ONLY)
//   node tools/gate/knip-gate.mjs --seed                            write the first baseline (refused if one exists)
//
// What it runs: `knip --production --config knip.production.json --include exports,types,files,duplicates`.
// Production mode drops every test entry, so an export read only by a test is reported (default `knip` reads it
// as live). knip.production.json mirrors knip.json with `!` suffixes on non-test entries; it is a second file
// because `!` entries in knip.json would also add src/{main,falcon,overlay}.ts to the default run (production
// mode does not follow the pages' absolute /src/*.ts script paths, so it needs them) and shift its findings.
// Keep the two entry lists in step.
//
// Baseline: tools/gate/knip-baseline.json, a multiset of `type:file:name` (no lines) -> count, plus `accepted`
// (key -> reason). A key above its baseline count is a NEW finding; below it, a FIXED entry.
//   --staged   fail only on new findings whose file is staged. Paths after the flag are the staged list (the gate
//              passes them: a hook's temporary index is not visible to a child); none -> `git diff --cached`.
//              Misses an export killed in another file; the full tier and the weekly sweep catch that.
//   --warn     report only: print `warning knip: ...` lines (the gate echoes them on pass) and exit 0.
//   --prune    lowers only. Fixed entries print `warning knip: N baseline entries fixed; run --prune`.
//   --accept   raises: the key must be a current new finding; the reason is stored under `accepted`.
// Refuses (exit 2): --prune/--accept/--seed with a dirty src/, tools/ or tests/ tree (knip reads the working
// tree, so a half-done edit would bake into the baseline); --accept without a reason or for a key that is not
// a current new finding; --seed over an existing baseline; a missing baseline; unparseable knip output
// (with --warn: a warning, exit 0).
// A helper that lands before its caller: tag it `/** @public */` (knip skips it) and drop the tag when the caller lands.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root as repoRoot } from '../lib/paths.mjs';
import { toolsPrefix } from '../lib/release-layout.mjs';

const root = repoRoot();
const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knip-baseline.json');
const KNIP = 'npx --no -- knip --production --config knip.production.json --include exports,types,files,duplicates --reporter json --no-exit-code';
// tools/ comes from the paths contract; src/ and tests/ are not contract ids, so their literals count against nothing.
const WATCHED = ['src/', toolsPrefix(), 'tests/'];
const OWN = /^tools\/gate\/knip-/; // the gate's own files may be dirty while it seeds

const posix = (p) => p.split(path.sep).join('/');

/** knip JSON -> sorted array of `type:file:name` keys (repeats kept: the multiset). */
export function keysOf(json) {
  const keys = [];
  for (const issue of json.issues || []) {
    const file = posix(issue.file);
    for (const [type, items] of Object.entries(issue)) {
      if (!Array.isArray(items) || type === 'file') continue;
      for (const it of items) {
        const name = Array.isArray(it) ? it.map((x) => x.name).join('|') : it.name;
        if (name) keys.push(`${type}:${file}:${name}`);
      }
    }
  }
  return keys.sort();
}

const fileOf = (key) => key.split(':')[1];

const count = (keys) => {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
  return m;
};

/**
 * Pure diff. current: key array; baseline: { key: count } object; staged: optional path array.
 * added: keys above their baseline count (one entry per extra occurrence); with `staged`, only keys whose file is in it.
 * fixed: baseline occurrences no longer found (never filtered by staged).
 */
export function diff(current, baseline, staged) {
  const cur = count(current);
  const added = [];
  const fixed = [];
  const inStaged = staged ? new Set(staged.map(posix)) : null;
  for (const [key, n] of cur) {
    const extra = n - (baseline[key] || 0);
    if (extra > 0 && (!inStaged || inStaged.has(fileOf(key)))) for (let i = 0; i < extra; i++) added.push(key);
  }
  for (const [key, n] of Object.entries(baseline)) {
    const gone = n - (cur.get(key) || 0);
    for (let i = 0; i < gone; i++) fixed.push(key);
  }
  return { added: added.sort(), fixed: fixed.sort() };
}

function runKnip() {
  const r = spawnSync(KNIP, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 1 << 28 });
  try {
    return { keys: keysOf(JSON.parse(r.stdout)) };
  } catch (e) {
    return { error: `${e.message}; ${(r.stderr || '').trim().slice(0, 200)}` };
  }
}

function dirty() {
  const r = spawnSync('git', ['status', '--porcelain', '-uall', '--', ...WATCHED], { cwd: root, encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter((p) => !OWN.test(p));
}

function stagedList() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function writeBaseline(entries, accepted) {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  const out = {
    $comment: 'Knip production ratchet: tools/gate/knip-gate.mjs. Multiset of type:file:name -> count. Lowers via --prune; rises only via --accept (main thread only).',
    entries: sorted,
    accepted,
  };
  fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`);
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  const j = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  return { entries: j.entries || {}, accepted: j.accepted || {} };
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const known = ['--warn', '--staged', '--prune', '--accept', '--seed'];
  const bad = [...flags].find((f) => !known.includes(f));
  if (bad) return usage(`unknown flag ${bad}`);
  const warn = flags.has('--warn');
  const say = (line) => console.log(warn ? `warning knip: ${line}` : `knip: ${line}`);

  const mutate = flags.has('--prune') || flags.has('--accept') || flags.has('--seed');
  if (mutate) {
    const d = dirty();
    if (d.length) {
      console.error(`knip-gate: refusing, dirty tree (${d.length} path(s), e.g. ${d[0]}); commit or stash first`);
      return 2;
    }
  }

  const base = readBaseline();
  if (!base && !flags.has('--seed')) {
    console.error('knip-gate: no tools/gate/knip-baseline.json; seed it with --seed from a clean tree');
    return 2;
  }
  if (base && flags.has('--seed')) {
    console.error('knip-gate: baseline exists; use --prune or --accept');
    return 2;
  }

  const run = runKnip();
  if (run.error) {
    if (warn) {
      console.log(`warning knip: run failed: ${run.error}`);
      return 0;
    }
    console.error(`knip-gate: run failed: ${run.error}`);
    return 2;
  }

  if (flags.has('--seed')) {
    writeBaseline(Object.fromEntries(count(run.keys)), {});
    console.log(`knip-gate: seeded ${run.keys.length} findings`);
    return 0;
  }

  if (flags.has('--prune')) {
    const cur = count(run.keys);
    const entries = {};
    let lowered = 0;
    for (const [k, n] of Object.entries(base.entries)) {
      const keep = Math.min(n, cur.get(k) || 0);
      lowered += n - keep;
      if (keep) entries[k] = keep;
    }
    const accepted = Object.fromEntries(Object.entries(base.accepted).filter(([k]) => entries[k]));
    writeBaseline(entries, accepted);
    console.log(`knip-gate: pruned ${lowered} baseline entries`);
    return 0;
  }

  if (flags.has('--accept')) {
    const i = argv.indexOf('--accept');
    const key = argv[i + 1];
    const reason = argv.slice(i + 2).join(' ').trim();
    if (!key || !reason) return usage('--accept needs <key> <reason>');
    if (!diff(run.keys, base.entries).added.includes(key)) {
      console.error(`knip-gate: ${key} is not a current new finding`);
      return 2;
    }
    base.entries[key] = (base.entries[key] || 0) + 1;
    base.accepted[key] = reason;
    writeBaseline(base.entries, base.accepted);
    console.log(`knip-gate: accepted ${key}`);
    return 0;
  }

  let staged = null;
  if (flags.has('--staged')) {
    const rest = argv.slice(argv.indexOf('--staged') + 1).filter((a) => !a.startsWith('--'));
    staged = rest.length ? rest : stagedList();
  }
  const { added, fixed } = diff(run.keys, base.entries, staged);
  for (const k of added) say(`new ${k}`);
  if (fixed.length) console.log(`warning knip: ${fixed.length} baseline entries fixed; run --prune`);
  if (added.length && !warn) {
    console.error(`knip-gate: ${added.length} new finding(s). Remove the dead export, or tag a helper that lands before its caller /** @public */.`);
    return 1;
  }
  return 0;
}

function usage(msg) {
  console.error(`knip-gate: ${msg}\nusage: node tools/gate/knip-gate.mjs [--warn] [--staged [path...]] | --prune | --accept <key> <reason> | --seed`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
