import test from 'node:test';
import assert from 'node:assert/strict';
import { routeOrthogonal, simplify, pathD } from '../src/flow/route.ts';

const box = (l, t, w, h) => ({ l, t, r: l + w, b: t + h });

/** true when the axis-aligned segment a-b passes through the open interior of rect r */
function crosses(a, b, r) {
  if (a.x === b.x) {
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return a.x > r.l && a.x < r.r && y1 > r.t && y0 < r.b;
  }
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  return a.y > r.t && a.y < r.b && x1 > r.l && x0 < r.r;
}

function assertOrthogonal(pts) {
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y, `segment ${i} is not axis-aligned`);
  }
}

function assertEndsDown(pts) {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  assert.equal(a.x, b.x, 'last segment is vertical');
  assert.ok(b.y > a.y, 'last segment runs downward');
}

test('routeOrthogonal: forward and aligned is one straight segment', () => {
  const pts = routeOrthogonal({ x: 120, y: 105 }, 'bottom', { x: 120, y: 200 }, 'top');
  assert.deepEqual(pts, [{ x: 120, y: 105 }, { x: 120, y: 200 }]);
  assert.equal(pathD(pts), 'M 120 105 L 120 200');
});

test('routeOrthogonal: forward and offset jogs once at mid-height, ends vertical-down', () => {
  const pts = routeOrthogonal({ x: 120, y: 100 }, 'bottom', { x: 400, y: 200 }, 'top');
  assert.deepEqual(pts, [{ x: 120, y: 100 }, { x: 120, y: 150 }, { x: 400, y: 150 }, { x: 400, y: 200 }]);
  assertEndsDown(pts);
});

test('routeOrthogonal: backward, cards overlapping in x, clears both boxes', () => {
  // source card below the target card, same column
  const A = box(0, 300, 240, 60); // source
  const B = box(16, 48, 240, 60); // target
  const src = { x: 120, y: A.b + 5 };
  const dst = { x: 136, y: B.t };
  const pts = routeOrthogonal(src, 'bottom', dst, 'top', { srcBox: A, dstBox: B });
  assertOrthogonal(pts);
  assertEndsDown(pts);
  assert.deepEqual(pts[0], src);
  assert.deepEqual(pts[pts.length - 1], dst);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(!crosses(pts[i - 1], pts[i], A), `segment ${i} crosses the source card`);
    assert.ok(!crosses(pts[i - 1], pts[i], B), `segment ${i} crosses the target card`);
  }
});

test('routeOrthogonal: backward with a horizontal gap takes the lane between the cards', () => {
  const A = box(400, 300, 240, 60);
  const B = box(0, 48, 240, 60);
  const src = { x: 520, y: A.b + 5 };
  const dst = { x: 120, y: B.t };
  const pts = routeOrthogonal(src, 'bottom', dst, 'top', { srcBox: A, dstBox: B });
  assertOrthogonal(pts);
  assertEndsDown(pts);
  assert.ok(pts.some((p) => p.x === 320), 'lane at the gap midpoint');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(!crosses(pts[i - 1], pts[i], A) && !crosses(pts[i - 1], pts[i], B), `segment ${i} crosses a card`);
  }
});

test('routeOrthogonal: draft to a bare point above the source still ends vertical-down', () => {
  const A = box(0, 200, 240, 60);
  const pts = routeOrthogonal({ x: 120, y: 265 }, 'bottom', { x: 150, y: 100 }, 'top', { srcBox: A });
  assertOrthogonal(pts);
  assertEndsDown(pts);
});

test('routeOrthogonal: unsupported side pairs throw', () => {
  assert.throws(() => routeOrthogonal({ x: 0, y: 0 }, 'top', { x: 0, y: 100 }, 'top'));
});

test('simplify: drops duplicates and collinear middles', () => {
  const pts = simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 10 }, { x: 5, y: 10 }]);
  assert.deepEqual(pts, [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 5, y: 10 }]);
});
