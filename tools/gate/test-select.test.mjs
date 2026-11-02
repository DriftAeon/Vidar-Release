// Table over the fast-gate test selector on a fixture tree, plus gate.plan wiring with an injected selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_RE, READ_RE, SCAN_RE, selectTests } from './test-select.mjs';
import { plan } from './gate.mjs';

const T = dirname(dirname(fileURLToPath(import.meta.url))).split(/[\\/]/).pop(); // the tools folder, from this file's place

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'tsel-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}
function sel(files, staged, opts = {}) {
  const root = fixture(files);
  try { return selectTests(staged, { root, env: {}, ...opts }); } finally { rmSync(root, { recursive: true, force: true }); }
}

const BASE = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'import { a } from "./a";\nexport const b = a;\n',
  'src/c.ts': 'export const c = 1;\n',
  'src/types.ts': 'export type X = 1;\n',
  'src/d.ts': 'import type { X } from "./types";\nexport const d = 1;\n',
  'tests/static.test.mjs': 'import { b } from "../src/b.ts";\n',
  'tests/dynamic.test.mjs': 'const m = await import("../src/c.ts");\n',
  'tests/types.test.mjs': 'import { d } from "../src/d.ts";\n',
  'tests/unrelated.test.mjs': 'import test from "node:test";\n',
  'tests/mention.test.mjs': 'const p = "src/c.ts";\n',
  'tests/scan.test.mjs': 'import { readdirSync } from "node:fs";\nreaddirSync(root);\n',
  'tests/reader-lit.test.mjs': 'readFileSync(join(root, "src/zzz.ts"));\n',
  'tests/reader-bare.test.mjs': 'readFileSync(join(root, "Cargo.toml"));\n',
  'tests/rust.test.mjs': 'readdirSync(join(root, "src-tauri"));\nconst lit = "src/zzz.ts";\n',
  [`${T}/q/q.test.mjs`]: 'import test from "node:test";\n',
};

test('transitive static import maps the test', () => {
  assert.deepEqual(sel(BASE, ['src/a.ts']).files, ['tests/static.test.mjs']);
});

test('dynamic literal import maps the test, and so does a literal mention', () => {
  assert.deepEqual(sel(BASE, ['src/c.ts']).files, ['tests/dynamic.test.mjs', 'tests/mention.test.mjs']);
});

test('import type is erased: a types-only change maps nothing', () => {
  assert.deepEqual(sel(BASE, ['src/types.ts']).files, []);
});

test('a staged test file runs itself', () => {
  const r = sel(BASE, ['tests/unrelated.test.mjs']);
  assert.deepEqual(r.files, ['tests/unrelated.test.mjs']);
  assert.equal(r.counts.staged, 1);
});

test('floor adds every scanning test and each reader without a literal repo path', () => {
  const r = sel(BASE, ['src/a.ts'], { floor: true });
  assert.deepEqual(r.files, ['tests/reader-bare.test.mjs', 'tests/rust.test.mjs', 'tests/scan.test.mjs', 'tests/static.test.mjs']);
  assert.ok(!sel(BASE, ['src/a.ts']).files.includes('tests/scan.test.mjs'));
});

test('a Rust file runs the tree walkers that name its top dir, not the whole floor', () => {
  assert.deepEqual(sel(BASE, ['src-tauri/main.rs']).files, ['tests/rust.test.mjs']);
});

test('a tree walker that names an ancestor dir of the staged file runs', () => {
  const files = { ...BASE, 'src/deep/e.ts': 'export const e = 1;\n', 'tests/dir.test.mjs': 'readdirSync(join(root, "src/deep"));\n' };
  assert.deepEqual(sel(files, ['src/deep/e.ts']).files, ['tests/dir.test.mjs']);
});

test('unknown file kind that no test names falls back to the full suite', () => {
  assert.match(sel(BASE, ['assets/blob.bin']).reason, /unknown kind/);
  assert.deepEqual(sel({ ...BASE, 'tests/blob.test.mjs': 'x = "assets/blob.bin"' }, ['assets/blob.bin']).files, ['tests/blob.test.mjs']);
});

test('test infrastructure and config changes fall back to the full suite', () => {
  for (const p of ['tests/helpers/dom-mount.mjs', 'tests/lib/rig.mjs', `${T}/gate/gate.mjs`, 'package.json', 'package-lock.json', 'tsconfig.json', 'src/tsconfig.app.json', 'contracts/paths.json']) {
    assert.equal(sel(BASE, [p]).all, true, p);
  }
});

test('VIDAR_GATE_FULL_TESTS=1 forces the full suite', () => {
  assert.equal(sel(BASE, ['src/a.ts'], { env: { VIDAR_GATE_FULL_TESTS: '1' } }).all, true);
});

test('a selector error fails closed', () => {
  const r = selectTests(['src/a.ts'], { root: join(tmpdir(), 'tsel-missing-root'), env: {} });
  assert.equal(r.all, true);
  assert.match(r.reason, /selector error/);
});

test('regexes are pinned', () => {
  assert.equal(SCAN_RE.source, 'readdirSync|readdir\\(|globSync|ls-files|walk\\(');
  assert.equal(READ_RE.source, 'readFileSync|spawn|execFile');
  assert.equal(FULL_RE.length, 5);
});

const fixed = (res) => () => res;

test('plan: a src/ commit runs the mapped tests, minus the tree scans it already runs', () => {
  const s = plan(['src/prefs.ts'], fixed({ files: ['tests/a.test.mjs', 'tests/agent-literals.test.mjs'], counts: { total: 9 } }));
  const t = s.find((x) => x[0].startsWith('tests ('));
  assert.equal(t[0], 'tests (1 of 9)');
  assert.ok(!t[1].includes('agent-literals'));
  assert.ok(s.some((x) => x[0] === 'tree scans'));
});

test('plan: nothing mapped adds no test step; a fallback runs npm test and says why', () => {
  assert.ok(!plan(['src/prefs.ts'], fixed({ files: [], counts: { total: 9 } })).some((x) => x[0].startsWith('tests (')));
  const all = plan(['src/prefs.ts'], fixed({ all: true, reason: 'because' }));
  assert.ok(all.some((x) => x[0] === 'npm test (because)' && x[1] === 'npm test'));
  assert.ok(!all.some((x) => x[0] === 'tree scans'));
});

test('plan: a too-long selection falls back to npm test', () => {
  const files = Array.from({ length: 400 }, (_, i) => `tests/some-long-test-name-${i}.test.mjs`);
  assert.ok(plan(['src/prefs.ts'], fixed({ files, counts: { total: 500 } })).some((x) => x[0].startsWith('npm test')));
});

test('plan: a docs-only commit selects nothing and never calls the selector', () => {
  assert.deepEqual(plan(['docs/a.md'], () => { throw new Error('called'); }), []);
});

test('plan: the ipc drift test is skipped when the selection holds it', () => {
  const has = plan(['src-tauri/src/main.rs'], fixed({ files: ['tests/ipc-commands.test.mjs'], counts: { total: 9 } }));
  assert.ok(!has.some((x) => x[0] === 'ipc drift test'));
  const none = plan(['src-tauri/src/main.rs'], fixed({ files: [], counts: { total: 9 } }));
  assert.ok(none.some((x) => x[0] === 'ipc drift test'));
});
