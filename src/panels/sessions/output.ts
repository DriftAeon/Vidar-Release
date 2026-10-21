// PTY output handling for terminal tabs: frame coalescing, the character-activity pulse and the
// Codex cursor settle, with one per-tab teardown (dropOutput). sessions.ts binds its tab map in.
import {
  CHARACTER_ACTIVITY_QUIET_MS,
  rawOutputMeansWork,
  reduceOutputPulse,
  reduceOutputQuiet,
  type OutputActivityState,
} from "../../character/behavior";
import { dispatchCharacterActivity } from "../../character/events";
import { createFlowGate, FLOW_HIGH, FLOW_LOW, type FlowGate } from "./flow-gate";
import type { TerminalSession } from "./types";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let setFlow: (id: string, paused: boolean) => void = () => {};

/** sessions.ts, at load: the tab map flushOutput and markStreaming read, and
 *  the pty_flow call the watermarks drive. */
export function bindOutput(deps: {
  sessions: ReadonlyMap<string, TerminalSession>;
  setFlow?: (id: string, paused: boolean) => void;
}) {
  sessions = deps.sessions;
  if (deps.setFlow) setFlow = deps.setFlow;
  // A hidden window parses slowly (WebView2 throttles background timers), so
  // no tab pauses while hidden; showing it again re-checks the watermarks.
  document.addEventListener("visibilitychange", () => {
    for (const g of gates.values()) g.setSuspended(document.hidden);
  });
}

/* Flow control: bytes are in flight from queueOutput until xterm's write
   callback (parsed) or a drop; the watermarks live in flow-gate.ts. */
const gates = new Map<string, FlowGate>();

function gateFor(id: string): FlowGate {
  let g = gates.get(id);
  if (!g) {
    g = createFlowGate(FLOW_HIGH, FLOW_LOW, (paused) => setFlow(id, paused), document.hidden);
    gates.set(id, g);
  }
  return g;
}

/** pty-flow-resumed: Rust unpaused this tab's reader for input or at its
 *  pause ceiling; keep the gate in step so it can pause again. */
export function flowResumed(id: string) {
  gates.get(id)?.resumed();
}

/* ---- output coalescing ----
   ConPTY hands a full-screen TUI frame over as several chunks. Writing each
   one to xterm as it lands lets a render tick fall mid-frame, and the cursor
   gets painted wherever the parser paused — a bright block hopping up a few
   rows in Codex (Ratatui, no DEC 2026 sync markers). Claude Code wraps its
   frames in those markers so xterm already holds them atomic; this makes the
   unmarked case behave the same by waiting for a short quiet gap before one
   write. QUIET_MS is below anything a keystroke echo can feel; MAX_MS caps
   the wait so a firehose still paints. */
const QUIET_MS = 6;
const MAX_MS = 24;

interface Pending {
  chunks: Uint8Array[];
  timer: number;
  first: number;
}

const pending = new Map<string, Pending>();
interface OutputActivity extends OutputActivityState {
  timer: number | undefined;
}
const outputActivity = new Map<string, OutputActivity>();
const HIDE_CURSOR = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c]);

function scheduleActivityCheck(id: string, state: OutputActivity, delay = CHARACTER_ACTIVITY_QUIET_MS): void {
  if (state.timer !== undefined) return;
  state.timer = window.setTimeout(() => {
    state.timer = undefined;
    if (outputActivity.get(id) !== state || !state.active) return;
    const result = reduceOutputQuiet(state, performance.now());
    if (result.remaining > 0) {
      scheduleActivityCheck(id, state, result.remaining);
      return;
    }
    if (result.edge === false) dispatchCharacterActivity({ id, active: false });
  }, delay);
}

export function noteCharacterOutput(id: string, now = performance.now()): void {
  const previous = outputActivity.get(id);
  const result = reduceOutputPulse(previous, now);
  const state: OutputActivity = previous ?? { ...result.state, timer: undefined };
  outputActivity.set(id, state);
  if (result.edge === true) dispatchCharacterActivity({ id, active: true });
  if (state.active) scheduleActivityCheck(id, state);
}

function clearCharacterOutput(id: string): void {
  const state = outputActivity.get(id);
  if (!state) return;
  if (state.timer !== undefined) window.clearTimeout(state.timer);
  if (state.active) dispatchCharacterActivity({ id, active: false });
  outputActivity.delete(id);
}

