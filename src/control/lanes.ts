// src\control\lanes.ts — lane-done subscriptions (`spawn|prompt --notify`): the
// registry of who is owed a `lane done|dead|timeout` line, and the one send that
// arms each. Pure: every effect is a seam `listen.ts` passes in, so
// `tests\control-lanes.test.mjs` loads this file directly.
//
// Lifecycle: `reserve` (before the card; cap per requester) → `promptOnce` (after
// Approve; waits for the child to be sendable, sends once, arms on Ok) → fires on
// the child's next turn_done (one skipped if it was busy at send, unless that turn
// ended while the send was in flight), on a dead chip (3 polls running), or at the deadline → the fixed line is sent to the requester the same way.
// Renderer memory only: a reload or swap drops every subscription.

/** Outstanding subscriptions per requester tab; past it `reserve` refuses (`err busy`). */
export const LANE_CAP = 4;
/** The wait clamp (wait.rs): default 600 s, at most 3600 s. */
const LANE_TIMEOUT_MS = 600_000;
const LANE_TIMEOUT_MAX_MS = 3_600_000;
/** How long a just-spawned tab may take to become sendable before the prompt fails. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
/** Dead-chip poll; turn ends come as events, Stopped/Disconnected has none. */
const DEAD_POLL_MS = 1_000;
/** Consecutive dead polls before `dead` fires (a respawn reads Stopped for a moment). */
const DEAD_POLLS = 3;

export type LaneOutcome = "done" | "dead" | "timeout";

export interface LaneSeams {
  /** Composer-less send of one user prompt into `tab`; resolves when the host accepted it. */
  send(tab: string, text: string): Promise<void>;
  /** `tab`'s transport can take a send now. */
  ready(tab: string): boolean;
  /** `tab` has a turn in flight (its next turn_done is not ours). */
  busy(tab: string): boolean;
  /** `tab` is closed or its chip reads Stopped/Disconnected. */
  dead(tab: string): boolean;
  toast(message: string): void;
  now(): number;
  /** setTimeout-shaped; returns a cancel. */
  after(ms: number, fn: () => void): () => void;
}

/** A capacity slot taken before the card; the approved values are frozen into it. */
export interface LaneLease {
  readonly deliverTo: string;
  readonly report: string | null;
}

interface Lease extends LaneLease {
  /** `sending`: busy was read and the send is in flight; turn ends seen meanwhile are counted. */
  state: "reserved" | "sending" | "armed" | "closed";
  child: string | null;
  skip: number;
  /** turn_done events for `child` while `sending`; they consume the busy skip at arm. */
  seenWhileSending: number;
  stop: Array<() => void>;
}

/** wait.rs's `report` rule (non-blank, <= 400 bytes, no control characters) plus no
 *  `"`, since the line quotes it. Null = absent; undefined = invalid. */
export function laneReport(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !v.trim()) return undefined;
  if (new TextEncoder().encode(v).length > 400) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f"]/.test(v)) return undefined;
  return v;
}

/** The tab the line goes to: the card's `deliver_to` when Rust filled it (spawned
 *  hosted tabs, `falcon.hosted`), else `fallback` — the requester resolved through
 *  the frontend's session map (`resolveRequesterTab`), which is the only way an
 *  ADOPTED Falcon tab is found; without it the notify would drop silently. */
export function laneDeliverTo(deliverTo: unknown, fallback: () => string | null): string | null {
  if (typeof deliverTo === "string" && deliverTo) return deliverTo;
  return fallback();
}

/** The only text a lane ever puts into the requester: fixed words, the child's tab id,
 *  and the report path the human approved, quoted as data. */
export function laneLine(outcome: LaneOutcome, tab: string, report: string | null): string {
  return `lane ${outcome} ${tab} report=${report === null ? "-" : `"${report}"`}`;
}

