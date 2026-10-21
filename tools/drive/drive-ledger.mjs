// Run-scoped tab ledger for vidar-drive.mjs: which tabs existed before a smoke began, so
// `close-spawned` can end the hosted tabs the smoke opened and `check-clean` can refuse while
// any remain (ruling docs/projects/falcon/falcon-idle-reap.md §Decision 6). Each drive call is
// its own process, so the ledger lives on disk: <driverMode>/ledger.json (paths contract id
// `driverMode`, the same folder guard-driver reads `<session>.json` from; this name never
// matches a session id).
//
// A ledger binds while it is younger than the budget lock (LOCK_MS) and not older than the
// budget's arming: a freshly armed VIDAR_DRIVE_BUDGET is a new smoke, so it re-snapshots.
// `check-clean` deletes it once clean, which ends the run.
import fs from "node:fs";
import path from "node:path";
import { resolve } from "../lib/paths.mjs";
import { LOCK_MS } from "./drive-budget.mjs";

export const LEDGER_NAME = "ledger.json";

export function ledgerFile(opts = {}) {
  return path.join(resolve("driverMode", opts), LEDGER_NAME);
}

export const LEDGER_VERSION = 3;

/** The client name the Falcon shell negotiates (src-tauri/src/falcon.rs `CLIENT_NAME`, shell build);
 *  a session whose `last_holder` is this was last driven from the shell. */
export const SHELL_CLIENT = "falcon-shell";

const strings = (a) => Array.isArray(a) && a.every((t) => typeof t === "string");
const stringsOrNull = (a) => a === null || strings(a);

/** `{v: 3, at, sessions, unresolved, local, page, falcon}` or null when absent or malformed.
 *  `local` (ids of non-hosted tabs), `page` (performance.timeOrigin) and `falcon` (live session ids)
 *  are null when unknown. A v2 `{v: 2, at, sessions, unresolved}` is upgraded with those three null,
 *  so a bump mid-run does not wipe the snapshot. Older shapes (the pre-2026-10-02 `{at, tabs}`, the
 *  pre-v2 `{at, sessions}`) count as malformed, so the next verb re-snapshots. */
export function readLedger(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(r?.at) || !strings(r.sessions) || !strings(r.unresolved)) return null;
    if (r.v === 2) return { ...r, v: LEDGER_VERSION, local: null, page: null, falcon: null };
    if (r.v !== LEDGER_VERSION) return null;
    if (!stringsOrNull(r.local) || !stringsOrNull(r.falcon)) return null;
    if (r.page !== null && !Number.isFinite(r.page)) return null;
    return r;
  } catch {
    return null;
  }
}

/** Verbs that read and never change Vidar: they must not start a ledger, or a closing state read after a
 *  passing check-clean would arm a fresh 2 h ledger. Every other verb (open, send, answer, card, click,
 *  eval, invoke, shortcut, paste) can create a tab or session, so it snapshots first. One string, split:
 *  a bare quoted state literal counts against the paths contract (tests/paths-contract.test.mjs). */
export const READ_ONLY_VERBS = "state text shot console budget".split(" ");

/** True when a verb with no live ledger must snapshot before it runs. */
export function armsLedger(cmd) {
  return cmd !== "close-spawned" && cmd !== "check-clean" && !READ_ONLY_VERBS.includes(cmd);
}

/** The ledger this call belongs to, or null when a new smoke must snapshot first.
 *  `budget` is budgetStatus() (null when uncapped). */
export function liveLedger(file, budget, now = Date.now()) {
  const l = readLedger(file);
  if (!l) return null;
  if (now < l.at || now - l.at >= LOCK_MS) return null;
  if (budget && budget.armedAt > l.at) return null;
  return l;
}

/** Falcon session ids of the hosted tabs in a drive-state snapshot: the ledger's key. Tab ids
 *  (`s<n>-<boot>`, sessions.ts) change on every reload or relaunch, so a re-adopted tab would
 *  look new by id; its Falcon session does not change. */
export function hostedSessions(state) {
  return (state?.tabs ?? []).map((t) => t.falconSession).filter((s) => typeof s === "string" && s);
}

/** Tab ids of hosted tabs with no Falcon session in a drive-state snapshot (not yet attached, or
 *  the host lookup failed): neither known nor spawned, so the ledger records them separately. */
export function unresolvedHosted(state) {
  return (state?.tabs ?? []).filter((t) => t.hosted && !t.falconSession).map((t) => t.id);
}

