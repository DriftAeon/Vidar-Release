import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingInputs, guard } from './helpers/optional-input.mjs';

const skip = missingInputs(import.meta.url, '../tools/measure/run-cost.mjs');
const { subagentRows, statsFor, costTotal, breakdown, notesSessionPrefixes } = skip ? {} : await import('../tools/measure/run-cost.mjs');
const test = guard(baseTest, skip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'subagent-3.jsonl');
const made = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vidar-subagent-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('notesSessionPrefixes: old "session <hex>" and 10-06 "<HH:mm> <hex> <task>:" entries both join', () => {
  const runDir = mkTmp();
  fs.writeFileSync(path.join(runDir, 'NOTES.md'), [
    'Session 1a66a944 (catapult 16:52): resumed.',
    '09:41 f15fb670 controls-smoke: swapped d4247fb with -Debug.',
    '10:27 3BB01E32 clutter-sweep/w1: plan-v2 written.',
    '- 16:50 156a1c57 wave 1 launched',
    '- 2026-10-07 752130ed runes: run opened',
    'commit 0f79d0b1 at 10:30 deadbeef is prose, not an entry.',
  ].join('\n'));
  assert.deepEqual(notesSessionPrefixes(runDir).sort(), ['156a1c57', '1a66a944', '3bb01e32', '752130ed', 'f15fb670']);
});

test('subagentRows: one settled subagent transcript, summed tokens, role prefix', () => {
  const tmpDir = mkTmp();
  const subagentsDir = path.join(tmpDir, 'subagents');
  fs.mkdirSync(subagentsDir);
  const dest = path.join(subagentsDir, 'agent-test.jsonl');
  fs.copyFileSync(FIXTURE, dest);
  // Idle well past SETTLE_MS (15 min) so the settle rule (file-idle only, no cost-state) passes.
  const past = (Date.now() - 20 * 60 * 1000) / 1000;
  fs.utimesSync(dest, past, past);

  const rows = subagentRows(subagentsDir, 'orchestrator', statsFor);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.session, 'agent-test');
  assert.equal(r.role, 'subagent:orchestrator');
  assert.equal(r.source, 'summed');
  assert.equal(r.in, 450);
  assert.equal(r.out, 185);
  assert.equal(r.cacheRead, 45);
  assert.equal(r.cacheCreate, 23);
  assert.equal(r.agents, 0);
});

test('subagentRows: sibling meta names the profile; absent meta gives ""', () => {
  const tmpDir = mkTmp();
  const subagentsDir = path.join(tmpDir, 'subagents');
  fs.mkdirSync(subagentsDir);
  const past = (Date.now() - 20 * 60 * 1000) / 1000;
  for (const id of ['agent-with', 'agent-without']) {
    const dest = path.join(subagentsDir, `${id}.jsonl`);
    fs.copyFileSync(FIXTURE, dest);
    fs.utimesSync(dest, past, past);
  }
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'subagent-3.meta.json'), path.join(subagentsDir, 'agent-with.meta.json'));

  const rows = subagentRows(subagentsDir, 'orchestrator', statsFor);
  const by = Object.fromEntries(rows.map((r) => [r.session, r]));
  assert.equal(by['agent-with'].profile, 'Hound');
  assert.equal(by['agent-with'].askedModel, 'haiku');
  assert.equal(by['agent-without'].profile, '');
  assert.equal(by['agent-without'].askedModel, '');
  assert.deepEqual([...breakdown(rows).keys()].sort(), ['subagent:orchestrator', 'subagent:orchestrator [Hound]']);
});

test('subagentRows: unsettled transcript (fresh mtime) yields no row', () => {
  const tmpDir = mkTmp();
  const subagentsDir = path.join(tmpDir, 'subagents');
  fs.mkdirSync(subagentsDir);
  const fresh = path.join(subagentsDir, 'agent-fresh.jsonl');
  fs.copyFileSync(FIXTURE, fresh);
  // CopyFileW keeps the source mtime on Windows, so the copy is "old"; stamp it now
  const now = new Date();
  fs.utimesSync(fresh, now, now);

  const rows = subagentRows(subagentsDir, 'orchestrator', statsFor);
  assert.equal(rows.length, 0);
});

test('subagentRows: workflow agents are joined, the workflow journal is not', () => {
  const tmpDir = mkTmp();
  const subagentsDir = path.join(tmpDir, 'subagents');
  const wfDir = path.join(subagentsDir, 'workflows', 'wf_test-1');
  fs.mkdirSync(wfDir, { recursive: true });
  const past = (Date.now() - 20 * 60 * 1000) / 1000;
  for (const name of ['agent-wf1.jsonl', 'journal.jsonl']) {
    const dest = path.join(wfDir, name);
    fs.copyFileSync(FIXTURE, dest);
    fs.utimesSync(dest, past, past);
  }

  const rows = subagentRows(subagentsDir, 'orchestrator', statsFor);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session, 'agent-wf1');
  assert.equal(rows[0].role, 'workflow:orchestrator');
  assert.equal(rows[0].in, 450);
});

test('costTotal: children of a cost-state parent are listed, not added', () => {
  const rows = [
    { session: 'parent', role: 'orchestrator', source: 'cost-state', usd: '17.7200' },
    { session: 'agent-a', role: 'workflow:orchestrator', source: 'summed', usd: '9.0000', inParent: true },
    { session: 'agent-b', role: 'subagent:orchestrator', source: 'summed', usd: '8.5000', inParent: true },
    { session: 'solo', role: 'subagent:other', source: 'summed', usd: '1.0000' },
  ];
  assert.equal(costTotal(rows.slice(0, 3)).toFixed(2), '17.72');
  assert.equal(costTotal(rows).toFixed(2), '18.72'); // un-flagged child (parent not cost-state) still counts
  const b = breakdown(rows.filter((r) => r.inParent));
  assert.deepEqual([...b.keys()], ['workflow:orchestrator', 'subagent:orchestrator']);
  assert.equal(b.get('workflow:orchestrator').usd, 9);
});

test('subagentRows: missing directory yields no rows', () => {
  const rows = subagentRows(path.join(os.tmpdir(), 'vidar-subagent-does-not-exist'), 'orchestrator', statsFor);
  assert.equal(rows.length, 0);
});
