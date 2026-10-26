// Hosted (Falcon) tab actions: Close Session with its wait-for-ack and Jettison to the Falcon
// shell, with their mutual busy guards. sessions.ts binds its tab map and removeSessionView in.
import { invoke } from "../../ipc";
import type { TerminalSession } from "./types";
import { openTabMenu } from "./tab-strip";
import { attachRenderedBody, detachRenderedBody, retireRenderedBody } from "./rendered-body";
import { hostedCloseDecision } from "./hosted-close";
import { closeInBackground } from "./close-flow";
import { reportCloseFailure } from "./close-notice";
import { showSessionsToast } from "./zoom";
import type { RenderedBody } from "../rendered";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let removeSessionView: (id: string, s: TerminalSession) => void = () => {};

/** sessions.ts, at load: the tab map and the view teardown a finished close/jettison calls. */
export function bindHosted(deps: {
  sessions: ReadonlyMap<string, TerminalSession>;
  removeSessionView: (id: string, s: TerminalSession) => void;
}) {
  sessions = deps.sessions;
  removeSessionView = deps.removeSessionView;
}

/** Remove a tab whose adopt was refused: the view leaves, the body is disposed, nothing is killed
 *  (the session belongs to another holder; `abandon()` would falcon_kill it). */
export function dropUnadoptedTab(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  detachRenderedBody(s);
  removeSessionView(id, s);
}

/** Tab X and Close Session. Default: the tab leaves the bar and view in the same frame
 *  and the shutdown settles in the background (failures go to the close notice). `wait: true`
 *  (a caller that re-checks the tab afterwards) keeps the tab until Falcon acknowledges.
 *
 *  Accepted risk (2026-10-05): if Vidar quits after a close but before Falcon receives the
 *  kill (spawn, interrupt and up to 5 s of turn completion come first, `rendered/lifecycle.ts`),
 *  the session survives and `launcher/readopt.ts` re-adopts it at next launch. No persistence. */
export async function closeHostedTab(id: string, opts?: { wait?: boolean }) {
  if (closeBusy.has(id)) return;
  const s = sessions.get(id);
  const body = s?.rendered;
  if (!s || !body?.hosted()) return;
  if (isJettisonBusy(id)) {
    s.closeError = "jettison in flight; try again";
    openTabMenu(id, s.button);
    return;
  }
  if (!opts?.wait) {
    closeBusy.add(id);
    try {
      await closeOffDom(s, body, "hosted");
    } finally {
      closeBusy.delete(id);
    }
    return;
  }
  closeBusy.add(id);
  try {
    s.closeError = undefined;
    s.button.classList.add("closing");
    body.el.inert = true;
    // A view whose host connection is lost cannot get an acknowledgement; waiting on one
    // failed every close and reopened the tab menu instead (2026-10-03). Drop it now.
    if (body.disconnected()) {
      void body.abandon();
      detachRenderedBody(s);
      removeSessionView(id, s);
      return;
    }
    try {
      // Close is the destructive hosted-session action. Unlike a tab close, it
      // terminates Falcon's child and waits for the transport's acknowledgement.
      await body.shutdown();
    } catch (e) {
      const cur = sessions.get(id);
      if (!cur || cur.rendered !== body) return;
      if (hostedCloseDecision({ disconnected: body.disconnected(), error: e }) === "remove") {
        console.warn(`hosted session unreachable, closing the tab locally: ${String(e)}`);
        void body.abandon();
        detachRenderedBody(cur);
        removeSessionView(id, cur);
        return;
      }
      cur.closeError = String(e);
      console.error(`hosted session close failed: ${cur.closeError}`);
      cur.button.classList.remove("closing");
      body.el.inert = false;
      openTabMenu(id, cur.button); // keep the failure visible and leave the tab attached
      return;
    }
    const cur = sessions.get(id);
    if (!cur || cur.rendered !== body) return;
    detachRenderedBody(cur);
    removeSessionView(id, cur);
  } finally {
    closeBusy.delete(id);
  }
}

/** Codex/Astra (local Rendered) tab close: same instant removal, `detach()` in the background. */
export async function closeRenderedLocal(id: string) {
  const s = sessions.get(id);
  const body = s?.rendered;
  if (!s || !body || closeBusy.has(id)) return;
  closeBusy.add(id);
  try {
    await closeOffDom(s, body, "local");
  } finally {
    closeBusy.delete(id);
  }
}

/** Removes the view now; the settle path holds `s` and `body` itself, so it never reads the tab map
 *  (the id is already gone from it). `removeSessionView` leaves `s.rendered` alone, so
 *  `detachRenderedBody` in `finalize` still finds the body; the `rendered === body` check covers
 *  a tab whose body was swapped meanwhile. Disposed exactly once. */
