// src\control\open-ask.ts — the open-a-tab ask gate (bridge\open, src-tauri\src\open.rs): the
// `open-ask` listener, split from main.ts. adoptHosted and spawnAstra are
// launcher functions passed in by main.ts, so this module never imports the launcher or main.
import { invoke, listen } from "../ipc";
import type { FalconSessionSummary as FalconHostedSession } from "../ipc";
import { sessionTitle, jettisonSession, findTabByFalconSessionHosted, isJettisonBusy, openFalconSessionIds } from "../panels/sessions";
import { askGate } from "../panels/askgate";
import { depFound } from "../deps/state";

/** How long after initAskGate an unreported `desks` or `codex` dependency (the desks pack gate,
 *  K2) still means "not settled yet". The ask gate starts (open_ready) before the first
 *  dependency report lands; an ask pending across a swap arrives inside that window and must not
 *  be answered failed. */
const DESKS_SETTLE_MS = 15_000;
const OPENS_ASTRA = "Astra · Codex, writes display only, armed for review";

/** True once the dependency report shows both `desks` and `codex` found; false after the settle
 *  window, or as soon as either is reported missing. */
async function desksReady(bootAt: number): Promise<boolean> {
  for (;;) {
    const desks = depFound("desks");
    const codex = depFound("codex");
    if (desks !== null && codex !== null) return desks && codex;
    if (Date.now() - bootAt >= DESKS_SETTLE_MS) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface OpenAskDeps {
  adoptHosted: (s: FalconHostedSession, draft?: string) => Promise<string>;
  spawnAstra: (returnTo: string) => Promise<string>;
}

// Open-a-tab asks (bridge\open, src-tauri/src/open.rs): a desk tab asks the USER
// to open a companion tab. Vidar shows the ask, and only a click opens anything
// — there is no armed-requester shortcut here, because the human is the gate.
// The verdict always goes back: an unanswered ask blocks the asker until its own
// deadline, so every path below calls open_result exactly once.
export function initAskGate({ adoptHosted, spawnAstra }: OpenAskDeps) {
  const bootAt = Date.now();
  listen<{ id: string; kind: string; reason: string; requester: string; session: string | null; claimedAtMs: number }>("open-ask", async (e) => {
    const d = e.payload;
    const report = (ok: boolean, tab: string | null, verdict: string, comment: string, reason: string | null) =>
      invoke("open_result", { id: d.id, ok, tab, verdict, comment, reason }).catch(() => {});
    if (d.kind === "jettison") {
      // Auto-approved like "dock": the session named itself via
      // $env:FALCON_SESSION (tools\falcon\jettison.ps1), open.rs already validated
      // it, and the move is the same one click the tab menu offers — no
      // second modal on top of a script the user already ran.
      //
      // Wrapped: a throw here used to escape this listener entirely and never
      // call report(), leaving jettison.ps1 to burn its full timeout for
      // nothing.
      try {
        const session = d.session;
        if (!session) return report(false, null, "failed", "", "no session on the ask");
        const tab = await findTabByFalconSessionHosted(session);
        if (!tab) return report(false, null, "failed", "", "no tab hosts that session");
        if (isJettisonBusy(tab)) return report(false, null, "failed", "", "a jettison is already in flight");
        const { ok, reason } = await jettisonSession(tab);
        if (!ok) return report(false, null, "failed", "", reason ?? "jettison failed");
        return report(true, tab, "approved", "", null);
      } catch (e) {
        return report(false, null, "failed", "", String(e));
      }
    }
    if (d.kind === "dock") {
      // Auto-approved: a Dock is the user's own click in a window they are
      // looking at, not another tab asking. Peek, not
      // take — the shell's own 2 s poll may be peeking the same file for a
      // "jettison" record, and a destructive read here must never eat that.
      const h = await invoke(
        "falcon_handoff_peek",
        { direction: "dock" },
      );
      if (!h) return report(false, null, "failed", "", "no dock handoff");
      if ((await openFalconSessionIds()).includes(h.session)) {
        return report(false, null, "failed", "", "already open in Vidar");
      }
      let hostedList: FalconHostedSession[] = [];
      try {
        ({ sessions: hostedList } = await invoke("falcon_list"));
      } catch (err) {
        return report(false, null, "failed", "", String(err instanceof Error ? err.message : err));
      }
      const summary = hostedList.find((x) => x.session === h.session);
      if (!summary) return report(false, null, "failed", "", "not hosted");
      try {
        const tab = await adoptHosted(summary, h.draft);
        // Cleared only now: a peek that merely looked must not be the reason
        // the other side loses its record.
        await invoke("falcon_handoff_clear", { direction: "dock", session: h.session }).catch(() => {});
        return report(true, tab, "approved", "", null);
      } catch (err) {
        return report(false, null, "failed", "", String(err instanceof Error ? err.message : err));
      }
    }
    if (d.kind !== "astra") return report(false, null, "failed", "", `unknown kind "${d.kind}"`);
    // Desks pack gate (K2) before the dialog, so the user never sees an ask that cannot succeed.
    if (!(await desksReady(bootAt))) return report(false, null, "failed", "", "Desks Pack Not Set Up");
    const asker = sessionTitle(d.requester) ?? d.requester;
    const { approved, shown, comment, reason } = await askGate({
      permission: true,
      details: [["Asked By",asker], ["Opens", OPENS_ASTRA], ["Request", d.id]],
      matrix: { nodes: [], fields: [], facts: [
        { label: "Asked By", icon: "user", value: asker },
        { label: "Opens", icon: "opens", value: OPENS_ASTRA },
        { label: "Request", icon: "request", value: d.id, mono: true },
      ] },
      question: d.reason,
      claimedAtMs: d.claimedAtMs,
      id: d.id,
      tab: d.requester,
    }, "astra"); // d.kind is "astra" here (checked above)
    // Deduped or expired: the user never saw it, so this is NOT a denial. The
    // asker must be able to tell "they said no" from "it never reached them".
    if (!shown) return report(false, null, "failed", comment, reason ?? "self-answered");
    if (!approved) return report(false, null, "denied", comment, null);
    try {
      const tab = await spawnAstra(d.requester);
      return report(true, tab, "approved", comment, null);
    } catch (err) {
      return report(false, null, "failed", comment, String(err instanceof Error ? err.message : err));
    }
  }).then(() => invoke("open_ready")).catch(() => {});
}
