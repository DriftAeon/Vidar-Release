// Following the bottom of a Rendered transcript: an eased glide while output streams, an
// instant jump for replay/hydrate/resume and explicit resets. One concern: where scrollTop goes
// while the view is stuck to the bottom. The stick flag itself stays in rendered.ts's scroll
// handler, which asks programmatic() before un-sticking from position alone.
//
// Motion is a critically damped spring on scrollTop, retargeted every frame to the live bottom,
// so a stream of small growths reads as one steady glide and never overshoots. A gap over one
// viewport jumps to CAP_TAIL_PX short of the bottom and eases only that tail.

import type { RenderedState } from "./state";

/** Spring stiffness (rad/s). Critically damped: a 40 px step is inside 0.5 px after ~160 ms. */
const OMEGA = 40;
/** What a long gap leaves to ease after its jump: about two transcript lines. */
export const CAP_TAIL_PX = 40;
/** Settled: closer than this to the bottom and slower than SETTLE_V. */
const SETTLE_PX = 0.5;
const SETTLE_V = 20; // px/s
/** A frame gap above this (background throttling) is integrated as this. */
const MAX_DT = 0.064; // s

export interface SpringState { pos: number; vel: number }

/** One exact step of a critically damped spring toward `target` over `dt` seconds. Exact, not
 *  Euler: any dt is stable and the position never crosses the target from rest. */
export function springStep(s: SpringState, target: number, dt: number, omega = OMEGA): SpringState {
  const x = s.pos - target;
  const e = Math.exp(-omega * dt);
  const k = s.vel + omega * x;
  return { pos: target + (x + k * dt) * e, vel: (s.vel - omega * k * dt) * e };
}

/** Where a glide starts: a gap larger than the viewport is cut to `tail` short of the target. */
export function capStart(pos: number, target: number, viewport: number, tail = CAP_TAIL_PX): number {
  return target - pos > viewport ? target - tail : pos;
}

/** Milliseconds for a step of `distance` px from rest to settle (frame-free, 1 ms resolution). */
export function settleMs(distance: number, omega = OMEGA): number {
  let s: SpringState = { pos: 0, vel: 0 };
  for (let t = 1; t < 5000; t++) {
    s = springStep(s, distance, 0.001, omega);
    if (Math.abs(distance - s.pos) < SETTLE_PX && Math.abs(s.vel) < SETTLE_V) return t;
  }
  return 5000;
}

export interface Follow {
  /** eased follow to the bottom when stuck; instant during replay/hydration or reduced motion */
  toBottom(): void;
  /** instant, unconditional: replay end, hydration end, explicit resets */
  jump(): void;
  /** true while the last scroll came from here: a glide runs, or scrollTop is still what it wrote */
  programmatic(): boolean;
  dispose(): void;
}

export interface SendStick {
  /** the composer just sent: the next live user-block echo re-sticks the view */
  arm(): void;
  /** the send was refused: no echo is coming */
  disarm(): void;
  /** a user block is about to draw; re-sticks once if armed, never during replay or hydrate */
  onEcho(): void;
}

/** One-shot "composer sends only" scroll: Relay answers, bus sends and other echoes leave a
 *  scrolled-up view where it is. */
export function createSendStick(S: Pick<RenderedState, "stick" | "replaying" | "hydrating">): SendStick {
  let armed = false;
  return {
    arm() { armed = true; },
    disarm() { armed = false; },
    onEcho() {
      if (!armed || S.replaying || S.hydrating) return;
      armed = false;
      S.stick = true;
    },
  };
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

export function createFollow(transcript: HTMLElement, S: Pick<RenderedState, "stick" | "replaying" | "hydrating">): Follow {
  let raf = 0;
  let last = 0;
  let spring: SpringState = { pos: 0, vel: 0 };
  let written = Number.NaN;
  const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const bottom = () => Math.max(0, transcript.scrollHeight - transcript.clientHeight);
  const write = (top: number) => { transcript.scrollTop = top; written = transcript.scrollTop; };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  function frame(now: number) {
    raf = 0;
    if (!S.stick || !transcript.isConnected) return;
    // a restore started mid-glide paints without scrolling (toBottom's rule): the glide ends, the restore's end jumps
    if (S.replaying || S.hydrating) return;
    // an external write mid-glide (keepPinned, find, drag) moved scrollTop: glide on from there
    if (Math.abs(transcript.scrollTop - written) >= 1) spring = { pos: transcript.scrollTop, vel: 0 };
    const target = bottom();
    const dt =Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    // a large block landed mid-glide: same cap as at the start
    const pos = Math.min(capStart(spring.pos, target, transcript.clientHeight), target);
    spring = springStep({ pos, vel: pos === spring.pos ? spring.vel : 0 }, target, dt);
    if (Math.abs(target - spring.pos) < SETTLE_PX && Math.abs(spring.vel) < SETTLE_V) { write(target); return; }
    write(spring.pos);
    raf = requestAnimationFrame(frame);
  }

  function jump() {
    stop();
    write(transcript.scrollHeight);
  }

  function toBottom() {
    if (!S.stick) return;
    // a restore paints without scrolling: the end of the replay/hydrate does the one jump()
    if (S.replaying || S.hydrating) return;
    if (reduced?.matches) { jump(); return; }
    if (raf) return; // the running glide retargets to the live bottom every frame
    const target = bottom();
    const from = transcript.scrollTop;
    if (target - from < 1) return;
    spring = { pos: capStart(from, target, transcript.clientHeight), vel: 0 };
    if (spring.pos !== from) write(spring.pos);
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  // user intent un-sticks: any of these cancels the glide, and the scroll handler's position rule
  // takes over for the scroll they cause
  // (pointerdown and keys inside the transcript cancel harmlessly: the next paint resumes the follow)
  // `written` is kept: a glide write's scroll event fires a frame later, so a click landing in that
  // gap (expanding a tool row mid-glide) used to clear it, and the late event read as a user scroll
  // short of the bottom and un-stuck the view. A real user scroll moves scrollTop off `written`.
  const cancel = () => { stop(); };
  // upward intent also un-sticks, so a small scroll-up near the bottom is not re-followed
  const cancelUp = () => { cancel(); S.stick = false; };
  const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) cancelUp(); else cancel(); };
  const onKey = (e: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(e.key)) return;
    if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") cancelUp(); else cancel();
  };
  transcript.addEventListener("wheel", onWheel, { passive: true });
  transcript.addEventListener("touchstart", cancelUp, { passive: true });
  transcript.addEventListener("pointerdown", cancel);
  transcript.addEventListener("keydown", onKey);

  // the viewport resized (Agents bar, composer growth, tab shown): keep the newest lines in view
  let lastHeight = -1;
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const h = transcript.clientHeight;
    const wasHidden = lastHeight <= 0;
    lastHeight = h;
    if (!S.stick || h <= 0) return;
    if (wasHidden) jump(); else toBottom();
  }) : null;
  ro?.observe(transcript);

  return {
    toBottom,
    jump,
    programmatic: () => Math.abs(transcript.scrollTop - written) < 1,
    dispose() {
      stop();
      ro?.disconnect();
      transcript.removeEventListener("wheel", onWheel);
      transcript.removeEventListener("touchstart", cancelUp);
      transcript.removeEventListener("pointerdown", cancel);
      transcript.removeEventListener("keydown", onKey);
    },
  };
}
