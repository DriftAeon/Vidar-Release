import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadGraphsEnvelope,
  saveGraphsEnvelope,
  loadTemplatesEnvelope,
  saveTemplatesEnvelope,
  readGraphsEnvelope,
  backupInvalidEnvelope,
  seedGraphsIfAbsent,
  seedTemplatesIfAbsent,
  reseedStarters,
  STARTERS_REV_KEY,
  stampGraph,
  migrateLegacyLayout,
  instantiateTemplate,
  starterDescription,
  normalizeGraphsEnvelope,
  normalizeLegacyGraph,
  normalizeLegacyEnvelope,
  uniqueGraphName,
  GRAPHS_KEY,
  TEMPLATES_KEY,
  LEGACY_LAYOUT_KEY,
} from '../src/flow/store-core.ts';
import { EDIT_RULE, RETIRED_STARTER_IDS, STARTER_TEMPLATES } from '../src/flow/templates.ts';
import { validateGraph, setLiveModelIds } from '../src/flow/validate.ts';

// Map-backed StorageLike stub — never touches window/localStorage (leaf-module rule, §7).
function mapStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

const NOW = '2026-09-25T00:00:00.000Z';

test('graphs envelope round-trips through a Map stub', () => {
  const storage = mapStorage();
  const graph = stampGraph({ nodes: [], edges: [] }, NOW);
  saveGraphsEnvelope(storage, { v: 1, activeGraphId: graph.id, graphs: [graph] });
  const loaded = loadGraphsEnvelope(storage);
  assert.deepEqual(loaded, { v: 1, activeGraphId: graph.id, graphs: [graph] });
});

test('templates envelope round-trips through a Map stub', () => {
  const storage = mapStorage();
  saveTemplatesEnvelope(storage, { v: 1, templates: STARTER_TEMPLATES });
  const loaded = loadTemplatesEnvelope(storage);
  assert.deepEqual(loaded, { v: 1, templates: STARTER_TEMPLATES });
});

test('loadGraphsEnvelope: absent key is null', () => {
  assert.equal(loadGraphsEnvelope(mapStorage()), null);
});

test('loadGraphsEnvelope: unparsable JSON is null, not a throw', () => {
  const storage = mapStorage({ [GRAPHS_KEY]: '{not json' });
  assert.equal(loadGraphsEnvelope(storage), null);
});

test('loadGraphsEnvelope: v mismatch is treated as absent', () => {
  const storage = mapStorage({ [GRAPHS_KEY]: JSON.stringify({ v: 2, activeGraphId: null, graphs: [] }) });
  assert.equal(loadGraphsEnvelope(storage), null);
});

test('loadTemplatesEnvelope: v mismatch is treated as absent', () => {
  const storage = mapStorage({ [TEMPLATES_KEY]: JSON.stringify({ v: 0, templates: [] }) });
  assert.equal(loadTemplatesEnvelope(storage), null);
});

test('stampGraph: fills missing id/name/updatedAt, never overwrites present ones', () => {
  const stamped = stampGraph({ nodes: [], edges: [] }, NOW);
  assert.ok(stamped.id.length > 0);
  assert.equal(stamped.name, 'Untitled flow');
  assert.equal(stamped.updatedAt, NOW);

  const kept = stampGraph({ id: 'g1', name: 'Mine', updatedAt: '1999-01-01T00:00:00.000Z', nodes: [], edges: [] }, NOW);
  assert.equal(kept.id, 'g1');
  assert.equal(kept.name, 'Mine');
  assert.equal(kept.updatedAt, '1999-01-01T00:00:00.000Z');
});

test('migrateLegacyLayout: nodes/edges preserved, named "Legacy layout"', () => {
  const layout = { nodes: [{ id: 'a', kind: 'trigger', title: 'A', x: 0, y: 0, fields: [], inputs: [], outputs: ['out'] }], edges: [] };
  const graph = migrateLegacyLayout(layout, NOW);
  assert.equal(graph.name, 'Legacy layout');
  assert.equal(graph.updatedAt, NOW);
  assert.deepEqual(graph.nodes, layout.nodes);
  assert.deepEqual(graph.edges, layout.edges);
  assert.ok(graph.id.length > 0);
});

