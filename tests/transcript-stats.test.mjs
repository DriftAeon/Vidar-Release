import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingInputs, guard } from './helpers/optional-input.mjs';

const skip = missingInputs(import.meta.url, '../tools/measure/run-cost.mjs');
const { statsFor } = skip ? {} : await import('../tools/measure/run-cost.mjs');
const test = guard(baseTest, skip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'subagent-3.jsonl');

// Bug this covers: a subagent transcript never gets a cost-state record (only a top-level CLI
// session does), so `models` came back empty and `usd` null/0 even though every assistant record
// carries message.model + usage — the same fields a main transcript's cost-state is built from.
test('transcript-stats --json: subagent transcript (no cost-state) is priced from summed usage', () => {
  const s = statsFor(FIXTURE);
  assert.equal(s.source, 'summed');
  assert.deepEqual(s.models, ['claude-sonnet-5']);
  assert.equal(s.in, 450);
  assert.equal(s.out, 185);
  assert.equal(s.cacheRead, 45);
  assert.equal(s.cacheCreate, 23);
  // (450*2.00 + 185*10.00 + 45*0.20 + 23*2.50) / 1e6, PRICES["claude-sonnet-5"] in transcript-stats.mjs
  assert.ok(Math.abs(s.usd - 0.0028165) < 1e-9);
  assert.equal(s.hasUnknownModelCost, false);
});
