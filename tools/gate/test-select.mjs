// Test selection for the pre-commit fast gate: maps staged paths to the test files they can reach.
//   node tools/gate/test-select.mjs [--floor] <staged path>...   prints the files one per line, or `ALL <reason>`
// Derived on every run (nothing hand-listed); fails closed: any throw, helper/config change or unmappable file -> ALL.
// Design: docs/shelf/gate-test-select.md. Selection per staged path:
//   - a staged test file runs itself;
//   - a test whose import closure (static, re-export and literal dynamic relative imports) holds the file runs;
//   - a test whose text names the path (repo-relative, test-relative, extensionless), runs;
//   - a tree-walking test that names an ancestor dir of the path runs;
//   - a staged file no import can reach (Rust, css, ps1...) also runs the tree-walking tests that name its top dir;
//   - `floor` adds the always-run set: every scanning test, and every reading test with no literal repo path.
// Refuses to select (ALL): changes to tests/helpers, tests/lib, tools/gate, package files, tsconfig, contracts/,
// VIDAR_GATE_FULL_TESTS=1, or a file of an unknown kind that no test names.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root as repoRoot } from '../lib/paths.mjs';

// Pinned by the unit test. SCAN: tests that walk the tree; READ: tests that read or spawn files.
export const SCAN_RE = /readdirSync|readdir\(|globSync|ls-files|walk\(/;
export const READ_RE = /readFileSync|spawn|execFile/;
export const FULL_RE = [/^tests\/(helpers|lib)\//, /^tools\/gate\//, /^package(-lock)?\.json$/, /(^|\/)tsconfig[^/]*\.json$/, /^contracts\//];
export const RUST_GUARDS = ['tests/module-size.test.mjs', 'tests/paths-contract.test.mjs'];
const MODULE_EXT =/\.(ts|tsx|mjs|js|cjs)$/;
const KNOWN_EXT = /\.(ts|tsx|mjs|js|cjs|css|html|ps1|py|rs|md|toml|lock)$/;
const TEST_FILE = /\.test\.mjs$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'target', 'dist']);
// This file lives in <tools dir>/gate: the tools folder name comes from its own location, not a literal.
const TOOLS = posix.basename(posix.dirname(fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')));
const TYPE_ONLY_RE = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|[\w$]+)\s+from\s*(['"])[^'"\n]+\1/g;
const SPEC_RE =/\bfrom\s*(['"])(\.{1,2}\/[^'"\n]+)\1|\bimport\s*\(?\s*(['"])(\.{1,2}\/[^'"\n]+)\3/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walkTests(root, dir, out) {
  const base = join(root, dir);
  if (!existsSync(base)) return out;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walkTests(root, `${dir}/${e.name}`, out); }
    else if (TEST_FILE.test(e.name)) out.push(`${dir}/${e.name}`);
  }
  return out;
}

export function testUniverse(root) {
  return [...walkTests(root, 'tests', []), ...walkTests(root, TOOLS, [])].sort();
}

function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

function resolveSpec(root, fromRel, spec) {
  const target = posix.normalize(posix.join(posix.dirname(fromRel), spec.replace(/\?.*$/, '')));
  if (target.startsWith('..')) return null;
  for (const c of [target, `${target}.ts`, `${target}.mjs`, `${target}.js`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.mjs`, `${target}/index.js`]) {
    if (isFile(join(root, c))) return c;
  }
  return null;
}

// Transitive local import closure of one file (repo-relative posix paths, the file itself included).
function closureOf(root, start, textOf, memo) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!MODULE_EXT.test(f)) continue;
    if (memo.has(f)) { for (const d of memo.get(f)) stack.push(d); continue; }
    const deps = [];
    // `import type` / `export type` statements are erased before a test loads the file (tsc checks them in the gate).
    for (const m of textOf(f).replace(TYPE_ONLY_RE, '').matchAll(SPEC_RE)) {
      const r = resolveSpec(root, f, m[2] ?? m[4]);
      if (r) deps.push(r);
    }
    memo.set(f, deps);
    for (const d of deps) stack.push(d);
  }
  return seen;
}

function topDirs(root) {
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIR.has(e.name)).map((e) => e.name);
}

// `floor`: add the always-run set.
export function selectTests(staged, { root = repoRoot(), floor = false, env = process.env } = {}) {
  try {
    return select(staged, root, floor, env);
  } catch (e) {
    return { all: true, reason: `selector error: ${e.message}` };
  }
}

function select(staged, root, floor, env) {
  if (env.VIDAR_GATE_FULL_TESTS === '1') return { all: true, reason: 'VIDAR_GATE_FULL_TESTS=1' };
  const hit = staged.find((p) => FULL_RE.some((re) => re.test(p)));
  if (hit) return { all: true, reason: `${hit} is test infrastructure` };

  const universe = testUniverse(root);
  const texts = new Map();
  const textOf = (f) => {
    if (!texts.has(f)) texts.set(f, readFileSync(join(root, f), 'utf8'));
    return texts.get(f);
  };
  const tops = topDirs(root);
  const repoPathRe = new RegExp(`(?:^|[^\\w.-])(?:${tops.map(escapeRe).join('|')})/[\\w.-]`);
  const memo = new Map();
  const chosen = new Set();
  const reasons = { staged: 0, mapped: 0, floor: 0 };
  const add = (t, kind) => { if (!chosen.has(t)) { chosen.add(t); reasons[kind]++; } };

  for (const p of staged) if (universe.includes(p) && isFile(join(root, p))) add(p, 'staged');

  const others = staged.filter((p) => !universe.includes(p));
  const closures = new Map();
  for (const t of universe) closures.set(t, closureOf(root, t, textOf, memo));
  // A test that walks the tree through a tools/ or tests/ library (module-size-lib) is a walker too: the library's
  // text joins the test's own for the walker checks. src/ files are the code under test, never counted as walkers.
  const info = new Map(universe.map((t) => {
    const own = textOf(t);
    const libs = [...closures.get(t)].filter((f) => f !== t && MODULE_EXT.test(f) && !f.startsWith('src/') && SCAN_RE.test(textOf(f)));
    const text = [own, ...libs.map(textOf)].join('\n');
    return [t, { text: own, walkText: text, reads: SCAN_RE.test(text) || READ_RE.test(text), scans: SCAN_RE.test(text), literal: repoPathRe.test(own) }];
  }));

  for (const p of others) {
    const isModule = MODULE_EXT.test(p);
    const names = [p, p.replace(/\.(ts|tsx|mjs|js)$/, '')];
    const dirs = [];
    for (let d = posix.dirname(p); d !== '.' && d.includes('/'); d = posix.dirname(d)) dirs.push(d);
    const top = p.split('/')[0];
    const topRe = new RegExp(`(?:^|[^\\w.-])${escapeRe(top)}(?=[/\\\\"'\`])`);
    let any = false;
    // The two scanners that guard Rust take their roots from a contract JSON the text rules cannot see: named, as the note allows.
    if (/\.rs$/.test(p)) for (const g of RUST_GUARDS) if (universe.includes(g)) { add(g, 'mapped'); any = true; }
    for (const t of universe) {
      const { text, walkText, scans } = info.get(t);
      let hitFor = closures.get(t)?.has(p) ?? false;
      if (!hitFor) {
        const relTo = posix.relative(posix.dirname(t), p);
        const cands = [...names, ...(relTo.startsWith('..') ? [relTo, relTo.replace(/\.(ts|tsx|mjs|js)$/, '')] : [])];
        hitFor = cands.some((c) => text.includes(c));
      }
      if (!hitFor && scans) hitFor = dirs.some((d) => walkText.includes(d));
      if (!hitFor && scans && !isModule) hitFor = topRe.test(walkText); // a tree walker may reach a file nothing imports
      if (hitFor) { add(t, 'mapped'); any = true; }
    }
    if (!any && !KNOWN_EXT.test(p) && !/^docs\//.test(p)) {
      return { all: true, reason: `${p} is an unknown kind of file and no test names it` };
    }
  }

  if (floor) {
    for (const t of universe) {
      const i = info.get(t);
      if (i.scans || (i.reads && !i.literal)) add(t, 'floor');
    }
  }
  return { files: [...chosen].sort(), counts: { total: universe.length, ...reasons } };
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const r = selectTests(args.filter((a) => !a.startsWith('--')), { floor: args.includes('--floor') });
  console.log(r.all ? `ALL ${r.reason}` : r.files.join('\n'));
  if (!r.all) console.error(JSON.stringify(r.counts));
}