export function createLanes(seams: LaneSeams, timeoutMs = LANE_TIMEOUT_MS) {
  const deadline = Math.min(LANE_TIMEOUT_MAX_MS, Math.max(1_000, timeoutMs));
  const leases = new Set<Lease>();

  const outstanding = (requester: string): number =>
    [...leases].filter((l) => l.deliverTo === requester && l.state !== "closed").length;

  function close(l: Lease): void {
    l.state = "closed";
    for (const stop of l.stop.splice(0)) stop();
    leases.delete(l);
  }

  function fire(l: Lease, outcome: LaneOutcome): void {
    if (l.state !== "armed" || l.child === null) return;
    const child = l.child;
    close(l);
    seams.send(l.deliverTo, laneLine(outcome, child, l.report)).catch(() => {
      seams.toast(`lane ${outcome} not delivered to ${l.deliverTo}`);
    });
  }

  /** The send is about to go out: from here a turn_done for `child` is counted, not dropped. */
  function startSending(l: Lease, child: string): void {
    if (l.state !== "reserved") return;
    l.state = "sending";
    l.child = child;
  }

  function arm(l: Lease, child: string, busyAtSend: boolean): void {
    if (l.state !== "sending") return;
    l.state = "armed";
    l.child = child;
    // A busy turn that ended while the send was in flight already went by: not skipped twice.
    l.skip = Math.max(0, (busyAtSend ? 1 : 0) - l.seenWhileSending);
    l.stop.push(seams.after(deadline, () => fire(l, "timeout")));
    let cancelPoll = (): void => {};
    let deadPolls = 0;
    const poll = (): void => {
      if (l.state !== "armed") return;
      // Consecutive only: a /clear or model switch respawns through a brief Stopped.
      deadPolls = seams.dead(child) ? deadPolls + 1 : 0;
      if (deadPolls >= DEAD_POLLS) { fire(l, "dead"); return; }
      cancelPoll = seams.after(DEAD_POLL_MS, poll);
    };
    cancelPoll = seams.after(DEAD_POLL_MS, poll);
    l.stop.push(() => cancelPoll());
  }

  /** Resolves once `tab` is sendable, rejects after `READY_TIMEOUT_MS`. No dead
   *  check here: a body reads Stopped until its first spawn starts. */
  function whenReady(tab: string): Promise<void> {
    const until = seams.now() + READY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (seams.ready(tab)) { resolve(); return; }
        if (seams.now() >= until) { reject(new Error("tab not ready")); return; }
        seams.after(READY_POLL_MS, check);
      };
      check();
    });
  }

  /** Gives a slot back that never armed (denied, expired, spawn or send failed). */
  function release(lease: LaneLease | null): void {
    const l = lease as Lease | null;
    if (l && (l.state === "reserved" || l.state === "sending")) close(l);
  }

  return {
    /** Takes a slot for `deliverTo`, or null when it already holds `LANE_CAP`. */
    reserve(deliverTo: string, report: string | null): LaneLease | null {
      if (outstanding(deliverTo) >= LANE_CAP) return null;
      const l: Lease = { deliverTo, report, state: "reserved", child: null, skip: 0, seenWhileSending: 0, stop: [] };
      leases.add(l);
      return l;
    },

    /** Gives a slot back that never armed (denied, expired, spawn or send failed). */
    release,

    /** Waits until `tab` is sendable, reads busy, sends `text` exactly once. The
     *  lease (if any) arms only when that send resolved; a rejection releases it. */
    async promptOnce(tab: string, text: string, lease: LaneLease | null): Promise<void> {
      try {
        await whenReady(tab);
        const busyAtSend = seams.busy(tab);
        if (lease) startSending(lease as Lease, tab);
        await seams.send(tab, text);
        if (lease) arm(lease as Lease, tab, busyAtSend);
      } catch (err) {
        release(lease);
        throw err;
      }
    },

    /** The child's turn_done (live, never replay). */
    turnDone(tab: string): void {
      for (const l of [...leases]) {
        if (l.child !== tab) continue;
        if (l.state === "sending") { l.seenWhileSending++; continue; }
        if (l.state !== "armed") continue;
        if (l.skip > 0) { l.skip--; continue; }
        fire(l, "done");
      }
    },

    /** Outstanding (reserved or armed) slots for a requester. */
    outstanding,
  };
}
