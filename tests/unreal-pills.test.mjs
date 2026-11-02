// src/unreal/pills.ts: pill and pin mapping for the Unreal tab head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pillViews, pinView } from '../src/unreal/pills.ts';

const mcp = (e, r, l) => ({ editorMcp: e, riderMcp: r, riderLink: l });

test('pill labels, signals and tooltips', () => {
  const [ed, ri, link] = pillViews(mcp(
    { up: true, reason: 'live' }, { up: false, reason: 'Proxy Unreachable' }, { up: false, reason: '' },
  ));
  assert.deepEqual([ed.label, ed.signal, ed.tooltip], ['Editor MCP Up', 'ok', 'Editor MCP Up: live']);
  assert.deepEqual([ri.label, ri.signal, ri.tooltip], ['Rider MCP Down', 'alert', 'Rider MCP Down: Proxy Unreachable']);
  assert.deepEqual([link.label, link.tooltip], ['RiderLink Not Connected', 'RiderLink Not Connected']);
  const up = { up: true, reason: '' };
  assert.equal(pillViews(mcp(up, up, up))[2].label, 'RiderLink Connected');
});

test('pillViews omits a null riderLink and a null result', () => {
  const p = { up: true, reason: '' };
  assert.equal(pillViews(null).length, 0);
  assert.equal(pillViews(mcp(p, p, null)).length, 2);
  assert.equal(pillViews(mcp(p, p, p)).length, 3);
});

test('pinView', () => {
  assert.equal(pinView(null).label, 'No Engine Pinned');
  const v = pinView({ root: 'r', uproject: 'u', engine: 'C:\\UE\\5.8', engineVersion: '5.8.2', pinnedAt: 1 });
  assert.deepEqual([v.label, v.tooltip, v.pinned], ['Engine 5.8.2', 'C:\\UE\\5.8', true]);
});
