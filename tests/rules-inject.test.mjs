import test from 'node:test';
import assert from 'node:assert/strict';
import { injectRules, rulesPlan } from '../src/rules/inject.ts';

const cmd = (c) => ['-NoExit', '-Command', c];
const claudeRules = { file: 'C:\\v\\runtime\\rules\\built\\0123456789ab.md', codex: null, warnings: [] };
const codexRules = { file: 'C:\\v\\runtime\\rules\\built\\0123456789ab.md', codex: { mode: 'c', value: '"Core \\"rule\\".\\n"' }, warnings: [] };

test('raw claude: the flag follows the leading token', () => {
  const r = injectRules(cmd('claude'), claudeRules);
  assert.deepEqual(r.args, cmd(`claude --append-system-prompt-file '${claudeRules.file}'`));
  assert.equal(r.warning, undefined);
});

test('claude --resume <id>: the flag lands before the resume form', () => {
  const id = '0a7e3c59-8b2f-4f6d-a1c4-5e9d7b3f2c10';
  const r = injectRules(cmd(`claude --resume ${id}`), claudeRules);
  assert.deepEqual(r.args, cmd(`claude --append-system-prompt-file '${claudeRules.file}' --resume ${id}`));
});

test('codex resume <id>: -c goes before the subcommand, value single-quoted', () => {
  const r = injectRules(cmd('codex resume abc'), codexRules);
  assert.deepEqual(r.args, cmd(`codex -c 'developer_instructions="Core \\"rule\\".\\n"' resume abc`));
});

test('codex profile mode uses --profile', () => {
  const r = injectRules(cmd('codex'), { ...codexRules, codex: { mode: 'profile', name: 'vidar-rules-0123456789ab' } });
  assert.deepEqual(r.args, cmd(`codex --profile 'vidar-rules-0123456789ab'`));
});

test('astra shape keeps its own flags after the injected one', () => {
  const r = injectRules(cmd('codex -a never -s workspace-write -c model_verbosity=low'), codexRules);
  assert.match(r.args[2], /^codex -c 'developer_instructions=.*' -a never -s workspace-write -c model_verbosity=low$/);
});

test("a path containing ' has the quote doubled", () => {
  const r = injectRules(cmd('claude'), { ...claudeRules, file: "C:\\it's\\0123456789ab.md" });
  assert.equal(r.args[2], "claude --append-system-prompt-file 'C:\\it''s\\0123456789ab.md'");
});

test('unknown shape: args unchanged plus a warning', () => {
  for (const args of [undefined, ['-NoExit', '-Command', 'gemini'], ['-NoProfile', '-Command', '& x.ps1 -Vendor acme'], ['-NoExit'], cmd('claudex')]) {
    const r = injectRules(args, claudeRules);
    assert.equal(r.args, args);
    assert.match(r.warning, /^Rules not applied to this terminal launch/);
  }
});

test('no rules, or nothing for that agent: unchanged and silent', () => {
  const a = cmd('claude');
  assert.deepEqual(injectRules(a, undefined), { args: a });
  assert.deepEqual(injectRules(a, { file: null, codex: null, warnings: ['x'] }), { args: a });
  assert.deepEqual(injectRules(cmd('codex'), claudeRules), { args: cmd('codex') });
});

test('malformed rules or key warn instead of throwing', () => {
  const bad = rulesPlan({ id: 'claude', key: 'claude', label: 'Claude', rules: 'core' });
  assert.match(bad.warning, /is not a list/);
  const noKey = rulesPlan({ id: 'claude', key: 42, label: 'Claude', rules: ['core'] });
  assert.match(noKey.warning, /has no key/);
  assert.equal(rulesPlan({ id: 'claude', key: 'claude' }), null);
});

test('vendor and other non-claude/codex rows get the generic warning', () => {
  for (const id of ['acme', 'beta', 'gemini']) {
    const r = rulesPlan({ id, key: id, label: id, rules: ['core'] });
    assert.match(r.warning, /is not a Claude or Codex row/);
  }
});

test('curly single quotes in a path are doubled like straight ones', () => {
  const r = injectRules(cmd('claude'), { ...claudeRules, file: 'C:\\a\u2018b\u2019c\u201Ad\u201Be\\f.md' });
  assert.equal(r.args[2], "claude --append-system-prompt-file 'C:\\a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be\\f.md'");
});

test('rulesPlan and injectRules: an external adopt inherits the Raw Claude row rules', () => {
  const row = { id: 'claude', key: 'claude', label: 'Claude', rules: ['core'] };
  assert.deepEqual(rulesPlan(row), { key: 'claude', ids: ['core'], client: 'claude' });
  // the adopt args are the resume form; the prepared file lands on it
  const r = injectRules(cmd('claude --resume 0a7e3c59-8b2f-4f6d-a1c4-5e9d7b3f2c10'), claudeRules);
  assert.match(r.args[2], /^claude --append-system-prompt-file '.+' --resume /);
});