/** Tab ids of the tabs that are not Falcon-hosted (raw PTY, Codex): what the smoke must close by X. */
export function localTabs(state) {
  return (state?.tabs ?? []).filter((t) => !t.hosted).map((t) => t.id);
}

/** `exited` is the exit code (`number | null`, `FalconSessionSummary`): code 0 is exited, not live. */
const isLive = (s) => s.exited === null || s.exited === undefined;

/** What one probe (`{state, page, falcon}`, PROBE_JS in vidar-drive.mjs) records. `probe.falcon` is
 *  `{sessions: [{session, exited, attached?, last_holder?}], held: [{tab, session}]}`, or null when
 *  Falcon was unavailable or a call threw; the ledger then keeps `falcon: null` (unknown, never empty). */
export function snapshotRecord(probe) {
  return {
    sessions: hostedSessions(probe?.state),
    unresolved: unresolvedHosted(probe?.state),
    local: localTabs(probe?.state),
    page: Number.isFinite(probe?.page) ? probe.page : null,
    falcon: probe?.falcon ? probe.falcon.sessions.filter(isLive).map((s) => s.session) : null,
  };
}

export function writeLedger(file, snap, now = Date.now()) {
  const record = {
    v: LEDGER_VERSION, at: now,
    sessions: [...snap.sessions], unresolved: [...(snap.unresolved ?? [])],
    local: snap.local ? [...snap.local] : null, page: snap.page ?? null,
    falcon: snap.falcon ? [...snap.falcon] : null,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
  return record;
}

export function clearLedger(file) {
  fs.rmSync(file, { force: true });
}

/** Tab ids (what the X click needs) split two ways. `spawned`: hosted tabs whose Falcon session
 *  the ledger did not record. `unresolved`: hosted tabs with no Falcon session that the snapshot
 *  did not already see unresolved; their origin is unknown, so they are never counted clean and
 *  never closed. A PTY tab (not hosted) is neither. */
export function spawnedHosted(ledger, state) {
  const known = new Set(ledger.sessions);
  const seenUnresolved = new Set(ledger.unresolved ?? []);
  const tabs = (state?.tabs ?? []).filter((t) => t.hosted);
  return {
    spawned: tabs.filter((t) => t.falconSession && !known.has(t.falconSession)).map((t) => t.id),
    unresolved: tabs.filter((t) => !t.falconSession && !seenUnresolved.has(t.id)).map((t) => t.id),
  };
}

/** Non-hosted tab ids, report only (cleanup never closes them). Same page as the snapshot: the ones
 *  not in `ledger.local` are `spawned`. A changed page (a reload gives every tab a new id), or a
 *  ledger with no `local`/`page` (upgraded from v2), cannot tell old from new: every local tab is
 *  `unresolved`. */
export function leftoverLocal(ledger, probe) {
  const now = localTabs(probe?.state);
  if (!ledger.local || ledger.page === null || ledger.page !== probe?.page) return { spawned: [], unresolved: now };
  const known = new Set(ledger.local);
  return { spawned: now.filter((id) => !known.has(id)), unresolved: [] };
}

export const NO_FALCON_LIST = "could not list Falcon sessions";

/** Live Falcon sessions the snapshot did not see and nothing in Vidar owns: not in `ledger.falcon` or
 *  `ledger.sessions`, not held by a tab in this state, not in `falcon_hosted_held` (views waiting for
 *  readopt). Exited ones are ignored. `kind` names who can end it: `shell` when the shell last held it
 *  or a client is attached with no Vidar tab (Close Session in the Falcon shell); otherwise `parked`
 *  (its row under Launcher > Claude > Falcon). A null falcon on either side lists nothing and reports
 *  `unresolved`, never a pass. Detection only: nothing here kills or adopts. */
export function leftoverSessions(ledger, probe) {
  if (!ledger.falcon || !probe?.falcon) return { spawned: [], unresolved: [NO_FALCON_LIST] };
  const owned = new Set([
    ...ledger.falcon, ...ledger.sessions,
    ...hostedSessions(probe.state),
    ...(probe.falcon.held ?? []).map((h) => h.session),
  ]);
  const spawned = probe.falcon.sessions
    .filter((s) => isLive(s) && !owned.has(s.session))
    .map((s) => ({ session: s.session, kind: s.last_holder === SHELL_CLIENT || s.attached > 0 ? "shell" : "parked" }));
  return { spawned, unresolved: [] };
}
