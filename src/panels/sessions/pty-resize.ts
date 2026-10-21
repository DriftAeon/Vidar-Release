// Trailing debounce for resize_pty: a divider drag fits the xterm grid every frame, but the pty only
// needs the size it settles on. The sender decides what to send (it reads the grid at fire time);
// this module owns only the per-id timers.

/** Quiet time after the last grid change before the pty is told (well above a 16 ms frame). */
export const RESIZE_SETTLE_MS = 100;

export interface ResizeTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const windowTimers: ResizeTimers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export function createPtyResize(
  send: (id: string) => void,
  timers: ResizeTimers = windowTimers,
  ms: number = RESIZE_SETTLE_MS,
) {
  const armed = new Map<string, number>();
  const cancel = (id: string) => {
    const handle = armed.get(id);
    if (handle === undefined) return;
    timers.clearTimeout(handle);
    armed.delete(id);
  };
  return {
    /** Re-arm the one trailing send for this id. */
    later(id: string) {
      cancel(id);
      armed.set(id, timers.setTimeout(() => {
        armed.delete(id);
        send(id);
      }, ms));
    },
    /** Drop any pending send and send now. */
    now(id: string) {
      cancel(id);
      send(id);
    },
    cancel,
  };
}
