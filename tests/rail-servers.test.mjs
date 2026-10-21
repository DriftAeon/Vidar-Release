// One rail button per MCP server: URL dedupe, the button title, and the button list.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeRackServers,
  rackServerId,
  rackUrlKey,
  railServers,
  serverTitle,
} from '../src/panels/rack-modules.ts';

const http = (name, scope, target, project = null) => ({
  name, scope, transport: 'http', target, args: [], envKeys: [], project,
});

test('Claude and Codex rows for one URL dedupe to one entry', () => {
  const claude = http('proxy', 'user', 'http://127.0.0.1:8399/mcp');
  const codex = http('proxy', 'codex', 'HTTP://127.0.0.1:8399/mcp/');
  assert.equal(rackUrlKey(claude), rackUrlKey(codex));
  assert.deepEqual(dedupeRackServers([claude, codex]), [claude]);
});

test('a user and a project row for the proxy URL keep the first', () => {
  const project = http('proxy', 'project', 'http://127.0.0.1:8399/mcp', 'D:/work/game');
  const user = http('proxy', 'user', 'http://127.0.0.1:8399/mcp');
  assert.deepEqual(dedupeRackServers([project, user]), [project]);
});

test('URL key folds scheme, host and port only, and trims a trailing slash', () => {
  assert.equal(rackUrlKey(http('a', 'user', 'HTTP://LocalHost:64482/Stream/')), 'http://localhost:64482/Stream');
  assert.notEqual(rackUrlKey(http('a', 'user', 'http://h/A')), rackUrlKey(http('b', 'user', 'http://h/a')));
  const stdio = { name: 's', scope: 'user', transport: 'stdio', target: 'node', args: ['x'], envKeys: [], project: null };
  assert.equal(rackUrlKey(stdio), null);
});

test('server titles split camelCase, - and _, keeping OpenAI whole', () => {
  assert.equal(serverTitle('openaiDeveloperDocs'), 'OpenAI Developer Docs');
  assert.equal(serverTitle('rider'), 'Rider');
  assert.equal(serverTitle('my-server'), 'My Server');
  assert.equal(serverTitle('some_tool'), 'Some Tool');
});

test('the button list collapses the proxy into Proxy MCP and orders the rest by saved order', () => {
  const docs = http('openaiDeveloperDocs', 'codex', 'https://developers.openai.com/mcp');
  const proxy = http('proxy', 'codex', 'http://127.0.0.1:8399/mcp');
  const proxyAgain = http('proxyCopy', 'codex', 'http://127.0.0.1:8399/mcp/');
  const rider = http('rider', 'codex', 'http://127.0.0.1:64482/stream');
  const misc = http('my-server', 'codex', 'http://127.0.0.1:9000/mcp');
  const saved = [rackServerId(rider), 'lmstudio', rackServerId(docs)];
  const list = railServers([docs, proxy, proxyAgain, misc, rider], saved);
  assert.equal(list.proxy?.id, rackServerId(proxy));
  assert.deepEqual(list.others.map((e) => [e.title, e.icon]), [
    ['Rider', 'rider'],
    ['OpenAI Developer Docs', 'openai'],
    ['My Server', 'link'],
  ]);
});

test('servers with a brand mark in the icon manifest use it, not the link', () => {
  const list = railServers([
    http('notion', 'user', 'https://mcp.notion.com/mcp'),
    http('atlassian', 'user', 'https://mcp.atlassian.com/v1/mcp'),
    http('Slack', 'user', 'https://mcp.slack.com/mcp'),
  ], []);
  assert.deepEqual(list.others.map((e) => e.icon).sort(), ['jira', 'notion', 'slack']);
});

test('a proxy-URL row under another name still maps to Proxy MCP', () => {
  const renamed = http('gateway', 'user', 'http://127.0.0.1:8399/mcp');
  const list = railServers([renamed], []);
  assert.equal(list.proxy?.id, rackServerId(renamed));
  assert.deepEqual(list.others, []);
});
