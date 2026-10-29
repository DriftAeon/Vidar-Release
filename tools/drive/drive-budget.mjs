// Budget bookkeeping for vidar-drive.mjs, split out so it is unit-testable
// without a DevTools connection. File path and clock are injectable (tests use
// a temp file instead of %TEMP%\vidar-drive-budget.json). Leaf: importing this
// module has no side effects.
//
// The cap binds the capped caller: an executor could otherwise re-arm its own
// smoke budget (50→200 via `budget reset`, 45→60 by changing
// the env value). So an armed record younger than LOCK_MS is the only truth —
// a different env value does not re-arm it, exhaustion is final for it, and
// only an orchestrator reset (explicit flag, recorded in the file) replaces it.

import fs from "node:fs";

/** How long an armed record binds. Older than this, the next call re-arms from
 *  the env value (a new smoke in a later session, not a refill of this one). */
export const LOCK_MS = 2 * 60 * 60 * 1000;

/** The env value as a cap, or null when it is not a positive integer ("",
 *  "0", "abc", "2.5", undefined): such a value is treated as unset, so it never
 *  writes a zero record that would lock the caller out for LOCK_MS. */
export function armedFromEnv(envValue) {
  if (typeof envValue !== "string" || !/^\s*\d+\s*$/.test(envValue)) return null;
  const n = Number(envValue);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function readBudget(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const ok = s && Number.isFinite(s.armed) && Number.isFinite(s.remaining) && Number.isFinite(s.armedAt);
    return ok ? s : null;
  } catch {
    return null;
  }
}

// Atomic replace: write a sibling temp file, then rename over the record, so a
// reader never sees a half-written file. The read-modify-write in stepBudget is
// not locked: two concurrent drives may share one decrement. Windows refuses the
// rename (EPERM/EACCES/EBUSY) while another handle (Defender, an indexer) briefly
// holds the target, so it retries a few times before giving up.
function writeBudget(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

function liveRecord(file, now) {
  const prev = readBudget(file);
  return prev && now - prev.armedAt >= 0 && now - prev.armedAt < LOCK_MS ? prev : null;
}

/** One call's worth of budget bookkeeping. `envValue` is
 *  process.env.VIDAR_DRIVE_BUDGET (string) or undefined.
 *
 *  - a record armed less than LOCK_MS ago binds, whatever the env value says
 *    now — unset included (`envIgnored` is true when a set value differs).
 *    the unset case must not return null, because a caller whose
 *    env does not carry over to its next shell call (the PowerShell tool keeps
 *    no $env between calls) would run past a live record;
 *  - no live record and envValue unset or not a positive integer: null — no
 *    cap, file untouched;
 *  - no record, an unreadable one, or one older than LOCK_MS: arms fresh from
 *    the env value, stamped `armedAt: now`;
 *  then decrements and persists.
 *
 *  Return shape: { armed, remaining, envIgnored }. A non-null result with
 *  armedFromEnv(envValue) === null means a live record bound an unset env. `remaining` is -1 when the
 *  budget was already exhausted before this call (the caller refuses, exit 3);
 *  otherwise it is the count left after this call is spent. */
export function stepBudget(file, envValue, now = Date.now()) {
  const prev = liveRecord(file, now);
  const envArmed = armedFromEnv(envValue);
  if (!prev && envArmed === null) return null;
  const live = !!prev;
  const state = live ? prev : { armed: envArmed, remaining: envArmed, armedAt: now };
  const envIgnored = live && envArmed !== null && prev.armed !== envArmed;
  if (state.remaining <= 0) {
    if (!live) writeBudget(file, state);
    return { armed: state.armed, remaining: -1, envIgnored };
  }
  const next = { ...state, remaining: state.remaining - 1 };
  writeBudget(file, next);
  return { armed: next.armed, remaining: next.remaining, envIgnored };
}

/** Read-only view for `budget` with no args: the live record, or null when
 *  none binds. Never writes, never decrements. `expiresAt` is when the lock
 *  lapses (armedAt + LOCK_MS). */
export function budgetStatus(file, now = Date.now()) {
  const r = liveRecord(file, now);
  if (!r) return null;
  return { armed: r.armed, remaining: Math.max(0, r.remaining), armedAt: r.armedAt, expiresAt: r.armedAt + LOCK_MS, resetBy: r.resetBy ?? null };
}

/** Re-arms the budget file at `file` to envValue's count. Orchestrator-only:
 *  returns null (and writes nothing) unless `byOrchestrator` is true and
 *  envValue is a positive integer. The
 *  record keeps `resetBy: "orchestrator"` so a later read shows it was used. */
export function resetBudget(file, envValue, { byOrchestrator = false, now = Date.now() } = {}) {
  if (!byOrchestrator) return null;
  const armed = armedFromEnv(envValue);
  if (armed === null) return null;
  const state = { armed, remaining: armed, armedAt: now, resetBy: "orchestrator" };
  writeBudget(file, state);
  return state;
}
