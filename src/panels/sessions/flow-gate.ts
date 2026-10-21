/* PTY output flow control: the watermark state output.ts keeps per tab.
   xterm silently drops writes once ~50 MB is pending (WriteBuffer.ts), so a
   child that outpaces the parser loses output. Crossing HIGH pauses the pty
   reader (pty_flow, src-tauri/src/pty/flow.rs), falling to LOW resumes it; the
   gap keeps it from toggling per chunk. Import-free so Node tests load it. */
export const FLOW_HIGH = 1024 * 1024;
export const FLOW_LOW = 128 * 1024;

export interface FlowGate {
  add(n: number): void;
  done(n: number): void;
  /** While suspended (window hidden) the gate never pauses: WebView2 throttles
   *  background timers, parsing slows, and a pause would stall the child.
   *  Suspending resumes a paused reader; unsuspending re-checks high water. */
  setSuspended(on: boolean): void;
  /** Rust ended the pause itself (input or its pause ceiling: pty-flow-resumed).
   *  Drops the paused state without an edge, since the reader already runs, so
   *  the next add at or over high water pauses again. */
  resumed(): void;
  readonly paused: boolean;
  readonly inFlight: number;
}

/** Pure watermark state: `onChange` fires on edges only (pause at >= high, resume at <= low). */
export function createFlowGate(
  high: number,
  low: number,
  onChange: (paused: boolean) => void,
  suspended = false,
): FlowGate {
  let inFlight = 0;
  let paused = false;
  const maybePause = () => {
    if (!paused && !suspended && inFlight >= high) {
      paused = true;
      onChange(true);
    }
  };
  return {
    setSuspended(on) {
      suspended = on;
      if (on && paused) {
        paused = false;
        onChange(false);
      } else if (!on) {
        maybePause();
      }
    },
    resumed() {
      paused = false;
    },
    add(n) {
      inFlight += n;
      maybePause();
    },
    done(n) {
      inFlight = Math.max(0, inFlight - n);
      if (paused && inFlight <= low) {
        paused = false;
        onChange(false);
      }
    },
    get paused() {
      return paused;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
