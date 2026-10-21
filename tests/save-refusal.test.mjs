import test from 'node:test';
import assert from 'node:assert/strict';
import { saveRefusal } from '../src/settings/save-refusal.ts';

test('a partial load names what was ignored and says to fix the file', () => {
  const err = 'vidar.json: ignored wrong-typed key(s), defaults used for them: fontSize (bad)';
  assert.equal(saveRefusal(err), 'vidar.json Has Errors: fontSize (bad) — Fix The File To Save');
});

test('skipped entries get the same refusal', () => {
  const err = 'vidar.json: skipped entries: agents[1] id broken (bad)';
  assert.equal(saveRefusal(err), 'vidar.json Has Errors: agents[1] id broken (bad) — Fix The File To Save');
});

test('both clauses are kept, starting at the first', () => {
  const err = 'vidar.json: ignored wrong-typed key(s), defaults used for them: fontSize (bad) | vidar.json: skipped entries: agents[0] (x)';
  assert.match(saveRefusal(err), /^vidar\.json Has Errors: fontSize \(bad\) \| .*skipped entries: agents\[0\] \(x\) — Fix/);
});

test('a hard parse failure still says nothing loaded', () => {
  assert.equal(saveRefusal('vidar.json parse error: x'), 'vidar.json Did Not Load: vidar.json parse error: x');
});
