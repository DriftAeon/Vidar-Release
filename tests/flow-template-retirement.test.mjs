import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_TEMPLATES, RETIRED_TEMPLATE_ALIASES } from '../src/flow/templates.ts';
import { reseedStarters, STARTERS_REV, STARTERS_REV_KEY } from '../src/flow/store-core.ts';

function mapStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('the duplicate plan starter retires from stored templates while its id resolves', () => {
  const retiredId = 'tpl-plan-review-revise-execute-academy';
  const replacementId = RETIRED_TEMPLATE_ALIASES[retiredId];
  const replacement = STARTER_TEMPLATES.find((t) => t.id === replacementId);
  assert.ok(replacement);
  assert.deepEqual(replacement.graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id),
    ['plan', 'review', 'revise', 'execute', 'verify', 'analyze']);

  const legacy = { ...replacement, id: retiredId, name: 'Old Plan' };
  const custom = { ...replacement, id: 'custom-plan', name: 'Custom Plan' };
  const storage = mapStorage({ [STARTERS_REV_KEY]: String(STARTERS_REV - 1) });
  const migrated = reseedStarters(storage, [legacy, custom], STARTER_TEMPLATES,
    STARTERS_REV, Object.keys(RETIRED_TEMPLATE_ALIASES));
  assert.equal(migrated.some((t) => t.id === retiredId), false);
  assert.equal(migrated.find((t) => t.id === 'custom-plan'), custom);
  assert.equal(migrated.filter((t) => t.id === replacementId).length, 1);
  assert.equal(storage.getItem(STARTERS_REV_KEY), String(STARTERS_REV));
});

test('each starter tooltip names every agent stage in order', () => {
  for (const template of STARTER_TEMPLATES) {
    const titles = template.graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.title);
    const labels = template.description.split(' → ');
    assert.equal(labels.length, titles.length, template.name);
    for (const [i, title] of titles.entries()) assert.ok(labels[i].startsWith(title), template.name);
  }
});