test('seedGraphsIfAbsent: migrates an existing legacy layout key into one graph', () => {
  const layout = { nodes: [{ id: 'a', kind: 'trigger', title: 'A', x: 0, y: 0, fields: [], inputs: [], outputs: ['out'] }], edges: [] };
  const storage = mapStorage({ [LEGACY_LAYOUT_KEY]: JSON.stringify(layout) });
  const env = seedGraphsIfAbsent(storage, NOW);
  assert.equal(env.graphs.length, 1);
  assert.equal(env.graphs[0].name, 'Legacy layout');
  assert.equal(env.activeGraphId, env.graphs[0].id);
});

test('seedGraphsIfAbsent: no legacy layout key starts empty, not MOCK_GRAPH', () => {
  const env = seedGraphsIfAbsent(mapStorage(), NOW);
  assert.deepEqual(env, { v: 1, activeGraphId: null, graphs: [] });
});

test('seedTemplatesIfAbsent: seeds defaults when the key is absent, and writes them', () => {
  const storage = mapStorage();
  const result = seedTemplatesIfAbsent(storage, STARTER_TEMPLATES);
  assert.deepEqual(result, STARTER_TEMPLATES);
  assert.deepEqual(loadTemplatesEnvelope(storage), { v: 1, templates: STARTER_TEMPLATES });
});

test('seedTemplatesIfAbsent: leaves an existing templates key alone', () => {
  const custom = [{ id: 'custom', name: 'Custom', graph: { name: 'Custom', nodes: [], edges: [] } }];
  const storage = mapStorage({ [TEMPLATES_KEY]: JSON.stringify({ v: 1, templates: custom }) });
  const result = seedTemplatesIfAbsent(storage, STARTER_TEMPLATES);
  assert.deepEqual(result, custom);
});

test('reseedStarters: replaces starters by id, keeps user templates, appends missing, runs once', () => {
  const custom = { id: 'custom', name: 'Custom', graph: { name: 'Custom', nodes: [], edges: [] } };
  const oldStarter = { ...STARTER_TEMPLATES[0], name: 'Old layout' };
  const storage = mapStorage();
  const result = reseedStarters(storage, [oldStarter, custom], STARTER_TEMPLATES, 2);
  assert.deepEqual(result, [STARTER_TEMPLATES[0], custom, ...STARTER_TEMPLATES.slice(1)]);
  assert.deepEqual(loadTemplatesEnvelope(storage), { v: 1, templates: result });
  assert.equal(storage.getItem(STARTERS_REV_KEY), '2');
  // same rev again: stored edits to a starter survive
  const edited = [{ ...STARTER_TEMPLATES[0], name: 'Edited' }];
  assert.equal(reseedStarters(storage, edited, STARTER_TEMPLATES, 2), edited);
});

test('reseedStarters: a retired starter id leaves storage at rev 9, user templates stay', () => {
  const custom = { id: 'custom', name: 'Custom', graph: { name: 'Custom', nodes: [], edges: [] } };
  const bench = { id: 'tpl-codex-mcp-ab', name: 'Codex MCP A/B Bench', graph: { name: 'Bench', nodes: [], edges: [] } };
  const storage = mapStorage({ [STARTERS_REV_KEY]: '8' });
  const result = reseedStarters(storage, [bench, custom], STARTER_TEMPLATES, 9, RETIRED_STARTER_IDS);
  assert.ok(!result.some((t) => t.id === 'tpl-codex-mcp-ab'));
  assert.ok(result.some((t) => t.id === 'custom'));
  assert.ok(!loadTemplatesEnvelope(storage).templates.some((t) => t.id === 'tpl-codex-mcp-ab'));
  assert.equal(storage.getItem(STARTERS_REV_KEY), '9');
});

