import test from 'node:test';
import assert from 'node:assert/strict';
import { injectAppLayer } from '../src/rules/app-layer.ts';
import { injectRules } from '../src/rules/inject.ts';

const cmd = (c) => ['-NoExit', '-Command', c];
const FLAGS = '--plugin-dir "$env:VIDAR_ROOT\\plugins\\vidar-app" --allowedTools mcp__plugin_vidar_drive';

test('app layer: claude gains both flags after the token', () => {
  assert.deepEqual(injectAppLayer(cmd('claude')), cmd(`claude ${FLAGS}`));
});

test('app layer: claude --resume x keeps the resume form after the flags', () => {
  assert.deepEqual(injectAppLayer(cmd('claude --resume x')), cmd(`claude ${FLAGS} --resume x`));
});

test('app layer: composes with a rules flag in a stable order', () => {
  const rules = { file: 'C:\\v\\built\\a.md', codex: null, warnings: [] };
  const withRules = injectRules(cmd('claude --resume x'), rules).args;
  assert.deepEqual(injectAppLayer(withRules), cmd(`claude ${FLAGS} --append-system-prompt-file 'C:\\v\\built\\a.md' --resume x`));
});

const PLUGIN = '--plugin-dir "$env:VIDAR_ROOT\\plugins\\vidar-app"';
const ALLOWED = '--allowedTools mcp__plugin_vidar_drive';

test('app layer: a command already naming plugins\\vidar-app gets no second --plugin-dir', () => {
  for (const p of ['C:\\v\\plugins\\vidar-app', 'c:/v/PLUGINS/Vidar-App']) {
    assert.deepEqual(injectAppLayer(cmd(`claude --plugin-dir "${p}"`)), cmd(`claude ${ALLOWED} --plugin-dir "${p}"`));
  }
});

test('app layer: an existing --allowedTools / --allowed-tools keeps ours out', () => {
  for (const f of ['--allowedTools', '--allowed-tools']) {
    assert.deepEqual(injectAppLayer(cmd(`claude ${f} Read`)), cmd(`claude ${PLUGIN} ${f} Read`));
  }
});

test('app layer: --strict-mcp-config still gets --plugin-dir but no --allowedTools', () => {
  assert.deepEqual(injectAppLayer(cmd('claude --strict-mcp-config --resume x')), cmd(`claude ${PLUGIN} --strict-mcp-config --resume x`));
});

test('app layer: nothing to add leaves the args untouched', () => {
  const c = cmd('claude --plugin-dir "C:\\v\\plugins\\vidar-app" --allowedTools Read');
  assert.deepEqual(injectAppLayer(c), c);
});

test('app layer: codex, a vendor row and unknown shapes are unchanged', () => {
  const codex = cmd('codex resume abc');
  assert.deepEqual(injectAppLayer(codex), codex);
  const vendor = cmd('claude-vendor --x');
  assert.deepEqual(injectAppLayer(vendor), vendor);
  const custom = ['-NoProfile', '-File', 'x.ps1'];
  assert.deepEqual(injectAppLayer(custom), custom);
  assert.equal(injectAppLayer(undefined), undefined);
});
