// src/runes/trace.ts against the L1a fixture: golden.json catalog + a loaded result built from transcript.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { traceRunes, normPath, canLoad } from '../src/runes/trace.ts';

const FX = new URL('./fixtures/runes-catalog/', import.meta.url);
const BASE = 'D:\\fx\\repo';
const J = (p) => JSON.stringify(p).slice(1, -1); // backslashes escaped: the fixtures are JSON text
const sub = (s) => s.replaceAll('<base>', J(BASE)).replaceAll('<repo>', J(BASE)).replaceAll('<REPO>', J(BASE.toUpperCase())).replaceAll('<home>', J('D:\\fx\\home'));

const catalog = () => JSON.parse(sub(readFileSync(new URL('golden.json', FX), 'utf8')));

/** What loaded.rs returns for the fixture: instructions = start, nested_memory = touch, deduped by lowercased path. */
function loadedFrom(lines) {
  const files = [], seen = new Set();
  const add = (path, memoryType, when) => {
    if (seen.has(path.toLowerCase())) return;
    seen.add(path.toLowerCase());
    files.push({ path, memoryType, when });
  };
  for (const line of lines) {
    const a = JSON.parse(line).attachment;
    if (a?.type === 'instructions') for (const f of a.files) add(f.path, f.type, 'start');
    if (a?.type === 'nested_memory') add(a.path, a.content?.type ?? '', 'touch');
  }
  return { source: 'transcript', files, truncated: false };
}
const transcript = () => sub(readFileSync(new URL('transcript.jsonl', FX), 'utf8')).split('\n').filter(Boolean);

const stateOf = (t, key, id) => t.libraries.find((l) => l.lib.key === key).sets.find((s) => s.set.id === id).state;
const vidar = (t) => t.libraries.find((l) => l.lib.key === 'vidar');

test('set states, rune flags and the outside list from the fixture transcript', () => {
  const t = traceRunes(catalog(), loadedFrom(transcript()), BASE);
  assert.equal(t.known, true);
  assert.equal(stateOf(t, 'vidar', 'app-core'), 'Loaded'); // <REPO>/claude.md matches case-insensitively
  assert.equal(stateOf(t, 'vidar', 'ui-paths'), 'On Touch'); // its target was not touched
  assert.equal(vidar(t).runeLoaded.get('alpha-rule'), true);
  assert.equal(vidar(t).runeLoaded.get('beta-fact'), true);
  assert.deepEqual(vidar(t).setsOf.get('alpha-rule'), ['app-core', 'ui-paths']);
  assert.deepEqual(t.outside.map((o) => o.label), ['D:\\fx\\home/.claude/CLAUDE.md', '.claude/rules/ui-copy.md']);
  assert.equal(t.libraries[0].lib.key, 'global');
  assert.equal(t.libraries[0].sets.length, 0);
});

test('a path-scoped target loaded as nested memory is Loaded; untargeted sets are Not Loaded', () => {
  const lines = [...transcript(), JSON.stringify({ type: 'attachment', attachment: { type: 'nested_memory', path: `${BASE.replaceAll('\\', '/')}/.claude/rules/UI.md`, content: { type: 'Project' } } })];
  const c = catalog();
  c.libraries[1].sets.push({ id: 'loose', target: null, targetAbs: null, activate: 'none', paths: [], scope: ['global'], tier: 4, members: [{ id: 'beta-fact', recall: false }] });
  const t = traceRunes(c, loadedFrom(lines), BASE);
  assert.equal(stateOf(t, 'vidar', 'ui-paths'), 'Loaded');
  assert.equal(stateOf(t, 'vidar', 'loose'), 'Not Loaded');
  assert.ok(!t.outside.some((o) => normPath(o.path).endsWith('ui.md')));
});

test('a plugins/ target is Via Plugin Hook and loads nothing; an unknown member never throws', () => {
  const c = catalog();
  c.libraries[1].sets.push({ id: 'hooked', target: 'plugins/x/context.md', targetAbs: `${BASE}\\plugins\\x\\context.md`, activate: 'none', paths: [], scope: ['global'], tier: 1, members: [{ id: 'gone-rune', recall: false }] });
  const t = traceRunes(c, loadedFrom(transcript()), BASE);
  assert.equal(stateOf(t, 'vidar', 'hooked'), 'Via Plugin Hook');
  assert.equal(vidar(t).runeLoaded.has('gone-rune'), false);
});

test('no transcript: states unknown except plugin sets, runes unflagged, nothing outside', () => {
  const t = traceRunes(catalog(), { source: 'none', reason: 'No Session Yet', files: [], truncated: false }, BASE);
  assert.equal(t.known, false);
  assert.equal(stateOf(t, 'vidar', 'app-core'), null);
  assert.equal(vidar(t).runeLoaded.get('alpha-rule'), null);
  assert.deepEqual(t.outside, []);
});

test('canLoad hides unread every-session and tier 4 sets; path-scoped, plugin and untraced sets stay', () => {
  const c = catalog();
  c.libraries[1].sets.push(
    { id: 'other-agent', target: 'AGENTS.md', targetAbs: `${BASE}\\AGENTS.md`, activate: 'none', paths: [], scope: ['global'], tier: 1, members: [] },
    { id: 'loose', target: null, targetAbs: null, activate: 'none', paths: [], scope: ['global'], tier: 4, members: [] },
    { id: 'hooked', target: 'plugins/x/context.md', targetAbs: `${BASE}\\plugins\\x\\context.md`, activate: 'none', paths: [], scope: ['global'], tier: 1, members: [] },
  );
  const of = (t, id) => vidar(t).sets.find((s) => s.set.id === id);
  const t = traceRunes(c, loadedFrom(transcript()), BASE);
  assert.equal(canLoad(of(t, 'app-core')), true); // Loaded
  assert.equal(canLoad(of(t, 'ui-paths')), true); // On Touch
  assert.equal(canLoad(of(t, 'other-agent')), false);
  assert.equal(canLoad(of(t, 'loose')), false);
  assert.equal(canLoad(of(t, 'hooked')), true);
  const u = traceRunes(c, { source: 'none', reason: 'No Session Yet', files: [], truncated: false }, BASE);
  assert.equal(canLoad(of(u, 'other-agent')), true); // unknown, kept
});