test('instantiateTemplate: keeps node ids, mints a fresh graph id, deep-copies', () => {
  for (const template of STARTER_TEMPLATES) {
    const graph = instantiateTemplate(template, NOW);
    assert.equal(graph.updatedAt, NOW);
    assert.notEqual(graph.id, template.id);
    assert.deepEqual(graph.nodes.map((n) => n.id), template.graph.nodes.map((n) => n.id));
    assert.deepEqual(graph.edges, template.graph.edges);
    // deep copy: mutating the instantiated graph must not touch the template literal, including
    // fieldSpecs/inputs/an edge endpoint — a hand-copy that only cloned fields/addons left these
    // shared with the template stored in S.templates.
    graph.nodes[0].fields.push({ k: 'x', v: 'y' });
    assert.notDeepEqual(graph.nodes[0].fields, template.graph.nodes[0].fields);
    if (graph.nodes[0].fieldSpecs) {
      graph.nodes[0].fieldSpecs[0].kind = 'number';
      assert.notEqual(graph.nodes[0].fieldSpecs[0].kind, template.graph.nodes[0].fieldSpecs[0].kind);
    }
    graph.nodes[0].inputs.push('extra');
    assert.notDeepEqual(graph.nodes[0].inputs, template.graph.nodes[0].inputs);
    graph.edges[0].from.node = 'mutated';
    assert.notEqual(graph.edges[0].from.node, template.graph.edges[0].from.node);
  }
});

test('normalizeGraphsEnvelope: drops malformed entries, stamps survivors, resolves a dangling activeGraphId', () => {
  const good = { id: 'g1', name: 'Good', nodes: [], edges: [], updatedAt: '1999-01-01T00:00:00.000Z' };
  const missingId = { name: 'No id', nodes: [], edges: [] };
  const notAGraph = { id: 'g2', name: 'Bad', nodes: 'not-an-array', edges: [] };
  const env = { v: 1, activeGraphId: 'does-not-exist', graphs: [good, missingId, notAGraph] };
  const normalized = normalizeGraphsEnvelope(env, NOW);

  assert.equal(normalized.graphs.length, 2);
  assert.deepEqual(normalized.graphs[0], good); // already-stamped values are kept as-is
  assert.ok(normalized.graphs[1].id.length > 0);
  assert.equal(normalized.graphs[1].name, 'No id');
  assert.equal(normalized.graphs[1].updatedAt, NOW);
  // dangling activeGraphId falls back to the first surviving graph
  assert.equal(normalized.activeGraphId, normalized.graphs[0].id);
});

test('normalizeGraphsEnvelope: no surviving graphs resolves activeGraphId to null', () => {
  const env = { v: 1, activeGraphId: 'ghost', graphs: [{ id: 'x', name: 'Bad', nodes: null, edges: [] }] };
  const normalized = normalizeGraphsEnvelope(env, NOW);
  assert.deepEqual(normalized.graphs, []);
  assert.equal(normalized.activeGraphId, null);
});

test('readGraphsEnvelope + backupInvalidEnvelope: an invalid key going through the seed path leaves a backup holding the original raw text', () => {
  const rawInvalid = '{not json';
  const storage = mapStorage({ [GRAPHS_KEY]: rawInvalid });

  const read = readGraphsEnvelope(storage);
  assert.equal(read.status, 'invalid');
  assert.equal(read.raw, rawInvalid);

  backupInvalidEnvelope(storage, GRAPHS_KEY, read.raw, NOW);
  const env = seedGraphsIfAbsent(storage, NOW); // the seed path that would otherwise overwrite silently
  saveGraphsEnvelope(storage, env);

  const backupKey = [...storage._map.keys()].find((k) => k.startsWith(`${GRAPHS_KEY}.bak-`));
  assert.ok(backupKey, 'expected a backup key to exist');
  assert.equal(storage._map.get(backupKey), rawInvalid);
  // the live key itself is now the freshly-seeded (empty) envelope, not the invalid raw text
  assert.notEqual(storage.getItem(GRAPHS_KEY), rawInvalid);
});

test('readGraphsEnvelope: an absent key needs no backup', () => {
  const storage = mapStorage();
  const read = readGraphsEnvelope(storage);
  assert.equal(read.status, 'absent');
  assert.equal(read.raw, null);
});

test('migrateLegacyLayout: backfills addon.value from label when a legacy addon lacks one', () => {
  const layout = {
    nodes: [
      {
        id: 'a', kind: 'trigger', title: 'A', x: 0, y: 0, fields: [], inputs: [], outputs: ['out'],
        addons: [{ kind: 'rule', label: 'Some Rule' }],
      },
    ],
    edges: [],
  };
  const graph = migrateLegacyLayout(layout, NOW);
  assert.equal(graph.nodes[0].addons[0].value, 'Some Rule');
});

