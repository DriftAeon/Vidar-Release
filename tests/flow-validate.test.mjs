import test from 'node:test';
import assert from 'node:assert/strict';
import { setPackModelIds, validateGraph } from '../src/flow/validate.ts';

const NOW = '2026-09-25T00:00:00.000Z';

function graph(nodes, edges) {
  return { id: 'g1', name: 'g', nodes, edges, updatedAt: NOW };
}

function input(overrides = {}) {
  return {
    id: 'input',
    kind: 'input',
    title: 'Input',
    x: 0,
    y: 0,
    fields: [
      { k: 'shape', v: 'free-text' },
      { k: 'content', v: 'hello' },
    ],
    fieldSpecs: [
      { k: 'shape', required: true, kind: 'select', options: ['free-text', 'structured'] },
      { k: 'content', required: true, kind: 'text' },
    ],
    inputs: [],
    outputs: ['out'],
    ...overrides,
  };
}

function agent(id, task, overrides = {}) {
  return {
    id,
    kind: 'agent',
    title: id,
    x: 0,
    y: 0,
    model: 'claude-sonnet-5',
    fields: [{ k: 'task', v: task }],
    fieldSpecs: [{ k: 'task', required: true, kind: 'text' }],
    inputs: ['in'],
    outputs: ['out'],
    ...overrides,
  };
}

function output(overrides = {}) {
  return { id: 'output', kind: 'output', title: 'Output', x: 0, y: 0, fields: [], inputs: ['in'], outputs: [], ...overrides };
}

function edge(id, fromNode, toNode) {
  return { id, from: { node: fromNode, port: 'out' }, to: { node: toNode, port: 'in' } };
}

function straightChain(taskText = 'do the thing') {
  return graph(
    [input(), agent('agent-1', taskText), output()],
    [edge('e1', 'input', 'agent-1'), edge('e2', 'agent-1', 'output')],
  );
}

test('valid straight chain passes with no issues', () => {
  const result = validateGraph(straightChain('Do the thing with {{input}}'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.invalidNodeIds.size, 0);
});

test('agent: an Input to Output chain with no Agent is rejected', () => {
  const g = graph([input(), output()], [edge('e1', 'input', 'output')]);
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('at least one Agent')));
});

test('agent: a chain with one Agent passes', () => {
  assert.equal(validateGraph(straightChain()).valid, true);
});

test('cwd: relative, drive-relative and incomplete UNC paths are rejected', () => {
  for (const bad of ['project', '.\\project', 'C:project', '\\\\server', '\\\\server\\', '/tmp/x']) {
    const g = straightChain();
    g.nodes[1].addons = [{ kind: 'cwd', label: 'Cwd', value: bad }];
    const result = validateGraph(g);
    assert.equal(result.valid, false, bad);
    assert.ok(result.issues.some((i) => i.message.includes('absolute Windows directory')), bad);
  }
});

test('cwd: drive-rooted and UNC directories pass', () => {
  for (const good of ['C:\\work\\proj', 'D:/work/proj', 'C:\\', '\\\\server\\share', '\\\\server\\share\\dir']) {
    const g = straightChain();
    g.nodes[1].addons = [{ kind: 'cwd', label: 'Cwd', value: good }];
    assert.equal(validateGraph(g).valid, true, good);
  }
});

test('required field: empty required field fails and names the node', () => {
  const g = straightChain();
  g.nodes[0].fields[1].v = ''; // content is required
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.invalidNodeIds.has('input'));
  assert.ok(result.issues.some((i) => i.message.includes('required field "content"')));
});

test('required field: agent node with no model fails', () => {
  const g = straightChain();
  delete g.nodes[1].model;
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.invalidNodeIds.has('agent-1'));
  assert.ok(result.issues.some((i) => i.message.includes('no model selected')));
});

test('topology: a branch (two outgoing edges) is rejected', () => {
  const g = graph(
    [input(), agent('agent-1', 'a'), agent('agent-2', 'b'), output()],
    [edge('e1', 'input', 'agent-1'), edge('e2', 'input', 'agent-2'), edge('e3', 'agent-1', 'output'), edge('e4', 'agent-2', 'output')],
  );
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('branch')));
});

