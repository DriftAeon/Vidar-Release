// Gate runner. `node tools/gate/gate.mjs fast|full`
//   fast: scoped to staged files (pre-commit); nothing relevant staged -> exit 0.
//   full: wave-boundary gate; sequential, stops at the first failure.
// One line per step (name, pass/fail, seconds); a failing step prints its output tail.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintStep } from './lint-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const tier = isMain ? process.argv[2] : 'fast';
if (isMain && tier !== 'fast' && tier !== 'full') {
  console.error('usage: node tools/gate/gate.mjs fast|full');
  process.exit(2);
}

const S = {
  // --no: never download; without node_modules npx would fetch the deprecated npm `tsc` package (2.0.4).
  tsc: ['tsc', 'npx --no -- tsc --noEmit'],
  test: ['npm test', 'npm test'],
  // The drift test reads main.rs's generate_handler! list, so a Rust-only commit needs it too.
  ipcDrift: ['ipc drift test', 'node --test --experimental-strip-types tests/ipc-commands.test.mjs'],
  // A commit staging only src-tauri files skipped npm test, and the tree scans then went red for every later commit.
  treeScans: ['tree scans', 'node --test tests/no-machine-paths.test.mjs tests/paths-contract.test.mjs tests/agent-literals.test.mjs tests/agent-ids-parity.test.mjs'],
  build: ['npm build', 'npm run build'],
  checkTauri: ['cargo check tauri', 'cargo check --manifest-path src-tauri/Cargo.toml'],
  checkFalcon: ['cargo check falcon', 'cargo check --manifest-path src-falcon/Cargo.toml'],
  testTauri: ['cargo test tauri', 'cargo test --manifest-path src-tauri/Cargo.toml'],
  testFalcon: ['cargo test falcon', 'cargo test --manifest-path src-falcon/Cargo.toml'],
  // A hint is a string, or a function of the step output (undefined = no hint).
  runes: ['runes lint', 'node tools/runes/lint.mjs',
    (out) => (out.includes('manifest.json: stale') ? 'Stale manifest: run `node tools/runes/cook.mjs --manifest`, then stage runes/manifest.json.' : undefined)],
  // Fails on a wrapped entry; the word-count warning is printed on pass too (see the run loop).
  docsIndex: ['docs index', 'node tools/gate/index-check.mjs',
    'Join the wrapped line onto its entry line in INDEX.md (one line per entry).'],
  // cook --check prints the drift and the rune behind each differing line (`<target>:<line> <- runes/...`).
  cook: ['runes cook check', 'node tools/runes/cook.mjs --check',
    'Edit the rune named above, never the target. Then `node tools/runes/cook.mjs --diff`, `--swap`, `--manifest`; stage runes and targets together.'],
};

function staged() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// `git commit -- <paths>` runs the hook with a temporary GIT_INDEX_FILE; spawned test commands must not inherit it
// (release-build.test.mjs then sees another dirty set). staged() above keeps the inherited env: it reads that index.
export function stepEnv(base = process.env) {
  const env = { ...base };
  delete env.GIT_INDEX_FILE;
  return env;
}

export function plan(f = staged()) {
  if (tier === 'full') return [S.build, S.runes, S.cook, S.docsIndex, S.test, S.testTauri, S.testFalcon, S.checkFalcon];
  const web = (p) => /\.(ts|tsx|js|mjs|cjs|css|html)$/.test(p) && (p.startsWith('src/') || !p.includes('/'));
  const needWeb = f.some(web);
  // A tools .ps1 or a content .py is scanned for agent keys, so staging one runs npm test and the tree scans.
  const keyed = f.some((p) => /^(tools\/.*\.ps1|content\/.*\.py)$/.test(p));
  const needTest = keyed || f.some((p) => p.startsWith('tests/') || (p.startsWith('tools/') && p.endsWith('.mjs')));
  const needTauri = f.some((p) => p.startsWith('src-tauri/'));
  // Falcon imports from src-tauri; unsure which files, so any src-tauri change checks it too.
  const needFalcon = needTauri || f.some((p) => p.startsWith('src-falcon/'));
  const steps = [];
  if (needWeb) {
    const lints = lintStep(f); // staged files only; null when neither linter covers any
    if (lints) steps.push(lints);
    steps.push(S.tsc);
  }
  if (f.some((p) => /^runes\//.test(p))) steps.push(S.runes);
  if (f.some((p) => /^(runes\/|\.claude\/rules\/)/.test(p) || p === 'CLAUDE.md' || p === 'AGENTS.md')) steps.push(S.cook);
  if (f.some((p) => /^docs.(explore.)?INDEX.md$/.test(p))) steps.push(S.docsIndex);
  if (needTest) steps.push(S.test);
  else if (f.includes('src-tauri/src/main.rs') || f.includes('src/ipc-hosts.ts')) steps.push(S.ipcDrift);
  // The agent-literal ratchet reads src/**/*.ts, so a src-only commit (no tests/ file) runs the tree scans too.
  if (keyed || (!needTest && (needWeb || f.some((p) => /^(src-tauri|src-falcon|profiles)\//.test(p))))) steps.push(S.treeScans);
  if (needTauri) steps.push(S.checkTauri);
  if (needFalcon) steps.push(S.checkFalcon);
  return steps;
}

if (isMain) main();

function main() {
const steps = plan();
if (!steps.length) process.exit(0);

const t0 = Date.now();
for (const [name, cmd, hint] of steps) {
  const t = Date.now();
  const r = spawnSync(cmd, { cwd: root, shell: true, env: stepEnv(), encoding: 'utf8', maxBuffer: 1 << 28 });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const ok = r.status === 0;
  console.log(`${name.padEnd(20)} ${ok ? 'pass' : 'FAIL'} ${secs}s`);
  if (ok) for (const w of (r.stdout || '').split('\n').filter((l) => l.startsWith('warning'))) console.log(`  ${w}`);
  if (!ok) {
    const text = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
    console.log(text.split('\n').slice(-40).join('\n'));
    const h = typeof hint === 'function' ? hint(text) : hint;
    if (h) console.log(h); // after the tail, so it is the last thing seen
    console.log(`gate ${tier}: FAILED at ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    process.exit(1);
  }
}
console.log(`gate ${tier}: ok ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
