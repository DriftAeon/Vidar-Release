// Fast-tier gate lints only staged files: path filter, whole-tree default, dirty file outside the set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintStep } from '../tools/gate/lint-plan.mjs';
import { covers as coversUi } from '../tools/ui/lint-ui.mjs';
import { covers as coversCopy } from '../tools/ui/lint-copy.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('lint-ui covers only src css/ts, not .d.ts', () => {
  assert.ok(coversUi('src/styles/a.css'));
  assert.ok(coversUi('src/panels/a.ts'));
  assert.ok(!coversUi('src/types.d.ts'));
  assert.ok(!coversUi('src/main.js'));
  assert.ok(!coversUi('tests/a.mjs'));
  assert.ok(!coversUi('docs/a.css'));
});

test('lint-copy covers src sources, index.html and contracts json', () => {
  assert.ok(coversCopy('src/panels/a.ts'));
  assert.ok(coversCopy('src/a.mjs'));
  assert.ok(coversCopy('index.html'));
  assert.ok(coversCopy('contracts/paths.json'));
  assert.ok(!coversCopy('src/styles/a.css'));
  assert.ok(!coversCopy('src/a.test.ts'));
  assert.ok(!coversCopy('src/types.d.ts'));
  assert.ok(!coversCopy('tools/x.mjs'));
});

test('lintStep passes each linter only its covered staged paths', () => {
  const [name, cmd] = lintStep(['src/styles/a.css', 'src/b.ts', 'tests/t.mjs', 'src-tauri/src/main.rs']);
  assert.equal(name, 'lints');
  const [ui, copy] = cmd.split(' && ');
  assert.equal(ui, 'node tools/ui/lint-ui.mjs --staged "src/styles/a.css" "src/b.ts"');
  assert.equal(copy, 'node tools/ui/lint-copy.mjs --staged "src/b.ts"');
});

test('lintStep skips a linter with nothing covered, and the step when neither', () => {
  const [, cmd] = lintStep(['src/styles/a.css']);
  assert.equal(cmd, 'node tools/ui/lint-ui.mjs --staged "src/styles/a.css"');
  assert.equal(lintStep(['tests/t.mjs', 'src/types.d.ts', 'README.md']), null);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-lint-'));
  mkdirSync(join(root, 'src', 'styles'), { recursive: true });
  writeFileSync(join(root, 'src', 'styles', 'good.css'), '.a { padding: var(--space-4); }\n');
  // Legacy token: a lint-ui finding (the zoom-toast.css case).
  writeFileSync(join(root, 'src', 'styles', 'dirty.css'), '.b { padding: var(--space-3); }\n');
  return root;
}
const run = (root, ...paths) =>
  spawnSync(process.execPath, [join(repo, 'tools', 'ui', 'lint-ui.mjs'), '--root', root, ...paths], { encoding: 'utf8' });

test('no path list scans the whole tree (dirty file fails)', () => {
  const root = fixture();
  try { assert.equal(run(root).status, 1); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dirty file outside the path list does not fail the run', () => {
  const root = fixture();
  try {
    assert.equal(run(root, 'src/styles/good.css').status, 0);
    assert.equal(run(root, 'src/styles/dirty.css').status, 1);
    // an uncovered path scans nothing
    assert.equal(run(root, 'docs/dirty.css').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--update-baseline is refused with a path list', () => {
  const root = fixture();
  try { assert.equal(run(root, '--update-baseline', 'src/styles/good.css').status, 2); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fast plan: a Rust-only commit runs the tree scans, a tests/ commit leaves them to npm test', async () => {
  const { plan } = await import('../tools/gate/gate.mjs');
  const names = (f) => plan(f).map((s) => s[0]);
  assert.ok(names(['src-tauri/x.rs']).includes('tree scans'));
  assert.ok(names(['src-falcon/x.rs']).includes('tree scans'));
  assert.ok(names(['profiles/x.md']).includes('tree scans'));
  assert.ok(!names(['src-tauri/x.rs', 'tests/a.test.mjs']).includes('tree scans'));
  assert.ok(!names(['docs/a.md']).includes('tree scans'));
});