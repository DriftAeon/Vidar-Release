// Pure MCP rack identity, cache, and saved-order migration contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRackProject,
  rackServerId,
  rackToolsKey,
  dedupeRackServers,
  reconcileRackOrder,
} from '../src/panels/rack-modules.ts';

const server = (overrides = {}) => ({
  name: 'rider',
  scope: 'project',
  transport: 'stdio',
  target: 'rider-mcp',
  args: ['--stdio'],
  envKeys: [],
  project: 'C:/Work/One',
  ...overrides,
});

test('canonical IDs encode scope, normalized project, and name', () => {
  const one = server({ name: 'rider:tools', project: 'C:\\Work\\One\\' });
  const otherProject = server({ name: 'rider:tools', project: 'C:/Work/Two' });

  assert.equal(normalizeRackProject(one.project), 'c:/work/one');
  assert.equal(rackServerId(one), 'rack:server:project:c%3A%2Fwork%2Fone:rider%3Atools');
  assert.equal(rackServerId(one), rackServerId(server({ name: 'rider:tools' })));
  assert.notEqual(rackServerId(one), rackServerId(otherProject));
  assert.equal(rackServerId(server({ scope: 'user', project: null })), 'rack:server:user:rider');
  assert.equal(rackServerId(server({ scope: 'user', project: 'C:/Other' })), 'rack:server:user:rider');
  assert.equal(rackServerId(server({ scope: 'codex', project: null })), 'rack:server:codex:rider');
  assert.equal(rackToolsKey(server({ scope: 'codex', project: null })),
    rackToolsKey(server({ scope: 'codex', project: 'ignored' })));
});

test('every local or project tools cache identity includes normalized project', () => {
  for (const transport of ['stdio', 'http']) {
    const base = server({ scope: 'local', transport, target: transport === 'http' ? 'http://localhost:8399' : 'rider-mcp' });
    assert.equal(
      rackToolsKey(base),
      rackToolsKey({ ...base, project: 'c:\\WORK\\ONE\\' }),
      `${transport} should share a cache entry for equivalent project spellings`,
    );
    assert.notEqual(
      rackToolsKey(base),
      rackToolsKey({ ...base, project: 'C:/Work/Two' }),
      `${transport} must separate projects`,
    );
  }
  assert.notEqual(rackToolsKey(server()), rackToolsKey(server({ scope: 'project', project: 'C:/Work/Two' })));
});

test('duplicate reader rows retain their first object', () => {
  const first = server({ disabled: false });
  const duplicate = server({ project: 'c:\\work\\one\\', disabled: true });
  const secondProject = server({ project: 'C:/Work/Two' });

  assert.deepEqual(dedupeRackServers([first, duplicate, secondProject]), [first, secondProject]);
});

test('unique bare and scoped legacy hints migrate to canonical IDs', () => {
  const rider = server();
  const unreal = server({ name: 'unreal', scope: 'user', project: null });

  assert.deepEqual(reconcileRackOrder(['rider', 'user:unreal'], [rider, unreal]), [
    rackServerId(rider),
    rackServerId(unreal),
  ]);
});

test('ambiguous and absent legacy hints remain dormant', () => {
  const one = server();
  const two = server({ project: 'C:/Work/Two' });
  const user = server({ scope: 'user', project: null });

  assert.deepEqual(reconcileRackOrder(['rider', 'project:rider', 'missing', 'user:missing'], [one, two, user]), [
    'rider',
    'project:rider',
    'missing',
    'user:missing',
  ]);
});

test('saved duplicate canonical IDs and colliding migrated hints keep the first', () => {
  const rider = server();
  const id = rackServerId(rider);

  assert.deepEqual(reconcileRackOrder([id, id, 'rider', 'project:rider'], [rider]), [id]);
  assert.deepEqual(reconcileRackOrder(['rider', id, 'project:rider'], [rider]), [id]);
});
