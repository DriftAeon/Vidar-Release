// src/lab/items.ts: which runes the Lab lists per agent, and which history rows belong to which item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_TOOLS_ERROR, casesFor, labItems, rowMatches } from '../src/lab/items.ts';
import { dryCommand, liveCommand } from '../src/lab/commands.ts';

const rune = (id) => ({ id });
const set = (target, ...ids) => ({ target, members: ids.map((id) => ({ id, recall: false })) });
const libs = [
  {
    key: 'global',
    runes: [rune('a'), rune('b'), rune('c'), rune('d')],
    sets: [set('CLAUDE.md', 'a', 'b'), set('AGENTS.md', 'b', 'c'), set('.claude/rules/x.md', 'd')],
  },
  { key: 'vidar', runes: [], sets: [] },
];
const on = (...ids) => (id) => ids.includes(id);
const flat = (groups) => groups.flatMap((g) => g.items.map((i) => `${g.lib}:${i.rune.id}:${i.target}`));

test('Claude only lists CLAUDE.md members', () => {
  assert.deepEqual(flat(labItems(libs, on('claude'))), ['global:a:CLAUDE.md', 'global:b:CLAUDE.md']);
});

test('Codex only lists AGENTS.md members', () => {
  assert.deepEqual(flat(labItems(libs, on('codex'))), ['global:b:AGENTS.md', 'global:c:AGENTS.md']);
});

test('both on: a shared rune gives two items; .claude/rules targets never list', () => {
  const got = flat(labItems(libs, on('claude', 'codex')));
  assert.deepEqual(got, ['global:a:CLAUDE.md', 'global:b:CLAUDE.md', 'global:b:AGENTS.md', 'global:c:AGENTS.md']);
  assert.ok(!got.some((g) => g.includes(':d:')));
  assert.deepEqual(flat(labItems(libs, on())), []);
  assert.equal(labItems(libs, on('claude')).length, 2, 'every library keeps its group, empty or not');
});

test('a row matches an item by target, absent meaning CLAUDE.md', () => {
  assert.ok(rowMatches({}, 'CLAUDE.md'));
  assert.ok(rowMatches({ target: null }, 'CLAUDE.md'));
  assert.ok(!rowMatches({}, 'AGENTS.md'));
  assert.ok(rowMatches({ target: 'AGENTS.md' }, 'AGENTS.md'));
  assert.ok(!rowMatches({ target: 'AGENTS.md' }, 'CLAUDE.md'));
});

test('Codex commands end in --target AGENTS.md; Claude strings are unchanged', () => {
  assert.equal(dryCommand('r', 'global'), 'node tools/lab/run.mjs --item rune:r --lib global');
  assert.equal(dryCommand('r', 'global', 'CLAUDE.md'), dryCommand('r', 'global'));
  assert.equal(dryCommand('r', 'vidar', 'AGENTS.md'), 'node tools/lab/run.mjs --item rune:r --lib vidar --target AGENTS.md');
  assert.equal(liveCommand('r', 'global', 1), `${dryCommand('r', 'global')} --live --confirm 6`);
  assert.equal(liveCommand('r', 'global', 1, 'AGENTS.md'), `${dryCommand('r', 'global')} --live --confirm 6 --target AGENTS.md`);
  assert.equal(liveCommand('r', 'global', 3, 'AGENTS.md'), null);
});

test('a Codex item marks declared-tools cases; Claude items keep them', () => {
  const cases = [{ name: 'x', toolsDeclared: true }, { name: 'y', toolsDeclared: false }, { name: 'z', toolsDeclared: true, error: 'bad' }];
  assert.equal(casesFor(cases, 'CLAUDE.md'), cases);
  const got = casesFor(cases, 'AGENTS.md');
  assert.equal(got[0].error, CODEX_TOOLS_ERROR);
  assert.equal(got[1].error, undefined);
  assert.equal(got[2].error, 'bad');
});
