import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chooseReadout, isCssSurface, matchingToken, parseColor, tokenMap } from '../src/tools/eyedropper-readout.ts';
import { frameShields, sampleLoop } from '../src/tools/eyedropper-sampling.ts';
import { pickFreeze } from '../src/tools/pick-freeze.ts';

test('picking uses sampled pixels and keeps shell CSS values supplementary', () => {
  const pixel = [12, 34, 56];
  const css = { bg: [100, 110, 120], fg: [220, 230, 240] };
  assert.deepEqual(chooseReadout(pixel, css), { picked: pixel, pixel, ...css });
  assert.deepEqual(chooseReadout(pixel, null), { picked: pixel, pixel, bg: null, fg: null });
  assert.equal(chooseReadout(null, css).picked, null, 'failed sampling must not copy CSS as a pixel');
});

test('contained image, iframe, SVG and terminal surfaces suppress CSS readouts', () => {
  const { document } = new JSDOM(`<button id="shell">Pick</button><iframe></iframe>
    <canvas></canvas><img><video></video><svg><path></path></svg>
    <div class="xterm"><span>Terminal Glyph</span></div>`).window;
  assert.equal(isCssSurface(document.querySelector('#shell')), true);
  for (const selector of ['iframe', 'canvas', 'img', 'video', 'path', '.xterm span']) {
    assert.equal(isCssSurface(document.querySelector(selector)), false, selector);
  }
  assert.equal(isCssSurface(null), false);
});

test('CSS token hints match colour values and ignore fully transparent backgrounds', () => {
  const { document } = new JSDOM('<html style="--bg: #123; --label: Words; --mix: var(--bg); --fg: rgb(1, 2, 3)"></html>').window;
  const tokens = tokenMap(document.documentElement.style);
  assert.equal(matchingToken([17, 34, 51], tokens), '--bg');
  assert.equal(matchingToken([17, 34, 52], tokens), null);
  assert.equal(matchingToken([1, 2, 3], tokens), '--fg');
  assert.deepEqual([...tokens.values()], ['--bg', '--fg']);
  assert.equal(parseColor('rgba(0, 0, 0, 0)'), null);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('polling is throttled and stops after disarm', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const loop = sampleLoop(async () => { calls++; return null; }, () => {});
  try {
    loop.start();
    await tick();
    t.mock.timers.tick(74);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await tick();
    assert.equal(calls, 2);
    loop.stop();
    t.mock.timers.tick(150);
    assert.equal(calls, 2);
  } finally { loop.stop(); }
});

test('iframe click shields are transparent to hit testing and removed on disarm', () => {
  const dom = new JSDOM('<iframe></iframe>');
  const document = dom.window.document;
  const previous = globalThis.document;
  globalThis.document = document;
  const frame = document.querySelector('iframe');
  frame.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
  frame.getClientRects = () => [frame.getBoundingClientRect()];
  document.elementFromPoint = () => {
    assert.equal(document.querySelector('.eyedrop-capture').style.pointerEvents, 'none');
    return frame;
  };
  const shields = frameShields();
  try {
    shields.update();
    const shield = document.querySelector('.eyedrop-capture');
    assert.equal(shield.style.left, '10px');
    assert.equal(shield.style.width, '200px');
    assert.equal(shields.elementAt(25, 30), frame);
    assert.equal(shield.style.pointerEvents, '');
    frame.remove();
    shields.update();
    assert.equal(shield.isConnected, false);
    document.body.appendChild(frame);
    shields.update();
    shields.clear();
    assert.equal(document.querySelector('.eyedrop-capture'), null);
  } finally { shields.clear(); globalThis.document = previous; dom.window.close(); }
});

test('native requests serialize and a result from before disarm cannot repaint a new arm', async () => {
  const pending = [];
  const received = [];
  const loop = sampleLoop((point) => new Promise((resolve) => pending.push({ point, resolve })),
    (value, pick) => received.push({ value, pick }));
  try {
    loop.start();
    assert.equal(pending.length, 1);
    loop.pick({ clientX: 10, clientY: 20 });
    assert.equal(pending.length, 1);
    loop.stop();
    loop.start();
    assert.equal(pending.length, 1, 'rearm waits for the old request');
    pending[0].resolve({ rgb: [1, 2, 3], clientX: 0, clientY: 0 });
    await tick();
    assert.deepEqual(received, [], 'old generation is ignored');
    loop.pick({ clientX: 30, clientY: 40 });
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[1].point, { clientX: 30, clientY: 40 });
    pending[1].resolve({ rgb: [4, 5, 6], clientX: 30, clientY: 40 });
    await tick();
    assert.equal(received.length, 1);
    assert.equal(received[0].pick, true);
  } finally { loop.stop(); }
});

test('a successful pick freezes native polling; a second pick re-samples once and freezes again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const points = [];
  const loop = sampleLoop(async (point) => { points.push(point); return null; }, () => {});
  try {
    loop.start();
    await tick();
    assert.equal(loop.frozen, false);
    loop.pick({ clientX: 5, clientY: 6 });
    await tick();
    assert.equal(loop.frozen, true);
    const calls = points.length;
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(points.length, calls, 'no polling while frozen');
    loop.pick({ clientX: 50, clientY: 60 });
    await tick();
    assert.deepEqual(points.at(-1), { clientX: 50, clientY: 60 });
    assert.equal(points.length, calls + 1);
    assert.equal(loop.frozen, true);
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(points.length, calls + 1);
    loop.stop();
    assert.equal(loop.frozen, false, 'disarm clears the freeze');
    loop.start();
    await tick();
    assert.equal(loop.frozen, false);
  } finally { loop.stop(); }
});

test('a failed pick keeps polling instead of freezing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = false, calls = 0;
  const loop = sampleLoop(async () => { calls++; if (fail) throw new Error('x'); return null; }, () => {});
  try {
    loop.start();
    await tick();
    fail = true;
    loop.pick({ clientX: 1, clientY: 1 });
    await tick();
    assert.equal(loop.frozen, false);
    const before = calls;
    t.mock.timers.tick(75);
    await tick();
    assert.equal(calls, before + 1);
  } finally { loop.stop(); }
});

test('region ref freeze: tracking until a pick, a second pick holds again, reset tracks', () => {
  const f = pickFreeze();
  assert.equal(f.tracking, true);
  f.pick();
  assert.equal(f.tracking, false);
  f.pick();
  assert.equal(f.tracking, false);
  f.reset();
  assert.equal(f.tracking, true);
});
