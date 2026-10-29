// claude-sidecar-recover.mjs: the interrupt window, recovery and resume replay for claude-sidecar.mjs. An interrupt
// that lands while the CLI waits on a permission can make the SDK throw out of the stream;
// a throw inside the window ends the turn and the
// sidecar rebuilds the query on the same session instead of failing.
// Imported by claude-sidecar.mjs and bundled beside it (Falcon bundle sidecar\, friend zip tools\).
//
// Usage: import { createInterruptWindow, forwardInterrupt, replayHistory } from "./claude-sidecar-recover.mjs";
//
// Refuses: no top-level side effects; every sidecar object it touches (pending permissions, the
// prompt queue, the query options, `out`) is passed in, never imported.

// A throw within INTERRUPT_GRACE_MS of an interrupt this sidecar forwarded ends the turn instead:
// 10 s is twice the 5 s Vidar's stopAgent gives an interrupted turn before it kills, and the throw
// follows the interrupt's own control round trip; a failure later than that is not the interrupt's,
// and still fails.
export const INTERRUPT_GRACE_MS = 10_000;
export const INTERRUPT_SETTLE_MS = 1_000; // how long a rejected interrupt waits for that recovery

/** True when a stream error at `now` is the interrupt's: one was forwarded at `at`, at most `windowMs` ago. */
export function interruptedThrow(now, at, windowMs = INTERRUPT_GRACE_MS) {
  return at > 0 && now >= at && now - at <= windowMs;
}

/** The window's state. `handed` holds the items handed to the CLI since the interrupt or the turn's
 *  result while the window is open: Falcon sends its next prompt on that result, and a CLI that then
 *  dies never ran it, so `recover` queues them again for the rebuilt query. */
export function createInterruptWindow() {
  let at = 0; // Date.now() of the last interrupt forwarded to a live query; 0 = none
  let resultSince = false; // the interrupted turn already emitted its own result
  let handed = [];
  return {
    start() { at = Date.now(); resultSince = false; handed = []; },
    hand(item) { if (at) handed.push(item); },
    /** Each SDK message: a result is the interrupted turn's own; a new turn after it closes the window. */
    observe(msg) {
      if (msg?.type === "result") { resultSince = true; handed = []; }
      else if (resultSince && (msg?.type === "assistant" || msg?.type === "stream_event" || msg?.subtype === "init")) { at = 0; handed = []; }
    },
    caught(now = Date.now()) { return interruptedThrow(now, at); },
    /** A throw inside the window: deny what the dead query left open, end the turn the way an
     *  interrupted turn ends (a result, subtype error_during_execution, which Vidar draws as
     *  Interrupted) unless that turn already sent its own, and point the next query at the same
     *  session. The stream ends with the query, so it is rebuilt; the SDK offers no way to keep it. */
    recover(message, { pending, falcon, cancelledPermissions, out, observeAgentSignals, queue, options, sessionId }) {
      for (const [id, r] of pending) {
        pending.delete(id);
        if (falcon) { cancelledPermissions.add(id); out({ type: "falcon", subtype: "permission", id, state: "cancelled" }); }
        r({ behavior: "deny", message: "Interrupted" });
      }
      if (!resultSince) {
        const result = { type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: sessionId, permission_denials: [], vidar_interrupted: message };
        out(result);
        if (falcon) observeAgentSignals(result);
      }
      at = 0;
      queue.unshift(...handed); // the dead CLI took them after its result and never ran them
      handed = [];
      options.resume = sessionId;
    },
  };
}

// Resume replay: the CLI itself streams nothing from the past, so the history goes out first. Each
// message goes out in its live shape plus `replay: true`; tool results and inputs get the same caps
// as live traffic. Bounded: the LAST REPLAY_MAX user/assistant messages (the SDK only offers
// offset-from-start, so the whole list is read once and the tail kept). The SDK's history excludes
// subagent sidechains, so only the main session is restored. Boundaries go out as sidecar
// replaying/replayed lines.
const REPLAY_MAX = 400;
export async function replayHistory(resume, getSessionMessages, { out, shrink }) {
  try {
    const history = (await getSessionMessages(resume)).filter((h) => h.type === "user" || h.type === "assistant");
    const tail = history.slice(-REPLAY_MAX);
    const truncated = history.length - tail.length;
    out({ type: "sidecar", subtype: "replaying", count: tail.length, truncated });
    for (const h of tail) {
      out(shrink({ type: h.type, message: h.message, parent_tool_use_id: h.parent_tool_use_id ?? null, replay: true }));
    }
    out({ type: "sidecar", subtype: "replayed", count: tail.length, truncated });
  } catch (e) {
    out({ type: "sidecar", subtype: "error", message: `history: ${e?.message ?? e}` });
  }
}

/** Forward an interrupt to query `iq` and report its outcome to Falcon. A rejection from the query
 *  this interrupt tore down is the interrupt working: the SDK rejects it during cleanup, around the
 *  throw "run" recovers from. Checked a beat later when not already rebuilt (`getQ` is the live
 *  query), since the two race; a query still live then failed for real. */
export function forwardInterrupt(iq, getQ, cid, { out, falconOutcome }) {
  iq?.interrupt().then(
    () => falconOutcome(cid, "applied"),
    (e) => {
      const settle = () => {
        if (getQ() !== iq) { falconOutcome(cid, "applied"); return; }
        out({ type: "sidecar", subtype: "error", message: `interrupt: ${e?.message ?? e}` });
        falconOutcome(cid, "failed", `interrupt: ${e?.message ?? e}`);
      };
      if (getQ() !== iq) settle(); else setTimeout(settle, INTERRUPT_SETTLE_MS);
    },
  );
}