// Same regex as §4.2 (own copy — leaf modules cannot import each other's copy under node --test).
const PLACEHOLDER_RE = /\{\{([a-z0-9_-]+)\}\}/g;
const ID_CHARSET_RE = /^[a-z][a-z0-9_-]*$/;

/** Walks `graph.edges` from the node with no incoming edge, following `from -> to`, and returns
 *  the ids in visit order. Asserts the graph is a straight chain on the way (every node visited
 *  exactly once, in/out-degree <= 1) rather than trusting `nodes` array order for "upstream" —
 *  a `nodes` reorder or a miswired `chainEdges` would pass silently either way. */
function walkChain(graph) {
  const outDegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const inDegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const nextOf = new Map();
  for (const e of graph.edges) {
    outDegree.set(e.from.node, (outDegree.get(e.from.node) ?? 0) + 1);
    inDegree.set(e.to.node, (inDegree.get(e.to.node) ?? 0) + 1);
    nextOf.set(e.from.node, e.to.node);
  }
  for (const n of graph.nodes) {
    assert.ok((outDegree.get(n.id) ?? 0) <= 1, `${n.id}: out-degree > 1, not a chain`);
    assert.ok((inDegree.get(n.id) ?? 0) <= 1, `${n.id}: in-degree > 1, not a chain`);
  }
  const starts = graph.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  assert.equal(starts.length, 1, 'expected exactly one chain start (no incoming edge)');
  const order = [];
  let cur = starts[0].id;
  while (cur !== undefined) {
    assert.ok(!order.includes(cur), `${cur}: visited twice, graph is not a simple chain`);
    order.push(cur);
    cur = nextOf.get(cur);
  }
  assert.equal(order.length, graph.nodes.length, 'chain walk did not visit every node');
  return order;
}

test('every starter-template node id matches the §2 charset', () => {
  for (const template of STARTER_TEMPLATES) {
    for (const node of template.graph.nodes) {
      assert.match(node.id, ID_CHARSET_RE, `${template.id}/${node.id}: id fails the charset`);
    }
  }
});

