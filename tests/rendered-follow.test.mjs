import test from 'node:test';
import assert from 'node:assert/strict';
import { springStep, capStart, settleMs, CAP_TAIL_PX, createSendStick, createFollow } from '../src/panels/rendered/follow.ts';

/** A scroller stand-in: scrollTop clamps like the browser's; listeners are kept by type. */
function fakeTranscript(scrollHeight, clientHeight) {
  const on = {};
  let top = 0;
  return {
    on,
    scrollHeight,
    clientHeight,
    isConnected: true,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.round(Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))); },
    addEventListener(type, fn) { on[type] = fn; },
    removeEventListener() {},
  };
}

test('follow: a click mid-glide keeps the glide\'s own write programmatic (no un-stick from its late scroll event)', () => {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const t = fakeTranscript(300, 300);
    const S = { stick: true, replaying: false, hydrating: false };
    const f = createFollow(t, S);
    t.scrollHeight = 500; // a 200 px block landed while pinned: over the 60 px re-stick margin
    f.toBottom();
    frames.shift()(performance.now() + 16); // one glide frame writes part of the way
    assert.ok(t.scrollTop > 0 && t.scrollTop < 200, `mid-glide at ${t.scrollTop}`);
    t.on.pointerdown(); // the user clicks a tool row before that write's scroll event fires
    assert.equal(f.programmatic(), true, 'the pending scroll event is still the glide\'s');
    t.scrollTop = t.scrollTop - 30; // a real user scroll moves off the written position
    assert.equal(f.programmatic(), false);
    f.dispose();
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

test('follow spring: a 40 px step settles in 120-180 ms and never overshoots', () => {
  const ms = settleMs(40);
  assert.ok(ms >= 120 && ms <= 180, `settle ${ms} ms`);
  for (const dt of [1 / 240, 1 / 60, 1 / 30, 0.064]) {
    let s = { pos: 0, vel: 0 };
    for (let i = 0; i < 200; i++) {
      s = springStep(s, 40, dt);
      assert.ok(s.pos <= 40 + 1e-9, `overshoot at dt=${dt}: ${s.pos}`);
    }
  }
});

test('follow cap: a gap over one viewport keeps only the tail to ease', () => {
  assert.equal(capStart(0, 2000, 600), 2000 - CAP_TAIL_PX);
  assert.equal(capStart(1500, 2000, 600), 1500);
});

test('send stick: a composer send while scrolled up re-sticks on its echo', () => {
  const S = { stick: false, replaying: false, hydrating: false };
  const st = createSendStick(S);
  st.arm();
  st.onEcho();
  assert.equal(S.stick, true);
  S.stick = false;
  st.onEcho(); // one-shot: a later echo does not stick
  assert.equal(S.stick, false);
});

test('send stick: a non-composer echo while scrolled up leaves the view', () => {
  const S = { stick: false, replaying: false, hydrating: false };
  const st = createSendStick(S);
  st.onEcho();
  assert.equal(S.stick, false);
});

test('send stick: replay and hydrate echoes neither stick nor consume; a refused send disarms', () => {
  const S = { stick: false, replaying: true, hydrating: false };
  const st = createSendStick(S);
  st.arm();
  st.onEcho();
  S.replaying = false; S.hydrating = true;
  st.onEcho();
  assert.equal(S.stick, false);
  S.hydrating = false;
  st.onEcho();
  assert.equal(S.stick, true);
  S.stick = false;
  st.arm(); st.disarm(); st.onEcho();
  assert.equal(S.stick, false);
});

test('follow: a restore that starts mid-glide stops the glide without writing scrollTop (cover 6)', () => {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const t = fakeTranscript(300, 300);
    const S = { stick: true, replaying: false, hydrating: false };
    const f = createFollow(t, S);
    t.scrollHeight = 500;
    f.toBottom();
    frames.shift()(performance.now() + 16);
    const at = t.scrollTop;
    assert.ok(at > 0 && at < 200, `mid-glide at ${at}`);
    S.hydrating = true; // a hydrate (or replay) begins: it paints without scrolling
    frames.shift()(performance.now() + 32);
    assert.equal(t.scrollTop, at, 'the glide wrote through the restore');
    assert.equal(frames.length, 0, 'the glide ended');
    f.dispose();
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

test('send stick: a transcript reset disarms, so an echo after it does not re-stick (cover 7)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/panels/rendered.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function resetTranscript()'), src.indexOf('\n  }\n', src.indexOf('function resetTranscript()')));
  assert.ok(body.includes('sendStick.disarm()'), 'resetTranscript keeps the send stick armed');
  // the sequence the reset closes: armed, its echo swallowed by a hydrate, reset, a later echo
  const S = { stick: true, replaying: false, hydrating: true };
  const st = createSendStick(S);
  st.arm();
  st.onEcho();
  st.disarm(); // resetTranscript
  S.hydrating = false; S.stick = false;
  st.onEcho();
  assert.equal(S.stick, false);
});