test('topology: an orphan node not wired into the chain is rejected', () => {
  const g = graph(
    [input(), agent('agent-1', 'a'), agent('orphan', 'b'), output()],
    [edge('e1', 'input', 'agent-1'), edge('e2', 'agent-1', 'output')],
  );
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.invalidNodeIds.has('orphan'));
  assert.ok(result.issues.some((i) => i.message.includes('not connected into the chain')));
});

test('topology: not exactly one input node is rejected', () => {
  const g = graph([input(), input({ id: 'input2' }), output()], []);
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('exactly one input node')));
});

test('topology: a cycle is rejected', () => {
  const g = graph(
    [input(), agent('a', 'x'), agent('b', 'y'), output()],
    [edge('e1', 'input', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a'), edge('e4', 'b', 'output')],
  );
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('cycle') || i.message.includes('cannot merge')));
});

test('{{ref}}: a reference to {{input}} resolves when the input node has id "input"', () => {
  const result = validateGraph(straightChain('Use {{input}} please'));
  assert.equal(result.valid, true);
});

test('{{ref}}: a reference to an unknown node id is rejected', () => {
  const result = validateGraph(straightChain('Use {{nope}} please'));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('unknown node')));
});

test('{{ref}}: a self-reference is rejected', () => {
  const result = validateGraph(straightChain('Use {{agent-1}} please'));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('references itself')));
});

test('{{ref}}: a forward reference (downstream node) is rejected', () => {
  const g = graph(
    [input(), agent('first', 'refers to {{second}}'), agent('second', 'ok'), output()],
    [edge('e1', 'input', 'first'), edge('e2', 'first', 'second'), edge('e3', 'second', 'output')],
  );
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.nodeId === 'first' && i.message.includes('not upstream')));
});

test('{{ref}}: a reference to a true upstream node resolves', () => {
  const g = graph(
    [input(), agent('first', 'a'), agent('second', 'refers to {{first}}'), output()],
    [edge('e1', 'input', 'first'), edge('e2', 'first', 'second'), edge('e3', 'second', 'output')],
  );
  const result = validateGraph(g);
  assert.equal(result.valid, true);
});

test('addon: an addon with no value fails', () => {
  const g = straightChain();
  g.nodes[1].addons = [{ kind: 'cwd', label: 'Cwd', value: '' }];
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('modifier has no value')));
});

test('addon: retries outside 0-2 fails', () => {
  const g = straightChain();
  g.nodes[1].addons = [{ kind: 'retries', label: 'Retries', value: '3' }];
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('retries must be 0, 1 or 2')));
});

test('addon: retries of 0, 1 or 2 passes', () => {
  const g = straightChain();
  g.nodes[1].addons = [{ kind: 'retries', label: 'Retries', value: '2' }];
  const result = validateGraph(g);
  assert.equal(result.valid, true);
});

test('structured content: valid JSON passes', () => {
  const g = straightChain();
  g.nodes[0].fields[0].v = 'structured';
  g.nodes[0].fields[1].v = '{"a":1}';
  const result = validateGraph(g);
  assert.equal(result.valid, true);
});

test('structured content: invalid JSON fails', () => {
  const g = straightChain();
  g.nodes[0].fields[0].v = 'structured';
  g.nodes[0].fields[1].v = '{not json}';
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('not valid JSON')));
});

test('kind whitelist: a reserved/legacy kind is rejected', () => {
  const g = straightChain();
  g.nodes.push({ id: 'gate-1', kind: 'gate', title: 'Gate', x: 0, y: 0, fields: [], inputs: [], outputs: [] });
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.message.includes('unsupported kind')));
});

test('model: an id no active module declares fails and names the model', () => {
  const g = straightChain();
  g.nodes[1].model = 'acme-large';
  setPackModelIds([]);
  const result = validateGraph(g);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.nodeId === 'agent-1' && i.message.includes('"acme-large"')));
  setPackModelIds(['acme-large']);
  assert.equal(validateGraph(g).valid, true);
  setPackModelIds([]);
});