function closeOffDom(s: TerminalSession, body: RenderedBody, kind: "hosted" | "local"): Promise<void> {
  let done = false;
  return closeInBackground({
    kind,
    label: s.container.dataset.title || s.id,
    body,
    removeView: () => {
      retireRenderedBody(body);
      removeSessionView(s.id, s);
    },
    finalize: () => {
      if (done) return;
      done = true;
      if (s.rendered === body) detachRenderedBody(s);
      else body.dispose();
    },
    classify: (error) => hostedCloseDecision({ disconnected: body.disconnected(), error }),
    fail: reportCloseFailure,
  });
}

/** Tab ids with a jettison or a close in progress: `initAskGate`'s `jettison`
 *  branch (`src/control/open-ask.ts`) needs to refuse a second script-driven ask for a tab that
 *  is already mid-detach, since that path has no click to naturally serialise
 *  against (the tab-menu row does, because the menu is gone after one click).
 *  `closeBusy` gives the two actions a mutual guard — a fast X and a menu
 *  Jettison (or a second X) on the same tab must not race the same lease. */
const jettisonBusy = new Set<string>();
const closeBusy = new Set<string>();

export function isJettisonBusy(id: string): boolean {
  return jettisonBusy.has(id);
}

/** Hand a hosted tab to the Falcon shell: detach first (a re-adopt before
 *  detach completes is refused by the host as "already controlled by
 *  the current holder"), then write the handoff, then ask the host to raise its window.
 *  A failure after detach rolls back by re-adopting the same session — the
 *  existing attach path, not a new one.
 *  Returns ok/reason so a script-driven caller (`src/control/open-ask.ts`'s `jettison` ask-gate
 *  branch) can report a verdict; the tab-menu click (below) still just fires
 *  it and lets `closeError` carry the failure into the reopened menu. */
export async function jettisonSession(id: string): Promise<{ ok: boolean; reason?: string }> {
  if (jettisonBusy.has(id)) return { ok: false, reason: "a jettison for this tab is already in flight" };
  if (closeBusy.has(id)) return { ok: false, reason: "close in flight" };
  jettisonBusy.add(id);
  try {
    const s = sessions.get(id);
    const body = s?.rendered;
    if (!s || !body?.hosted()) return { ok: false, reason: "tab is not a hosted Rendered Claude tab" };
    s.closeError = undefined;
    let session = s.falconSession ?? null;
    if (!session) {
      try {
        session = await invoke("falcon_hosted_session", { id });
      } catch {
        session = null;
      }
    }
    if (!session) {
      s.closeError = "no hosted session id yet";
      openTabMenu(id, s.button);
      return { ok: false, reason: "no hosted session id yet" };
    }
    const draft = body.draft();
    try {
      await body.detach();
    } catch (e) {
      const cur = sessions.get(id);
      if (cur) {
        cur.closeError = String(e);
        openTabMenu(id, cur.button);
      }
      return { ok: false, reason: String(e) };
    }
    const cur = sessions.get(id);
    if (!cur || cur.rendered !== body) return { ok: false, reason: "tab changed underneath the jettison" };
    try {
      await invoke("falcon_handoff_write", { session, draft, direction: "jettison" });
      await invoke("falcon_show");
    } catch (e) {
      // Rollback with the existing attach path: re-adopt the session this tab
      // just detached from, so the tab is never left orphaned. The detached
      // body is disposed and its container cleared first — mirroring the
      // shell's own detachBody (falcon.ts) — so re-attaching cannot stack a
      // second composer in the same tab.
      await invoke("falcon_handoff_clear", { direction: "jettison", session }).catch(() => {});
      const sid = body.sessionId() ?? undefined;
      detachRenderedBody(cur);
      cur.falconSession = session;
      attachRenderedBody(cur, sid, draft);
      cur.closeError = String(e);
      openTabMenu(id, cur.button);
      return { ok: false, reason: String(e) };
    }
    cur.rendered?.dispose();
    cur.rendered = undefined;
    removeSessionView(id, cur);
    return { ok: true };
  } finally {
    jettisonBusy.delete(id);
  }
}

/** The tab menu's Jettison row: the reopened menu's "Failed" row went with the next keystroke and
 *  the early returns showed nothing at all (2026-10-25), so every failure also gets a toast. */
export async function jettisonFromMenu(id: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await jettisonSession(id);
  if (!result.ok) showSessionsToast(`Jettison Failed — ${result.reason ?? "unknown error"}`, 4000);
  return result;
}
