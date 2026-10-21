// src\control\watch.ts — `ctl.wait`'s poll loop.
// Pure: no IPC, no drive import — `listen.ts` passes `driveSnapshot` in, so
// `tests\control-watch.test.mjs` can load this file directly.

/** The slice of `driveSnapshot()` a wait reads: rendered tabs carry `state`
 *  (`stateChip.dataset.state ?? ""`), raw tabs carry none. */
export interface WaitSnapshot {
  tabs: ReadonlyArray<{ id: string; body: string; state?: string }>;
}

export type WaitVerdict = "done" | "dead" | "running";

/** How long a chip may read idle from the start of a wait before that idle
 *  counts as done. A Falcon-hosted tab's `sendUser` never sets busy
 *  optimistically: the chip turns busy only on `prompt-dispatched` or
 *  `turn_start`, so `prompt X; wait X` sees idle first (review blocker). */
const WAIT_GRACE_MS = 10_000;

/** Absent from the snapshot (closed, never opened) is dead; a chip reading
 *  `"dead"` (Stopped/Disconnected) is dead; `"idle"` is done; anything else,
 *  including `""` (chip not stamped yet), is still running. */
export function waitVerdict(snap: WaitSnapshot, tabId: string): WaitVerdict {
  const tab = snap.tabs.find((t) => t.id === tabId);
  if (!tab) return "dead";
  if (tab.state === "idle") return "done";
  if (tab.state === "dead") return "dead";
  return "running";
}

/** Per-wait memory across ticks: when it began and whether the chip has read
 *  busy (a stamped state other than idle/dead) since then. */
export interface WaitProgress {
  startedAt: number;
  seenBusy: boolean;
}

/** One tick of a wait. Idle is done only once the chip has been seen busy
 *  since the wait began, or after `graceMs` of unbroken idle (an already-idle
 *  tab with no turn coming). An unstamped chip (`""`) is not busy: a fresh
 *  tab reads that before "Starting…", which itself reads idle. Mutates
 *  `p.seenBusy`. */
export function waitStep(
  p: WaitProgress,
  snap: WaitSnapshot,
  tabId: string,
  now: number,
  graceMs = WAIT_GRACE_MS,
): WaitVerdict {
  const verdict = waitVerdict(snap, tabId);
  if (verdict === "dead") return "dead";
  if (verdict === "running") {
    if (snap.tabs.find((t) => t.id === tabId)?.state) p.seenBusy = true;
    return "running";
  }
  return p.seenBusy || now - p.startedAt >= graceMs ? "done" : "running";
}

export interface WatchOptions {
  intervalMs?: number;
  graceMs?: number;
  /** The requesting tab; once it leaves the snapshot the wait ends `"gone"`
   *  so an abandoned wait frees its pending slot. Null skips the check. */
  requesterTab?: string | null;
  /** Aborting stops polling at once and resolves `"cancelled"` (Rust already
   *  answered the wait: superseded, or the bus is going away). */
  signal?: AbortSignal;
}

/** Polls `snapshot()` every `intervalMs` until `tabId` is done or dead, the
 *  requester tab is gone, `timeoutMs` passes, or `opts.signal` aborts.
 *  Checks once immediately. */
export function watchTab(
  tabId: string,
  timeoutMs: number,
  snapshot: () => WaitSnapshot,
  opts: WatchOptions = {},
): Promise<"done" | "dead" | "timeout" | "gone" | "cancelled"> {
  const intervalMs = opts.intervalMs ?? 750;
  const graceMs = opts.graceMs ?? WAIT_GRACE_MS;
  const requesterTab = opts.requesterTab ?? null;
  const signal = opts.signal;
  const progress: WaitProgress = { startedAt: Date.now(), seenBusy: false };
  const deadline = progress.startedAt + timeoutMs;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => { clearTimeout(timer); resolve("cancelled"); };
    if (signal?.aborted) { resolve("cancelled"); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (v: "done" | "dead" | "timeout" | "gone"): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const tick = (): void => {
      if (signal?.aborted) return;
      let verdict: WaitVerdict = "running";
      try {
        const snap = snapshot();
        if (requesterTab && !snap.tabs.some((t) => t.id === requesterTab)) { finish("gone"); return; }
        verdict = waitStep(progress, snap, tabId, Date.now(), graceMs);
      } catch {
        verdict = "running"; // a transient snapshot failure is not a verdict
      }
      if (verdict !== "running") { finish(verdict); return; }
      if (Date.now() >= deadline) { finish("timeout"); return; }
      timer = setTimeout(tick, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    };
    tick();
  });
}