export function flushOutput(id: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  window.clearTimeout(p.timer);
  const gate = gateFor(id);
  let queued = 0;
  for (const c of p.chunks) queued += c.length;
  const s = sessions.get(id);
  if (!s?.term) {
    gate.done(queued); // dropped, no longer in flight
    return;
  }
  const parsed = () => gate.done(queued);
  // only for a TUI that goes quiet when idle — see rawOutputMeansWork
  if (rawOutputMeansWork(s.agent)) noteCharacterOutput(id);
  let frame: Uint8Array;
  if (p.chunks.length === 1) {
    frame = p.chunks[0];
  } else {
    let n = 0;
    for (const c of p.chunks) n += c.length;
    frame = new Uint8Array(n);
    let off = 0;
    for (const c of p.chunks) {
      frame.set(c, off);
      off += c.length;
    }
  }

  if (s.agent !== "codex") {
    s.term.write(frame, parsed);
    return;
  }

  // Codex's Ratatui frames can turn the cursor back on while moving through
  // the composer. Appending the hide sequence makes it the final terminal
  // state of this atomic xterm write, rather than letting a frame override a
  // preceding hide.
  const hiddenFrame = new Uint8Array(frame.length + HIDE_CURSOR.length);
  hiddenFrame.set(frame);
  hiddenFrame.set(HIDE_CURSOR, frame.length);
  s.term.write(hiddenFrame, parsed);
}

/* ConPTY re-emits a TUI frame on its own timer, walking the cursor to the
   previous row to repaint the composer border and back, with a gap longer
   than the coalescing window above — so the block cursor still hops on every
   keystroke in Codex (its own DEC 2026 markers don't survive ConPTY). Rather
   than chase ConPTY's timing, hide the cursor while bytes are arriving and
   reveal it once the stream has been quiet for SETTLE_MS. 40 ms winked
   between every letter and was worse than the hop; the window has to
   outlast a typing burst (~100–150 ms per key at 70–90 WPM) so the cursor
   stays away until a real pause. */
const SETTLE_MS = 300;
const settling = new Map<string, number>();

function markStreaming(id: string) {
  const s = sessions.get(id);
  if (!s?.term || s.agent !== "codex") return;
  window.clearTimeout(settling.get(id));
  settling.set(
    id,
    window.setTimeout(() => {
      settling.delete(id);
      // This is local presentation state only; never send it through the pty.
      // A TUI redraw may have moved the cursor through several rows, but it is
      // revealed only once the completed frame has been quiet for a moment.
      s.term?.write("\x1b[?25h");
    }, SETTLE_MS),
  );
}

export function queueOutput(id: string, bytes: Uint8Array) {
  markStreaming(id);
  const now = performance.now();
  let p = pending.get(id);
  if (!p) {
    p = { chunks: [], timer: 0, first: now };
    pending.set(id, p);
  } else if (now - p.first >= MAX_MS) {
    // held long enough — paint what we have, start a fresh window with this chunk
    flushOutput(id);
    p = { chunks: [], timer: 0, first: now };
    pending.set(id, p);
  } else {
    window.clearTimeout(p.timer);
  }
  p.chunks.push(bytes);
  gateFor(id).add(bytes.length);
  p.timer = window.setTimeout(() => flushOutput(id), QUIET_MS);
}

// WebView2 builds that ship Uint8Array.fromBase64 decode natively; the atob loop is the fallback
// (lib is ES2022, so the method is not in the types).
const nativeFromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

export function b64ToBytes(b64: string): Uint8Array {
  if (nativeFromBase64) return nativeFromBase64.call(Uint8Array, b64);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** detachTerminalBody: drop a tab's pending frame, cursor settle and activity pulse. */
export function dropOutput(id: string) {
  const p = pending.get(id);
  if (p) {
    window.clearTimeout(p.timer);
    pending.delete(id);
  }
  window.clearTimeout(settling.get(id));
  settling.delete(id);
  clearCharacterOutput(id);
  // A detach with the pty still alive must not leave its reader paused; a
  // kill unpauses on the Rust side anyway.
  if (gates.get(id)?.paused) setFlow(id, false);
  gates.delete(id);
}