test('every starter-template placeholder names an upstream node id, walked from the chain\'s edges', () => {
  for (const template of STARTER_TEMPLATES) {
    const order = walkChain(template.graph);
    for (let i = 0; i < order.length; i++) {
      const node = template.graph.nodes.find((n) => n.id === order[i]);
      const task = node.fields.find((f) => f.k === 'task')?.v;
      if (task === undefined) continue;
      const upstream = new Set(order.slice(0, i));
      const refs = [...task.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
      assert.ok(refs.length > 0, `${template.id}/${node.id}: task has no placeholders`);
      for (const ref of refs) {
        assert.ok(upstream.has(ref), `${template.id}/${node.id}: {{${ref}}} is not an upstream node id`);
      }
    }
  }
});

// Frozen per §6's table — model/preset drift on an agent node should fail here, not by eye.
const EXPECTED_AGENT_NODES = {
  'tpl-plan-review-revise-execute-academy': [
    { id: 'plan', preset: 'plan', model: 'claude-opus-5-5' },
    { id: 'review', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'revise', preset: 'revise', model: 'claude-sonnet-5' },
    { id: 'execute', preset: 'execute', model: 'claude-sonnet-5' },
    { id: 'academy', preset: 'academy', model: 'claude-sonnet-5' },
  ],
  'tpl-brainstorm-format-review-execute': [
    { id: 'format', preset: 'brainstorm-format', model: 'claude-sonnet-5' },
    { id: 'review', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'execute', preset: 'execute', model: 'claude-sonnet-5' },
  ],
  // linear starter set: each ends in analyze
  'tpl-planned-implementation': [
    { id: 'plan', preset: 'plan', model: 'claude-opus-5-5' },
    { id: 'review', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'revise', preset: 'revise', model: 'claude-sonnet-5' },
    { id: 'execute', preset: 'execute', model: 'claude-sonnet-5' },
    { id: 'verify', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'analyze', preset: 'academy', model: 'claude-sonnet-5' },
  ],
  'tpl-diagnose-and-fix': [
    { id: 'investigate', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'diagnose', preset: 'custom', model: 'claude-opus-5-5' },
    { id: 'review-fix', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'execute', preset: 'execute', model: 'claude-sonnet-5' },
    { id: 'verify', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'analyze', preset: 'academy', model: 'claude-sonnet-5' },
  ],
  'tpl-idea-to-brief': [
    { id: 'organize', preset: 'brainstorm-format', model: 'claude-sonnet-5' },
    { id: 'challenge', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'refine', preset: 'revise', model: 'claude-sonnet-5' },
    { id: 'brief', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'analyze', preset: 'academy', model: 'claude-sonnet-5' },
  ],
  'tpl-research-and-decide': [
    { id: 'frame', preset: 'custom', model: 'claude-opus-5-5' },
    { id: 'gather', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'compare', preset: 'custom', model: 'claude-opus-5-5' },
    { id: 'recommend', preset: 'custom', model: 'claude-opus-5-5' },
    { id: 'analyze', preset: 'academy', model: 'claude-sonnet-5' },
  ],
  'tpl-bounded-review': [
    { id: 'scope', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'inspect', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'challenge', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'report', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'analyze', preset: 'academy', model: 'claude-sonnet-5' },
  ],
  'tpl-handoff-and-resume': [
    { id: 'gather', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'reconcile', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'handoff', preset: 'custom', model: 'claude-sonnet-5' },
    { id: 'check', preset: 'review', model: 'claude-opus-5-5' },
    { id: 'analyze', preset: 'academy', model: 'claude-sonnet-5' },
  ],
};

test('starter templates match the §6 model/preset table exactly', () => {
  for (const template of STARTER_TEMPLATES) {
    const actual = template.graph.nodes
      .filter((n) => n.kind === 'agent')
      .map((n) => ({ id: n.id, preset: n.fields.find((f) => f.k === 'preset')?.v, model: n.model }));
    assert.deepEqual(actual, EXPECTED_AGENT_NODES[template.id], `${template.id}: agent nodes drifted from §6`);
  }
});

// ---- legacy kind normalisation (normalizeLegacyGraph / normalizeLegacyEnvelope) ----

/** The pre-v1 MOCK_GRAPH shape (git show 7ce42e9:src/flow/model.ts), as migrateLegacyLayout
 *  stored it: trigger → agent → tool → review → output, legacy addons with value backfilled. */
function legacyMockGraph() {
  const layout = {
    nodes: [
      { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 0, y: 0, fields: [{ k: 'source', v: 'docs/inbox/*.md' }], inputs: [], outputs: ['out'] },
      {
        id: 'agent', kind: 'agent', title: 'Agent', x: 0, y: 200, inputs: ['in'], outputs: ['out'],
        fields: [{ k: 'profile', v: 'Striker' }, { k: 'model', v: 'sonnet' }, { k: 'brief', v: 'settled by the launcher' }],
        addons: [
          { kind: 'skill', label: 'adversarial-diff-review' },
          { kind: 'effort', label: 'medium' },
          { kind: 'model', label: 'sonnet' },
          { kind: 'rule', label: 'rendered-panel.md' },
        ],
      },
      {
        id: 'tool', kind: 'tool', title: 'Tool', x: 0, y: 400, inputs: ['in'], outputs: ['out'],
        fields: [{ k: 'command', v: 'npm run build' }], addons: [{ kind: 'hook', label: 'guard-crawl' }],
      },
      {
        id: 'review', kind: 'review', title: 'Review', x: 0, y: 600, inputs: ['in'], outputs: ['out'],
        fields: [{ k: 'profile', v: 'Orion' }, { k: 'model', v: 'opus' }],
        addons: [{ kind: 'effort', label: 'high' }, { kind: 'model', label: 'opus' }, { kind: 'permission', label: 'read-only' }],
      },
      { id: 'output', kind: 'output', title: 'Output', x: 0, y: 800, fields: [{ k: 'message', v: 'flow: mock' }], inputs: ['in'], outputs: [] },
    ],
    edges: [
      { id: 'e1', from: { node: 'trigger', port: 'out' }, to: { node: 'agent', port: 'in' } },
      { id: 'e2', from: { node: 'agent', port: 'out' }, to: { node: 'tool', port: 'in' } },
      { id: 'e3', from: { node: 'tool', port: 'out' }, to: { node: 'review', port: 'in' } },
      { id: 'e4', from: { node: 'review', port: 'out' }, to: { node: 'output', port: 'in' } },
    ],
  };
  return migrateLegacyLayout(layout, NOW);
}

test('normalizeLegacyGraph: every node ends up a v1 kind, every addon a v1 addon kind', () => {
  const { graph, changed } = normalizeLegacyGraph(legacyMockGraph());
  assert.equal(changed, true);
  assert.deepEqual(graph.nodes.map((n) => n.kind), ['input', 'agent', 'agent', 'output']);
  for (const n of graph.nodes) {
    for (const a of n.addons ?? []) assert.ok(['permission-allowlist', 'system-prompt', 'cwd', 'retries'].includes(a.kind), a.kind);
  }
});

test('normalizeLegacyGraph: trigger becomes the "input" node and edges follow; tool is bridged out', () => {
  const { graph } = normalizeLegacyGraph(legacyMockGraph());
  assert.ok(graph.nodes.some((n) => n.id === 'input' && n.kind === 'input'));
  assert.ok(!graph.nodes.some((n) => n.id === 'tool'));
  const pairs = graph.edges.map((e) => `${e.from.node}>${e.to.node}`).sort();
  assert.deepEqual(pairs, ['agent>review', 'input>agent', 'review>output']);
});

test('normalizeLegacyGraph: model addon/field → node.model, permission → permission-allowlist', () => {
  const { graph } = normalizeLegacyGraph(legacyMockGraph());
  const agent = graph.nodes.find((n) => n.id === 'agent');
  const review = graph.nodes.find((n) => n.id === 'review');
  assert.equal(agent.model, 'claude-sonnet-5');
  assert.equal(review.model, 'claude-opus-5-5');
  assert.ok(!agent.fields.some((f) => f.k === 'model'));
  assert.deepEqual(review.addons, [{ kind: 'permission-allowlist', label: 'Read,Grep,Glob', value: 'Read,Grep,Glob' }]);
  assert.equal(review.fields.find((f) => f.k === 'preset')?.v, 'review');
  assert.ok(review.fieldSpecs.some((s) => s.k === 'task' && s.required));
  // user content kept as fields, never turned into invented task text
  assert.equal(agent.fields.find((f) => f.k === 'task')?.v, '');
  assert.equal(agent.fields.find((f) => f.k === 'brief')?.v, 'settled by the launcher');
});

test('normalizeLegacyGraph: every dropped addon/node is recorded with its text', () => {
  const g = legacyMockGraph();
  const { drops } = normalizeLegacyGraph(g);
  const got = drops.map((d) => `${d.nodeId}:${d.what}:${d.kind}:${d.text.split('\n')[0]}`).sort();
  assert.deepEqual(got, [
    'agent:addon:effort:medium',
    'agent:addon:rule:rendered-panel.md',
    'agent:addon:skill:adversarial-diff-review',
    'review:addon:effort:high',
    'tool:addon:hook:guard-crawl',
    'tool:node:tool:Tool',
  ]);
  assert.ok(drops.every((d) => d.graphId === g.id));
  assert.match(drops.find((d) => d.what === 'node').text, /command: npm run build/);
});

test('normalizeLegacyGraph: once its empty required fields are filled, the normalised graph validates', () => {
  const { graph } = normalizeLegacyGraph(legacyMockGraph());
  graph.nodes.find((n) => n.id === 'input').fields.find((f) => f.k === 'content').v = 'x';
  for (const id of ['agent', 'review']) graph.nodes.find((n) => n.id === id).fields.find((f) => f.k === 'task').v = 'do it';
  assert.deepEqual(validateGraph(graph).issues, []);
});

test('normalizeLegacyGraph: runs once — a second pass is a no-op', () => {
  const first = normalizeLegacyGraph(legacyMockGraph());
  const second = normalizeLegacyGraph(first.graph);
  assert.equal(second.changed, false);
  assert.equal(second.graph, first.graph);
  assert.deepEqual(second.drops, []);
});

test('instantiateTemplate: a no-Claude roster gives runnable nodes, the template keeps its models', () => {
  const wired = ['codex-default'];
  setLiveModelIds(() => wired);
  try {
    for (const template of STARTER_TEMPLATES) {
      const before = template.graph.nodes.map((n) => n.model);
      const graph = instantiateTemplate(template, NOW, wired);
      for (const n of graph.nodes) if (n.kind === 'agent') assert.equal(n.model, 'codex-default');
      assert.deepEqual(graph.nodes.map((n) => n.id), template.graph.nodes.map((n) => n.id));
      assert.deepEqual(template.graph.nodes.map((n) => n.model), before);
      // the input node's blank content is the user's to fill; only model issues matter here
      assert.deepEqual(validateGraph(graph).issues.filter((i) => /model/.test(i.message)), []);
    }
    // an available model is kept; an empty roster changes nothing
    const kept = instantiateTemplate(STARTER_TEMPLATES[0], NOW, ['claude-sonnet-5', 'claude-opus-5-5']);
    assert.deepEqual(kept.nodes.map((n) => n.model), STARTER_TEMPLATES[0].graph.nodes.map((n) => n.model));
    const none = instantiateTemplate(STARTER_TEMPLATES[0], NOW, []);
    assert.deepEqual(none.nodes.map((n) => n.model), STARTER_TEMPLATES[0].graph.nodes.map((n) => n.model));
  } finally {
    setLiveModelIds(null);
  }
});

test('starter descriptions follow the wired models and starter tasks use the runner-neutral edit rule', () => {
  const brainstorm = STARTER_TEMPLATES.find((template) => template.id === 'tpl-brainstorm-format-review-execute');
  const labels = {
    'codex-default': 'Codex Default',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-opus-5-5': 'Opus 5.5',
  };
  const modelLabel = (id) => labels[id] ?? id;
  assert.equal(starterDescription(brainstorm, ['codex-default'], modelLabel),
    'Format (Codex Default) → Review (Codex Default) → Execute (Codex Default)');
  assert.equal(starterDescription(brainstorm, ['claude-sonnet-5', 'claude-opus-5-5'], modelLabel),
    'Format (Sonnet 5) → Review (Opus 5.5) → Execute (Sonnet 5)');
  assert.equal(EDIT_RULE, 'Make file changes with your file-edit tool, not shell commands.');
  for (const template of STARTER_TEMPLATES) {
    const codexDescription = starterDescription(template, ['codex-default'], modelLabel);
    assert.match(codexDescription, /Codex Default/, template.id);
    assert.doesNotMatch(codexDescription, /Opus|Sonnet|Claude/, template.id);
    for (const node of template.graph.nodes) {
      if (node.kind !== 'agent') continue;
      const task = node.fields.find((field) => field.k === 'task')?.v ?? '';
      assert.doesNotMatch(task, /Edit\/Write/, `${template.id}/${node.id}`);
      if (node.id === 'execute') assert.ok(task.includes(EDIT_RULE), `${template.id}/${node.id}`);
    }
  }
});

test('normalizeLegacyGraph: a v1 graph (starter template) is untouched', () => {
  const g = instantiateTemplate(STARTER_TEMPLATES[0], NOW);
  const r = normalizeLegacyGraph(g);
  assert.equal(r.changed, false);
  assert.equal(r.graph, g);
});

test('normalizeLegacyEnvelope: rewrites an already-migrated graph stored in graphs.v1, leaves v1 graphs alone', () => {
  const legacy = legacyMockGraph();
  const v1 = instantiateTemplate(STARTER_TEMPLATES[0], NOW);
  const storage = mapStorage();
  saveGraphsEnvelope(storage, { v: 1, activeGraphId: legacy.id, graphs: [legacy, v1] });
  const { env, changed, drops } = normalizeLegacyEnvelope(loadGraphsEnvelope(storage));
  assert.equal(changed, true);
  assert.ok(drops.length > 0);
  assert.equal(env.graphs[0].nodes[0].kind, 'input');
  assert.deepEqual(env.graphs[1], v1);
  assert.equal(env.activeGraphId, legacy.id);
  assert.equal(normalizeLegacyEnvelope(env).changed, false);
});

test('uniqueGraphName: free name kept, collisions take " 2", then the next free suffix', () => {
  assert.equal(uniqueGraphName('Plan', ['Build']), 'Plan');
  assert.equal(uniqueGraphName('Plan', ['Plan']), 'Plan 2');
  assert.equal(uniqueGraphName('Plan', ['Plan', 'Plan 2', 'Plan 3']), 'Plan 4');
  assert.equal(uniqueGraphName('Plan', ['Plan', 'Plan 3']), 'Plan 2');
});
